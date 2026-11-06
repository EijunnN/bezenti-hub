import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Whether each checkpoint's ref is in the Hub repository, beside its payload's `uploadedToHub`, so
// the uploader finds what is left to upload. Checkpoints from before stay NULL: never uploaded.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE orchestration_v2_projection_checkpoints ADD COLUMN uploaded_to_hub INTEGER`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_checkpoints_upload_pending_idx
    ON orchestration_v2_projection_checkpoints(thread_id)
    WHERE status = 'ready' AND uploaded_to_hub = 0
  `;
});
