/**
 * Vaults. Metadata in the database; each value a sealed store entry (`vault-value-<entry id>`).
 * Rights are AccessPolicy's `vault.*` via SpaceDirectory.authorizeResource. Only `reveal` returns
 * a value; everything is audited without one. See docs/internals/secrets.md.
 */
import {
  MAIN_VAULT_ID,
  SECRET_MASK_MIN_LENGTH,
  SECRET_VALUE_MAX_BYTES,
  secretNameProblem,
  type SpaceId,
  type UserId,
  type VaultBrokenLink,
  type VaultCreateInput,
  type VaultDeleteInput,
  type VaultDeleteResult,
  type VaultEntriesListInput,
  type VaultEntriesListResult,
  type VaultEntry,
  type VaultEntryDeleteInput,
  type VaultEntryDeleteResult,
  type VaultEntryFromMainInput,
  VaultEntryId,
  type VaultEntryKind,
  type VaultEntryPutInput,
  type VaultEntryResult,
  VaultError,
  type VaultErrorReason,
  VaultId,
  type VaultListResult,
  type VaultSummary,
  type VaultUpdateInput,
  type VaultWarning,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import type * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as SecretCipher from "../auth/SecretCipher.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as VaultKeyCheck from "./VaultKeyCheck.ts";

/** The store entry that holds an `own` or `copy` entry's value. */
const valueEntryName = (entryId: string) => `${SecretCipher.VAULT_VALUE_ENTRY_PREFIX}${entryId}`;

const MAIN_VAULT_NAME = "Main vault";

export interface RevealedSecret {
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
}

export class Vaults extends Context.Service<
  Vaults,
  {
    /** The Vaults the acting User sees, the Main vault first. */
    readonly list: Effect.Effect<VaultListResult, VaultError>;
    readonly create: (input: VaultCreateInput) => Effect.Effect<VaultSummary, VaultError>;
    readonly update: (input: VaultUpdateInput) => Effect.Effect<VaultSummary, VaultError>;
    readonly remove: (input: VaultDeleteInput) => Effect.Effect<VaultDeleteResult, VaultError>;
    readonly listEntries: (
      input: VaultEntriesListInput,
    ) => Effect.Effect<VaultEntriesListResult, VaultError>;
    readonly putEntry: (input: VaultEntryPutInput) => Effect.Effect<VaultEntryResult, VaultError>;
    readonly deleteEntry: (
      input: VaultEntryDeleteInput,
    ) => Effect.Effect<VaultEntryDeleteResult, VaultError>;
    readonly linkEntry: (
      input: VaultEntryFromMainInput,
    ) => Effect.Effect<VaultEntryResult, VaultError>;
    readonly copyEntry: (
      input: VaultEntryFromMainInput,
    ) => Effect.Effect<VaultEntryResult, VaultError>;
    /**
     * Refuses, as `reveal` would, before the door asks for a strong factor: nobody but whom the
     * policy lets reveal ever has a proof checked.
     */
    readonly authorizeReveal: (input: {
      readonly vaultId: VaultId;
      readonly entryId: VaultEntryId;
    }) => Effect.Effect<void, VaultError>;
    /**
     * A secret's value, for the acting User when the policy lets them reveal it (the Owner),
     * audited before it is handed out. The door asks for the strong factor first.
     */
    readonly reveal: (input: {
      readonly vaultId: VaultId;
      readonly entryId: VaultEntryId;
    }) => Effect.Effect<RevealedSecret, VaultError>;
  }
>()("t3/vaults/Vaults") {}

const isVaultError = Schema.is(VaultError);

const fail = (reason: VaultErrorReason, message: string) =>
  Effect.fail(new VaultError({ reason, message }));

const NOT_FOUND = "That Vault or secret does not exist.";

interface VaultRow {
  readonly vaultId: string;
  readonly name: string;
  readonly description: string | null;
  readonly spaceId: string | null;
  readonly isMain: number;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly entryCount: number;
}

interface EntryRow {
  readonly entryId: string;
  readonly vaultId: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: VaultEntryKind;
  readonly linkedEntryId: string | null;
  readonly unmasked: number;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
  /** A link's original, when it still exists in the Main vault. */
  readonly linkedName: string | null;
  readonly linkedUnmasked: number | null;
}

const VAULT_COLUMNS = `
  v.vault_id AS "vaultId", v.name AS "name", v.description AS "description",
  v.space_id AS "spaceId", v.is_main AS "isMain", v.archived_at AS "archivedAt",
  v.created_at AS "createdAt", v.updated_at AS "updatedAt",
  (SELECT COUNT(*) FROM vault_entries e WHERE e.vault_id = v.vault_id) AS "entryCount"
`;

const ENTRY_COLUMNS = `
  e.entry_id AS "entryId", e.vault_id AS "vaultId", e.name AS "name",
  e.description AS "description", e.kind AS "kind", e.linked_entry_id AS "linkedEntryId",
  e.unmasked AS "unmasked", e.version AS "version", e.updated_at AS "updatedAt",
  e.updated_by AS "updatedBy",
  o.name AS "linkedName", o.unmasked AS "linkedUnmasked"
`;

/** UTF-8 text without NUL, not empty, at most SECRET_VALUE_MAX_BYTES. Says why, never what. */
const valueProblem = (value: string): string | undefined => {
  if (value.length === 0) return "A secret needs a value.";
  if (value.includes("\u0000")) return "A secret's value cannot contain a NUL character.";
  if (new TextEncoder().encode(value).byteLength > SECRET_VALUE_MAX_BYTES) {
    return `A secret's value is at most ${SECRET_VALUE_MAX_BYTES / 1024} KiB.`;
  }
  return undefined;
};

const isShort = (value: string) => [...value].length < SECRET_MASK_MIN_LENGTH;

const checkName = (name: string) => {
  const problem = secretNameProblem(name);
  if (problem === "invalid") {
    return fail(
      "invalid-name",
      `${JSON.stringify(name.slice(0, 40))} is not an environment variable name: use capital letters, digits and _ (not starting with a digit), at most 128.`,
    );
  }
  if (problem === "reserved") {
    return fail(
      "reserved-name",
      `${name} is reserved: the Hub sets it, or it would change how the agent's tools run.`,
    );
  }
  return Effect.void;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const audit = yield* AuditLog.AuditLog;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;

  /** Logs what failed (never a value: none reaches these causes) and answers generically. */
  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`Vaults: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );

  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const newId = (prefix: string) =>
    random
      .randomBytes(16)
      .pipe(Effect.map((bytes) => `${prefix}-${Buffer.from(bytes).toString("hex")}`));

  const actor = spaces.actingUser.pipe(
    Effect.catchTags({
      SpaceAccessDeniedError: () => fail("forbidden", "Sign in to use Vaults."),
      SpaceDirectoryStorageError: storage("read who you are"),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () => fail("forbidden", "Sign in to use Vaults."),
        onSome: Effect.succeed,
      }),
    ),
  );

  const findVault = (vaultId: string) =>
    sql<VaultRow>`SELECT ${sql.literal(VAULT_COLUMNS)} FROM vaults v WHERE v.vault_id = ${vaultId}`.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.catch(storage("read the Vault")),
    );

  /** A Vault of a deleted Organization is the Owner's alone, like the Owner's own. */
  const resourceOf = Effect.fn("Vaults.resourceOf")(function* (row: VaultRow) {
    const space =
      row.spaceId === null
        ? Option.none()
        : yield* spaces
            .spaceById(row.spaceId as SpaceId)
            .pipe(Effect.catch(storage("read the Vault's Organization")));
    return {
      kind: "vault",
      isMain: row.isMain === 1,
      space: Option.match(space, { onNone: () => null, onSome: (found) => found.resource }),
    } satisfies AccessPolicy.VaultResource;
  });

  const mainResource: AccessPolicy.VaultResource = { kind: "vault", isMain: true, space: null };

  const allowed = (userId: UserId, action: AccessPolicy.Action, resource: AccessPolicy.Resource) =>
    spaces.authorizeResource(userId, action, resource).pipe(
      Effect.as(true),
      Effect.catchTags({
        SpaceAccessDeniedError: () => Effect.succeed(false),
        SpaceDirectoryStorageError: storage("check what you may do"),
      }),
    );

  const summaryOf = Effect.fn("Vaults.summaryOf")(function* (
    userId: UserId,
    row: VaultRow,
    spaceName: string | null,
  ) {
    const resource = yield* resourceOf(row);
    return {
      id: VaultId.make(row.vaultId),
      name: row.name,
      description: row.description,
      spaceId: row.spaceId as SpaceId | null,
      spaceName,
      isMain: row.isMain === 1,
      archived: row.archivedAt !== null,
      entryCount: row.entryCount,
      canEdit: row.archivedAt === null && (yield* allowed(userId, "vault.edit", resource)),
      canManage: yield* allowed(userId, "vault.manage", resource),
      canReveal: yield* allowed(userId, "vault.reveal", resource),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies VaultSummary;
  });

  const spaceNameOf = (spaceId: string | null) =>
    spaceId === null
      ? Effect.succeed(null)
      : spaces
          .spaceById(spaceId as SpaceId)
          .pipe(
            Effect.map(Option.match({ onNone: () => null, onSome: (found) => found.name })),
            Effect.catch(storage("read the Vault's Organization")),
          );

  /**
   * The Vault, once the acting User may take `action` on it. A Vault they cannot see answers
   * exactly like a missing one.
   */
  const authorizeVault = Effect.fn("Vaults.authorizeVault")(function* (
    vaultId: string,
    action: AccessPolicy.Action,
  ) {
    const userId = yield* actor;
    const row = yield* findVault(vaultId);
    if (Option.isNone(row)) return yield* fail("not-found", NOT_FOUND);
    const resource = yield* resourceOf(row.value);
    if (!(yield* allowed(userId, "vault.view", resource))) {
      return yield* fail("not-found", NOT_FOUND);
    }
    if (!(yield* allowed(userId, action, resource))) {
      return yield* fail(
        "forbidden",
        action === "vault.edit"
          ? resource.isMain || resource.space === null
            ? "Only the Owner edits this Vault."
            : "Only the Owner and the Organization's Admins edit this Vault's secrets."
          : action === "vault.reveal"
            ? "Only the Owner reveals a secret's value."
            : "Only the Owner manages Vaults.",
      );
    }
    if (action === "vault.edit" && row.value.archivedAt !== null) {
      return yield* fail("forbidden", "This Vault is archived: restore it to change its secrets.");
    }
    return { userId, row: row.value, resource };
  });

  const entriesOf = (vaultId: string) =>
    sql<EntryRow>`
      SELECT ${sql.literal(ENTRY_COLUMNS)}
      FROM vault_entries e
      LEFT JOIN vault_entries o ON o.entry_id = e.linked_entry_id AND o.vault_id = ${MAIN_VAULT_ID}
      WHERE e.vault_id = ${vaultId}
      ORDER BY e.name
    `.pipe(Effect.catch(storage("read the Vault's secrets")));

  const findEntry = (vaultId: string, entryId: string) =>
    sql<EntryRow>`
      SELECT ${sql.literal(ENTRY_COLUMNS)}
      FROM vault_entries e
      LEFT JOIN vault_entries o ON o.entry_id = e.linked_entry_id AND o.vault_id = ${MAIN_VAULT_ID}
      WHERE e.vault_id = ${vaultId} AND e.entry_id = ${entryId}
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.catch(storage("read the secret")),
      Effect.flatMap(
        Option.match({
          onNone: () => fail("not-found", NOT_FOUND),
          onSome: Effect.succeed,
        }),
      ),
    );

  const entryOf = (row: EntryRow, seesMain: boolean): VaultEntry => {
    const broken = row.kind === "link" && row.linkedName === null;
    return {
      id: VaultEntryId.make(row.entryId),
      vaultId: VaultId.make(row.vaultId),
      name: row.name,
      description: row.description,
      kind: row.kind,
      broken,
      linkedFrom:
        seesMain && row.kind === "link" && row.linkedEntryId !== null && !broken
          ? { entryId: VaultEntryId.make(row.linkedEntryId), name: row.linkedName ?? "" }
          : null,
      unmasked: (row.kind === "link" ? (row.linkedUnmasked ?? 0) : row.unmasked) === 1,
      version: row.version,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy as UserId | null,
    };
  };

  const nameTaken = (vaultId: string, name: string, except?: string) =>
    sql<{ readonly entryId: string }>`
      SELECT entry_id AS "entryId" FROM vault_entries WHERE vault_id = ${vaultId} AND name = ${name}
    `.pipe(
      Effect.map((rows) => rows.some((row) => row.entryId !== except)),
      Effect.catch(storage("read the Vault's secrets")),
      Effect.flatMap((taken) =>
        taken
          ? fail("duplicate-name", `This Vault already has a secret named ${name}.`)
          : Effect.void,
      ),
    );

  const writeValue = (entryId: string, value: string) =>
    store
      .set(valueEntryName(entryId), new TextEncoder().encode(value))
      .pipe(Effect.catch(storage("store the secret")));

  /** Removes a value; one left behind by a failure is swept at the next start. */
  const removeValue = (entryId: string) =>
    store.remove(valueEntryName(entryId)).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Vaults: could not remove a value; the next start removes it", {
          entryId,
          cause,
        }),
      ),
    );

  const readValue = (entryId: string) =>
    store.get(valueEntryName(entryId)).pipe(
      Effect.catch(storage("read the secret")),
      Effect.flatMap(
        Option.match({
          onNone: () => fail("not-found", "This secret's value is missing."),
          onSome: (bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
        }),
      ),
    );

  const recordEdit = (input: {
    readonly userId: UserId;
    readonly vault: VaultRow;
    readonly entryId: string;
    readonly name: string;
    readonly kind: VaultEntryKind;
    readonly op: string;
    readonly from?: string;
    readonly brokenLinks?: number;
  }) =>
    audit.record({
      actor: AuditLog.userActor(input.userId),
      action: "secret.edit",
      spaceId: input.vault.spaceId as SpaceId | null,
      target: { kind: "secret", id: input.entryId, name: input.name },
      detail: {
        vault: input.vault.name,
        vaultId: input.vault.vaultId,
        kind: input.kind,
        op: input.op,
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.brokenLinks === undefined ? {} : { brokenLinks: input.brokenLinks }),
      },
    });

  const seesMain = (userId: UserId) => allowed(userId, "vault.view", mainResource);

  const result = Effect.fn("Vaults.result")(function* (
    userId: UserId,
    vaultId: string,
    entryId: string,
    warnings: ReadonlyArray<VaultWarning>,
  ) {
    const row = yield* findEntry(vaultId, entryId);
    return { entry: entryOf(row, yield* seesMain(userId)), warnings } satisfies VaultEntryResult;
  });

  const list = Effect.gen(function* () {
    const userId = yield* actor;
    const rows = yield* sql<VaultRow>`
      SELECT ${sql.literal(VAULT_COLUMNS)} FROM vaults v ORDER BY v.is_main DESC, v.position, v.name
    `.pipe(Effect.catch(storage("read the Vaults")));
    const spaceIds = new Set(
      rows.flatMap((row) => (row.spaceId === null ? [] : [row.spaceId as SpaceId])),
    );
    const names = yield* spaces
      .spacesById([...spaceIds])
      .pipe(Effect.catch(storage("read the Vaults' Organizations")));
    const vaults: Array<VaultSummary> = [];
    for (const row of rows) {
      if (!(yield* allowed(userId, "vault.view", yield* resourceOf(row)))) continue;
      const spaceName =
        row.spaceId === null ? null : (names.get(row.spaceId as SpaceId)?.name ?? null);
      vaults.push(yield* summaryOf(userId, row, spaceName));
    }
    return { vaults };
  }).pipe(Effect.withSpan("Vaults.list"));

  const create = Effect.fn("Vaults.create")(function* (input: VaultCreateInput) {
    const userId = yield* actor;
    let space: AccessPolicy.SpaceResource | null = null;
    if (input.spaceId !== null) {
      const found = yield* spaces
        .spaceById(input.spaceId)
        .pipe(Effect.catch(storage("read the Organization")));
      if (Option.isNone(found) || found.value.resource.kind !== "organization") {
        return yield* fail("not-found", "A Vault belongs to an Organization, or to the Owner.");
      }
      space = found.value.resource;
    }
    if (!(yield* allowed(userId, "vault.manage", { kind: "vault", isMain: false, space }))) {
      return yield* fail("forbidden", "Only the Owner creates Vaults.");
    }
    const vaultId = yield* newId("vault");
    const at = yield* now;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const taken = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM vaults WHERE name = ${input.name} COLLATE NOCASE
          `;
          if ((taken[0]?.n ?? 0) > 0) {
            return yield* fail("duplicate-name", `There is already a Vault named ${input.name}.`);
          }
          yield* sql`
            INSERT INTO vaults (vault_id, name, description, space_id, is_main, created_at, updated_at, created_by)
            VALUES (${vaultId}, ${input.name}, ${input.description ?? null}, ${input.spaceId}, 0, ${at}, ${at}, ${userId})
          `;
          yield* audit.record({
            actor: AuditLog.userActor(userId),
            action: "vault.create",
            spaceId: input.spaceId,
            target: { kind: "vault", id: vaultId, name: input.name },
          });
        }),
      )
      .pipe(Effect.catchIf((error) => !isVaultError(error), storage("create the Vault")));
    const row = yield* findVault(vaultId);
    if (Option.isNone(row)) return yield* fail("not-found", NOT_FOUND);
    return yield* summaryOf(userId, row.value, yield* spaceNameOf(row.value.spaceId));
  });

  const update = Effect.fn("Vaults.update")(function* (input: VaultUpdateInput) {
    const { userId, row } = yield* authorizeVault(input.vaultId, "vault.manage");
    const renamed = input.name !== undefined && input.name !== row.name;
    if (row.isMain === 1 && (renamed || input.archived !== undefined)) {
      return yield* fail("main-vault", "The Main vault keeps its name and is never archived.");
    }
    const at = yield* now;
    const archivedAt =
      input.archived === undefined
        ? row.archivedAt
        : input.archived
          ? (row.archivedAt ?? at)
          : null;
    const archiveChanged = (archivedAt !== null) !== (row.archivedAt !== null);
    const described = input.description !== undefined && input.description !== row.description;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (renamed) {
            const taken = yield* sql<{ readonly n: number }>`
              SELECT COUNT(*) AS n FROM vaults
              WHERE name = ${input.name ?? ""} COLLATE NOCASE AND vault_id <> ${row.vaultId}
            `;
            if ((taken[0]?.n ?? 0) > 0) {
              return yield* fail(
                "duplicate-name",
                `There is already a Vault named ${input.name ?? ""}.`,
              );
            }
          }
          yield* sql`
            UPDATE vaults SET
              name = ${input.name ?? row.name},
              description = ${input.description === undefined ? row.description : input.description},
              archived_at = ${archivedAt},
              updated_at = ${at}
            WHERE vault_id = ${row.vaultId}
          `;
          if (renamed || described || archiveChanged) {
            yield* audit.record({
              actor: AuditLog.userActor(userId),
              action: "vault.update",
              spaceId: row.spaceId as SpaceId | null,
              target: { kind: "vault", id: row.vaultId, name: input.name ?? row.name },
              detail: {
                ...(renamed ? { from: row.name, to: input.name ?? row.name } : {}),
                ...(described ? { described: true } : {}),
                ...(archiveChanged ? { archived: archivedAt !== null } : {}),
              },
            });
          }
        }),
      )
      .pipe(Effect.catchIf((error) => !isVaultError(error), storage("change the Vault")));
    const updated = yield* findVault(row.vaultId);
    if (Option.isNone(updated)) return yield* fail("not-found", NOT_FOUND);
    return yield* summaryOf(userId, updated.value, yield* spaceNameOf(updated.value.spaceId));
  });

  const remove = Effect.fn("Vaults.remove")(function* (input: VaultDeleteInput) {
    const { userId, row } = yield* authorizeVault(input.vaultId, "vault.manage");
    if (row.isMain === 1) {
      return yield* fail("main-vault", "The Main vault is never deleted.");
    }
    const entries = yield* entriesOf(row.vaultId);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM vault_entries WHERE vault_id = ${row.vaultId}`;
          yield* sql`DELETE FROM vault_allowances WHERE vault_id = ${row.vaultId}`;
          yield* sql`DELETE FROM space_default_vaults WHERE vault_id = ${row.vaultId}`;
          yield* sql`DELETE FROM project_vault_choices WHERE vault_id = ${row.vaultId}`;
          yield* sql`DELETE FROM vaults WHERE vault_id = ${row.vaultId}`;
          yield* audit.record({
            actor: AuditLog.userActor(userId),
            action: "vault.delete",
            spaceId: row.spaceId as SpaceId | null,
            target: { kind: "vault", id: row.vaultId, name: row.name },
            detail: { entries: entries.length },
          });
        }),
      )
      .pipe(Effect.catch(storage("delete the Vault")));
    // After the rows: a value whose row is gone is never read again, and the next start sweeps it.
    for (const entry of entries) {
      if (entry.kind !== "link") yield* removeValue(entry.entryId);
    }
    return { deleted: true };
  });

  const listEntries = Effect.fn("Vaults.listEntries")(function* (input: VaultEntriesListInput) {
    const { userId, row } = yield* authorizeVault(input.vaultId, "vault.view");
    const entries = yield* entriesOf(row.vaultId);
    const main = yield* seesMain(userId);
    return {
      vault: yield* summaryOf(userId, row, yield* spaceNameOf(row.spaceId)),
      entries: entries.map((entry) => entryOf(entry, main)),
    } satisfies VaultEntriesListResult;
  });

  const putEntry = Effect.fn("Vaults.putEntry")(function* (input: VaultEntryPutInput) {
    const { userId, row } = yield* authorizeVault(input.vaultId, "vault.edit");
    yield* checkName(input.name);
    const value = input.value === undefined ? undefined : Redacted.value(input.value);
    if (value !== undefined) {
      const problem = valueProblem(value);
      if (problem !== undefined) return yield* fail("invalid-value", problem);
    }
    const warnings: ReadonlyArray<VaultWarning> =
      value !== undefined && isShort(value) ? ["short-value"] : [];
    const at = yield* now;

    if (input.entryId === undefined) {
      if (value === undefined) return yield* fail("invalid-value", "A secret needs a value.");
      yield* nameTaken(row.vaultId, input.name);
      const entryId = yield* newId("secret");
      // The value first: a row never points at a value that is not there.
      yield* writeValue(entryId, value);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO vault_entries (entry_id, vault_id, name, description, kind, unmasked, version, created_at, updated_at, updated_by)
              VALUES (${entryId}, ${row.vaultId}, ${input.name}, ${input.description ?? null}, 'own', ${isShort(value) ? 1 : 0}, 1, ${at}, ${at}, ${userId})
            `;
            yield* recordEdit({
              userId,
              vault: row,
              entryId,
              name: input.name,
              kind: "own",
              op: "add",
            });
          }),
        )
        .pipe(
          Effect.catch((cause) =>
            removeValue(entryId).pipe(
              Effect.andThen(
                nameTaken(row.vaultId, input.name).pipe(
                  Effect.andThen(storage("add the secret")(cause)),
                ),
              ),
            ),
          ),
        );
      return yield* result(userId, row.vaultId, entryId, warnings);
    }

    const entry = yield* findEntry(row.vaultId, input.entryId);
    if (value !== undefined && entry.kind === "link") {
      return yield* fail(
        "not-linkable",
        `${entry.name} is a Secret link: its value is the Main vault's. Replace the original there, or delete the link and add a secret of this Vault's own.`,
      );
    }
    const renamed = input.name !== entry.name;
    if (renamed) yield* nameTaken(row.vaultId, input.name, entry.entryId);
    const described = input.description !== undefined && input.description !== entry.description;
    if (value === undefined && !renamed && !described) {
      return yield* result(userId, row.vaultId, entry.entryId, []);
    }
    if (value !== undefined) yield* writeValue(entry.entryId, value);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE vault_entries SET
              name = ${input.name},
              description = ${input.description === undefined ? entry.description : input.description},
              unmasked = ${value === undefined ? entry.unmasked : isShort(value) ? 1 : 0},
              version = version + ${value === undefined ? 0 : 1},
              updated_at = ${at},
              updated_by = ${userId}
            WHERE entry_id = ${entry.entryId}
          `;
          yield* recordEdit({
            userId,
            vault: row,
            entryId: entry.entryId,
            name: input.name,
            kind: entry.kind,
            op: value !== undefined ? "replace" : renamed ? "rename" : "describe",
            ...(renamed ? { from: entry.name } : {}),
          });
        }),
      )
      .pipe(Effect.catch(storage("change the secret")));
    return yield* result(userId, row.vaultId, entry.entryId, warnings);
  });

  const linksTo = (entryId: string) =>
    sql<VaultBrokenLink>`
      SELECT e.vault_id AS "vaultId", v.name AS "vaultName", e.entry_id AS "entryId", e.name AS "name"
      FROM vault_entries e JOIN vaults v ON v.vault_id = e.vault_id
      WHERE e.kind = 'link' AND e.linked_entry_id = ${entryId}
      ORDER BY v.name, e.name
    `.pipe(Effect.catch(storage("read the Secret links")));

  const deleteEntry = Effect.fn("Vaults.deleteEntry")(function* (input: VaultEntryDeleteInput) {
    const { userId, row } = yield* authorizeVault(input.vaultId, "vault.edit");
    const entry = yield* findEntry(row.vaultId, input.entryId);
    // Only the Main vault's secrets have links, and only the Owner edits it: the list is theirs.
    const links = row.vaultId === MAIN_VAULT_ID ? yield* linksTo(entry.entryId) : [];
    if (links.length > 0 && input.breakLinks !== true) {
      return { deleted: false, brokenLinks: links } satisfies VaultEntryDeleteResult;
    }
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM vault_entries WHERE entry_id = ${entry.entryId}`;
          yield* recordEdit({
            userId,
            vault: row,
            entryId: entry.entryId,
            name: entry.name,
            kind: entry.kind,
            op: "delete",
            ...(links.length > 0 ? { brokenLinks: links.length } : {}),
          });
        }),
      )
      .pipe(Effect.catch(storage("delete the secret")));
    if (entry.kind !== "link") yield* removeValue(entry.entryId);
    return { deleted: true, brokenLinks: links } satisfies VaultEntryDeleteResult;
  });

  /**
   * A link to, or a copy of, a Main vault secret: it takes editing the Main vault (the Owner) as
   * well as the Vault it goes into, so no one reaches a Main vault value through another Vault.
   */
  const fromMain = Effect.fn("Vaults.fromMain")(function* (
    input: VaultEntryFromMainInput,
    kind: "link" | "copy",
  ) {
    const { userId, row } = yield* authorizeVault(input.vaultId, "vault.edit");
    if (!(yield* allowed(userId, "vault.edit", mainResource))) {
      return yield* fail("forbidden", "Only the Owner links or copies the Main vault's secrets.");
    }
    if (row.vaultId === MAIN_VAULT_ID) {
      return yield* fail(
        "not-linkable",
        "Secret links and copies go into another Vault, not the Main vault itself.",
      );
    }
    const source = yield* findEntry(MAIN_VAULT_ID, input.sourceEntryId);
    if (source.kind === "link") {
      return yield* fail("not-linkable", "A Secret link points at a secret, never at a link.");
    }
    const name = input.name ?? source.name;
    yield* checkName(name);
    yield* nameTaken(row.vaultId, name);
    const entryId = yield* newId("secret");
    const at = yield* now;
    const description = input.description === undefined ? source.description : input.description;
    if (kind === "copy") yield* writeValue(entryId, yield* readValue(source.entryId));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO vault_entries (entry_id, vault_id, name, description, kind, linked_entry_id, unmasked, version, created_at, updated_at, updated_by)
            VALUES (${entryId}, ${row.vaultId}, ${name}, ${description}, ${kind}, ${kind === "link" ? source.entryId : null}, ${source.unmasked}, 1, ${at}, ${at}, ${userId})
          `;
          yield* recordEdit({
            userId,
            vault: row,
            entryId,
            name,
            kind,
            op: kind,
            from: source.name,
          });
        }),
      )
      .pipe(
        Effect.catch((cause) =>
          (kind === "copy" ? removeValue(entryId) : Effect.void).pipe(
            Effect.andThen(storage(`add the ${kind}`)(cause)),
          ),
        ),
      );
    const warnings: ReadonlyArray<VaultWarning> = source.unmasked === 1 ? ["short-value"] : [];
    return yield* result(userId, row.vaultId, entryId, warnings);
  });

  const reveal = Effect.fn("Vaults.reveal")(function* (input: {
    readonly vaultId: VaultId;
    readonly entryId: VaultEntryId;
  }) {
    const { userId, row } = yield* authorizeVault(input.vaultId, "vault.reveal");
    const entry = yield* findEntry(row.vaultId, input.entryId);
    const holder = entry.kind === "link" ? entry.linkedEntryId : entry.entryId;
    if (holder === null || (entry.kind === "link" && entry.linkedName === null)) {
      return yield* fail("not-found", `${entry.name} is a broken link: its original is gone.`);
    }
    const value = yield* readValue(holder);
    // Recorded before the value leaves: one whose reveal could not be recorded is not shown.
    yield* audit
      .record({
        actor: AuditLog.userActor(userId),
        action: "secret.reveal",
        spaceId: row.spaceId as SpaceId | null,
        target: { kind: "secret", id: entry.entryId, name: entry.name },
        detail: { vault: row.name, vaultId: row.vaultId, kind: entry.kind },
      })
      .pipe(Effect.catch(storage("record the reveal")));
    return { name: entry.name, value: Redacted.make(value) } satisfies RevealedSecret;
  });

  const authorizeReveal = Effect.fn("Vaults.authorizeReveal")(function* (input: {
    readonly vaultId: VaultId;
    readonly entryId: VaultEntryId;
  }) {
    const { row } = yield* authorizeVault(input.vaultId, "vault.reveal");
    yield* findEntry(row.vaultId, input.entryId);
  });

  return Vaults.of({
    list,
    authorizeReveal,
    create,
    update,
    remove,
    listEntries,
    putEntry,
    deleteEntry,
    linkEntry: Effect.fn("Vaults.linkEntry")((input: VaultEntryFromMainInput) =>
      fromMain(input, "link"),
    ),
    copyEntry: Effect.fn("Vaults.copyEntry")((input: VaultEntryFromMainInput) =>
      fromMain(input, "copy"),
    ),
    reveal,
  });
});

