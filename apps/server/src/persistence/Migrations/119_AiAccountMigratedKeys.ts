import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Spec 4 ticket 09: which provider-instance key («env:<instance>:<VARIABLE>» or
// «field:<instance>:<field>») the Hub's start already moved into which AI account, so running it
// again never makes a second account. Names only: never the key, nor a hash of it. No foreign key:
// the row outlives an account the Owner deletes, so a leftover is removed, not moved again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE ai_account_migrated_keys (
      source TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      migrated_at TEXT NOT NULL
    )
  `;
});
