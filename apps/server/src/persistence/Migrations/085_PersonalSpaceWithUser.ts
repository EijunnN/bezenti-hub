import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Every User has a Personal space from the moment the row exists, whichever path creates it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT OR IGNORE INTO spaces (space_id, kind, name, personal_owner_user_id, created_at)
    SELECT 'personal:' || user_id, 'personal', 'Personal', user_id, created_at FROM users
  `;
  yield* sql`
    CREATE TRIGGER users_personal_space AFTER INSERT ON users
    BEGIN
      INSERT OR IGNORE INTO spaces (space_id, kind, name, personal_owner_user_id, created_at)
      VALUES ('personal:' || NEW.user_id, 'personal', 'Personal', NEW.user_id, NEW.created_at);
    END
  `;
});
