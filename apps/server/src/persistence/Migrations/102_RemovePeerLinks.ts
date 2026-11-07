import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Peer Links are gone (spec 3): the Hub is the only way servers talk to each other. Their
// credentials are revoked before their rows go.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Received links that started work here, by that work's origin; `SessionStore` revokes other
  // link-marked tokens. Pre-fence links carry no durable mark (outside agents may share their
  // `T3 Code · …` name), so they lapse within 30 days, unused: linkers had to relink them.
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

  // Tasks delegated over a link that have no result yet: nothing will report one now. Ending
  // one must wake its parent, which takes the orchestrator, so `RetiredRemoteTasks` settles
  // them at startup.
  yield* sql`
    CREATE TABLE retired_remote_tasks (
      task_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO retired_remote_tasks (task_id, thread_id)
    SELECT subagent_id, thread_id FROM orchestration_v2_projection_subagents
    WHERE origin = 'app_owned'
      AND child_thread_id IS NULL
      AND json_type(payload_json, '$.remoteChild') = 'object'
      AND json_type(payload_json, '$.result') IS 'null'
  `;

  // The cards in which agents asked the user to link a machine, their positions in the
  // timeline, and the index that found them.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_waiting_link_idx`;
  yield* sql`
    DELETE FROM orchestration_v2_turn_item_positions
    WHERE EXISTS (
      SELECT 1 FROM orchestration_v2_projection_turn_items item
      WHERE item.thread_id = orchestration_v2_turn_item_positions.thread_id
        AND item.turn_item_id = orchestration_v2_turn_item_positions.turn_item_id
        AND item.type = 'link_request'
    )
  `;
  yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE type = 'link_request'`;

  // What linked work carried: its origin, and the remote parent or child of a delegated task.
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_remove(payload_json, '$.linkOrigin', '$.delegatedFrom')
    WHERE json_type(payload_json, '$.linkOrigin') IS NOT NULL
      OR json_type(payload_json, '$.delegatedFrom') IS NOT NULL
  `;
});
