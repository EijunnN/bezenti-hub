/**
 * Spec 5 ticket 05: a Vault value a living Thread received stays sealed after its secret is
 * replaced or deleted, so SecretMasker still masks what the Thread printed with it. Vaults asks
 * here before removing a value, and its start drops the rows (and so the values) of Threads that
 * are gone. Never a value: value ids and names only (`thread_secret_values`, migration 116).
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** Whether a Thread that still exists holds the value. */
export const heldByThread = (sql: SqlClient.SqlClient, valueId: string) =>
  sql<{ readonly held: number }>`
    SELECT EXISTS (
      SELECT 1 FROM thread_secret_values v
      JOIN orchestration_v2_projection_threads t ON t.thread_id = v.thread_id
      WHERE v.value_id = ${valueId} AND t.deleted_at IS NULL
    ) AS held
  `.pipe(Effect.map((rows) => rows[0]?.held === 1));

/** Forgets the values of Threads that are gone, then lists the value ids living Threads hold. */
export const pruneAndListHeld = Effect.fn("ThreadSecretValues.pruneAndListHeld")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`
      DELETE FROM thread_secret_values WHERE thread_id NOT IN (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
      )
    `;
  const rows = yield* sql<{ readonly valueId: string }>`
      SELECT DISTINCT value_id AS "valueId" FROM thread_secret_values
    `;
  return new Set(rows.map((row) => row.valueId));
});
