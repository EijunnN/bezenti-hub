// @effect-diagnostics globalTimers:off - The probe deadline runs while the platform lists its saved connections, outside an Effect runtime.
import type { HubProbe } from "@t3tools/client-runtime/connection/single-hub";
import type { EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

/**
 * Mobile connects only to its Hub and sees every Thread there, whichever machine runs it. The Hub
 * is decided once and stored; connections saved before (several Hubs, or servers paired with a
 * code) stay saved on the phone, unconnected, until the User removes one or uses it as their Hub.
 */

export const SINGLE_HUB_REFUSAL =
  "This app connects to one Hub only. Remove the Hub it uses under Settings → Environments first.";
export const KEPT_CONNECTION_REFUSAL =
  "This connection is kept on the phone but not connected. Choose «Use as my Hub» under Settings → Environments.";

/** What is stored: the Hub this phone connects, or none after the User removed it. */
export interface StoredHub {
  readonly hub: EnvironmentId | null;
}

interface SavedTarget {
  readonly _tag: string;
  readonly environmentId: EnvironmentId;
  readonly connectionId?: string;
}

interface SavedProfile {
  readonly connectionId: string;
  readonly httpBaseUrl?: string;
}

const uniqueEnvironments = (targets: ReadonlyArray<SavedTarget>) => [
  ...new Set(targets.map((target) => target.environmentId)),
];

/**
 * Which saved connection is the Hub: a stored choice without probing (a removed Hub leaves none);
 * else one saved connection; else the first of several answering as a Hub, asked once in parallel
 * within `timeoutMs`. None answering leaves none, and Settings asks the User to choose.
 */
export async function decideHub(input: {
  readonly targets: ReadonlyArray<SavedTarget>;
  readonly profiles: ReadonlyArray<SavedProfile>;
  readonly stored: StoredHub | undefined;
  readonly probe: HubProbe;
  readonly timeoutMs: number;
}): Promise<{ readonly hub: EnvironmentId | null; readonly persist: boolean }> {
  const saved = uniqueEnvironments(input.targets);
  if (input.stored !== undefined) {
    const hub = input.stored.hub;
    if (hub !== null && !saved.includes(hub)) return { hub: null, persist: true };
    return { hub, persist: false };
  }
  if (saved.length === 0) return { hub: null, persist: false };
  if (saved.length === 1) return { hub: saved[0]!, persist: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), input.timeoutMs);
  });
  const answers = await Promise.all(
    input.targets.map((target) => {
      const profile = input.profiles.find((entry) => entry.connectionId === target.connectionId);
      if (target._tag !== "BearerConnectionTarget" || profile?.httpBaseUrl === undefined) {
        return Promise.resolve(false);
      }
      return Promise.race([
        input.probe(profile.httpBaseUrl, target.environmentId).catch(() => false),
        deadline,
      ]);
    }),
  );
  clearTimeout(timer);
  const answered = input.targets.find((_, index) => answers[index] === true);
  return answered === undefined
    ? { hub: null, persist: false }
    : { hub: answered.environmentId, persist: true };
}

/**
 * Why a connection may not be saved: only the Hub may register again (new credential or route);
 * a new Hub only while there is none; a kept connection only once the User chose it as their Hub.
 */
export function registrationRefusal(input: {
  readonly environmentId: EnvironmentId;
  readonly hub: EnvironmentId | null;
  readonly kept: ReadonlyArray<EnvironmentId>;
}): string | null {
  if (input.hub !== null) return input.environmentId === input.hub ? null : SINGLE_HUB_REFUSAL;
  return input.kept.includes(input.environmentId) ? KEPT_CONNECTION_REFUSAL : null;
}

// The kept connection the User chose with «Use as my Hub», until its registration consumes it.
let chosenHub: EnvironmentId | null = null;

/** Lets the next registration of `environmentId` make that kept connection the Hub. */
export function chooseKeptAsHub(environmentId: EnvironmentId): void {
  chosenHub = environmentId;
}

/** The chosen kept connection, once, when `environmentId` is the one being registered. */
export function takeChosenHub(environmentId: EnvironmentId): EnvironmentId | null {
  if (chosenHub !== environmentId) return null;
  chosenHub = null;
  return environmentId;
}

export interface KeptConnection {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionId: string;
}

export interface HubState {
  readonly hub: EnvironmentId | null;
  readonly kept: ReadonlyArray<KeptConnection>;
}

let state: HubState = { hub: null, kept: [] };
const listeners = new Set<() => void>();

export const hubState = {
  get: (): HubState => state,
  set: (next: HubState) => {
    state = next;
    for (const listener of listeners) listener();
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** The Hub and the kept connections; no Hub with kept ones means the User has to choose. */
export function useHubState(): HubState {
  return useSyncExternalStore(hubState.subscribe, hubState.get, hubState.get);
}
