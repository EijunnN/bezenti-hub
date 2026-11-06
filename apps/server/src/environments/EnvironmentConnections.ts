import type { EnvironmentCloseReason, EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

interface Live {
  readonly close: (reason: EnvironmentCloseReason) => Effect.Effect<void>;
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
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly close: (
      environmentId: EnvironmentId,
      reason: EnvironmentCloseReason,
    ) => Effect.Effect<void>;
    readonly isConnected: (environmentId: EnvironmentId) => Effect.Effect<boolean>;
  }
>()("t3/environments/EnvironmentConnections") {}

export const layer = Layer.sync(EnvironmentConnections, () => {
  const live = new Map<EnvironmentId, Live>();

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
            const entry: Live = { close: closeLive };
            live.set(environmentId, entry);
            return entry;
          }),
        ),
      ),
      (entry) =>
        Effect.sync(() => {
          if (live.get(environmentId) === entry) live.delete(environmentId);
        }),
    ).pipe(Effect.asVoid);

  return EnvironmentConnections.of({
    attach,
    close,
    isConnected: Effect.fn("EnvironmentConnections.isConnected")(function* (environmentId) {
      return yield* Effect.sync(() => live.has(environmentId));
    }),
  });
});
