import { makeKeptSavedConnections } from "@t3tools/client-runtime/connection/single-hub";
import { useSyncExternalStore } from "react";

/**
 * Mobile connects only to its Hub and sees every Thread there, whichever machine runs it. Saved
 * connections from before (several Hubs, or servers paired with a code) stay saved on the phone,
 * unconnected; this counts them for the one-time notice under Settings → Environments.
 */
export const keptSavedConnections = makeKeptSavedConnections();

export const SINGLE_HUB_REFUSAL =
  "This app connects to one Hub only. Remove the Hub it uses under Settings → Environments first.";

/** How many saved connections the phone keeps but no longer connects. */
export function useKeptSavedConnectionCount(): number {
  return useSyncExternalStore(
    keptSavedConnections.subscribe,
    keptSavedConnections.count,
    keptSavedConnections.count,
  );
}
