/**
 * The rows each way of losing a Vault's reach drops, so nothing comes back unseen and nothing of a
 * deleted Organization or removed User remains. Each runs in its caller's transaction; values go
 * after it commits (`removeValues`). docs/internals/secrets.md, «Losing reach».
 */
import type { ProjectId, SpaceId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { projectSpaceSql } from "../spaces/SpaceDirectory.ts";
import * as VaultReach from "./VaultReach.ts";

/** What a deleted Vault held. */
export interface ForgottenVault {
  readonly vaultId: string;
  readonly name: string;
  readonly entries: number;
}

/** A Vault, its secrets and every row that names it; the values its secrets held. */
export const forgetVault = Effect.fn("VaultReachLoss.forgetVault")(function* (
  sql: SqlClient.SqlClient,
  vaultId: string,
) {
  const gone = yield* sql<{ readonly valueId: string | null }>`
    DELETE FROM vault_entries WHERE vault_id = ${vaultId} RETURNING value_id AS "valueId"
  `;
  yield* sql`DELETE FROM vault_allowances WHERE vault_id = ${vaultId}`;
  yield* sql`DELETE FROM space_default_vaults WHERE vault_id = ${vaultId}`;
  yield* sql`DELETE FROM project_vault_choices WHERE vault_id = ${vaultId}`;
  yield* sql`DELETE FROM vaults WHERE vault_id = ${vaultId}`;
  return {
    entries: gone.length,
    valueIds: gone.flatMap((row) => (row.valueId === null ? [] : [row.valueId])),
  };
});

/**
 * One of the Owner's Vaults taken back from a Space: its allowance, the Space's default of it and
 * the choices of it by the Projects in that Space.
 */
export const forgetSpaceAllowance = Effect.fn("VaultReachLoss.forgetSpaceAllowance")(function* (
  sql: SqlClient.SqlClient,
  vaultId: string,
  spaceId: string,
) {
  yield* sql`
    DELETE FROM vault_allowances
    WHERE vault_id = ${vaultId} AND subject_kind = 'space' AND subject_id = ${spaceId}
  `;
  yield* sql`DELETE FROM space_default_vaults WHERE space_id = ${spaceId} AND vault_id = ${vaultId}`;
  yield* sql`
    DELETE FROM project_vault_choices WHERE vault_id = ${vaultId} AND project_id IN (
      SELECT project_id FROM projection_projects
      WHERE ${sql.literal(projectSpaceSql("space_id"))} = ${spaceId}
    )
  `;
});

/** One of the Owner's Vaults taken back from a User. */
export const forgetUserAllowance = (sql: SqlClient.SqlClient, vaultId: string, userId: string) =>
  sql`
    DELETE FROM vault_allowances
    WHERE vault_id = ${vaultId} AND subject_kind = 'user' AND subject_id = ${userId}
  `.pipe(Effect.asVoid);

/** A User removed from the Installation: every Vault allowed to them, as `{ vaultId, name }`. */
export const forgetUser = Effect.fn("VaultReachLoss.forgetUser")(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
) {
  const allowed = yield* sql<{ readonly vaultId: string; readonly name: string }>`
    SELECT a.vault_id AS "vaultId", v.name AS "name" FROM vault_allowances a
    JOIN vaults v ON v.vault_id = a.vault_id
    WHERE a.subject_kind = 'user' AND a.subject_id = ${userId}
    ORDER BY v.name
  `;
  yield* sql`DELETE FROM vault_allowances WHERE subject_kind = 'user' AND subject_id = ${userId}`;
  return allowed;
});

/**
 * An Organization deleted: its own Vaults with their secrets, the Owner's Vaults' allowances to it,
 * its defaults and its Projects' choices. The Owner's Vaults themselves stay.
 */
export const forgetOrganization = Effect.fn("VaultReachLoss.forgetOrganization")(function* (
  sql: SqlClient.SqlClient,
  spaceId: SpaceId,
) {
  const own = yield* sql<{ readonly vaultId: string; readonly name: string }>`
    SELECT vault_id AS "vaultId", name FROM vaults
    WHERE space_id = ${spaceId} AND is_main = 0 ORDER BY name
  `;
  const vaults: Array<ForgottenVault> = [];
  const valueIds: Array<string> = [];
  for (const vault of own) {
    const gone = yield* forgetVault(sql, vault.vaultId);
    vaults.push({ ...vault, entries: gone.entries });
    valueIds.push(...gone.valueIds);
  }
  yield* sql`DELETE FROM vault_allowances WHERE subject_kind = 'space' AND subject_id = ${spaceId}`;
  yield* sql`DELETE FROM space_default_vaults WHERE space_id = ${spaceId}`;
  yield* sql`
    DELETE FROM project_vault_choices WHERE project_id IN (
      SELECT project_id FROM projection_projects
      WHERE ${sql.literal(projectSpaceSql("space_id"))} = ${spaceId}
    )
  `;
  return { vaults, valueIds };
});

/**
 * A Project moving to Space `spaceId`: its choices of Vaults that do not reach that Space go, in
 * the transaction that moves it (`VaultReach.allowedToSpace`, read in that same transaction).
 */
export const keepProjectChoicesReaching = Effect.fn("VaultReachLoss.keepProjectChoicesReaching")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly projectId: ProjectId;
      readonly spaceId: SpaceId;
      readonly ownersPersonal: boolean;
    },
  ) {
    const reaching = yield* VaultReach.allowedToSpace(sql, input.spaceId, input.ownersPersonal);
    if (reaching.length === 0) {
      yield* sql`DELETE FROM project_vault_choices WHERE project_id = ${input.projectId}`;
      return;
    }
    yield* sql`
      DELETE FROM project_vault_choices
      WHERE project_id = ${input.projectId}
        AND vault_id NOT IN ${sql.in(reaching.map((row) => row.vaultId))}
    `;
  },
);

/** Removes values no row holds any more; a failure leaves them to the next start's sweep. */
export const removeValues = (
  values: ServerSecretStore.VaultValueStore["Service"],
  valueIds: ReadonlyArray<string>,
) =>
  Effect.forEach(
    valueIds,
    (valueId) =>
      values.remove(valueId).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Vaults: could not remove a value; the next start removes it", {
            valueId,
            cause,
          }),
        ),
      ),
    { discard: true },
  );
