import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE auth_sessions ADD COLUMN user_id TEXT REFERENCES users(user_id)`;
  yield* sql`CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id) WHERE user_id IS NOT NULL`;
});
