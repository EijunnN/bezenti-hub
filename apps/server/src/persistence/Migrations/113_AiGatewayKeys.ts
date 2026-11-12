import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Gateway keys (spec 4 ticket 04): what an agent or a local CLI sends to `/api/ai/*`. Only the
// SHA-256 of a key is kept, never the key. A Thread key names its Thread; a User key does not.
// Each request is checked again (AiGatewayKeys.authorize): revoking here is not the only guard.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE ai_gateway_keys (
      key_id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('thread', 'user')),
      user_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      thread_id TEXT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      last_used_at TEXT,
      revoked_at TEXT,
      revoked_reason TEXT,
      CHECK ((kind = 'thread') = (thread_id IS NOT NULL))
    )
  `;
  yield* sql`CREATE INDEX ai_gateway_keys_thread_idx ON ai_gateway_keys (thread_id)`;
  yield* sql`CREATE INDEX ai_gateway_keys_user_idx ON ai_gateway_keys (user_id)`;
  // The AI account a Thread's requests last went to (after a failover too), for its header.
  yield* sql`
    CREATE TABLE ai_gateway_thread_accounts (
      thread_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      model TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
