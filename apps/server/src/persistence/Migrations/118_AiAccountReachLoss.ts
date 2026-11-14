import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Spec 4 ticket 11: what earlier Hubs left naming a reach that is gone, dropped once (a removal or
// an Organization's deletion drops it in its own commit from now on): allowances to Spaces that no
// longer exist, to removed Users and to their Personal spaces; live gateway keys of removed Users
// and of Spaces that no longer exist. A Personal space is a row of `spaces` too.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DELETE FROM ai_account_allowances
    WHERE (subject_kind = 'space' AND subject_id NOT IN (SELECT space_id FROM spaces))
      OR (subject_kind = 'user' AND subject_id IN (
        SELECT user_id FROM users WHERE removed_at IS NOT NULL
      ))
      OR (subject_kind = 'space' AND subject_id IN (
        SELECT 'personal:' || user_id FROM users WHERE removed_at IS NOT NULL
      ))
  `;
  yield* sql`
    UPDATE ai_gateway_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_reason = 'user-inactive'
    WHERE revoked_at IS NULL
      AND user_id IN (SELECT user_id FROM users WHERE removed_at IS NOT NULL)
  `;
  yield* sql`
    UPDATE ai_gateway_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_reason = 'space-lost'
    WHERE revoked_at IS NULL AND space_id NOT IN (SELECT space_id FROM spaces)
  `;
});
