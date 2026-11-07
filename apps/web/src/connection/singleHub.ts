import { makeKeptSavedConnections } from "@t3tools/client-runtime/connection/single-hub";
import type { EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { isLocalEnvironmentDisabled } from "../localEnvironment";

export { chooseSavedHub, probeHubDescriptor } from "@t3tools/client-runtime/connection/single-hub";

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

// What the last read left unconnected, for the one-time notice in Settings → Environments.
const kept = makeKeptSavedConnections();

export const recordSavedConnections = kept.record;

/** The saved Hub this app connects, if any: the only saved connection a new one may replace. */
export function connectedSavedHub(): EnvironmentId | null {
  return kept.connected();
}

export const forgetConnectedSavedHub = kept.forget;

/** How many saved connections this app keeps but no longer connects. */
export function useKeptSavedConnectionCount(): number {
  return useSyncExternalStore(kept.subscribe, kept.count, kept.count);
}
