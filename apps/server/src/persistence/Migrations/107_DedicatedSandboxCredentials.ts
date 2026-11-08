import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A dedicated Sandbox connects with its own credential, issued to its host for one Space (hash
// only) and dropped when the machine's mode or Space changes. The one a reissue replaces stays
// valid until the new one is used or `previous_expires_at`, so a lost answer breaks nothing.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE dedicated_sandbox_credentials (
      environment_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      credential_hash TEXT NOT NULL UNIQUE,
      previous_credential_hash TEXT UNIQUE,
      previous_expires_at TEXT,
      issued_at TEXT NOT NULL
    )
  `;
});
