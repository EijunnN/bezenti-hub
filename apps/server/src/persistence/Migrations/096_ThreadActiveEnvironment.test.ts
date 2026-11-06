import { assert, it } from "@effect/vitest";
import { HUB_MACHINE_ENVIRONMENT_ID } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const at = "2026-10-01T00:00:00.000Z";

it.effect("existing Threads run on the Hub machine; Projects prefer none", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 95 });
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project-web', 'web', '/srv/web', '[]', ${at}, ${at})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES ('thread-old', 'project-web', 'Old', 'codex', 'full-access', 'default', ${at}, ${at}, '{}')
    `;

    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 96 }), [
      [96, "ThreadActiveEnvironment"],
    ]);
    const threads = yield* sql<{ readonly environmentId: string | null }>`
      SELECT active_environment_id AS "environmentId" FROM orchestration_v2_projection_threads
    `;
    assert.deepEqual(threads, [{ environmentId: HUB_MACHINE_ENVIRONMENT_ID }]);
    const projects = yield* sql<{ readonly environmentId: string | null }>`
      SELECT preferred_environment_id AS "environmentId" FROM projection_projects
    `;
    assert.deepEqual(projects, [{ environmentId: null }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
