import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Peer Links are gone (spec 3): the Hub is the only way servers talk to each other. Their
// credentials are revoked before their rows go.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Received links: the sessions other servers signed in to this one's `/mcp` with. Those that
  // started work here are named by that work's origin; `SessionStore` refuses the rest, whose
  // tokens carry the link marker.
  yield* sql`
    UPDATE auth_sessions
    SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE revoked_at IS NULL
      AND session_id IN (
        SELECT json_extract(payload_json, '$.linkOrigin.sessionId')
        FROM orchestration_v2_projection_threads
        WHERE json_type(payload_json, '$.linkOrigin.sessionId') = 'text'
      )
  `;

  // Made links: their tokens live in the server secret store, which SQL cannot reach. Their
  // names wait here until `RetiredSecrets` removes them at startup.
  yield* sql`
    CREATE TABLE retired_server_secrets (
      secret_name TEXT PRIMARY KEY
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO retired_server_secrets (secret_name)
    SELECT secret_name FROM peer_environment_links
  `;
  yield* sql`DROP TABLE peer_environment_links`;

  // The cards in which agents asked the user to link a machine, and the index that found them.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_waiting_link_idx`;
  yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE type = 'link_request'`;

  // What linked work carried: its origin, and the remote parent or child of a delegated task.
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_remove(payload_json, '$.linkOrigin', '$.delegatedFrom')
    WHERE json_type(payload_json, '$.linkOrigin') IS NOT NULL
      OR json_type(payload_json, '$.delegatedFrom') IS NOT NULL
  `;
});
