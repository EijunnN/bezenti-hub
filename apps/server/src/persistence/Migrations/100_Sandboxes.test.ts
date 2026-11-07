import { assert, it } from "@effect/vitest";
import { HUB_MACHINE_ENVIRONMENT_ID } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const at = "2026-11-01T00:00:00.000Z";

it.effect("keeps every machine, and a Sandbox is a Space's, with no owner", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 99 });
    yield* sql`
      INSERT INTO environments (
        environment_id, name, kind, mode, owner_user_id, credential_hash, credential_issued_at,
        credential_issued_by, registered_at, revoked_at
      ) VALUES ('laptop', 'Laptop', 'external', 'personal', 'user-1', 'hash-1', ${at}, 'user-1',
        ${at}, ${at})
    `;

    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 100 }), [[100, "Sandboxes"]]);
    const rows = yield* sql<{ readonly id: string; readonly revokedAt: string | null }>`
      SELECT environment_id AS id, revoked_at AS "revokedAt" FROM environments
      ORDER BY environment_id
    `;
    assert.deepEqual(rows, [
      { id: HUB_MACHINE_ENVIRONMENT_ID, revokedAt: null },
      { id: "laptop", revokedAt: at },
    ]);

    const insertSandbox = (ownerUserId: string | null, spaceId: string | null) => sql`
      INSERT INTO environments (
        environment_id, name, kind, mode, owner_user_id, space_id, credential_hash,
        credential_issued_at, registered_at
      ) VALUES (${`sandbox:${spaceId}`}, 'Acme Sandbox', 'sandbox', 'sandbox', ${ownerUserId},
        ${spaceId}, ${`hash-${spaceId}-${ownerUserId}`}, ${at}, ${at})
    `;
    yield* insertSandbox(null, "acme");
    assert.isTrue((yield* Effect.exit(insertSandbox("user-1", "globex")))._tag === "Failure");
    assert.isTrue((yield* Effect.exit(insertSandbox(null, null)))._tag === "Failure");
    // A credential is never shared, between Sandboxes or with a machine.
    assert.isTrue(
      (yield* Effect.exit(sql`
        INSERT INTO environments (
          environment_id, name, kind, mode, space_id, credential_hash, credential_issued_at,
          registered_at
        ) VALUES ('sandbox:globex', 'Globex Sandbox', 'sandbox', 'sandbox', 'globex', 'hash-1',
          ${at}, ${at})
      `))._tag === "Failure",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
