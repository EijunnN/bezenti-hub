import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Set when an archived Organization's permanent deletion starts; it is never restored after.
  yield* sql`ALTER TABLE spaces ADD COLUMN deleting_at TEXT`;
});
