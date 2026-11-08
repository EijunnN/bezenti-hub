import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Each Space's own Sandbox limits move out of `sandboxes` into a table of their own, so a Space
// whose only Sandbox is a dedicated machine (no `sandboxes` row) has them too. Null: the
// Installation's default (`sandbox_limit_defaults`). No foreign key to `spaces`: deleting a Space
// deletes its row with its Sandbox.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE space_sandbox_limits (
      space_id TEXT PRIMARY KEY,
      cpu_limit REAL CHECK (cpu_limit IS NULL OR cpu_limit > 0),
      memory_limit_bytes INTEGER CHECK (memory_limit_bytes IS NULL OR memory_limit_bytes > 0),
      pids_limit INTEGER CHECK (pids_limit IS NULL OR pids_limit > 0),
      disk_limit_bytes INTEGER CHECK (disk_limit_bytes IS NULL OR disk_limit_bytes > 0),
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO space_sandbox_limits (
      space_id, cpu_limit, memory_limit_bytes, pids_limit, disk_limit_bytes, updated_at
    )
    SELECT space_id, cpu_limit, memory_limit_bytes, pids_limit, disk_limit_bytes, updated_at
    FROM sandboxes
    WHERE cpu_limit IS NOT NULL OR memory_limit_bytes IS NOT NULL OR pids_limit IS NOT NULL
      OR disk_limit_bytes IS NOT NULL
  `;
  yield* sql`ALTER TABLE sandboxes DROP COLUMN cpu_limit`;
  yield* sql`ALTER TABLE sandboxes DROP COLUMN memory_limit_bytes`;
  yield* sql`ALTER TABLE sandboxes DROP COLUMN pids_limit`;
  yield* sql`ALTER TABLE sandboxes DROP COLUMN disk_limit_bytes`;
});