/** The Main vault exists from the start: the Owner's, never deleted. */
const ensureMainVault = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO vaults (vault_id, name, description, space_id, is_main, position, created_at, updated_at)
    VALUES (${MAIN_VAULT_ID}, ${MAIN_VAULT_NAME}, NULL, NULL, 1, 0, ${at}, ${at})
    ON CONFLICT (vault_id) DO NOTHING
  `;
});

/**
 * Values whose entry is gone (a deletion that stopped between the row and the value, or a restore
 * of an older database): removed, so no sealed value outlives its secret.
 */
const sweepOrphanValues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fs = yield* FileSystem.FileSystem;
  if (store.directory === undefined) return;
  const names = yield* fs.readDirectory(store.directory).pipe(Effect.orElseSucceed(() => []));
  const held = new Set(
    (yield* sql<{ readonly entryId: string }>`
      SELECT entry_id AS "entryId" FROM vault_entries WHERE kind <> 'link'
    `).map((row) => valueEntryName(row.entryId)),
  );
  let removed = 0;
  for (const file of names) {
    const name = file.replace(/\.(sealed|bin)$/u, "");
    if (name === file || !name.startsWith(SecretCipher.VAULT_VALUE_ENTRY_PREFIX)) continue;
    if (held.has(name)) continue;
    yield* store.remove(name).pipe(Effect.ignore);
    removed += 1;
  }
  if (removed > 0) yield* Effect.logInfo("Vaults: removed values of deleted secrets", { removed });
});

/** The Hub's start: the Main vault, the database's key check, and no orphaned values. */
const start = Effect.gen(function* () {
  const { keyring } = yield* ServerSecretStore.MasterKeyring;
  yield* ensureMainVault.pipe(Effect.orDie);
  if (Option.isSome(keyring)) {
    yield* VaultKeyCheck.checkDatabaseKey(keyring.value).pipe(
      Effect.catchTags({ SqlError: (cause) => Effect.die(cause) }),
    );
    yield* sweepOrphanValues.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Vaults: could not sweep values of deleted secrets", { cause }),
      ),
    );
  }
});

export const layer = Layer.effect(Vaults, Effect.andThen(start, make));
