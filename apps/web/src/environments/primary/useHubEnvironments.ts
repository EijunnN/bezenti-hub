import {
  type EnvironmentConnectionStatus,
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type HubEnvironmentSummary,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { fetchHubEnvironments } from "./hubEnvironments";

/**
 * Status and providers change on heartbeats, every ten seconds on the Hub; a machine that drops
 * shows «Reconnecting» at once and «Offline» a minute later, so a short poll keeps rows live.
 */
const REFRESH_MS = 5000;

// One list for every component that shows where Threads run, fetched while any of them is mounted.
let environments: ReadonlyArray<HubEnvironmentSummary> = [];
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

const refresh = () => {
  void fetchHubEnvironments().then(
    (list) => {
      // Every Thread row reads this list: an unchanged answer must not re-render them all.
      if (JSON.stringify(list.environments) === JSON.stringify(environments)) return;
      environments = list.environments;
      for (const listener of listeners) listener();
    },
    // Signed out, or a server without Environments: nothing to show.
    () => undefined,
  );
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    refresh();
    timer = setInterval(refresh, REFRESH_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};

const snapshot = () => environments;

/** The Environments the signed-in User may see, the Hub machine first; kept fresh while mounted. */
export function useHubEnvironments(): ReadonlyArray<HubEnvironmentSummary> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** What a Thread's header and row say about where it runs. */
export interface ActiveEnvironmentView {
  readonly name: string;
  readonly status: EnvironmentConnectionStatus;
  readonly isHubMachine: boolean;
}

export const ENVIRONMENT_STATUS_LABELS: Record<EnvironmentConnectionStatus, string> = {
  online: "Online",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

/**
 * A Thread's Active environment, a field of the Thread from the stream, by name and live status;
 * a Thread that names none runs on the Hub machine. Null when the User can't see the machine.
 */
function activeEnvironmentOf(
  list: ReadonlyArray<HubEnvironmentSummary>,
  environmentId: EnvironmentId | null | undefined,
): ActiveEnvironmentView | null {
  if (environmentId === null) return null;
  const id = environmentId ?? HUB_MACHINE_ENVIRONMENT_ID;
  const environment = list.find((entry) => entry.id === id);
  if (environment === undefined) return null;
  return {
    name: environment.name,
    status: environment.kind === "hub" ? "online" : environment.status,
    isHubMachine: environment.kind === "hub",
  };
}

/**
 * One Thread's Active environment, kept live. Re-renders only when its name or status changes,
 * not on every heartbeat of every machine, since each sidebar row asks.
 */
export function useActiveEnvironment(
  environmentId: EnvironmentId | null | undefined,
): ActiveEnvironmentView | null {
  const read = () => JSON.stringify(activeEnvironmentOf(environments, environmentId));
  const key = useSyncExternalStore(subscribe, read, read);
  return JSON.parse(key) as ActiveEnvironmentView | null;
}

/** "Laptop" while online, "Laptop, offline" otherwise: the words an accessible name ends with. */
export function activeEnvironmentLabel(environment: ActiveEnvironmentView): string {
  return environment.status === "online"
    ? environment.name
    : `${environment.name}, ${ENVIRONMENT_STATUS_LABELS[environment.status].toLowerCase()}`;
}

/** Why a new Thread could not run on the Environment, or null when it can. */
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

// The Environment chosen for each new Thread, until it is sent.
const choices = new Map<string, EnvironmentId>();
const choiceListeners = new Set<() => void>();

export function chooseHubEnvironment(draftThreadId: string, environmentId: EnvironmentId | null) {
  if (environmentId === null) choices.delete(draftThreadId);
  else choices.set(draftThreadId, environmentId);
  for (const listener of choiceListeners) listener();
}

/** The Environment the User picked for a new Thread; undefined lets the Hub choose. */
export function readHubEnvironmentChoice(draftThreadId: string): EnvironmentId | undefined {
  return choices.get(draftThreadId);
}

const subscribeChoices = (listener: () => void) => {
  choiceListeners.add(listener);
  return () => {
    choiceListeners.delete(listener);
  };
};

export function useHubEnvironmentChoice(draftThreadId: string): EnvironmentId | undefined {
  return useSyncExternalStore(
    subscribeChoices,
    () => choices.get(draftThreadId),
    () => choices.get(draftThreadId),
  );
}
