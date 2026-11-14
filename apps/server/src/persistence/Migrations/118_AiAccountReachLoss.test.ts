import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-01T00:00:00.000Z";

it.effect("drops the AI account rows a Hub before ticket 11 left naming a reach that is gone", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 117 });
    yield* sql`
      INSERT INTO users (user_id, display_name, is_owner, created_at) VALUES
        ('owner', 'Owner', 1, ${AT}), ('grace', 'grace', 0, ${AT}), ('gone', 'gone', 0, ${AT})
    `;
    yield* sql`UPDATE users SET removed_at = ${AT}, disabled_at = ${AT} WHERE user_id = 'gone'`;
    yield* sql`
      INSERT INTO spaces (space_id, kind, name, created_at)
      VALUES ('org-acme', 'organization', 'Acme', ${AT})
    `;
    yield* sql`
      INSERT INTO ai_accounts (account_id, name, type, provider, priority, created_at, updated_at)
      VALUES ('claude', 'Claude', 'api-key', 'claude', 1, ${AT}, ${AT})
    `;
    const allow = (kind: string, subject: string) => sql`
      INSERT INTO ai_account_allowances (account_id, subject_kind, subject_id, created_at)
      VALUES ('claude', ${kind}, ${subject}, ${AT})
    `;
    yield* allow("space", "org-acme");
    yield* allow("space", "org-initech");
    yield* allow("space", "personal:grace");
    yield* allow("space", "personal:gone");
    yield* allow("user", "grace");
    yield* allow("user", "gone");
    const key = (id: string, userId: string, spaceId: string) => sql`
      INSERT INTO ai_gateway_keys (key_id, key_hash, kind, user_id, space_id, name, created_at)
      VALUES (${id}, ${`hash-${id}`}, 'user', ${userId}, ${spaceId}, ${id}, ${AT})
    `;
    yield* key("grace-acme", "grace", "org-acme");
    yield* key("grace-initech", "grace", "org-initech");
    yield* key("gone-acme", "gone", "org-acme");

    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 118 }), [
      [118, "AiAccountReachLoss"],
    ]);
    const allowances = yield* sql<{ readonly subject: string }>`
      SELECT subject_kind || ':' || subject_id AS subject FROM ai_account_allowances
      ORDER BY subject_kind, subject_id
    `;
    assert.deepEqual(
      allowances.map((row) => row.subject),
      ["space:org-acme", "space:personal:grace", "user:grace"],
    );
    const keys = yield* sql<{ readonly keyId: string; readonly reason: string | null }>`
      SELECT key_id AS "keyId", revoked_reason AS reason FROM ai_gateway_keys ORDER BY key_id
    `;
    assert.deepEqual(
      keys.map((row) => [row.keyId, row.reason]),
      [
        ["gone-acme", "user-inactive"],
        ["grace-acme", null],
        ["grace-initech", "space-lost"],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
