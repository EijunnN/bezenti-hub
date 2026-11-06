import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The User a task speaks as. NULL for tasks from before Users, which run as the server.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN owner_user_id TEXT`;
});
