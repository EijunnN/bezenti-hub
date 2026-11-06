import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The event sequence when the User last lost a Membership. A client resuming its shell from
  // before then gets a fresh snapshot, so it drops what it may no longer see.
  yield* sql`ALTER TABLE users ADD COLUMN access_narrowed_through INTEGER`;
});
