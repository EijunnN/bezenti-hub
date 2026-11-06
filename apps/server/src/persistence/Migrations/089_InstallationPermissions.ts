import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A row is a grant; revoking deletes it. The Owner holds every permission without rows.
  yield* sql`
    CREATE TABLE installation_permissions (
      user_id TEXT NOT NULL REFERENCES users(user_id),
      permission TEXT NOT NULL CHECK (permission IN ('personalSpace.create', 'environments.registerOwn')),
      granted_by TEXT NOT NULL REFERENCES users(user_id),
      granted_at TEXT NOT NULL,
      PRIMARY KEY (user_id, permission)
    )
  `;
});
