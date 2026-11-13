/**
 * Spec 5 ticket 05: a Thread's secret values as `[NAME]` in what the Hub stores or shows: every
 * value its processes received (kept in `thread_secret_values` for the Thread's life, rotated ones
 * too) and its owner's effective set now. Where it applies: `MaskedPaths.ts`.
 */
import { type ThreadId, UserId } from "@t3tools/contracts";
import {
  knownSecretPatterns,
  type MaskableSecret,
  makeSecretPatterns,
  maskDeep,
  rememberKnownSecrets,
  type SecretPatterns,
} from "@t3tools/shared/secretMasking";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

/** The values this process knows: for text that names no Thread. */
const processMasker = (): ThreadMasker => threadMaskerOf(knownSecretPatterns());

/** A value a process of the Thread received, as SecretDelivery hands it out. */
export interface DeliveredSecret {
  readonly name: string;
  readonly value: string;
  readonly valueId: string;
}

export class SecretMasker extends Context.Service<
  SecretMasker,
  {
    /**
     * The masker of a Thread (its root's: a child Thread's tools run in its root's process). Never
     * fails: when its values cannot be read, every value this process knows masks instead.
     * Without a Thread, the values this process knows.
     */
    readonly forThread: (threadId: ThreadId | string | undefined) => Effect.Effect<ThreadMasker>;
    /** Values handed to a process of the Thread: masked from now on, for the Thread's life. */
    readonly remember: (
      threadId: ThreadId,
      secrets: ReadonlyArray<DeliveredSecret>,
    ) => Effect.Effect<void>;
  }
>()("t3/vaults/SecretMasker") {}

/** How long a Thread's masker is reused before its owner's effective set is read again. */
const MASKER_TTL_MS = 5 * 60_000;
const MAX_CACHED_THREADS = 2048;

interface Entry {
  readonly loadedAt: number;
  /** In precedence order: the effective set's winners first, then what was delivered before. */
  readonly secrets: ReadonlyArray<MaskableSecret>;
  readonly masker: ThreadMasker;
}

const entryOf = (loadedAt: number, secrets: ReadonlyArray<MaskableSecret>): Entry => {
  rememberKnownSecrets(secrets);
  return { loadedAt, secrets, masker: threadMaskerOf(makeSecretPatterns(secrets)) };
};

const setBounded = <K, V>(map: Map<K, V>, key: K, value: V) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHED_THREADS) {
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

  const rootOf = Effect.fn("SecretMasker.rootOf")(function* (threadId: string) {
    const known = roots.get(threadId);
    if (known !== undefined) return known;
    const rows = yield* sql<{ readonly root: string | null }>`
      SELECT json_extract(payload_json, '$.lineage.rootThreadId') AS root
      FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `;
    // A Thread not projected yet (its creation is being written) is its own root for now.
    if (rows.length === 0) return threadId;
    const root = rows[0]?.root ?? threadId;
    setBounded(roots, threadId, root);
    return root;
  });

  const readValue = (valueId: string) =>
    Option.isNone(values)
      ? Effect.succeed(Option.none<string>())
      : values.value
          .get(valueId)
          .pipe(Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))));

  /** What the Thread's processes received, and its owner's effective set now. */
  const load = Effect.fn("SecretMasker.load")(function* (root: string) {
    const secrets: Array<MaskableSecret> = [];
    const seen = new Set<string>();
    const owner = yield* sql<{ readonly ownerUserId: string | null }>`
      SELECT owner_user_id AS "ownerUserId" FROM orchestration_v2_projection_threads
      WHERE thread_id = ${root}
    `.pipe(Effect.map((rows) => rows[0]?.ownerUserId ?? null));
    if (owner !== null && Option.isSome(effective)) {
      const set = yield* effective.value
        .forThread({ threadId: root as ThreadId, actingUserId: UserId.make(owner) })
        .pipe(
          Effect.map((set) => set.variables),
          // A User no longer in the Space receives nothing more; what they received stays below.
          Effect.orElseSucceed(() => []),
        );
      for (const variable of set) {
        if (variable.unmasked || seen.has(variable.valueId)) continue;
        const value = yield* readValue(variable.valueId);
        if (Option.isNone(value)) continue;
        seen.add(variable.valueId);
        secrets.push({ name: variable.name, value: value.value });
      }
    }
    const remembered = yield* sql<{ readonly valueId: string; readonly name: string }>`
      SELECT value_id AS "valueId", name FROM thread_secret_values
      WHERE thread_id = ${root} ORDER BY remembered_at DESC
    `;
    for (const row of remembered) {
      if (seen.has(row.valueId)) continue;
      const value = yield* readValue(row.valueId);
      if (Option.isNone(value)) continue;
      seen.add(row.valueId);
      secrets.push({ name: row.name, value: value.value });
    }
    return secrets;
  });

  const forThread = Effect.fn("SecretMasker.forThread")(function* (
    threadId: ThreadId | string | undefined,
  ) {
    if (threadId === undefined) return processMasker();
    return yield* Effect.gen(function* () {
      const root = yield* rootOf(threadId);
      const now = yield* Clock.currentTimeMillis;
      const cached = cache.get(root);
      if (cached !== undefined && now - cached.loadedAt < MASKER_TTL_MS) return cached.masker;
      const loaded = yield* load(root);
      // What was delivered before (or while this loaded) stays, even if its row is not written.
      const latest = cache.get(root)?.secrets ?? [];
      const merged = entryOf(now, [
        ...loaded,
        ...latest.filter((secret) => !loaded.some((s) => s.value === secret.value)),
      ]);
      setBounded(cache, root, merged);
      return merged.masker;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("SecretMasker: could not read a Thread's secrets; masking every known", {
          threadId,
          cause,
        }).pipe(Effect.andThen(Effect.sync(processMasker))),
      ),
    );
  });

  const remember = Effect.fn("SecretMasker.remember")(function* (
    threadId: ThreadId,
    delivered: ReadonlyArray<DeliveredSecret>,
  ) {
    if (delivered.length === 0) return;
    // Masked in memory first: output can arrive before the row is written.
    rememberKnownSecrets(delivered);
    const root = yield* rootOf(threadId).pipe(Effect.orElseSucceed(() => threadId as string));
    const current = cache.get(root);
    const kept = current?.secrets ?? [];
    const added = delivered.filter((secret) => !kept.some((s) => s.value === secret.value));
    if (added.length > 0 || current === undefined) {
      // Without a loaded entry (loadedAt 0) the next use still reads what came before.
      setBounded(
        cache,
        root,
        entryOf(current?.loadedAt ?? 0, [
          ...added.map(({ name, value }) => ({ name, value })),
          ...kept,
        ]),
      );
    }
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

  return SecretMasker.of({ forThread, remember });
});

export const layer = Layer.effect(SecretMasker, make);
