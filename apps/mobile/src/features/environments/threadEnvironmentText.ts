import {
  type ActiveEnvironmentView,
  NEEDS_ENVIRONMENT_LABEL,
  PAUSED_OFFLINE_LABEL,
  SANDBOX_FAILED_LABEL,
  SANDBOX_STARTING_LABEL,
  type ThreadEnvironmentState,
  activeEnvironmentLabel,
  activeEnvironmentStatusLabel,
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
  /** The machine's name, as every client names it. */
  readonly environmentName: string;
  /** Why a `failed` Sandbox's last start failed. */
  readonly startError: string | null;
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
          : `${environment.name} · ${activeEnvironmentStatusLabel(environment)}`;
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
    environmentName: environment.name,
    startError: environment.startError,
  };
}

/**
 * What the notice above a Thread's messages says about where it runs, or null when there is
 * nothing to say: its machine removed, a turn paused on a machine that is not online, or its
 * Sandbox starting or failed to start (with why).
 */
export function threadEnvironmentNoticeText(
  runsOn: ThreadEnvironmentPresentation | null,
): string | null {
  if (runsOn === null) return null;
  switch (runsOn.state) {
    case null:
      return null;
    case "needs-environment":
      return "Needs an environment: the machine this Thread ran on was removed or no longer runs Threads. Move it to continue.";
    case "sandbox-starting":
      return `${SANDBOX_STARTING_LABEL} ${runsOn.environmentName} starts for this Thread's work; the Thread goes on once it runs.`;
    case "sandbox-failed":
      return `${SANDBOX_FAILED_LABEL}: ${runsOn.startError ?? "the Hub gave no reason"}`;
    case "paused-offline":
      return `${runsOn.text}. The turn resumes when the machine comes back, or move the Thread.`;
  }
}
