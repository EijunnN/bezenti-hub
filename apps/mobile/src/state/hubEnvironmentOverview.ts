// @effect-diagnostics globalTimers:off - The poll runs in React subscriptions, outside an Effect runtime.
import { fetchRemoteHubEnvironmentOverview } from "@t3tools/client-runtime/environment/hub-environments";
import type { HubEnvironmentOverviewEntry } from "@t3tools/contracts";
import { useCallback, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import type { SavedRemoteConnection } from "../lib/connection";
import { runtime } from "../lib/runtime";

/** Status changes on heartbeats; the list follows them while it is on screen. */
const OVERVIEW_REFRESH_MS = 5000;

interface OverviewSnapshot {
  /** Null until the first answer. */
  readonly environments: ReadonlyArray<HubEnvironmentOverviewEntry> | null;
  /** Whether the last read failed (the last list stays). */
  readonly failed: boolean;
}

export interface HubEnvironmentOverviewState extends OverviewSnapshot {
  readonly refresh: () => void;
}

const EMPTY: OverviewSnapshot = { environments: null, failed: false };

type OverviewConnection = Pick<SavedRemoteConnection, "httpBaseUrl" | "bearerToken">;

// One read loop for the Owner's list, while it is on screen and the app is in the foreground. The
// session it reads with: another Hub or User must never see the previous list.
let session: string | null = null;
let readWith: { readonly httpBaseUrl: string; readonly bearerToken: string } | null = null;
let snapshot: OverviewSnapshot = EMPTY;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};
const stop = () => {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
};
const schedule = () => {
  stop();
  if (listeners.size > 0 && AppState.currentState === "active") {
    timer = setTimeout(read, OVERVIEW_REFRESH_MS);
  }
};

function read() {
  stop();
  if (readWith === null) return;
  const started = generation;
  void runtime.runPromise(fetchRemoteHubEnvironmentOverview(readWith)).then(
    (overview) => {
      if (started !== generation) return;
      snapshot = { environments: overview.environments, failed: false };
      notify();
      schedule();
    },
    () => {
      if (started !== generation) return;
      snapshot = { ...snapshot, failed: true };
      notify();
      schedule();
    },
  );
}

AppState.addEventListener("change", (state) => {
  if (state !== "active") stop();
  else if (listeners.size > 0) read();
});

const sessionOf = (connection: OverviewConnection | null) =>
  connection === null || connection.bearerToken === null
    ? null
    : `${connection.httpBaseUrl}\n${connection.bearerToken}`;

/**
 * Every machine on the Hub, from the Owner-only overview, while `connection` is set (only the
 * Owner's screen passes one) and a view is subscribed.
 */
export function useHubEnvironmentOverview(
  connection: OverviewConnection | null,
): HubEnvironmentOverviewState {
  const key = sessionOf(connection);
  const httpBaseUrl = connection?.httpBaseUrl ?? null;
  const bearerToken = connection?.bearerToken ?? null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (key !== session) {
        session = key;
        generation += 1;
        snapshot = EMPTY;
        readWith =
          httpBaseUrl === null || bearerToken === null ? null : { httpBaseUrl, bearerToken };
      }
      listeners.add(listener);
      if (listeners.size === 1) read();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    [key, httpBaseUrl, bearerToken],
  );
  const current = useSyncExternalStore(
    subscribe,
    () => (key === session ? snapshot : EMPTY),
    () => EMPTY,
  );
  return { ...current, refresh: read };
}
