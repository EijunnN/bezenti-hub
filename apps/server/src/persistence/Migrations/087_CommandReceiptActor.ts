import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The User a command acted for, stamped by the server; NULL for its own work and older rows.
  yield* sql`ALTER TABLE orchestration_command_receipts ADD COLUMN actor_user_id TEXT`;
});
