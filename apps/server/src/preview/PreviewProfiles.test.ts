import { SpaceId, UserId, WS_METHODS } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { guardRpcPayload } from "../auth/RpcSpaceAccess.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  type Server,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import * as PreviewProfiles from "./PreviewProfiles.ts";

/** The Owner, with Acme (an Admin, a Member and a Guest) and Globex (a Member). */
const hub = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
  const owner = created.cookie ?? "";
  const ownerId = UserId.make((created.body.user as { id: string }).id);
  const organization = Effect.fn(function* (name: string) {
    const made = yield* server.request("/api/spaces/organizations", {
      body: { name },
      cookie: owner,
    });
    return SpaceId.make(made.body.id as string);
  });
  const acme = yield* organization("Acme");
  const globex = yield* organization("Globex");
  const others = [
    { id: UserId.make("admin-acme"), space: acme, role: "admin" },
    { id: UserId.make("member-acme"), space: acme, role: "member" },
    { id: UserId.make("guest-acme"), space: acme, role: "guest" },
    { id: UserId.make("member-globex"), space: globex, role: "member" },
  ] as const;
  for (const other of others) {
    yield* addMember(server, { id: other.id, displayName: other.id });
    yield* joinOrganization(server, other.space, other.id, other.role);
  }
  const spaces = Context.get(server.services, SpaceDirectory.SpaceDirectory);
  yield* spaces.changed;
  const profiles = yield* PreviewProfiles.PreviewProfiles.pipe(
    Effect.provide(
      PreviewProfiles.layer.pipe(Layer.provide(Layer.succeedContext(server.services))),
    ),
  );
  return {
    server,
    ownerId,
    acme,
    globex,
    others,
    spaces,
    profiles,
  };
});

