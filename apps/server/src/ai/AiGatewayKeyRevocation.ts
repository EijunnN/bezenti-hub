/**
 * Gateway keys revoked when what they were for ends: a Thread archived or deleted, a provider
 * session stopped or detached, a User disabled or removed or no longer working in a key's Space.
 * Each request is checked anyway (AiGatewayKeys.authorize); this keeps the record true.
 */
import type { OrchestrationV2DomainEvent, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import * as AiGatewayKeys from "./AiGatewayKeys.ts";

/** What one event or status change ends; exported for tests that feed their own streams. */
export const revokeFor = Effect.fn("AiGatewayKeyRevocation.revokeFor")(function* (
  change:
    | { readonly _tag: "event"; readonly event: OrchestrationV2DomainEvent }
    | { readonly _tag: "user"; readonly userId: UserId; readonly active: boolean }
    | { readonly _tag: "memberships"; readonly userId: UserId },
) {
  const keys = yield* AiGatewayKeys.AiGatewayKeys;
  const activity = yield* AiGatewayActivity.AiGatewayActivity;
  if (change._tag === "user") {
    if (!change.active) yield* keys.revokeUser(change.userId, "user-inactive");
    return;
  }
  if (change._tag === "memberships") {
    yield* keys.revokeLostSpaces(change.userId);
    return;
  }
  const { event } = change;
  if (event.type === "provider-session.updated") {
    // A session that stopped (or failed) takes its keys with it.
    if (event.payload.status === "stopped" || event.payload.status === "error") {
      yield* keys.revokeSession(event.payload.id, "session-closed");
    }
  } else if (event.type === "provider-session.detached") {
    yield* keys.revokeSession(event.payload.providerSessionId, "session-detached", event.threadId);
  } else if (event.type === "thread.archived") {
    yield* keys.revokeThread(event.threadId, "thread-archived");
  } else if (event.type === "thread.deleted") {
    yield* keys.revokeThread(event.threadId, "thread-deleted");
    yield* activity.forgetThread(event.threadId);
  }
});

const logged = Effect.catchCause((cause) =>
  Effect.logWarning("Could not revoke AI gateway keys", { cause }),
);

/** A User disabled or removed, or whose Memberships changed: what their keys may still reach. */
export const layerUserChanges = Layer.effectDiscard(
  Effect.gen(function* () {
    const spaces = yield* SpaceDirectory.SpaceDirectory;
    const context = yield* Effect.context<
      AiGatewayKeys.AiGatewayKeys | AiGatewayActivity.AiGatewayActivity
    >();
    // Subscribed before this layer is up, so no change made after it is missed.
    const statuses = yield* spaces.subscribeUserStatusChanges;
    const memberships = yield* spaces.subscribeMembershipChanges;
    yield* statuses.pipe(
      Stream.runForEach((change) =>
        revokeFor({ _tag: "user", userId: change.userId, active: change.active }).pipe(
          Effect.provide(context),
          logged,
        ),
      ),
      Effect.forkScoped,
    );
    yield* memberships.pipe(
      Stream.runForEach((userId) =>
        revokeFor({ _tag: "memberships", userId }).pipe(Effect.provide(context), logged),
      ),
      Effect.forkScoped,
    );
  }),
);

const layerDomainEvents = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const context = yield* Effect.context<
      AiGatewayKeys.AiGatewayKeys | AiGatewayActivity.AiGatewayActivity
    >();
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "thread.archived" ||
          event.type === "thread.deleted" ||
          event.type === "provider-session.updated" ||
          event.type === "provider-session.detached",
      ),
      Stream.runForEach((event) =>
        revokeFor({ _tag: "event", event }).pipe(Effect.provide(context), logged),
      ),
      logged,
      Effect.forkScoped,
    );
  }),
);

export const layer = Layer.mergeAll(layerUserChanges, layerDomainEvents);
