import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE user_passwords (
      user_id TEXT PRIMARY KEY REFERENCES users(user_id),
      password_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // The secret is sealed with a key from the server's secret store, never stored in clear.
  yield* sql`
    CREATE TABLE user_totp (
      user_id TEXT PRIMARY KEY REFERENCES users(user_id),
      secret_ciphertext TEXT NOT NULL,
      enrolled_at TEXT NOT NULL,
      last_used_step INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE user_reset_links (
      link_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id),
      token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT REFERENCES users(user_id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    )
  `;
  yield* sql`CREATE INDEX user_reset_links_user_idx ON user_reset_links(user_id)`;
});
