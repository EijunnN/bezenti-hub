import { HUB_MACHINE_ENVIRONMENT_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The machines registered with this Hub, the Hub machine seeded here. A removed machine keeps its
// row, revoked, so its credential answers "revoked" rather than "unknown".
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE environments (
      environment_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('hub', 'external')),
      mode TEXT NOT NULL DEFAULT 'personal' CHECK (mode IN ('personal')),
      owner_user_id TEXT,
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
        (kind = 'hub' AND owner_user_id IS NULL AND credential_hash IS NULL)
        OR (kind = 'external' AND owner_user_id IS NOT NULL AND credential_hash IS NOT NULL
          AND credential_issued_at IS NOT NULL)
      )
    )
  `;
  yield* sql`CREATE UNIQUE INDEX environments_one_hub ON environments(kind) WHERE kind = 'hub'`;
  yield* sql`CREATE INDEX environments_owner_idx ON environments(owner_user_id)`;
  // The Hub machine's id is a constant, the same on every Hub.
  yield* sql`
    INSERT INTO environments (environment_id, name, kind, registered_at)
    VALUES (${HUB_MACHINE_ENVIRONMENT_ID}, 'Hub machine', 'hub', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `;
});
