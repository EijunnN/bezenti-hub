import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A moved Thread's handoff as soon as it is written (`ThreadMoveService`, step `handoff`), so a
// restart before the switch reuses it instead of paying for the summary again. The Thread's
// shell only carries a preview; the switch copies the whole of it into the timeline item.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_move_handoffs (
      move_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_move_handoffs_thread_idx
    ON orchestration_v2_move_handoffs(thread_id)
  `;
});
