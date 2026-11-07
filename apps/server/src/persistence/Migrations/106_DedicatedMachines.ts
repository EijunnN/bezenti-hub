import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A machine dedicated to a Space belongs to the Installation, not to a User: it has no owner (the
// Owner who dedicated it is in the audit log), so turning a User off never takes it. SQLite cannot
// change a CHECK, so `environments` is rebuilt; dedicated rows lose their owner.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE environments_new (
      environment_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('hub', 'external', 'sandbox')),
      mode TEXT NOT NULL DEFAULT 'personal' CHECK (mode IN ('personal', 'dedicated', 'sandbox')),
      owner_user_id TEXT,
      space_id TEXT,
      credential_hash TEXT UNIQUE,
      credential_issued_at TEXT,
      credential_issued_by TEXT,
      registered_at TEXT NOT NULL,
      last_seen_at TEXT,
      last_os TEXT,
      last_hostname TEXT,
      last_protocol_version INTEGER,
      last_resources_json TEXT,
      last_providers_json TEXT,
      revoked_at TEXT,
      CHECK (
        (kind = 'hub' AND mode = 'personal' AND owner_user_id IS NULL AND space_id IS NULL
          AND credential_hash IS NULL)
        OR (kind = 'external' AND credential_hash IS NOT NULL AND credential_issued_at IS NOT NULL
          AND ((mode = 'personal' AND owner_user_id IS NOT NULL AND space_id IS NULL)
            OR (mode = 'dedicated' AND owner_user_id IS NULL AND space_id IS NOT NULL)))
        OR (kind = 'sandbox' AND mode = 'sandbox' AND owner_user_id IS NULL
          AND space_id IS NOT NULL AND credential_hash IS NOT NULL
          AND credential_issued_at IS NOT NULL)
      )
    )
  `;
  yield* sql`
    INSERT INTO environments_new (
      environment_id, name, kind, mode, owner_user_id, space_id, credential_hash,
      credential_issued_at, credential_issued_by, registered_at, last_seen_at, last_os,
      last_hostname, last_protocol_version, last_resources_json, last_providers_json, revoked_at
    )
    SELECT environment_id, name, kind, mode,
      CASE WHEN mode = 'dedicated' THEN NULL ELSE owner_user_id END,
      space_id, credential_hash, credential_issued_at, credential_issued_by, registered_at,
      last_seen_at, last_os, last_hostname, last_protocol_version, last_resources_json,
      last_providers_json, revoked_at
    FROM environments
  `;
  yield* sql`DROP TABLE environments`;
  yield* sql`ALTER TABLE environments_new RENAME TO environments`;
  yield* sql`CREATE UNIQUE INDEX environments_one_hub ON environments(kind) WHERE kind = 'hub'`;
  yield* sql`CREATE INDEX environments_owner_idx ON environments(owner_user_id)`;
  yield* sql`CREATE INDEX environments_space_idx ON environments(space_id)`;
});
