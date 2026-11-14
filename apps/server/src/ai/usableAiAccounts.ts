/**
 * Spec 4 ticket 09: whether the Hub has a usable AI account (not deleted, not disabled). A read
 * error answers no: a desktop never has its provider keys moved or refused because of one.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const hasUsableAiAccounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly found: number }>`
    SELECT EXISTS (
      SELECT 1 FROM ai_accounts WHERE deleted_at IS NULL AND disabled = 0
    ) AS found
  `;
  return rows[0]?.found === 1;
}).pipe(Effect.orElseSucceed(() => false));
