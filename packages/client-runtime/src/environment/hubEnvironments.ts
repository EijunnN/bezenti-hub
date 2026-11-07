// @effect-diagnostics globalTimers:off - The poll runs in React subscriptions, outside an Effect runtime.
// Where each Thread runs, as every client shows it: the Hub's Environments list (each machine's
// name and live status), a Thread's Active environment read from it, and the words and steps of
// moving a Thread to another machine. Web and mobile share these so they say the same things.
import {
  type EnvironmentConnectionStatus,
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type HubEnvironmentList,
  type HubEnvironmentSummary,
  type OrchestrationV2ThreadMove,
  type OrchestrationV2ThreadMoveStep,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";
import { environmentEndpointUrl } from "./endpoint.ts";

/** The Hub's Environments with a bearer session, as mobile holds one for its Hub. */
export const fetchRemoteHubEnvironments = (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}) =>
  makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "environments").pipe(
    Effect.flatMap((client) =>
      executeEnvironmentHttpRequest(
        environmentEndpointUrl(input.httpBaseUrl, "/api/environments"),
        10_000,
        client.list({ headers: { authorization: `Bearer ${input.bearerToken}` } }),
      ),
    ),
  );

/**
 * Status and providers change on heartbeats, every ten seconds on the Hub; a machine that drops
 * shows «Reconnecting» at once and «Offline» a minute later, so a short poll keeps rows live.
 */
const HUB_ENVIRONMENTS_REFRESH_MS = 5000;
/** With only the Hub machine there is nothing to keep live: a slow check notices a first join. */
const HUB_ENVIRONMENTS_IDLE_REFRESH_MS = 60_000;

/** «loading» until the first answer, «error» while the last read failed. */
export type HubEnvironmentsStatus = "loading" | "ready" | "error";

export interface HubEnvironmentsPoller {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => ReadonlyArray<HubEnvironmentSummary>;
  readonly status: () => HubEnvironmentsStatus;
  /** Reads the list now, as a view that just changed something asks. */
  readonly refresh: () => void;
  /** Forgets the list, as when the session it was read with ends. */
  readonly reset: () => void;
  /** Pauses reading while the app is in the background; resumes with a read. */
  readonly setActive: (active: boolean) => void;
}

/**
 * One list for every view that shows where Threads run, read while any of them is subscribed and
 * the app is active: every `intervalMs` while machines joined the Hub, every `idleIntervalMs`
 * while the Hub machine is alone. A failed read keeps the last list and reports «error». An
 * unchanged answer does not notify, since every Thread row reads the list.
 */
export function makeHubEnvironmentsPoller(options: {
  readonly fetch: () => Promise<HubEnvironmentList>;
  readonly intervalMs?: number;
  readonly idleIntervalMs?: number;
}): HubEnvironmentsPoller {
  let environments: ReadonlyArray<HubEnvironmentSummary> = [];
  let status: HubEnvironmentsStatus = "loading";
  let generation = 0;
  let active = true;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const running = () => active && listeners.size > 0;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    stop();
    if (!running()) return;
    const interval =
      environments.length > 1
        ? (options.intervalMs ?? HUB_ENVIRONMENTS_REFRESH_MS)
        : (options.idleIntervalMs ?? HUB_ENVIRONMENTS_IDLE_REFRESH_MS);
    timer = setTimeout(refresh, interval);
  };

  function refresh() {
    stop();
    const pending = options.fetch();
    // Read after starting: a fetch that resets for a new session keeps its own answer.
    const started = generation;
    void pending.then(
      (list) => {
        if (started !== generation) return;
        const changed =
          status !== "ready" || JSON.stringify(list.environments) !== JSON.stringify(environments);
        environments = list.environments;
        status = "ready";
        schedule();
        if (changed) notify();
      },
      () => {
        if (started !== generation) return;
        const changed = status !== "error";
        status = "error";
        schedule();
        if (changed) notify();
      },
    );
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1 && active) refresh();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    snapshot: () => environments,
    status: () => status,
    refresh,
    reset: () => {
      generation += 1;
      const changed = environments.length > 0 || status !== "loading";
      environments = [];
      status = "loading";
      if (changed) notify();
    },
    setActive: (next) => {
      if (next === active) return;
      active = next;
      if (!next) stop();
      else if (listeners.size > 0) refresh();
    },
  };
}

/**
 * Whether the User may move a Thread to another Environment: only a User who may continue it
 * (moving continues it elsewhere), and only with another machine to go to; a Thread whose machine
 * was removed can always go to the Hub machine.
 */
