/**
 * Whose a preview browser profile is, for every door to the server browser (WS, preview-stream,
 * MCP, popups), in the Thread's Space: the User who opened the tab, or for an agent's tab the
 * Thread's effective owner (as `claimWork`). Folder names are keyed hashes: they neither collide
 * nor tell whose they are.
 */
// @effect-diagnostics nodeBuiltinImport:off - HMAC of folder names, synchronously.
import * as NodeCrypto from "node:crypto";

import { type ThreadId, type UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { effectiveOwner } from "../spaces/SpaceVisibility.ts";
import type { ProfilePlace } from "./ServerBrowserContexts.ts";

export interface ProfileOwner {
  readonly userId: string;
  readonly spaceId: string;
}

/** The profiles' User for a session or Thread with no User: an Installation before its Owner. */
const NO_USER = "";

/** The User whose profiles a caller acts on: their own, never anyone else's. */
export const profileUserOf = (userId: UserId | undefined): string => userId ?? NO_USER;

/** The key that names profile folders, in the Installation's secret store. */
const NAMES_SECRET = "preview-profile-names";

export class PreviewProfiles extends Context.Service<
  PreviewProfiles,
  {
    /**
     * Whose a Thread's tabs' profiles are. None for a draft or a Thread with no row: such a tab
     * gets a throwaway context of its own, never a persistent one.
     */
    readonly ownerOfThread: (threadId: string) => Effect.Effect<Option.Option<ProfileOwner>>;
    /**
     * Whose profile a tab of the Thread uses: `openedBy`'s, the person who opened it, in the
     * Thread's Space; with nobody, the Thread's owner's (an agent's tab). None as `ownerOfThread`.
     */
    readonly ownerFor: (
      threadId: string,
      openedBy: string | undefined,
    ) => Effect.Effect<Option.Option<ProfileOwner>>;
    /** Where `owner`'s profile `profileId` lives. */
    readonly place: (owner: ProfileOwner, profileId: string) => ProfilePlace;
    readonly userFolder: (userId: string) => string;
    readonly profileFolder: (profileId: string) => string;
    /**
     * Whether `owner` still keeps profiles in that Space: not removed, and still sees it. No User's
     * (before there was an Owner) are not kept once there is one.
     */
    readonly keeps: (owner: ProfileOwner) => Effect.Effect<boolean>;
    /** Subscribes now: each User whose Memberships or status changed, to re-check their profiles. */
    readonly accessChanges: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>;
  }
>()("t3/preview/PreviewProfiles") {}

/** Folder names from `key`: one keyed hash per level, so no two Users, Spaces or ids share one. */
export const folderNames = (key: Uint8Array) => {
  const name = (level: string, value: string) =>
    NodeCrypto.createHmac("sha256", key).update(`${level}\0${value}`).digest("hex").slice(0, 32);
  return {
    userFolder: (userId: string) => name("user", userId),
    spaceFolder: (spaceId: string) => name("space", spaceId),
    profileFolder: (profileId: string) => name("profile", profileId),
  };
};

export const make = (input: {
  readonly key: Uint8Array;
  readonly ownerOfThread: PreviewProfiles["Service"]["ownerOfThread"];
  readonly keeps: PreviewProfiles["Service"]["keeps"];
  readonly accessChanges: PreviewProfiles["Service"]["accessChanges"];
}) => {
  const names = folderNames(input.key);
  return PreviewProfiles.of({
    ownerOfThread: input.ownerOfThread,
    ownerFor: Effect.fn("PreviewProfiles.ownerFor")(function* (threadId, openedBy) {
      const owner = yield* input.ownerOfThread(threadId);
      return Option.map(owner, (found) =>
        openedBy === undefined ? found : { userId: openedBy, spaceId: found.spaceId },
      );
    }),
    place: (owner, profileId) => ({
      owner: { userId: owner.userId, spaceId: owner.spaceId },
      userFolder: names.userFolder(owner.userId),
      spaceFolder: names.spaceFolder(owner.spaceId),
      profileFolder: names.profileFolder(profileId),
    }),
    userFolder: names.userFolder,
    profileFolder: names.profileFolder,
    keeps: input.keeps,
    accessChanges: input.accessChanges,
  });
};

export const layer = Layer.effect(
  PreviewProfiles,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const spaces = yield* SpaceDirectory.SpaceDirectory;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const key = yield* secrets.getOrCreateRandom(NAMES_SECRET, 32).pipe(Effect.orDie);

    const ownerOfThread = Effect.fn("PreviewProfiles.ownerOfThread")(function* (threadId: string) {
      // The same owner `claimWork` reads: its own, else its root's, else the Owner's.
      const [row] = yield* sql<{ readonly userId: string }>`
        SELECT ${effectiveOwner(sql, "t")} AS "userId"
        FROM orchestration_v2_projection_threads t
        WHERE t.thread_id = ${threadId}
      `.pipe(Effect.orDie);
      if (row === undefined) return Option.none<ProfileOwner>();
      const space = yield* spaces
        .spaceOf({ kind: "thread", id: threadId as ThreadId })
        .pipe(Effect.orDie);
      return Option.map(space, (found) => ({ userId: row.userId, spaceId: found.id }));
    });

    const keeps = Effect.fn("PreviewProfiles.keeps")(
      function* (owner: ProfileOwner) {
        if (owner.userId === NO_USER) {
          const [found] = yield* sql<{ readonly one: number }>`
            SELECT 1 AS one FROM users WHERE is_owner = 1 LIMIT 1
          `;
          return found === undefined;
        }
        const userId = owner.userId as UserId;
        const user = yield* spaces.installationUser(userId);
        if (Option.isNone(user) || user.value.status === "removed") return false;
        // A disabled User may come back; what they had stays until then.
        if (user.value.status === "disabled") return true;
        const viewable = yield* spaces.viewableSpaces(userId);
        return viewable === "all" || viewable.includes(owner.spaceId as never);
      },
      Effect.orElseSucceed(() => true),
    );

    const accessChanges = Effect.gen(function* () {
      const memberships = yield* spaces.subscribeMembershipChanges;
      const statuses = yield* spaces.subscribeUserStatusChanges;
      return Stream.merge(
        memberships,
        statuses.pipe(Stream.map((change) => change.userId)),
      ) as Stream.Stream<string>;
    });

    return make({ key, ownerOfThread, keeps, accessChanges });
  }),
);
