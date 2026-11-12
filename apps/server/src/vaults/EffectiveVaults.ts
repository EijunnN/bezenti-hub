/**
 * The only place that computes which secrets a Thread's turn, terminal or script receives for the
 * User who starts it: value ids, never values, recomputed on every call. Rule and precedence (User,
 * then Project, then Space): docs/internals/secrets.md, «The effective set».
 */
import {
  ProjectId,
  secretNameRisk,
  type SpaceId,
  ThreadId,
  type UserId,
  VaultEntryId,
  VaultError,
  type VaultErrorReason,
  VaultId,
  type VaultShadowed,
  type VaultSource,
  type VaultThreadEnvironment,
  type VaultThreadEnvironmentInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as VaultReach from "./VaultReach.ts";

/** One variable of the effective set. */
export interface EffectiveVariable {
  readonly name: string;
  readonly description: string | null;
  readonly entryId: VaultEntryId;
  readonly vaultId: VaultId;
  readonly vaultName: string;
  readonly source: VaultSource;
  /**
   * The VaultValueStore entry holding the value (a link's original's): read by delivery alone.
   * A new id after every replace, so it also says whether the value changed.
   */
  readonly valueId: string;
  readonly unmasked: boolean;
  /** A name that changes how tools run; only the Owner sets one (`secretNameRisk`). */
  readonly dangerous: boolean;
  /** The Vaults that also define it and lost, in precedence order. */
  readonly shadowed: ReadonlyArray<VaultShadowed>;
}

export interface EffectiveSet {
  readonly threadId: ThreadId;
  readonly spaceId: SpaceId;
  readonly projectId: ProjectId | null;
  /** The Vaults it draws from, in the order that wins. */
  readonly vaults: ReadonlyArray<{
    readonly vaultId: VaultId;
    readonly name: string;
    readonly source: VaultSource;
  }>;
  /** By name. */
  readonly variables: ReadonlyArray<EffectiveVariable>;
}

export class EffectiveVaults extends Context.Service<
  EffectiveVaults,
  {
    /**
     * What a turn, terminal or script of the Thread receives when `actingUserId` starts it. Fails
     * `not-found` for a missing Thread and `forbidden` when the User no longer works in its Space.
     */
    readonly forThread: (input: {
      readonly threadId: ThreadId;
      readonly actingUserId: UserId;
    }) => Effect.Effect<EffectiveSet, VaultError>;
    /**
     * `vaults.threadEnvironment`: the names the calling User's turns in a Thread they see would
     * receive, and which Vault wins each. Never values or value ids.
     */
    readonly threadEnvironment: (
      input: VaultThreadEnvironmentInput,
    ) => Effect.Effect<VaultThreadEnvironment, VaultError>;
  }
>()("t3/vaults/EffectiveVaults") {}

const fail = (reason: VaultErrorReason, message: string) =>
  Effect.fail(new VaultError({ reason, message }));

const NOT_FOUND = "That Thread does not exist.";

interface EntryRow {
  readonly vaultId: string;
  readonly entryId: string;
  readonly name: string;
  readonly description: string | null;
  readonly valueId: string | null;
  readonly unmasked: number | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`EffectiveVaults: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );

  /** Entries of the Vaults, a link's value and length its original's (none once it is gone). */
  const entriesOf = (vaultIds: ReadonlyArray<VaultId>) =>
    vaultIds.length === 0
      ? Effect.succeed([] as ReadonlyArray<EntryRow>)
      : sql<EntryRow>`
          SELECT e.vault_id AS "vaultId", e.entry_id AS "entryId", e.name AS "name",
            e.description AS "description",
            CASE WHEN e.kind = 'link' THEN o.value_id ELSE e.value_id END AS "valueId",
            CASE WHEN e.kind = 'link' THEN o.unmasked ELSE e.unmasked END AS "unmasked"
          FROM vault_entries e
          LEFT JOIN vault_entries o
            ON e.kind = 'link' AND o.entry_id = e.linked_entry_id
            AND o.vault_id = (SELECT vault_id FROM vaults WHERE is_main = 1) AND o.kind <> 'link'
          WHERE e.vault_id IN ${sql.in(vaultIds)}
          ORDER BY e.name
        `;

  const forThread = Effect.fn("EffectiveVaults.forThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly actingUserId: UserId;
  }) {
    const placement = yield* spaces
      .placementOf(input.threadId)
      .pipe(Effect.catch(storage("read the Thread's Space")));
    if (Option.isNone(placement)) return yield* fail("not-found", NOT_FOUND);
    const { space } = placement.value;
    // A Thread without a Project (the scratch Project's) takes no Project's choices.
    const projectId =
      placement.value.projectId === null ||
      (yield* VaultReach.isScratchProject(sql, path, baseDir, placement.value.projectId).pipe(
        Effect.catch(storage("read the Thread's Project")),
      ))
        ? null
        : placement.value.projectId;
    // Whoever no longer works in the Space (a removed Membership, a disabled User) starts
    // nothing there: nothing is computed for them, their own Vaults included.
    const can = yield* spaces
      .authorizer(input.actingUserId)
      .pipe(Effect.catch(storage("check what you may do")));
    if (!can("space.view", space)) {
      return yield* fail("forbidden", "You no longer work in this Thread's Space.");
    }

    const reach = yield* Effect.gen(function* () {
      const ownersPersonal = yield* VaultReach.isOwnersPersonal(spaces, space);
      const allowed = yield* VaultReach.allowedToSpace(sql, space.id, ownersPersonal);
      const defaults = yield* VaultReach.chosenDefaults(sql, space.id);
      const choices = projectId === null ? [] : yield* VaultReach.projectChoices(sql, projectId);
      const ownVaults = yield* VaultReach.allowedToUser(sql, input.actingUserId);
      return { ownersPersonal, allowed, defaults, choices, ownVaults };
    }).pipe(Effect.catch(storage("read the Thread's Vaults")));

    const allowedById = new Map(reach.allowed.map((row) => [row.vaultId, row]));
    const removed = new Set(
      reach.choices.filter((choice) => choice.choice === "remove").map((c) => c.vaultId),
    );
    const added = new Set(
      reach.choices.filter((choice) => choice.choice === "add").map((c) => c.vaultId),
    );
    const groups: Array<{ readonly row: VaultReach.ReachRow; readonly source: VaultSource }> = [];
    const taken = new Set<VaultId>();
    const take = (row: VaultReach.ReachRow | undefined, source: VaultSource) => {
      if (row === undefined || row.archived || taken.has(row.vaultId)) return;
      taken.add(row.vaultId);
      groups.push({ row, source });
    };
    // The User's own first, then the Project's adds, then the defaults (the Main vault first where
    // it is one); every Space-side Vault only if allowed to the Space, minus the Project's removes.
    for (const row of reach.ownVaults) take(row, "user");
    for (const row of reach.allowed) {
      if (added.has(row.vaultId)) take(row, "project");
    }
    const defaults = [
      ...reach.allowed.filter((row) => row.isMain).map((row) => row.vaultId),
      ...reach.defaults,
    ];
    for (const vaultId of defaults) {
      if (!removed.has(vaultId)) take(allowedById.get(vaultId), "space");
    }

    const entries = yield* entriesOf(groups.map((group) => group.row.vaultId)).pipe(
      Effect.catch(storage("read the Thread's secrets")),
    );
    const byVault = new Map<string, Array<EntryRow>>();
    for (const entry of entries) {
      const list = byVault.get(entry.vaultId) ?? [];
      list.push(entry);
      byVault.set(entry.vaultId, list);
    }
    const winners = new Map<string, { variable: EffectiveVariable; shadowed: VaultShadowed[] }>();
    for (const { row, source } of groups) {
      for (const entry of byVault.get(row.vaultId) ?? []) {
        // A broken link holds nothing; a name the Hub keeps (or not a variable) is never set.
        if (entry.valueId === null) continue;
        const risk = secretNameRisk(entry.name);
        if (risk === "invalid" || risk === "gateway") continue;
        const winner = winners.get(entry.name);
        if (winner !== undefined) {
          winner.shadowed.push({ vaultId: row.vaultId, vaultName: row.name, source });
          continue;
        }
        winners.set(entry.name, {
          shadowed: [],
          variable: {
            name: entry.name,
            description: entry.description,
            entryId: VaultEntryId.make(entry.entryId),
            vaultId: row.vaultId,
            vaultName: row.name,
            source,
            valueId: entry.valueId,
            unmasked: entry.unmasked === 1,
            dangerous: risk === "dangerous",
            shadowed: [],
          },
        });
      }
    }
    const variables = [...winners.values()]
      .map(({ variable, shadowed }) => ({ ...variable, shadowed }))
      .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      threadId: input.threadId,
      spaceId: space.id,
      projectId: projectId === null ? null : ProjectId.make(projectId),
      vaults: groups.map(({ row, source }) => ({ vaultId: row.vaultId, name: row.name, source })),
      variables,
    } satisfies EffectiveSet;
  });

  const threadEnvironment = Effect.fn("EffectiveVaults.threadEnvironment")(function* (
    input: VaultThreadEnvironmentInput,
  ) {
    const actor = yield* spaces.actingUser.pipe(
      Effect.catchTags({
        SpaceAccessDeniedError: () => fail("forbidden", "Sign in to see a Thread's secrets."),
        SpaceDirectoryStorageError: storage("read who you are"),
      }),
    );
    if (Option.isNone(actor)) return yield* fail("forbidden", "Sign in to see a Thread's secrets.");
    // A Thread the caller does not see (another Space, or one an agent is not bound to) answers
    // like a missing one.
    yield* spaces
      .authorizeItem(actor.value, "space.view", { kind: "thread", id: input.threadId })
      .pipe(
        Effect.catchTags({
          SpaceDirectoryStorageError: storage("read the Thread"),
          SpaceAccessDeniedError: () => fail("not-found", NOT_FOUND),
          SpaceResourceNotFoundError: () => fail("not-found", NOT_FOUND),
        }),
      );
    const set = yield* forThread({ threadId: input.threadId, actingUserId: actor.value });
    return {
      threadId: ThreadId.make(set.threadId),
      spaceId: set.spaceId,
      projectId: set.projectId,
      vaults: set.vaults,
      variables: set.variables.map((variable) => ({
        name: variable.name,
        description: variable.description,
        vaultId: variable.vaultId,
        vaultName: variable.vaultName,
        source: variable.source,
        unmasked: variable.unmasked,
        dangerous: variable.dangerous,
        shadowed: variable.shadowed,
      })),
    } satisfies VaultThreadEnvironment;
  });

  return EffectiveVaults.of({ forThread, threadEnvironment });
});

export const layer = Layer.effect(EffectiveVaults, make);
