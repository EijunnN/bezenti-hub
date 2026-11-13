/**
 * Spec 5 ticket 05: a Vault value a Thread received stays sealed after its secret is replaced or
 * deleted, so SecretMasker still masks what the Thread printed with it, until the Thread is deleted
 * (its tombstone, `deleted_at`). A Thread missing from the projections (a rebuild) keeps them.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** Whether a Thread that is not deleted holds the value. */
export const heldByThread = (sql: SqlClient.SqlClient, valueId: string) =>
  sql<{ readonly held: number }>`
    SELECT EXISTS (
      SELECT 1 FROM thread_secret_values v
      WHERE v.value_id = ${valueId} AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_threads t
        WHERE t.thread_id = v.thread_id AND t.deleted_at IS NOT NULL
      )
    ) AS held
  `.pipe(Effect.map((rows) => rows[0]?.held === 1));

/** Forgets the values of deleted Threads, then lists the value ids the others hold. */
export const pruneAndListHeld = Effect.fn("ThreadSecretValues.pruneAndListHeld")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`
    DELETE FROM thread_secret_values WHERE thread_id IN (
      SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
    )
  `;
  const rows = yield* sql<{ readonly valueId: string }>`
    SELECT DISTINCT value_id AS "valueId" FROM thread_secret_values
  `;
  return new Set(rows.map((row) => row.valueId));
});
