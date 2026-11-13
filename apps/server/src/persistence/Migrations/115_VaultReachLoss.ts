import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Spec 5 ticket 07: drops Vault rows earlier Hubs left naming a lost reach (each loss now drops
// its own, vaults/VaultReachLoss.ts); frozen SQL of VaultReach's rule.
const REACHES = (space: string) => `(
  (v.vault_id = 'vault-main' AND v.is_main = 1
    AND ${space} = 'personal:' || (SELECT user_id FROM users WHERE is_owner = 1))
  OR (v.is_main = 0 AND v.space_id = ${space})
  OR (v.is_main = 0 AND v.space_id IS NULL AND EXISTS (
    SELECT 1 FROM vault_allowances a
    WHERE a.vault_id = v.vault_id AND a.subject_kind = 'space' AND a.subject_id = ${space}
  )))`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // An Organization's Vaults whose Organization is gone, with everything naming them.
  const gone = `SELECT vault_id FROM vaults
    WHERE space_id IS NOT NULL AND space_id NOT IN (SELECT space_id FROM spaces)`;
  yield* sql`DELETE FROM vault_entries WHERE vault_id IN (${sql.literal(gone)})`;
  yield* sql`DELETE FROM vault_allowances WHERE vault_id IN (${sql.literal(gone)})`;
  yield* sql`DELETE FROM space_default_vaults WHERE vault_id IN (${sql.literal(gone)})`;
  yield* sql`DELETE FROM project_vault_choices WHERE vault_id IN (${sql.literal(gone)})`;
  yield* sql`DELETE FROM vaults WHERE vault_id IN (${sql.literal(gone)})`;
  // Allowances to a Space that is gone, or to a removed User.
  yield* sql`
    DELETE FROM vault_allowances
    WHERE (subject_kind = 'space' AND subject_id NOT IN (SELECT space_id FROM spaces))
      OR (subject_kind = 'user' AND subject_id IN (
        SELECT user_id FROM users WHERE removed_at IS NOT NULL))
  `;
  // A removed User's frozen Personal space keeps no allowance, default or choice.
  const removedPersonal = `SELECT 'personal:' || user_id FROM users WHERE removed_at IS NOT NULL`;
  yield* sql`
    DELETE FROM vault_allowances
    WHERE subject_kind = 'space' AND subject_id IN (${sql.literal(removedPersonal)})
  `;
  yield* sql`DELETE FROM space_default_vaults WHERE space_id IN (${sql.literal(removedPersonal)})`;
  yield* sql`
    DELETE FROM project_vault_choices WHERE project_id IN (
      SELECT project_id FROM projection_projects
      WHERE COALESCE(space_id, 'personal:' || (SELECT user_id FROM users WHERE is_owner = 1))
        IN (${sql.literal(removedPersonal)})
    )
  `;
  // Defaults and choices of a Vault that does not reach the Space they are in.
  yield* sql`
    DELETE FROM space_default_vaults
    WHERE NOT EXISTS (
      SELECT 1 FROM vaults v
      WHERE v.vault_id = space_default_vaults.vault_id
        AND ${sql.literal(REACHES("space_default_vaults.space_id"))}
    )
  `;
  yield* sql`
    DELETE FROM project_vault_choices
    WHERE NOT EXISTS (
      SELECT 1 FROM vaults v, projection_projects p
      WHERE v.vault_id = project_vault_choices.vault_id
        AND p.project_id = project_vault_choices.project_id AND p.deleted_at IS NULL
        AND ${sql.literal(
          REACHES(
            "COALESCE(p.space_id, 'personal:' || (SELECT user_id FROM users WHERE is_owner = 1))",
          ),
        )}
    )
  `;
});
