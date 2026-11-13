import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// AI usage (spec 4 ticket 05): one row per request through the AI gateway layer and a daily
// summary per (day, User, Space, AI account, model). Tokens only: never a prompt, an answer or a
// key. The per-request rows are swept after 90 days; the summaries stay. NULL tokens: unknown.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE ai_usage (
      usage_id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      day TEXT NOT NULL,
      user_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      thread_id TEXT,
      key_id TEXT NOT NULL,
      account_id TEXT,
      provider TEXT,
      model TEXT,
      shape TEXT NOT NULL,
      status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      failovers INTEGER NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER
    )
  `;
  yield* sql`CREATE INDEX ai_usage_at_idx ON ai_usage (at)`;
  yield* sql`CREATE INDEX ai_usage_thread_idx ON ai_usage (thread_id, at)`;
  yield* sql`
    CREATE TABLE ai_usage_daily (
      day TEXT NOT NULL,
      user_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      -- '' when a request reached no account or named no model.
      account_id TEXT NOT NULL,
      model TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      failed_requests INTEGER NOT NULL DEFAULT 0,
      unknown_requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, user_id, space_id, account_id, model)
    )
  `;
  yield* sql`CREATE INDEX ai_usage_daily_user_idx ON ai_usage_daily (user_id, day)`;
  yield* sql`CREATE INDEX ai_usage_daily_space_idx ON ai_usage_daily (space_id, day)`;
});
