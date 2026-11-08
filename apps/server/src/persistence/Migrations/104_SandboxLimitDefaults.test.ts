import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("gives the Installation one row of default Sandbox limits, and only one", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 103 });
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 104 }), [
      [104, "SandboxLimitDefaults"],
    ]);
    const rows = yield* sql<{
      readonly cpus: number;
      readonly memory: number;
      readonly pids: number;
      readonly disk: number;
    }>`
      SELECT cpu_limit AS cpus, memory_limit_bytes AS memory, pids_limit AS pids,
        disk_limit_bytes AS disk
      FROM sandbox_limit_defaults
    `;
    assert.deepEqual(rows, [{ cpus: 2, memory: 4 * 1024 ** 3, pids: 4096, disk: 20 * 1024 ** 3 }]);
    const insertAnother = sql`
      INSERT INTO sandbox_limit_defaults (id, updated_at) VALUES (2, '2026-11-01T00:00:00.000Z')
    `;
    assert.isTrue((yield* Effect.exit(insertAnother))._tag === "Failure");
    const nonPositive = sql`UPDATE sandbox_limit_defaults SET memory_limit_bytes = 0`;
    assert.isTrue((yield* Effect.exit(nonPositive))._tag === "Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
