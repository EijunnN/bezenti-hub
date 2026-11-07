import {
  type ActiveEnvironmentView,
  ENVIRONMENT_STATUS_LABELS,
  NEEDS_ENVIRONMENT_LABEL,
  PAUSED_OFFLINE_LABEL,
  SANDBOX_FAILED_LABEL,
  SANDBOX_STARTING_LABEL,
  type ThreadEnvironmentState,
  activeEnvironmentLabel,
  threadEnvironmentState,
} from "@t3tools/client-runtime/environment/hub-environments";
import type { HubEnvironmentStatus } from "@t3tools/contracts";

export interface ThreadEnvironmentPresentation {
  /** What a row or header shows: «Laptop», «Laptop · Offline», «Paused, environment offline». */
  readonly text: string;
  /** What its accessible name ends with: «runs on Laptop, offline». */
  readonly accessibilityText: string;
  readonly status: HubEnvironmentStatus;
  readonly state: ThreadEnvironmentState | null;
}

/**
 * Where a Thread runs, as its row and header say it. Nothing while the Hub machine is the only
 * Environment the User sees and the Thread runs there, since then where it runs is no news; a
 * Thread that needs an environment always says so.
 */
export function threadEnvironmentPresentation(input: {
  readonly environment: ActiveEnvironmentView | null;
  readonly hasJoinedEnvironments: boolean;
  readonly turnUnderWay: boolean;
}): ThreadEnvironmentPresentation | null {
  const { environment } = input;
  if (environment === null) return null;
  const state = threadEnvironmentState(environment, input.turnUnderWay);
  if (state === null && !input.hasJoinedEnvironments) return null;
  const stateLabel =
    state === "paused-offline"
      ? PAUSED_OFFLINE_LABEL
      : state === "sandbox-starting"
        ? SANDBOX_STARTING_LABEL
        : state === "sandbox-failed"
          ? SANDBOX_FAILED_LABEL
          : undefined;
  const text =
    state === "needs-environment"
      ? NEEDS_ENVIRONMENT_LABEL
      : stateLabel !== undefined
        ? `${stateLabel} · ${environment.name}`
        : environment.status === "online"
          ? environment.name
          : `${environment.name} · ${ENVIRONMENT_STATUS_LABELS[environment.status]}`;
  return {
    text,
    accessibilityText:
      state === "needs-environment"
        ? NEEDS_ENVIRONMENT_LABEL.toLowerCase()
        : stateLabel !== undefined
          ? `${stateLabel.toLowerCase()}, runs on ${environment.name}`
          : `runs on ${activeEnvironmentLabel(environment)}`,
    status: environment.status,
    state,
  };
}
