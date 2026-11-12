/**
 * Which Vaults may reach a Space or a User: the one rule for Vaults.ts and EffectiveVaults.ts. The
 * Main vault: the Owner's Personal space; an Organization's: itself; the Owner's others: whom they
 * were allowed to. Other allowance rows are ignored. See docs/internals/secrets.md.
 */
import { MAIN_VAULT_ID, type SpaceId, type UserId, VaultId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as AccessPolicy from "../auth/AccessPolicy.ts";
import { isScratchWorkspaceRoot } from "../environment/ScratchWorkspace.ts";
import type * as SpaceDirectory from "../spaces/SpaceDirectory.ts";

export interface ReachRow {
  readonly vaultId: VaultId;
  readonly name: string;
  readonly isMain: boolean;
  readonly archived: boolean;
}

interface RawReachRow {
  readonly vaultId: string;
  readonly name: string;
  readonly isMain: number;
  readonly archivedAt: string | null;
}

const COLUMNS = `v.vault_id AS "vaultId", v.name AS "name", v.is_main AS "isMain",
  v.archived_at AS "archivedAt"`;

/** The Owner's order, as Settings → Vaults lists them: the Main vault, then by position, name. */
const VAULT_ORDER = `v.is_main DESC, v.position, v.name COLLATE NOCASE`;

const toReach = (row: RawReachRow): ReachRow => ({
  vaultId: VaultId.make(row.vaultId),
  name: row.name,
  isMain: row.isMain === 1,
  archived: row.archivedAt !== null,
});

/** Whether the Space is the Owner's own Personal space: the only one the Main vault reaches. */
export const isOwnersPersonal = (
  spaces: SpaceDirectory.SpaceDirectory["Service"],
  space: AccessPolicy.SpaceResource,
) =>
  space.kind !== "personal" || space.personalOwnerUserId === null
    ? Effect.succeed(false)
    : spaces.principalOf(space.personalOwnerUserId).pipe(Effect.map((who) => who.isOwner));

/** The Vaults allowed to a Space, archived ones included, in the Owner's order. */
export const allowedToSpace = (
  sql: SqlClient.SqlClient,
  spaceId: SpaceId,
  ownersPersonal: boolean,
) =>
  sql<RawReachRow>`
    SELECT ${sql.literal(COLUMNS)} FROM vaults v
    WHERE (v.vault_id = ${MAIN_VAULT_ID} AND v.is_main = 1 AND ${ownersPersonal ? 1 : 0} = 1)
      OR (v.is_main = 0 AND v.space_id = ${spaceId})
      OR (v.is_main = 0 AND v.space_id IS NULL AND EXISTS (
        SELECT 1 FROM vault_allowances a
        WHERE a.vault_id = v.vault_id AND a.subject_kind = 'space' AND a.subject_id = ${spaceId}
      ))
    ORDER BY ${sql.literal(VAULT_ORDER)}
  `.pipe(Effect.map((rows) => rows.map(toReach)));

/** The Vaults allowed to a User themselves (the Owner's own, never the Main vault). */
export const allowedToUser = (sql: SqlClient.SqlClient, userId: UserId) =>
  sql<RawReachRow>`
    SELECT ${sql.literal(COLUMNS)} FROM vaults v
    WHERE v.is_main = 0 AND v.space_id IS NULL AND EXISTS (
      SELECT 1 FROM vault_allowances a
      WHERE a.vault_id = v.vault_id AND a.subject_kind = 'user' AND a.subject_id = ${userId}
    )
    ORDER BY ${sql.literal(VAULT_ORDER)}
  `.pipe(Effect.map((rows) => rows.map(toReach)));

/** A Space's chosen defaults, in their order (the first wins a shared name). */
export const chosenDefaults = (sql: SqlClient.SqlClient, spaceId: SpaceId) =>
  sql<{ readonly vaultId: string }>`
    SELECT vault_id AS "vaultId" FROM space_default_vaults
    WHERE space_id = ${spaceId} ORDER BY position, vault_id
  `.pipe(Effect.map((rows) => rows.map((row) => VaultId.make(row.vaultId))));

/**
 * Whether a Project is the scratch one, which holds the Threads without a Project: those use their
 * Space's defaults and their User's Vaults, never a Project's choices (it spans every Space).
 */
export const isScratchProject = (
  sql: SqlClient.SqlClient,
  path: Path.Path,
  baseDir: string,
  projectId: string,
) =>
  sql<{ readonly workspaceRoot: string }>`
    SELECT workspace_root AS "workspaceRoot" FROM projection_projects WHERE project_id = ${projectId}
  `.pipe(
    Effect.map((rows) => {
      const row = rows[0];
      return row !== undefined && isScratchWorkspaceRoot(path, baseDir, row.workspaceRoot);
    }),
  );

/** A Project's adds and removes. */
export const projectChoices = (sql: SqlClient.SqlClient, projectId: string) =>
  sql<{ readonly vaultId: string; readonly choice: "add" | "remove" }>`
    SELECT vault_id AS "vaultId", choice AS "choice" FROM project_vault_choices
    WHERE project_id = ${projectId} ORDER BY vault_id
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({ vaultId: VaultId.make(row.vaultId), choice: row.choice })),
    ),
  );
