import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { hubMachineLocationJson } from "../../environment/WorkspaceLocation.ts";

// Each Environment's checkout of a Project, where it is not the default. The Hub machine has no
// rows: its checkout is the Project's workspace root. Recorded worktree and checkpoint-scope paths
// gain their logical form; one outside its Project's checkout stays absolute, bound to the Hub
// machine (`docs/internals/overview.md`, «Logical workspace paths»).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE environment_project_checkouts (
      environment_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      checkout_path TEXT NOT NULL,
      chosen_at TEXT NOT NULL,
      PRIMARY KEY (environment_id, project_id)
    )
  `;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN worktree_location_json TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_projection_checkpoint_scopes ADD COLUMN cwd_location_json TEXT`;

  const threads = yield* sql<{
    readonly threadId: string;
    readonly worktreePath: string;
    readonly checkout: string | null;
  }>`
    SELECT
      t.thread_id AS "threadId",
      json_extract(t.payload_json, '$.worktreePath') AS "worktreePath",
      p.workspace_root AS "checkout"
    FROM orchestration_v2_projection_threads t
    LEFT JOIN projection_projects p ON p.project_id = t.project_id
    WHERE json_type(t.payload_json, '$.worktreePath') = 'text'
  `;
  for (const row of threads) {
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET worktree_location_json = ${hubMachineLocationJson(row.checkout, row.worktreePath)}
      WHERE thread_id = ${row.threadId}
    `;
  }

  const scopes = yield* sql<{
    readonly scopeId: string;
    readonly cwd: string;
    readonly checkout: string | null;
  }>`
    SELECT
      s.scope_id AS "scopeId",
      json_extract(s.payload_json, '$.cwd') AS "cwd",
      p.workspace_root AS "checkout"
    FROM orchestration_v2_projection_checkpoint_scopes s
    LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = s.thread_id
    LEFT JOIN projection_projects p ON p.project_id = t.project_id
    WHERE json_type(s.payload_json, '$.cwd') = 'text'
  `;
  for (const row of scopes) {
    yield* sql`
      UPDATE orchestration_v2_projection_checkpoint_scopes
      SET cwd_location_json = ${hubMachineLocationJson(row.checkout, row.cwd)}
      WHERE scope_id = ${row.scopeId}
    `;
  }
});
