/**
 * The User a command acts for. Transports set it from the session (the WS RPC middleware, the
 * HTTP mutate route); an MCP call acts as its credential's User. Nothing a client sends sets it.
 * None is the server's own work and the Owner's in-process callers, which the policy never stops.
 */
import type { UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

const CommandActor = Context.Reference<UserId | undefined>("t3/auth/CommandActor", {
  defaultValue: () => undefined,
});

/** The actor of the current fiber: the one set by its transport, else its MCP caller's User. */
export const current: Effect.Effect<UserId | undefined> = Effect.gen(function* () {
  const explicit = yield* CommandActor;
  if (explicit !== undefined) return explicit;
  const mcp = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
  return Option.isSome(mcp) ? mcp.value.userId : undefined;
});

/** Runs `effect` as `userId`; undefined leaves it as the server's own work. */
export const actAs =
  (userId: UserId | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    userId === undefined ? effect : Effect.provideService(effect, CommandActor, userId);
