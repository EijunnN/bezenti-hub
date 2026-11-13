import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Spec 5 ticket 05: the Vault values (ids and names, never values) a root Thread's processes
// received, so a value rotated since stays masked as `[NAME]` for the Thread's life. Vaults keeps
// those values sealed while a row holds them; its start drops the rows of gone Threads. The masker
// reads a User's own Threads and a root's children: both indexed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE thread_secret_values (
      thread_id TEXT NOT NULL,
      value_id TEXT NOT NULL,
      name TEXT NOT NULL,
      remembered_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, value_id)
    )
  `;
  yield* sql`CREATE INDEX thread_secret_values_value_idx ON thread_secret_values (value_id)`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_owner_idx
    ON orchestration_v2_projection_threads (owner_user_id, deleted_at)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_root_idx
    ON orchestration_v2_projection_threads (json_extract(payload_json, '$.lineage.rootThreadId'))
  `;
});
