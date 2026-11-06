import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  EnvironmentId,
  EventId,
  HUB_MACHINE_ENVIRONMENT_ID,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectCheckouts from "../../environment/ProjectCheckouts.ts";
import {
  decodeWorkspaceLocationJson,
  type WorkspaceLocation,
} from "../../environment/WorkspaceLocation.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../Migrations.ts";

const at = "2026-10-01T00:00:00.000Z";
const ROOT = "/srv/web";
const LAPTOP = EnvironmentId.make("environment:laptop");
const PROJECT = ProjectId.make("project-web");

const thread = (id: string, worktreePath: string | null, projectId: string = PROJECT) => ({
  id,
  projectId,
  title: id,
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  branch: null,
  worktreePath,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  deletedAt: null,
});

const scope = (id: string, threadId: string, cwd: string) => ({
  id,
  threadId,
  runId: `run:${id}`,
  nodeId: `node:${id}`,
  parentScopeId: null,
  providerThreadId: null,
  kind: "root_run",
  ordinalWithinParent: 0,
  advancesAppRunCount: true,
  cwd,
  createdAt: at,
});

const inCheckout = (path: string): WorkspaceLocation => ({ base: "checkout", path });
const onHubMachine = (path: string): WorkspaceLocation => ({
  base: "host",
  environmentId: HUB_MACHINE_ENVIRONMENT_ID,
  path,
});

const layer = it.layer(
  Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  ),
);

layer("095_ProjectCheckouts", (it) => {
  it.effect(
    "records worktrees and scope cwds relative to the checkout, keeping outside ones absolute",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 94 });
        yield* sql`
          INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES (${PROJECT}, 'web', ${ROOT}, '[]', ${at}, ${at})
        `;
        const threads = [
          thread("nested", `${ROOT}/packages/app`),
          thread("root", ROOT),
          thread("worktree", "/home/ana/.t3/worktrees/web/feature"),
          thread("sibling", `${ROOT}-old/app`),
          thread("dotted", `${ROOT}/../etc`),
          thread("local", null),
          thread("orphan", "/tmp/orphan", "project-gone"),
        ];
        for (const fixture of threads) {
          yield* sql`
            INSERT INTO orchestration_v2_projection_threads (
              thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
              created_at, updated_at, payload_json
            ) VALUES (
              ${fixture.id}, ${fixture.projectId}, ${fixture.title}, 'codex', 'full-access',
              'default', ${at}, ${at}, ${JSON.stringify(fixture)}
            )
          `;
        }
        for (const fixture of [
          scope("scope-nested", "nested", `${ROOT}/packages/app`),
          scope("scope-worktree", "worktree", "/home/ana/.t3/worktrees/web/feature"),
          scope("scope-unknown-thread", "missing", `${ROOT}/x`),
        ]) {
          yield* sql`
            INSERT INTO orchestration_v2_projection_checkpoint_scopes (
              scope_id, thread_id, run_id, node_id, parent_scope_id, provider_thread_id, kind,
              ordinal_within_parent, advances_app_run_count, created_at, payload_json
            ) VALUES (
              ${fixture.id}, ${fixture.threadId}, ${fixture.runId}, ${fixture.nodeId}, NULL, NULL,
              'root_run', 0, 1, ${at}, ${JSON.stringify(fixture)}
            )
          `;
        }

        assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 95 }), [
          [95, "ProjectCheckouts"],
        ]);

        const decode = (json: string | null) =>
          json === null ? null : decodeWorkspaceLocationJson(json);
        const threadRows = yield* sql<{
          readonly id: string;
          readonly location: string | null;
          readonly payload: string;
        }>`
          SELECT thread_id AS id, worktree_location_json AS location, payload_json AS payload
          FROM orchestration_v2_projection_threads
        `;
        const locations = new Map(threadRows.map((row) => [row.id, decode(row.location)]));
        assert.deepEqual(Object.fromEntries(locations), {
          nested: inCheckout("packages/app"),
          root: inCheckout("."),
          worktree: onHubMachine("/home/ana/.t3/worktrees/web/feature"),
          sibling: onHubMachine(`${ROOT}-old/app`),
          dotted: onHubMachine(`${ROOT}/../etc`),
          local: null,
          orphan: onHubMachine("/tmp/orphan"),
        });
        // The recorded path itself is untouched: the Hub machine reads it as before.
        const nested = threadRows.find((row) => row.id === "nested");
        assert.equal(JSON.parse(nested?.payload ?? "{}").worktreePath, `${ROOT}/packages/app`);

        const scopeRows = yield* sql<{ readonly id: string; readonly location: string | null }>`
          SELECT scope_id AS id, cwd_location_json AS location
          FROM orchestration_v2_projection_checkpoint_scopes
        `;
        assert.deepEqual(
          Object.fromEntries(scopeRows.map((row) => [row.id, decode(row.location)])),
          {
            "scope-nested": inCheckout("packages/app"),
            "scope-worktree": onHubMachine("/home/ana/.t3/worktrees/web/feature"),
            "scope-unknown-thread": onHubMachine(`${ROOT}/x`),
          },
        );

        // Today's projection writes record the same forms the migration produced.
        yield* runMigrations();
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("fresh");
        yield* store.apply({
          id: EventId.make("event:fresh:created"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            id: threadId,
            projectId: PROJECT,
            title: "fresh",
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdBy: "user",
            creationSource: "web",
            branch: null,
            worktreePath: `${ROOT}/docs`,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        yield* store.apply({
          id: EventId.make("event:fresh:scope"),
          type: "checkpoint-scope.created",
          threadId,
          occurredAt: now,
          payload: {
            id: CheckpointScopeId.make("scope-fresh"),
            threadId,
            runId: RunId.make("run:fresh"),
            nodeId: NodeId.make("node:fresh"),
            parentScopeId: null,
            providerThreadId: null,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: "/elsewhere",
            createdAt: now,
          },
        });
        const [fresh] = yield* sql<{ readonly location: string | null }>`
          SELECT worktree_location_json AS location FROM orchestration_v2_projection_threads
          WHERE thread_id = 'fresh'
        `;
        assert.deepEqual(decode(fresh?.location ?? null), inCheckout("docs"));
        const [freshScope] = yield* sql<{ readonly location: string | null }>`
          SELECT cwd_location_json AS location FROM orchestration_v2_projection_checkpoint_scopes
          WHERE scope_id = 'scope-fresh'
        `;
        assert.deepEqual(decode(freshScope?.location ?? null), onHubMachine("/elsewhere"));
      }),
  );

  it.effect("an Environment keeps a chosen checkout; the Hub machine's stays its root", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const checkouts = yield* ProjectCheckouts.ProjectCheckouts;
      const key = { environmentId: LAPTOP, projectId: PROJECT };
      assert.isTrue(Option.isNone(yield* checkouts.chosen(key)));
      yield* checkouts.choose({ ...key, checkoutPath: "/home/ana/src/web" });
      yield* checkouts.choose({ ...key, checkoutPath: "/home/ana/src/web-2" });
      assert.deepEqual(yield* checkouts.chosen(key), Option.some("/home/ana/src/web-2"));
      const refused = yield* Effect.flip(
        checkouts.choose({
          environmentId: HUB_MACHINE_ENVIRONMENT_ID,
          projectId: PROJECT,
          checkoutPath: "/elsewhere",
        }),
      );
      assert.equal(refused._tag, "ProjectCheckoutsError");
    }),
  );
});
