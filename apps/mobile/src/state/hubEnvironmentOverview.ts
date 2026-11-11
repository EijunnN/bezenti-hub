import {
  type HubEnvironmentsStatus,
  fetchRemoteHubEnvironmentOverview,
  makeHubEnvironmentsPoller,
} from "@t3tools/client-runtime/environment/hub-environments";
import type { HubEnvironmentOverview, HubEnvironmentOverviewEntry } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "./atom-registry";
import { hubConnectionAtom } from "./use-remote-environment-registry";

// The session the last overview was read with; another Hub or User must not see the previous one.
let readWith: string | null = null;

async function fetchOverview(): Promise<HubEnvironmentOverview> {
  const connection = appAtomRegistry.get(hubConnectionAtom);
  const session =
    connection === null || connection.bearerToken === null
      ? null
      : `${connection.httpBaseUrl}\n${connection.bearerToken}`;
  if (session !== readWith) {
    readWith = session;
    poller.reset();
  }
  // No session to read with: the list says it could not load, with «Try again».
  if (connection === null || connection.bearerToken === null) {
    throw new Error("No Hub session.");
  }
  return runtime.runPromise(
    fetchRemoteHubEnvironmentOverview({
      httpBaseUrl: connection.httpBaseUrl,
      bearerToken: connection.bearerToken,
    }),
  );
}

// The Owner-only overview, read by the same poll as the Hub's list (only the latest read's answer
// counts), only while the Owner's list is mounted and the app is in the foreground.
const poller = makeHubEnvironmentsPoller<HubEnvironmentOverviewEntry>({ fetch: fetchOverview });
AppState.addEventListener("change", (state) => poller.setActive(state === "active"));

/** Every machine on the Hub, for the Owner's list only; kept fresh while mounted. */
export function useHubEnvironmentOverview(): ReadonlyArray<HubEnvironmentOverviewEntry> {
  return useSyncExternalStore(poller.subscribe, poller.snapshot, poller.snapshot);
}

/** Whether the overview was read yet, and whether the last read failed. */
export function useHubEnvironmentOverviewStatus(): HubEnvironmentsStatus {
  return useSyncExternalStore(poller.subscribe, poller.status, poller.status);
}

/** Reads the overview again now, as «Try again» asks. */
export function refreshHubEnvironmentOverview(): void {
  poller.refresh();
}
