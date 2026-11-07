import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const at = "2026-10-01T00:00:00.000Z";

it.effect("a dedicated machine loses its owner; a personal one keeps it and must have one", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 105 });
    for (const [id, mode, space] of [
      ["env-laptop", "personal", null],
      ["env-vps", "dedicated", "org-acme"],
    ] as const) {
      yield* sql`
        INSERT INTO environments (
          environment_id, name, kind, mode, owner_user_id, space_id, credential_hash,
          credential_issued_at, credential_issued_by, registered_at
        ) VALUES (${id}, ${id}, 'external', ${mode}, 'owner', ${space}, ${`hash-${id}`}, ${at},
          'owner', ${at})
      `;
    }
    yield* runMigrations({ toMigrationInclusive: 106 });
    const rows = yield* sql<{ readonly id: string; readonly owner: string | null }>`
      SELECT environment_id AS id, owner_user_id AS owner FROM environments
      WHERE kind = 'external' ORDER BY id
    `;
    assert.deepEqual(rows, [
      { id: "env-laptop", owner: "owner" },
      { id: "env-vps", owner: null },
    ]);
    const ownedDedicated = yield* sql`
      INSERT INTO environments (
        environment_id, name, kind, mode, owner_user_id, space_id, credential_hash,
        credential_issued_at, registered_at
      ) VALUES ('env-x', 'x', 'external', 'dedicated', 'owner', 'org-acme', 'hash-x', ${at}, ${at})
    `.pipe(Effect.flip);
    assert.equal(ownedDedicated._tag, "SqlError");
    const ownerless = yield* sql`
      INSERT INTO environments (
        environment_id, name, kind, mode, owner_user_id, credential_hash, credential_issued_at,
        registered_at
      ) VALUES ('env-y', 'y', 'external', 'personal', NULL, 'hash-y', ${at}, ${at})
    `.pipe(Effect.flip);
    assert.equal(ownerless._tag, "SqlError");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
