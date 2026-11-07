import type { EnvironmentCloseReason, EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

interface Live {
  readonly close: (reason: EnvironmentCloseReason) => Effect.Effect<void>;
  /** Welcomed, with its hello recorded and its executor serving. */
  ready: boolean;
}

/** One attached socket, as long as it is the Environment's current one. */
export interface AttachedConnection {
  /**
   * The socket was welcomed and its executor serves: work can be placed on it. Nothing when a
   * newer socket of the same Environment replaced this one meanwhile.
   */
  readonly markReady: Effect.Effect<void>;
}

/**
 * The open sockets of joined Environments, one per Environment. A second connection for the same
 * Environment replaces the first, so a machine that reconnects before the Hub noticed it left
 * never counts twice.
 */
export class EnvironmentConnections extends Context.Service<
  EnvironmentConnections,
  {
    /** Holds `close` for the Environment until the scope ends. */
    readonly attach: (
      environmentId: EnvironmentId,
      close: Live["close"],
    ) => Effect.Effect<AttachedConnection, never, Scope.Scope>;
    readonly close: (
      environmentId: EnvironmentId,
      reason: EnvironmentCloseReason,
    ) => Effect.Effect<void>;
    readonly isConnected: (environmentId: EnvironmentId) => Effect.Effect<boolean>;
    readonly isReady: (environmentId: EnvironmentId) => Effect.Effect<boolean>;
    /** Completes once the Environment's current socket is ready: at once when it already is. */
    readonly awaitReady: (environmentId: EnvironmentId) => Effect.Effect<void>;
  }
>()("t3/environments/EnvironmentConnections") {}

export const layer = Layer.sync(EnvironmentConnections, () => {
  const live = new Map<EnvironmentId, Live>();
  const waiting = new Map<EnvironmentId, Set<() => void>>();

  const close: EnvironmentConnections["Service"]["close"] = (environmentId, reason) =>
    Effect.suspend(() => {
      const current = live.get(environmentId);
      if (current === undefined) return Effect.void;
      live.delete(environmentId);
      return current.close(reason);
    });

  const attach: EnvironmentConnections["Service"]["attach"] = (environmentId, closeLive) =>
    Effect.acquireRelease(
      close(environmentId, "replaced").pipe(
        Effect.andThen(
          Effect.sync(() => {
            const entry: Live = { close: closeLive, ready: false };
            live.set(environmentId, entry);
            return entry;
          }),
        ),
      ),
      (entry) =>
        Effect.sync(() => {
          if (live.get(environmentId) === entry) live.delete(environmentId);
        }),
    ).pipe(
      Effect.map((entry): AttachedConnection => ({
        markReady: Effect.sync(() => {
          // A replaced socket's welcome says nothing about the one that replaced it.
          if (live.get(environmentId) !== entry) return;
          entry.ready = true;
          const waiters = waiting.get(environmentId);
          waiting.delete(environmentId);
          for (const wake of waiters ?? []) wake();
        }),
      })),
    );

  return EnvironmentConnections.of({
    attach,
    close,
    isConnected: Effect.fn("EnvironmentConnections.isConnected")(function* (environmentId) {
      return yield* Effect.sync(() => live.has(environmentId));
    }),
    isReady: Effect.fn("EnvironmentConnections.isReady")(function* (environmentId) {
      return yield* Effect.sync(() => live.get(environmentId)?.ready === true);
    }),
    awaitReady: Effect.fn("EnvironmentConnections.awaitReady")(function* (environmentId) {
      yield* Effect.callback<void>((resume) => {
        if (live.get(environmentId)?.ready === true) return resume(Effect.void);
        const wake = () => resume(Effect.void);
        const waiters = waiting.get(environmentId) ?? new Set();
        waiters.add(wake);
        waiting.set(environmentId, waiters);
        return Effect.sync(() => {
          waiters.delete(wake);
          if (waiters.size === 0 && waiting.get(environmentId) === waiters) {
            waiting.delete(environmentId);
          }
        });
      });
    }),
  });
});
