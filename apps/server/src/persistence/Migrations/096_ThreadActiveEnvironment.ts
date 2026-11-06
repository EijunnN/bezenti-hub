import { HUB_MACHINE_ENVIRONMENT_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The Environment each Thread runs on, beside its payload's `activeEnvironmentId`, so the effect
// worker and the Environments view can ask by Environment. Existing Threads ran on the Hub machine.
// A Project's preferred Environment is where its new Threads start when the User picks none.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN active_environment_id TEXT`;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET active_environment_id = ${HUB_MACHINE_ENVIRONMENT_ID}
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_active_environment_idx
    ON orchestration_v2_projection_threads(active_environment_id)
  `;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN preferred_environment_id TEXT`;
});
