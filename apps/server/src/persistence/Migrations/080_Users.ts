import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      login_name TEXT UNIQUE,
      is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
      created_at TEXT NOT NULL,
      disabled_at TEXT,
      removed_at TEXT
    )
  `;

  // An Installation has exactly one Owner.
  yield* sql`CREATE UNIQUE INDEX users_single_owner_idx ON users(is_owner) WHERE is_owner = 1`;

  yield* sql`
    CREATE TABLE user_passkeys (
      credential_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id),
      public_key TEXT NOT NULL,
      sign_count INTEGER NOT NULL,
      transports TEXT NOT NULL,
      rp_id TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    )
  `;
  yield* sql`CREATE INDEX user_passkeys_user_idx ON user_passkeys(user_id)`;

  yield* sql`
    CREATE TABLE user_recovery_codes (
      code_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL,
      used_at TEXT
    )
  `;
  yield* sql`CREATE INDEX user_recovery_codes_user_idx ON user_recovery_codes(user_id)`;
});
