import {
  type ActiveEnvironmentView,
  activeEnvironmentOf,
  fetchRemoteHubEnvironments,
  makeHubEnvironmentsPoller,
} from "@t3tools/client-runtime/environment/hub-environments";
import type { EnvironmentId, HubEnvironmentList, HubEnvironmentSummary } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

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

// One list for every view that shows where Threads run, read while any of them is mounted.
const poller = makeHubEnvironmentsPoller({ fetch: fetchHubEnvironments });

/** The Hub's Environments the signed-in User may see, the Hub machine first; kept fresh. */
export function useHubEnvironments(): ReadonlyArray<HubEnvironmentSummary> {
  return useSyncExternalStore(poller.subscribe, poller.snapshot, poller.snapshot);
}

/** One Thread's Active environment, live; re-renders only when its name or status changes. */
export function useActiveEnvironment(
  environmentId: EnvironmentId | null | undefined,
): ActiveEnvironmentView | null {
  const read = () => JSON.stringify(activeEnvironmentOf(poller.snapshot(), environmentId));
  const key = useSyncExternalStore(poller.subscribe, read, read);
  return JSON.parse(key) as ActiveEnvironmentView | null;
}

/** Whether the User sees more machines than the Hub machine, so a Thread's machine is news. */
export function useHasJoinedEnvironments(): boolean {
  const read = () => poller.snapshot().length > 1;
  return useSyncExternalStore(poller.subscribe, read, read);
}

/** The last list, for building a menu; empty until a view mounted it. */
export function readHubEnvironments(): ReadonlyArray<HubEnvironmentSummary> {
  return poller.snapshot();
}
