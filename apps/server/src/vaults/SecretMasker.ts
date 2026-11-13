/**
 * Spec 5 ticket 05: a Thread's secret values as `[NAME]` in what the Hub stores or shows: what its
 * processes received (`thread_secret_values`, for the Thread's life) and its owner's effective set.
 * Never another User's values, and never unmasked when the set cannot be read. See `MaskedPaths.ts`.
 */
import {
  EnvironmentAuthenticatedPrincipal,
  HUB_MACHINE_ENVIRONMENT_ID,
  type ProjectId,
  type SpaceId,
  type ThreadId,
  UserId,
  type VaultError,
} from "@t3tools/contracts";
import {
  type MaskableSecret,
  makeSecretPatterns,
  maskDeep,
  rememberKnownSecrets,
  type SecretPatterns,
} from "@t3tools/shared/secretMasking";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EffectiveVaults from "./EffectiveVaults.ts";

/** A Thread's masker: the patterns, and the same applied to every string of a value. */
export interface ThreadMasker extends SecretPatterns {
  readonly maskDeep: <A>(value: A) => A;
}

export const threadMaskerOf = (patterns: SecretPatterns): ThreadMasker => ({
  ...patterns,
  maskDeep: (value) => (patterns.isEmpty ? value : maskDeep(value, patterns.mask)),
});

const maskerOf = (secrets: ReadonlyArray<MaskableSecret>) =>
  threadMaskerOf(makeSecretPatterns(secrets));

/** A masker that masks nothing: text that no Thread's values can be in. */
const noSecrets: ThreadMasker = maskerOf([]);

/** A Thread's values could not be read: what would have been stored or sent is not. */
export class SecretMaskingError extends Schema.TaggedError<SecretMaskingError>()(
  "SecretMaskingError",
  { threadId: Schema.optional(Schema.String), cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not read this Thread's secrets to hide them, so this was not stored or shown. Try again.";
  }
}

/** A value a process of the Thread received, as SecretDelivery hands it out. */
export interface DeliveredSecret {
  readonly name: string;
  readonly value: string;
  readonly valueId: string;
}

/** A Thread whose creation is being written: where it will be, and whose it is. */
export interface ThreadPlacementHint {
  readonly ownerUserId: UserId | undefined;
  readonly spaceId: SpaceId | undefined;
  readonly projectId: ProjectId | null;
}

