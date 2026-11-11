import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A machine the Hub installed over SSH (spec 3 ticket 10): where it reached it and the host key the
// Owner confirmed, which every later run to that address must match, and whether its key is kept
// in the secret store («keep for updates»). The key itself is never here.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE environment_ssh_hosts (
      environment_id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT NOT NULL,
      host_key_algorithm TEXT NOT NULL,
      host_key_fingerprint TEXT NOT NULL,
      key_kept INTEGER NOT NULL DEFAULT 0,
      installed_at TEXT NOT NULL,
      installed_by TEXT
    )
  `;
  yield* sql`CREATE INDEX environment_ssh_hosts_address ON environment_ssh_hosts (host, port)`;
});
