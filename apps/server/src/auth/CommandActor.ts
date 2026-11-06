/**
 * Who a command acts for. Transports set it from the session (the WS RPC middleware, the HTTP
 * mutate route); an MCP call acts as its credential's User. Nothing a client sends sets it.
 * Only the server's own work (effect worker, reactors, scheduled runs) has no actor at all.
 */
import type { UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

export type Actor =
  /** The server's own work. */
  | { readonly _tag: "Server" }
  | { readonly _tag: "User"; readonly userId: UserId }
  /** An agent in a Thread from before owners were recorded, which is the Owner's. */
  | { readonly _tag: "ThreadOwner" }
  /** A request whose session names no User, which only works before an Owner exists. */
  | { readonly _tag: "NoUser" };

const SERVER: Actor = { _tag: "Server" };

const CommandActor = Context.Reference<Actor>("t3/auth/CommandActor", {
  defaultValue: () => SERVER,
});

/** Who the current fiber acts for: its transport's User, else its MCP caller's. */
export const resolve: Effect.Effect<Actor> = Effect.gen(function* () {
  const explicit = yield* CommandActor;
  if (explicit._tag !== "Server") return explicit;
  const mcp = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
  if (Option.isNone(mcp)) return SERVER;
  const { userId, thread } = mcp.value;
  if (userId !== undefined) return { _tag: "User", userId };
  return thread !== undefined ? { _tag: "ThreadOwner" } : { _tag: "NoUser" };
});

/** The acting User, for stamping receipts and new Threads; undefined when none is named. */
export const current: Effect.Effect<UserId | undefined> = Effect.map(resolve, (actor) =>
  actor._tag === "User" ? actor.userId : undefined,
);

/** Runs `effect` for a request's session: as its User, or as a request with none. */
export const actAs =
  (userId: UserId | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(
      effect,
      CommandActor,
      userId === undefined ? { _tag: "NoUser" } : { _tag: "User", userId },
    );

/** Runs `effect` as `actor`, as a queue's worker does for the request that queued it. */
export const actAsResolved =
  (actor: Actor) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    actor._tag === "Server" ? effect : Effect.provideService(effect, CommandActor, actor);