export class SecretMasker extends Context.Service<
  SecretMasker,
  {
    /**
     * The masker of a Thread (its root's: a child Thread's tools run in its root's process). A
     * Thread not written yet uses `hint` (its owner's set where it will be), else masks nothing:
     * no process of it ran. Fails rather than mask with too little.
     */
    readonly forThread: (
      threadId: ThreadId | string,
      hint?: ThreadPlacementHint,
    ) => Effect.Effect<ThreadMasker, SecretMaskingError>;
    /**
     * A checkout on the Hub machine, for the User who asks (the request's principal): their own
     * Threads that run there. Another User's values never mask what one User sees (a guess would
     * come back as `[NAME]`); a call no User makes masks nothing.
     */
    readonly forCheckout: (cwd: string) => Effect.Effect<ThreadMasker, SecretMaskingError>;
    /** A change request, for the User who asks: their own Threads linked to it. As `forCheckout`. */
    readonly forPullRequest: (key: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ThreadMasker, SecretMaskingError>;
    /** Values handed to a process of the Thread: masked from now on, for the Thread's life. */
    readonly remember: (
      threadId: ThreadId,
      secrets: ReadonlyArray<DeliveredSecret>,
    ) => Effect.Effect<void>;
  }
>()("t3/vaults/SecretMasker") {}

/** How long a Thread's set is reused before its owner's effective set is read again. */
const MASKER_TTL_MS = 30_000;
const MAX_CACHED = 2048;

interface Entry {
  readonly loadedAt: number;
  /** In precedence order: the effective set's winners first, then what was delivered before. */
  readonly secrets: ReadonlyArray<MaskableSecret>;
  readonly masker: ThreadMasker;
}

const entryOf = (loadedAt: number, secrets: ReadonlyArray<MaskableSecret>): Entry => {
  // This process's own logs and spans mask them too (never what a client sees).
  rememberKnownSecrets(secrets);
  return { loadedAt, secrets, masker: maskerOf(secrets) };
};

const union = (
  first: ReadonlyArray<MaskableSecret>,
  second: ReadonlyArray<MaskableSecret>,
): ReadonlyArray<MaskableSecret> => [
  ...first,
  ...second.filter((secret) => !first.some((s) => s.value === secret.value)),
];

const setBounded = <K, V>(map: Map<K, V>, key: K, value: V) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const effective = yield* Effect.serviceOption(EffectiveVaults.EffectiveVaults);
  const values = yield* Effect.serviceOption(ServerSecretStore.VaultValueStore);
  const cache = new Map<string, Entry>();
  const roots = new Map<string, string>();
  // A value id names one value for good (a replace writes a new id): read once.
  const decrypted = new Map<string, string>();
  const loading = new Map<string, Deferred.Deferred<Entry | undefined, SecretMaskingError>>();

  const failed = (threadId: string | undefined) => (cause: unknown) =>
    new SecretMaskingError({ ...(threadId === undefined ? {} : { threadId }), cause });

  /** The Thread's root, or undefined while it is not projected (never cached then). */
  const rootOf = Effect.fnUntraced(function* (threadId: string) {
    const known = roots.get(threadId);
    if (known !== undefined) return known;
    const rows = yield* sql<{ readonly root: string | null }>`
      SELECT json_extract(payload_json, '$.lineage.rootThreadId') AS root
      FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `;
    if (rows.length === 0) return undefined;
    const root = rows[0]?.root ?? threadId;
    setBounded(roots, threadId, root);
    return root;
  });

  const readValue = Effect.fnUntraced(function* (valueId: string) {
    const known = decrypted.get(valueId);
    if (known !== undefined) return Option.some(known);
    if (Option.isNone(values)) return Option.none<string>();
    const bytes = yield* values.value.get(valueId);
    if (Option.isNone(bytes)) return Option.none<string>();
    const value = new TextDecoder().decode(bytes.value);
    setBounded(decrypted, valueId, value);
    return Option.some(value);
  });

  const valuesOf = Effect.fnUntraced(function* (
    variables: ReadonlyArray<{ readonly name: string; readonly valueId: string }>,
    into: Array<MaskableSecret>,
  ) {
    for (const variable of variables) {
      const value = yield* readValue(variable.valueId);
      if (Option.isSome(value) && !into.some((s) => s.value === value.value)) {
        into.push({ name: variable.name, value: value.value });
      }
    }
  });

  /** An owner's effective set: nothing for a User no longer in the Space; storage fails. */
  const effectiveSet = (compute: Effect.Effect<EffectiveVaults.EffectiveSet, VaultError>) =>
    compute.pipe(
      Effect.map((set) => set.variables.filter((variable) => !variable.unmasked)),
      Effect.catchIf(
        (error) => error.reason !== "storage",
        () => Effect.succeed([]),
      ),
    );

  /** What the root Thread's processes received, and its owner's effective set now. */
  const load = Effect.fnUntraced(function* (root: string) {
    const threads = yield* sql<{ readonly ownerUserId: string | null }>`
      SELECT owner_user_id AS "ownerUserId" FROM orchestration_v2_projection_threads
      WHERE thread_id = ${root}
    `;
    const secrets: Array<MaskableSecret> = [];
    const owner = threads[0]?.ownerUserId ?? null;
    if (owner !== null && Option.isSome(effective)) {
      const set = yield* effectiveSet(
        effective.value.forThread({
          threadId: root as ThreadId,
          actingUserId: UserId.make(owner),
        }),
      );
      yield* valuesOf(set, secrets);
    }
    // Delivered to the root or to a child of it (rows written before the child had a root).
    const remembered = yield* sql<{ readonly valueId: string; readonly name: string }>`
      SELECT value_id AS "valueId", name FROM thread_secret_values
      WHERE thread_id = ${root} OR thread_id IN (
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE json_extract(payload_json, '$.lineage.rootThreadId') = ${root}
      )
      ORDER BY remembered_at DESC
    `;
    yield* valuesOf(remembered, secrets);
    return secrets;
  });

  /** One load per root at a time; the others wait for it. */
  const loadEntry = (root: string, now: number) =>
    Effect.suspend(() => {
      const running = loading.get(root);
      if (running !== undefined) return Deferred.await(running);
      return Effect.uninterruptible(
        Effect.gen(function* () {
          const done = yield* Deferred.make<Entry | undefined, SecretMaskingError>();
          loading.set(root, done);
          const exit = yield* Effect.exit(
            load(root).pipe(
              Effect.map((loaded) => {
                // What was delivered before (or while this loaded) stays.
                const entry = entryOf(now, union(loaded, cache.get(root)?.secrets ?? []));
                setBounded(cache, root, entry);
                return entry as Entry | undefined;
              }),
              Effect.mapError(failed(root)),
            ),
          );
          loading.delete(root);
          yield* Deferred.done(done, exit);
          return yield* exit;
        }),
      );
    });

  const secretsFor = Effect.fnUntraced(function* (
    threadId: string,
    hint: ThreadPlacementHint | undefined,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const root = yield* rootOf(threadId).pipe(Effect.mapError(failed(threadId)));
    if (root === undefined) {
      // Being created: its owner's set where it will be (its first message and title come now).
      const delivered = cache.get(threadId)?.secrets ?? [];
      if (hint?.ownerUserId === undefined || Option.isNone(effective)) return delivered;
      const set = yield* effectiveSet(
        effective.value.forPlacement({
          threadId: threadId as ThreadId,
          spaceId: hint.spaceId,
          projectId: hint.projectId,
          actingUserId: hint.ownerUserId,
        }),
      ).pipe(Effect.mapError(failed(threadId)));
      const secrets: Array<MaskableSecret> = [];
      yield* valuesOf(set, secrets).pipe(Effect.mapError(failed(threadId)));
      return union(secrets, delivered);
    }
    const cached = cache.get(root);
    if (cached !== undefined && now - cached.loadedAt < MASKER_TTL_MS) return cached.secrets;
    const loaded = yield* loadEntry(root, now).pipe(
      // Fails closed: a set read before (the Thread's own, a little old) or nothing at all.
      Effect.catch((error) =>
        cached === undefined
          ? Effect.fail(error)
          : Effect.logWarning("SecretMasker: using the Thread's last read secrets", {
              threadId,
              cause: error,
            }).pipe(Effect.as(cached)),
      ),
    );
    return loaded?.secrets ?? [];
  });

  const forThread = Effect.fnUntraced(function* (
    threadId: ThreadId | string,
    hint?: ThreadPlacementHint,
  ) {
    const root = roots.get(threadId);
    if (root !== undefined) {
      const cached = cache.get(root);
      const now = yield* Clock.currentTimeMillis;
      if (cached !== undefined && now - cached.loadedAt < MASKER_TTL_MS) return cached.masker;
    }
    const secrets = yield* secretsFor(threadId, hint);
    const fresh = cache.get(roots.get(threadId) ?? threadId);
    return fresh !== undefined && fresh.secrets === secrets ? fresh.masker : maskerOf(secrets);
  });

  /** The Threads' sets together: text several of them could have written. */
  const forThreads = Effect.fnUntraced(function* (threadIds: ReadonlyArray<string>) {
    let secrets: ReadonlyArray<MaskableSecret> = [];
    for (const threadId of new Set(threadIds)) {
      secrets = union(secrets, yield* secretsFor(threadId, undefined));
    }
    return secrets.length === 0 ? noSecrets : maskerOf(secrets);
  });

  /** The User the current request is made for, if one is (decision A: only their values). */
  const viewer = Effect.map(Effect.serviceOption(EnvironmentAuthenticatedPrincipal), (principal) =>
    Option.flatMap(principal, (found) => Option.fromNullishOr(found.userId)),
  );

  const forCheckout = Effect.fn("SecretMasker.forCheckout")(function* (cwd: string) {
    const userId = yield* viewer;
    if (Option.isNone(userId)) return noSecrets;
    const rows = yield* sql<{ readonly threadId: string }>`
      SELECT t.thread_id AS "threadId" FROM orchestration_v2_projection_threads t
      LEFT JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.deleted_at IS NULL AND t.owner_user_id = ${userId.value}
        AND COALESCE(t.active_environment_id, ${HUB_MACHINE_ENVIRONMENT_ID}) = ${HUB_MACHINE_ENVIRONMENT_ID}
        AND COALESCE(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) = ${cwd}
    `.pipe(Effect.mapError(failed(undefined)));
    return yield* forThreads(rows.map((row) => row.threadId));
  });

  const forPullRequest = Effect.fn("SecretMasker.forPullRequest")(function* (key: {
    readonly repository: string;
    readonly number: number;
  }) {
    const userId = yield* viewer;
    if (Option.isNone(userId)) return noSecrets;
    const rows = yield* sql<{ readonly threadId: string; readonly repository: string | null }>`
      SELECT t.thread_id AS "threadId", json_extract(link.value, '$.repository') AS repository
      FROM orchestration_v2_projection_threads AS t
      JOIN json_each(t.payload_json, '$.pullRequests') AS link
      WHERE json_extract(link.value, '$.number') = ${key.number} AND t.deleted_at IS NULL
        AND t.owner_user_id = ${userId.value}
    `.pipe(Effect.mapError(failed(undefined)));
    const repository = key.repository.toLowerCase();
    return yield* forThreads(
      rows.filter((row) => row.repository?.toLowerCase() === repository).map((row) => row.threadId),
    );
  });

  const remember = Effect.fn("SecretMasker.remember")(function* (
    threadId: ThreadId,
    delivered: ReadonlyArray<DeliveredSecret>,
  ) {
    if (delivered.length === 0) return;
    for (const secret of delivered) setBounded(decrypted, secret.valueId, secret.value);
    const root = (yield* rootOf(threadId).pipe(Effect.orElseSucceed(() => undefined))) ?? threadId;
    // Masked in memory first: output can arrive before the row is written. Without a read set
    // (loadedAt 0) the next use still reads the rest.
    const current = cache.get(root);
    const added = delivered.map(({ name, value }) => ({ name, value }));
    setBounded(cache, root, entryOf(current?.loadedAt ?? 0, union(added, current?.secrets ?? [])));
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.forEach(
      delivered,
      (secret) => sql`
        INSERT INTO thread_secret_values (thread_id, value_id, name, remembered_at)
        VALUES (${root}, ${secret.valueId}, ${secret.name}, ${at})
        ON CONFLICT (thread_id, value_id) DO UPDATE SET name = excluded.name
      `,
      { discard: true },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("SecretMasker: could not record a Thread's secrets", {
          threadId,
          cause,
        }),
      ),
    );
  });

  // After a restart this process's own logs and spans mask every value at once (not only once a
  // Thread's masker is read). Never used for what a client sees.
  yield* Effect.gen(function* () {
    const rows = yield* sql<{ readonly name: string; readonly valueId: string }>`
      SELECT name, value_id AS "valueId" FROM vault_entries
      WHERE value_id IS NOT NULL AND unmasked = 0
      UNION SELECT name, value_id AS "valueId" FROM thread_secret_values
    `;
    const secrets: Array<MaskableSecret> = [];
    yield* valuesOf(rows, secrets);
    rememberKnownSecrets(secrets);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("SecretMasker: could not read the values for log masking", { cause }),
    ),
  );

  return SecretMasker.of({ forThread, forCheckout, forPullRequest, remember });
});

export const layer = Layer.effect(SecretMasker, make);
