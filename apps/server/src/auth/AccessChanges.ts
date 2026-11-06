import type { UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Tells whoever caches what a User may do that it changed, and closes that User's connections.
 * SpaceDirectory provides it; account code reaches it without depending on Spaces.
 */
export class AccessChanges extends Context.Service<
  AccessChanges,
  {
    /** After a write that changed what these Users may do commits. */
    readonly changed: (userIds: ReadonlyArray<UserId>) => Effect.Effect<void>;
    /** After a write that only widened what they may do: caches refresh, connections stay. */
    readonly widened: Effect.Effect<void>;
  }
>()("t3/auth/AccessChanges") {}