export function canMoveThread(input: {
  readonly canContinue: boolean;
  /** How many Environments the User sees, the Hub machine included. */
  readonly environmentCount: number;
  readonly activeEnvironmentId: EnvironmentId | null | undefined;
}): boolean {
  return input.canContinue && (input.environmentCount > 1 || input.activeEnvironmentId === null);
}

/** What a Thread's header and row say about where it runs. */
export interface ActiveEnvironmentView {
  readonly name: string;
  readonly status: EnvironmentConnectionStatus;
  readonly isHubMachine: boolean;
  /** Its Environment was removed: it runs nowhere until it moves («needs an environment»). */
  readonly needsEnvironment: boolean;
}

/** The words for a Thread whose Environment was removed. */
export const NEEDS_ENVIRONMENT_LABEL = "Needs an environment";
/** The words for a Thread whose turn waits for its machine to come back. */
export const PAUSED_OFFLINE_LABEL = "Paused, environment offline";

export const ENVIRONMENT_STATUS_LABELS: Record<EnvironmentConnectionStatus, string> = {
  online: "Online",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

/**
 * What the Thread's state is because of where it runs: «needs an environment» once its machine
 * was removed, «paused, environment offline» while a turn is under way on a machine that is not
 * online (it resumes when the machine returns, or the Thread moves). Null otherwise.
 */
export function threadEnvironmentState(
  environment: ActiveEnvironmentView | null,
  turnUnderWay: boolean,
): "needs-environment" | "paused-offline" | null {
  if (environment === null) return null;
  if (environment.needsEnvironment) return "needs-environment";
  if (turnUnderWay && !environment.isHubMachine && environment.status !== "online") {
    return "paused-offline";
  }
  return null;
}

/**
 * A Thread's Active environment, a field of the Thread from the stream, by name and live status;
 * a Thread that names none runs on the Hub machine. Null when the User can't see the machine.
 */
export function activeEnvironmentOf(
  list: ReadonlyArray<HubEnvironmentSummary>,
  environmentId: EnvironmentId | null | undefined,
): ActiveEnvironmentView | null {
  if (environmentId === null) {
    return {
      name: "No environment",
      status: "offline",
      isHubMachine: false,
      needsEnvironment: true,
    };
  }
  const id = environmentId ?? HUB_MACHINE_ENVIRONMENT_ID;
  const environment = list.find((entry) => entry.id === id);
  if (environment === undefined) return null;
  return {
    name: environment.name,
    status: environment.kind === "hub" ? "online" : environment.status,
    isHubMachine: environment.kind === "hub",
    needsEnvironment: false,
  };
}

/** "Laptop" while online, "Laptop, offline" otherwise: the words an accessible name ends with. */
export function activeEnvironmentLabel(environment: ActiveEnvironmentView): string {
  if (environment.needsEnvironment) return NEEDS_ENVIRONMENT_LABEL.toLowerCase();
  return environment.status === "online"
    ? environment.name
    : `${environment.name}, ${ENVIRONMENT_STATUS_LABELS[environment.status].toLowerCase()}`;
}

/** Why a Thread could not run on the Environment, or null when it can. */
export function environmentUnavailableReason(
  environment: HubEnvironmentSummary,
  providerInstanceId: ProviderInstanceId,
): string | null {
  if (environment.kind === "hub") return null;
  if (environment.status !== "online") {
    return environment.status === "reconnecting" ? "Reconnecting" : "Offline";
  }
  const provider = environment.providers.find((entry) => entry.instanceId === providerInstanceId);
  if (provider === undefined || !provider.installed || !provider.enabled) {
    return "Provider not available";
  }
  return null;
}

/** What each step of a move is doing, as the Thread and the move dialog say it. */
const MOVE_STEP_LABELS: Record<OrchestrationV2ThreadMoveStep, string> = {
  "waiting-for-turn": "Finishing the turn",
  "final-checkpoint": "Uploading a final checkpoint",
  fetching: "Fetching the checkpoint",
  preparing: "Preparing the workspace",
  handoff: "Handing over",
  switched: "Ready",
};

const MOVE_STEPS: ReadonlyArray<OrchestrationV2ThreadMoveStep> = [
  "waiting-for-turn",
  "final-checkpoint",
  "fetching",
  "preparing",
  "handoff",
  "switched",
];

/** A machine's name for the move's words; a Thread that names none ran on the Hub machine. */
export function environmentNameOf(
  environments: ReadonlyArray<HubEnvironmentSummary>,
  environmentId: EnvironmentId | null | undefined,
): string {
  if (environmentId === null) return "no Environment";
  return (
    environments.find((environment) => environment.id === environmentId)?.name ??
    (environmentId === undefined || environmentId === HUB_MACHINE_ENVIRONMENT_ID
      ? "Hub machine"
      : "another Environment")
  );
}

/** What the move is doing now; a turn waiting on the User says so, since the move waits too. */
export function moveStepLabel(move: OrchestrationV2ThreadMove): string {
  return move.step === "waiting-for-turn" && move.waitingOn === "user"
    ? "Waiting for your answer in the running turn"
    : MOVE_STEP_LABELS[move.step];
}

/** Every Environment but the one the Thread runs on; a Thread whose machine was removed may go anywhere. */
export function moveCandidates(
  environments: ReadonlyArray<HubEnvironmentSummary>,
  sourceId: EnvironmentId | null | undefined,
): ReadonlyArray<HubEnvironmentSummary> {
  const source = sourceId === undefined ? HUB_MACHINE_ENVIRONMENT_ID : sourceId;
  return environments.filter((environment) => environment.id !== source);
}

/** What the move dialog explains before the User chooses. */
export function moveExplanation(input: {
  readonly sourceRemoved: boolean;
  readonly sourceName: string;
  readonly withoutProject: boolean;
}): string {
  if (input.sourceRemoved) {
    return "The machine this Thread ran on was removed. The Thread keeps its history and goes on on the machine you choose, from the last checkpoint it uploaded.";
  }
  const fetches = input.withoutProject
    ? "The new machine fetches it into the Thread's own folder there, with the folder's branches; repositories nested in the folder stay behind."
    : "The new machine fetches it into a worktree of the Thread's own, with its branch, and runs the Project's setup script there, which also rebuilds ignored files such as dependencies.";
  return `The Thread keeps its history and goes on running on the machine you choose. If ${input.sourceName} is online, it first uploads a final checkpoint with any changes made by hand. ${fetches} If ${input.sourceName} is offline, the Thread continues from the last checkpoint it uploaded, and changes it kept are put on a separate branch when it comes back.`;
}

export type MoveProgressStepState = "done" | "current" | "failed" | "pending";

export interface MoveProgressView {
  /** One sentence on where the move is, for a live status region. */
  readonly summary: string;
  readonly steps: ReadonlyArray<{
    readonly step: OrchestrationV2ThreadMoveStep;
    readonly label: string;
    readonly state: MoveProgressStepState;
  }>;
  /** Which checkpoint the Thread continues from, once the move knows. */
  readonly continuesFrom: string | null;
  /** Why it failed, as the Hub said. */
  readonly failure: string | null;
  /** Where the target's own workspace changes were kept. */
  readonly setAside: string | null;
}

/** A move as its progress shows it: summary, each step's state, and what it continues from. */
export function moveProgressView(
  move: OrchestrationV2ThreadMove,
  sourceName: string,
  targetName: string,
): MoveProgressView {
  const failedStep = move.failure?.step ?? move.step;
  const current = MOVE_STEPS.indexOf(move.status === "failed" ? failedStep : move.step);
  const summary =
    move.status === "switched"
      ? `Moved to ${targetName}.`
      : move.status === "failed"
        ? `The move stopped at «${MOVE_STEP_LABELS[failedStep]}». The Thread stays on ${sourceName}.`
        : move.status === "cancelled"
          ? `The move was cancelled. The Thread stays on ${sourceName}.`
          : `Moving to ${targetName}: ${moveStepLabel(move)}`;
  const continuesFrom =
    move.continuesFrom === undefined
      ? null
      : move.continuesFrom.kind === "final"
        ? "It continues from a final checkpoint, with the changes made by hand."
        : move.continuesFrom.kind === "uploaded"
          ? `${sourceName} was offline: it continues from the checkpoint of turn ${move.continuesFrom.appRunOrdinal ?? "?"}, the last one uploaded.`
          : `${sourceName} was offline and never uploaded a checkpoint: it continues from the Project as it is on ${targetName}.`;
  return {
    summary,
    steps: MOVE_STEPS.map((step, index) => ({
      step,
      label:
        step === "final-checkpoint" && move.sourceOffline === true
          ? `${MOVE_STEP_LABELS[step]} (skipped: ${sourceName} was offline)`
          : MOVE_STEP_LABELS[step],
      state:
        move.status === "switched" || index < current
          ? "done"
          : index === current
            ? move.status === "failed"
              ? "failed"
              : "current"
            : "pending",
    })),
    continuesFrom,
    failure: move.status === "failed" && move.failure !== undefined ? move.failure.message : null,
    setAside:
      move.setAsideRefs !== undefined && move.setAsideRefs.length > 0
        ? `What ${targetName} had in the workspace is kept in ${move.setAsideRefs.join(", ")}.`
        : null,
  };
}
