import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Sliding sessions move expires_at forward on use; the rest keep the lifetime they were issued with.
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN sliding INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN user_id TEXT REFERENCES users(user_id)`;

  // Before the Owner existed only the machine's operator could pair, and that person is the Owner.
  yield* sql`
    UPDATE auth_sessions
    SET user_id = (SELECT user_id FROM users WHERE is_owner = 1)
    WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE is_owner = 1)
  `;

  // Every session belongs to a User once the Installation has an Owner.
  yield* sql`
    CREATE TRIGGER auth_sessions_require_user_insert
    BEFORE INSERT ON auth_sessions
    WHEN NEW.user_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE is_owner = 1)
    BEGIN SELECT RAISE(ABORT, 'auth session without a user once an Owner exists'); END
  `;
  yield* sql`
    CREATE TRIGGER auth_sessions_require_user_update
    BEFORE UPDATE OF user_id ON auth_sessions
    WHEN NEW.user_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE is_owner = 1)
    BEGIN SELECT RAISE(ABORT, 'auth session without a user once an Owner exists'); END
  `;
});
