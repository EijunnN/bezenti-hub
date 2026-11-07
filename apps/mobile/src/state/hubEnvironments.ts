import {
  type ActiveEnvironmentView,
  type HubEnvironmentsStatus,
  activeEnvironmentOf,
  fetchRemoteHubEnvironments,
  makeHubEnvironmentsPoller,
} from "@t3tools/client-runtime/environment/hub-environments";
import type { EnvironmentId, HubEnvironmentList, HubEnvironmentSummary } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "./atom-registry";
import { hubConnectionAtom } from "./use-remote-environment-registry";

// The session the last list was read with; another Hub or User must not see the previous list.
let readWith: string | null = null;

async function fetchHubEnvironments(): Promise<HubEnvironmentList> {
  const connection = appAtomRegistry.get(hubConnectionAtom);
  const session =
    connection === null || connection.bearerToken === null
      ? null
      : `${connection.httpBaseUrl}\n${connection.bearerToken}`;
  if (session !== readWith) {
    readWith = session;
    poller.reset();
  }
  if (connection === null || connection.bearerToken === null) {
    throw new Error("No Hub session.");
  }
  return runtime.runPromise(
    fetchRemoteHubEnvironments({
      httpBaseUrl: connection.httpBaseUrl,
      bearerToken: connection.bearerToken,
    }),
  );
}

// One poll for every view that shows where Threads run, only while one is mounted and the app is
// in the foreground; slow while the Hub machine is alone.
const poller = makeHubEnvironmentsPoller({ fetch: fetchHubEnvironments });
AppState.addEventListener("change", (state) => poller.setActive(state === "active"));

// Each Thread row asks for its machine: one view per machine and list, computed once.
let viewsOf: ReadonlyArray<HubEnvironmentSummary> | null = null;
const views = new Map<string, ActiveEnvironmentView | null>();
function activeEnvironmentView(
  environmentId: EnvironmentId | null | undefined,
): ActiveEnvironmentView | null {
  const list = poller.snapshot();
  if (viewsOf !== list) {
    viewsOf = list;
    // A view whose name and status did not change stays the same object, so its row stays put.
    for (const [key, previous] of views) {
      const next = activeEnvironmentOf(
        list,
        key === "undefined" ? undefined : key === "null" ? null : (key as EnvironmentId),
      );
      views.set(key, JSON.stringify(next) === JSON.stringify(previous) ? previous : next);
    }
  }
  const key = String(environmentId);
  if (!views.has(key)) views.set(key, activeEnvironmentOf(list, environmentId));
  return views.get(key) ?? null;
}

/** The Hub's Environments the signed-in User may see, the Hub machine first; kept fresh. */
export function useHubEnvironments(): ReadonlyArray<HubEnvironmentSummary> {
  return useSyncExternalStore(poller.subscribe, poller.snapshot, poller.snapshot);
}

/** Whether the list was read yet, and whether the last read failed. */
export function useHubEnvironmentsStatus(): HubEnvironmentsStatus {
  return useSyncExternalStore(poller.subscribe, poller.status, poller.status);
}

/** Reads the list again now, as «Try again» asks. */
export function refreshHubEnvironments(): void {
  poller.refresh();
}

/** One Thread's Active environment, live; the same object until its machine's list changes. */
export function useActiveEnvironment(
  environmentId: EnvironmentId | null | undefined,
): ActiveEnvironmentView | null {
  const read = () => activeEnvironmentView(environmentId);
  return useSyncExternalStore(poller.subscribe, read, read);
}

/** How many Environments the User sees, the Hub machine included. */
export function useHubEnvironmentCount(): number {
  const read = () => poller.snapshot().length;
  return useSyncExternalStore(poller.subscribe, read, read);
}

/** Whether the User sees more machines than the Hub machine, so a Thread's machine is news. */
export function useHasJoinedEnvironments(): boolean {
  const read = () => poller.snapshot().length > 1;
  return useSyncExternalStore(poller.subscribe, read, read);
}
