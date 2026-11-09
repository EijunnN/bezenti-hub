/**
 * Who a command acts for. Transports set it from the session (the WS RPC middleware, the HTTP
 * mutate route); an MCP call acts as its credential's User. Nothing a client sends sets it.
 * Only the server's own work (effect worker, reactors, scheduled runs) has no actor at all.
 */
import type { SpaceId, UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

/**
 * Where an actor's request came from, for the audit log: the Hub's shell (`t3 ...`), or an agent
 * (an MCP tool call) acting as its User. Never changes what the actor may do.
 */
export type ActorVia = "cli" | "agent";

/** The subject of a session the Hub's shell issues for its own requests to a running server. */
export const SHELL_SESSION_SUBJECT = "t3-shell";

export type Actor =
  /** The server's own work, or the shell's (`via: "cli"`) when it runs the services itself. */
  | { readonly _tag: "Server"; readonly via?: "cli" }
  | {
      readonly _tag: "User";
      readonly userId: UserId;
      readonly via?: ActorVia;
      /** An agent on a machine bound to one Space acts only there (`McpInvocationScope`). */
      readonly spaceLimit?: SpaceId;
    }
  /** An agent in a Thread from before owners were recorded, which is the Owner's. */
  | { readonly _tag: "ThreadOwner"; readonly spaceLimit?: SpaceId }
  /** A request whose session names no User, which only works before an Owner exists. */
  | { readonly _tag: "NoUser" };

const SERVER: Actor = { _tag: "Server" };

const CommandActor = Context.Reference<Actor>("t3/auth/CommandActor", {
  defaultValue: () => SERVER,
});

/** Who the current fiber acts for: its transport's User, else its MCP caller's. */
export const resolve: Effect.Effect<Actor> = Effect.gen(function* () {
  const explicit = yield* CommandActor;
  if (explicit._tag !== "Server" || explicit.via !== undefined) return explicit;
  const mcp = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
  if (Option.isNone(mcp)) return SERVER;
  const { userId, thread, spaceLimit } = mcp.value;
  const limit = spaceLimit === undefined ? {} : { spaceLimit };
  if (userId !== undefined) return { _tag: "User", userId, via: "agent", ...limit };
  return thread !== undefined ? { _tag: "ThreadOwner", ...limit } : { _tag: "NoUser" };
});

/** The one Space the current actor may act in, when its credential is bound to one. */
export const spaceLimit: Effect.Effect<SpaceId | undefined> = Effect.map(resolve, (actor) =>
  actor._tag === "User" || actor._tag === "ThreadOwner" ? actor.spaceLimit : undefined,
);

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
    actor._tag === "Server" && actor.via === undefined
      ? effect
      : Effect.provideService(effect, CommandActor, actor);

/** Runs `effect` for an HTTP session; a session the Hub's shell issued acts `via: "cli"`. */
export const actAsSession =
  (session: { readonly userId?: UserId; readonly subject: string }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    session.subject !== SHELL_SESSION_SUBJECT
      ? actAs(session.userId)(effect)
      : actAsResolved(
          session.userId === undefined
            ? { _tag: "Server", via: "cli" }
            : { _tag: "User", userId: session.userId, via: "cli" },
        )(effect);
