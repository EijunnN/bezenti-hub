import type { EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { isLocalEnvironmentDisabled } from "../localEnvironment";

/**
 * Web and desktop connect only to the Hub, never to the machines Threads run on. A browser's Hub
 * is the page's server, so nothing is saved; the desktop app either is the Hub (its local
 * environment) or, with that turned off, saves the one Hub it signs in to.
 */
export function savedConnectionSlots(): 0 | 1 {
  if (typeof window === "undefined" || window.desktopBridge === undefined) return 0;
  return isLocalEnvironmentDisabled() ? 1 : 0;
}

export const SINGLE_HUB_REFUSAL =
  "This app connects to one Hub only. Remove the Hub it uses, or turn off this computer's local environment, first.";

interface SavedTarget {
  readonly _tag: string;
  readonly environmentId: EnvironmentId;
  readonly connectionId?: string;
}

interface SavedProfile {
  readonly _tag: string;
  readonly connectionId: string;
  readonly httpBaseUrl?: string;
}

/** Whether the server at `httpBaseUrl` answers as the Hub `environmentId` (a joined machine doesn't). */
export type HubProbe = (httpBaseUrl: string, environmentId: EnvironmentId) => Promise<boolean>;

export const probeHubDescriptor: HubProbe = async (httpBaseUrl, environmentId) => {
  try {
    const response = await fetch(new URL("/.well-known/t3/environment", httpBaseUrl), {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const descriptor = (await response.json()) as { readonly environmentId?: unknown };
    return descriptor.environmentId === environmentId;
  } catch {
    return false;
  }
};

/**
 * The saved connections this app connects, at most `slots`: the first saved Hub whose descriptor
 * answers for it, else the first one reached over a bearer route, else the first saved. The rest
 * stay saved, never deleted: switching to them is the User's choice.
 */
export async function chooseSavedHub<T extends SavedTarget>(input: {
  readonly targets: ReadonlyArray<T>;
  readonly profiles: ReadonlyArray<SavedProfile>;
  readonly slots: 0 | 1;
  readonly probe: HubProbe;
}): Promise<ReadonlyArray<T>> {
  if (input.slots === 0 || input.targets.length === 0) return [];
  if (input.targets.length === 1) return input.targets;
  const bearer = input.targets.filter((target) => target._tag === "BearerConnectionTarget");
  for (const target of bearer) {
    const profile = input.profiles.find((entry) => entry.connectionId === target.connectionId);
    if (profile?.httpBaseUrl === undefined) continue;
    if (await input.probe(profile.httpBaseUrl, target.environmentId)) return [target];
  }
  return [bearer[0] ?? input.targets[0]!];
}

// What the last read left unconnected, for the one-time notice in Settings → Environments.
let kept: { readonly count: number; readonly connected: EnvironmentId | null } = {
  count: 0,
  connected: null,
};
const listeners = new Set<() => void>();

export function recordSavedConnections(input: {
  readonly saved: number;
  readonly connected: EnvironmentId | null;
}) {
  const next = {
    count: input.saved - (input.connected === null ? 0 : 1),
    connected: input.connected,
  };
  if (next.count === kept.count && next.connected === kept.connected) return;
  kept = next;
  for (const listener of listeners) listener();
}

/** The saved Hub this app connects, if any: the only saved connection a new one may replace. */
export function connectedSavedHub(): EnvironmentId | null {
  return kept.connected;
}

export function forgetConnectedSavedHub(environmentId: EnvironmentId) {
  if (kept.connected !== environmentId) return;
  kept = { count: kept.count, connected: null };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** How many saved connections this app keeps but no longer connects. */
export function useKeptSavedConnectionCount(): number {
  return useSyncExternalStore(
    subscribe,
    () => kept.count,
    () => kept.count,
  );
}