const insertThread = (
  server: Server,
  thread: {
    readonly id: string;
    readonly owner: string | null;
    readonly space: string | null;
    readonly root?: string;
  },
) =>
  server.sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json, owner_user_id, space_id
    ) VALUES (
      ${thread.id}, 'no-project', ${thread.id}, 'codex', 'full-access', 'default',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      ${JSON.stringify({ lineage: { rootThreadId: thread.root ?? thread.id } })},
      ${thread.owner}, ${thread.space}
    )
  `;

it.effect(
  "each Thread's profiles are its own User's in its own Space: Owner, Admin, Member and Guest, here or elsewhere",
  () =>
    Effect.gen(function* () {
      const { server, ownerId, acme, globex, others, profiles } = yield* hub;
      yield* insertThread(server, { id: "owner-in-acme", owner: ownerId, space: acme });
      yield* insertThread(server, { id: "owner-in-globex", owner: ownerId, space: globex });
      for (const other of others) {
        yield* insertThread(server, {
          id: `${other.id}-thread`,
          owner: other.id,
          space: other.space,
        });
      }
      // A child the server made has no owner of its own: its root's.
      yield* insertThread(server, {
        id: "member-acme-child",
        owner: null,
        space: acme,
        root: "member-acme-thread",
      });
      const ownerOf = (threadId: string) =>
        profiles.ownerOfThread(threadId).pipe(Effect.map(Option.getOrNull));

      assert.deepStrictEqual(yield* ownerOf("owner-in-acme"), { userId: ownerId, spaceId: acme });
      assert.deepStrictEqual(yield* ownerOf("owner-in-globex"), {
        userId: ownerId,
        spaceId: globex,
      });
      for (const other of others) {
        assert.deepStrictEqual(yield* ownerOf(`${other.id}-thread`), {
          userId: other.id,
          spaceId: other.space,
        });
      }
      assert.deepStrictEqual(yield* ownerOf("member-acme-child"), {
        userId: "member-acme",
        spaceId: acme,
      });
      // A draft (no row) is nobody's yet: its tabs get a throwaway profile.
      assert.isNull(yield* ownerOf("a-draft"));

      // Folders: per User, per Space, per profile, never the same for two of them.
      const places = [
        profiles.place({ userId: ownerId, spaceId: acme }, "default"),
        profiles.place({ userId: ownerId, spaceId: globex }, "default"),
        profiles.place({ userId: "member-acme", spaceId: acme }, "default"),
        profiles.place({ userId: "member-acme", spaceId: acme }, "work"),
      ];
      const paths = places.map((place) =>
        [place.userFolder, place.spaceFolder, place.profileFolder].join("/"),
      );
      assert.strictEqual(new Set(paths).size, paths.length);
      for (const path of paths) {
        assert.match(path, /^[0-9a-f]{32}\/[0-9a-f]{32}\/[0-9a-f]{32}$/);
        assert.notInclude(path, "member");
      }
    }).pipe(Effect.scoped),
);

it.effect(
  "a User keeps profiles only in Spaces they still see: leaving one or being removed ends them there",
  () =>
    Effect.gen(function* () {
      const { server, ownerId, acme, globex, spaces, profiles } = yield* hub;
      const changes = yield* profiles.accessChanges;
      const heard = yield* changes.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
      const keeps = (userId: string, spaceId: string) => profiles.keeps({ userId, spaceId });

      // The Owner keeps them everywhere; everyone else in the Spaces they see.
      assert.isTrue(yield* keeps(ownerId, acme));
      assert.isTrue(yield* keeps(ownerId, globex));
      for (const userId of ["admin-acme", "member-acme", "guest-acme"]) {
        assert.isTrue(yield* keeps(userId, acme), userId);
        assert.isFalse(yield* keeps(userId, globex), userId);
      }
      assert.isTrue(yield* keeps("member-globex", globex));
      assert.isFalse(yield* keeps("member-globex", acme));

      // The Member leaves Acme: their profiles there go, and they are told to the browser.
      yield* spaces.removeMembership({ spaceId: acme, userId: UserId.make("member-acme") });
      yield* spaces.membershipsChanged([UserId.make("member-acme")]);
      assert.deepStrictEqual([...(yield* Fiber.join(heard))], ["member-acme"]);
      assert.isFalse(yield* keeps("member-acme", acme));
      assert.isTrue(yield* keeps("admin-acme", acme));

      // A disabled User may come back: theirs stay. A removed one's go.
      yield* server.sql`UPDATE users SET disabled_at = '2026-01-02T00:00:00.000Z' WHERE user_id = 'guest-acme'`;
      yield* spaces.changed;
      assert.isTrue(yield* keeps("guest-acme", acme));
      yield* server.sql`UPDATE users SET removed_at = '2026-01-02T00:00:00.000Z' WHERE user_id = 'admin-acme'`;
      yield* spaces.changed;
      assert.isFalse(yield* keeps("admin-acme", acme));
    }).pipe(Effect.scoped),
);

it.effect(
  "clearing every User's profiles is the Owner's alone: not an Admin, Member or Guest of any Space",
  () =>
    Effect.gen(function* () {
      const { server, ownerId, others } = yield* hub;
      const visibility = Context.get(server.services, SpaceVisibility.SpaceVisibility);
      const clearAll = (userId: UserId) =>
        Effect.gen(function* () {
          const seen = yield* visibility.of(userId);
          return yield* guardRpcPayload(
            WS_METHODS.previewClearAllProfiles,
            undefined,
            seen,
            visibility,
            userId,
          ).pipe(Effect.result);
        });
      assert.strictEqual((yield* clearAll(ownerId))._tag, "Success");
      for (const other of others) {
        const refused = yield* clearAll(other.id);
        assert.strictEqual(refused._tag, "Failure", other.id);
      }
      // Each clears their own instead: a call with no Thread to place, for every Role.
      for (const userId of [ownerId, ...others.map((other) => other.id)]) {
        const seen = yield* visibility.of(userId);
        const own = yield* guardRpcPayload(
          WS_METHODS.previewClearProfile,
          { profileId: "default" },
          seen,
          visibility,
          userId,
        ).pipe(Effect.result);
        assert.strictEqual(own._tag, "Success", userId);
      }
    }).pipe(Effect.scoped),
);

it.effect("profiles of no User (before there was an Owner) are not kept once an Owner exists", () =>
  Effect.gen(function* () {
    const { acme, profiles } = yield* hub;
    assert.isFalse(yield* profiles.keeps({ userId: "", spaceId: acme }));
  }).pipe(Effect.scoped),
);
