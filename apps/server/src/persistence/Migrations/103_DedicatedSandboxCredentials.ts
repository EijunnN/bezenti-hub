import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A dedicated machine's Sandbox connects with a credential of its own, never the machine's: the
// Hub issues it to the host for one Space (only its hash here) and drops it when the machine's
// mode or Space changes, so a copy taken inside the container reaches nothing afterwards.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE dedicated_sandbox_credentials (
      environment_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      credential_hash TEXT NOT NULL UNIQUE,
      issued_at TEXT NOT NULL
    )
  `;
});
