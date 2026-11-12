import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// AI accounts (spec 4 ticket 02) and who each is allowed to. A credential is never a column: it
// is a sealed entry of `secrets/ai-accounts/`; `key_hint` keeps at most its last four characters.
// A Thread's account goes in its model selection JSON (`modelSelection.aiAccountId`).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE ai_accounts (
      account_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('subscription', 'api-key', 'direct')),
      provider TEXT NOT NULL,
      priority INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      status_message TEXT,
      disabled INTEGER NOT NULL DEFAULT 0,
      -- The store entry holding the credential; a replace writes a new one.
      credential_id TEXT,
      key_hint TEXT,
      -- openai-compatible: where it answers and the models it serves (a JSON array of names).
      base_url TEXT,
      models_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT
    )
  `;
  yield* sql`CREATE UNIQUE INDEX ai_accounts_name_idx ON ai_accounts (name COLLATE NOCASE)`;
  yield* sql`CREATE INDEX ai_accounts_priority_idx ON ai_accounts (priority)`;

  // Space ids and User ids are not foreign keys: a deleted Space or removed User leaves rows
  // AllowedAiAccounts never matches (the policy refuses them), removed with their owner later.
  yield* sql`
    CREATE TABLE ai_account_allowances (
      account_id TEXT NOT NULL REFERENCES ai_accounts(account_id) ON DELETE CASCADE,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('space', 'user')),
      subject_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (account_id, subject_kind, subject_id)
    )
  `;
  yield* sql`
    CREATE INDEX ai_account_allowances_subject_idx
    ON ai_account_allowances (subject_kind, subject_id)
  `;
});
