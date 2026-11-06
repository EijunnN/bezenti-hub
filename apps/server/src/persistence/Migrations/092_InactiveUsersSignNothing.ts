import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A disabled or removed User gets no new session or pairing link, even from a sign-in that was
// already under way when the Owner turned them off.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TRIGGER auth_sessions_require_active_user
    BEFORE INSERT ON auth_sessions
    WHEN EXISTS (
      SELECT 1 FROM users
      WHERE user_id = NEW.user_id AND (disabled_at IS NOT NULL OR removed_at IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'auth session for a disabled or removed user'); END
  `;
  yield* sql`
    CREATE TRIGGER auth_pairing_links_require_active_user
    BEFORE INSERT ON auth_pairing_links
    WHEN EXISTS (
      SELECT 1 FROM users
      WHERE user_id = NEW.user_id AND (disabled_at IS NOT NULL OR removed_at IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'pairing link for a disabled or removed user'); END
  `;
});
