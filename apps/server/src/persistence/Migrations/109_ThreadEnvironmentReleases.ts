import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A Thread a Project move released from a machine, written in the commit that released it and
// deleted once that machine is cut off (sessions detached, MCP revoked, streams ended), so a
// failure in between is finished on the next move, or as the Hub starts.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE thread_environment_releases (
      thread_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      provider_session_ids_json TEXT NOT NULL,
      released_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, environment_id)
    )
  `;
});
