import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A dedicated Sandbox connects with its own credential, issued to its host for one Space (hash
// only) and dropped when the machine's mode or Space changes. The last one used stays valid until
// a newer one is first used, so an answer lost on its way to the host breaks nothing.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE dedicated_sandbox_credentials (
      environment_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      credential_hash TEXT NOT NULL UNIQUE,
      previous_credential_hash TEXT UNIQUE,
      issued_at TEXT NOT NULL
    )
  `;
});
