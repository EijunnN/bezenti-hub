import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("moves each Space's own Sandbox limits to a table of their own", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 107 });
    for (const [spaceId, memory] of [
      ["org-acme", 1024 ** 3],
      ["org-globex", null],
    ] as const) {
      yield* sql`
        INSERT INTO sandboxes (
          space_id, environment_id, runtime, status, memory_limit_bytes, created_at, updated_at
        ) VALUES (
          ${spaceId}, ${`sandbox:${spaceId}`}, 'process', 'stopped', ${memory},
          '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'
        )
      `;
    }
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 108 }), [
      [108, "SpaceSandboxLimits"],
    ]);
    // Only a Space with a value of its own has a row.
    assert.deepEqual(
      yield* sql`
        SELECT space_id AS "spaceId", cpu_limit AS cpus, memory_limit_bytes AS memory
        FROM space_sandbox_limits
      `,
      [{ spaceId: "org-acme", cpus: null, memory: 1024 ** 3 }],
    );
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(sandboxes)`;
    assert.notInclude(
      columns.map((column) => column.name),
      "memory_limit_bytes",
    );
    // A Space with only a dedicated machine gets a row with no Sandbox.
    yield* sql`
      INSERT INTO space_sandbox_limits (space_id, pids_limit, updated_at)
      VALUES ('org-initech', 128, '2026-11-01T00:00:00.000Z')
    `;
    const nonPositive = sql`UPDATE space_sandbox_limits SET cpu_limit = 0`;
    assert.isTrue((yield* Effect.exit(nonPositive))._tag === "Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
