import { assert, it } from "@effect/vitest";
import {
  CommandId,
  GuestShareId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as CommandActor from "../auth/CommandActor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

// Thread commands are decided by the orchestrator and committed by the event sink; their entry
// commits in the same transaction as the events.

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "audited-thread-commands" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const grace = UserId.make("user:grace");

const entries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly action: string;
    readonly actorUserId: string | null;
    readonly targetId: string;
    readonly targetName: string | null;
  }>`
    SELECT action, actor_user_id AS "actorUserId", target_id AS "targetId",
      target_name AS "targetName"
    FROM audit_log ORDER BY audit_id
  `;
});

it.effect("a guest link and a permanent delete each record one entry as the acting User", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const create = (id: string, title: string) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create-${id}`),
        threadId: ThreadId.make(id),
        projectId: ProjectId.make("project:audited"),
        title,
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    yield* create("thread:shared", "Review me");
    yield* create("thread:draft", "Draft");
    const open = orchestrator.dispatch({
      type: "thread.guest-share.open",
      commandId: CommandId.make("open-share"),
      threadId: ThreadId.make("thread:shared"),
      shareId: GuestShareId.make("share:one"),
      host: "env.t3.test",
      expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 24 })),
    });
    const remove = orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-shared"),
      threadId: ThreadId.make("thread:shared"),
    });
    yield* open.pipe(CommandActor.actAs(grace));
    yield* remove.pipe(CommandActor.actAs(grace));
    // A replayed command commits nothing new and records nothing new.
    yield* remove.pipe(CommandActor.actAs(grace));
    // Discarding an unused draft is not a deletion anyone answers for.
    yield* orchestrator
      .dispatch({
        type: "thread.delete",
        commandId: CommandId.make("discard-draft"),
        threadId: ThreadId.make("thread:draft"),
        onlyIfUnused: true,
      })
      .pipe(CommandActor.actAs(grace));

    assert.deepEqual(yield* entries, [
      {
        action: "guestLink.create",
        actorUserId: grace,
        targetId: "thread:shared",
        targetName: "Review me",
      },
      {
        action: "thread.delete",
        actorUserId: grace,
        targetId: "thread:shared",
        targetName: "Review me",
      },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "an agent is named as the User it acts for, and a session naming no User records nothing once an Owner exists",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const create = (id: string) =>
        orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${id}`),
          threadId: ThreadId.make(id),
          projectId: ProjectId.make("project:audited"),
          title: id,
          modelSelection: { instanceId, model: "gpt-5.1-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      const remove = (id: string) =>
        orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`delete-${id}`),
          threadId: ThreadId.make(id),
        });
      for (const id of ["by-agent", "by-old-agent", "before-owner", "no-user"]) yield* create(id);
      // Before an Owner exists a session names nobody, and the server is recorded.
      yield* remove("before-owner").pipe(CommandActor.actAs(undefined));
      yield* sql`
      INSERT INTO users (user_id, display_name, is_owner, created_at)
      VALUES ('user:owner', 'Ada', 1, '2026-01-01T00:00:00.000Z')
    `;
      yield* remove("by-agent").pipe(
        CommandActor.actAsResolved({ _tag: "User", userId: grace, via: "agent" }),
      );
      // A Thread's agent from before owners were recorded acts as the Owner.
      yield* remove("by-old-agent").pipe(CommandActor.actAsResolved({ _tag: "ThreadOwner" }));
      const refused = yield* remove("no-user").pipe(CommandActor.actAs(undefined), Effect.exit);
      assert.isTrue(refused._tag === "Failure");

      const rows = yield* sql<{
        readonly source: string;
        readonly actorUserId: string | null;
        readonly targetId: string;
      }>`
      SELECT actor_source AS source, actor_user_id AS "actorUserId", target_id AS "targetId"
      FROM audit_log ORDER BY audit_id
    `;
      assert.deepEqual(rows, [
        { source: "system", actorUserId: null, targetId: "before-owner" },
        { source: "agent", actorUserId: grace, targetId: "by-agent" },
        { source: "agent", actorUserId: "user:owner", targetId: "by-old-agent" },
      ]);
      const [kept] = yield* sql<{ readonly deletedAt: string | null }>`
      SELECT deleted_at AS "deletedAt" FROM orchestration_v2_projection_threads
      WHERE thread_id = 'no-user'
    `;
      assert.isNull(kept?.deletedAt);
    }).pipe(Effect.provide(layerTest)),
);
