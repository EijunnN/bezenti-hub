import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The Installation's default Sandbox limits, one row the Owner changes in Settings. A Space's own
// values stay in `sandboxes` (null there: this default). Null here: no limit.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE sandbox_limit_defaults (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cpu_limit REAL CHECK (cpu_limit IS NULL OR cpu_limit > 0),
      memory_limit_bytes INTEGER CHECK (memory_limit_bytes IS NULL OR memory_limit_bytes > 0),
      pids_limit INTEGER CHECK (pids_limit IS NULL OR pids_limit > 0),
      disk_limit_bytes INTEGER CHECK (disk_limit_bytes IS NULL OR disk_limit_bytes > 0),
      updated_at TEXT NOT NULL
    )
  `;
  // 2 CPUs, 4 GiB of memory, 4096 processes and threads, 20 GiB of disk.
  yield* sql`
    INSERT INTO sandbox_limit_defaults (
      id, cpu_limit, memory_limit_bytes, pids_limit, disk_limit_bytes, updated_at
    ) VALUES (1, 2, ${4 * 1024 ** 3}, 4096, ${20 * 1024 ** 3}, '1970-01-01T00:00:00.000Z')
  `;
});
