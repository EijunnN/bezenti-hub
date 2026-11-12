/**
 * Spec 5 ticket 04: the one place that turns a Thread's effective set into one process's secrets,
 * read from the store as it starts and kept nowhere. Who receives them is decided here, on the Hub
 * (a turn: its Thread owner; a terminal or script: who starts it). docs/internals/secrets.md.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a sync hash of names and value ids, never of values.
import * as NodeCrypto from "node:crypto";
import {
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  SECRET_ENV_CONTRACT_VERSION,
  type SecretEnv,
  SecretDeliveryError,
  type ThreadId,
  UserId,
  VaultError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { servesSpace } from "../sandboxes/sandboxSpace.ts";
import * as EffectiveVaults from "./EffectiveVaults.ts";

/** The fingerprint of no secrets: what a process started without any has. */
const NO_SECRETS_FINGERPRINT = "none";

/** The machine a process starts on: the Thread's Active environment, and its executor contract. */
export interface SecretTarget {
  readonly environmentId: EnvironmentId;
  readonly contractVersion: number;
}

export type SecretDeliveryFailure = VaultError | SecretDeliveryError;

export class SecretDelivery extends Context.Service<
  SecretDelivery,
  {
    /** Whose secrets the Thread's turns receive: its owner, or its root Thread's. */
    readonly turnOwner: (threadId: ThreadId) => Effect.Effect<Option.Option<UserId>, VaultError>;
    /**
     * The secrets a process of the Thread receives when `actingUserId` starts it on `target`; none
     * without a User, for a Thread that is gone, or on a machine that does not serve its Space.
     */
    readonly forProcess: (input: {
      readonly threadId: ThreadId;
      readonly actingUserId: UserId | undefined;
      readonly target: SecretTarget;
    }) => Effect.Effect<SecretEnv | undefined, SecretDeliveryFailure>;
    /** Whether the Thread's turns receive any secret (names only: no value is read). */
    readonly receivesSecrets: (threadId: ThreadId) => Effect.Effect<boolean, VaultError>;
    /** `forProcess` for the Thread's turns: its owner starts them. */
    readonly forTurn: (input: {
      readonly threadId: ThreadId;
      readonly target: SecretTarget;
    }) => Effect.Effect<SecretEnv | undefined, SecretDeliveryFailure>;
  }
>()("t3/vaults/SecretDelivery") {}

/** The fingerprint of a set: its names and value ids (a replace writes a new id), never values. */
const fingerprintOf = (
  actingUserId: UserId,
  variables: ReadonlyArray<{ readonly name: string; readonly valueId: string }>,
): string =>
  variables.length === 0
    ? NO_SECRETS_FINGERPRINT
    : NodeCrypto.createHash("sha256")
        .update(JSON.stringify([actingUserId, variables.map((v) => [v.name, v.valueId])]))
        .digest("hex")
        .slice(0, 32);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const effective = yield* EffectiveVaults.EffectiveVaults;
  const values = yield* ServerSecretStore.VaultValueStore;

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`SecretDelivery: could not ${what}`, { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new VaultError({ reason: "storage", message: `Could not ${what}. Try again.` }),
        ),
      ),
    );

  const turnOwner = Effect.fn("SecretDelivery.turnOwner")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ readonly ownerUserId: string | null }>`
      SELECT COALESCE(t.owner_user_id, root.owner_user_id) AS "ownerUserId"
      FROM orchestration_v2_projection_threads t
      LEFT JOIN orchestration_v2_projection_threads root
        ON root.thread_id = json_extract(t.payload_json, '$.lineage.rootThreadId')
      WHERE t.thread_id = ${threadId}
    `.pipe(Effect.catch(storage("read who owns the Thread")));
    const owner = rows[0]?.ownerUserId ?? null;
    return owner === null ? Option.none<UserId>() : Option.some(UserId.make(owner));
  });

  /** A name that changes how tools run reaches a process only as the Owner last set it. */
  const ownerSet = Effect.fn("SecretDelivery.ownerSet")(function* (
    valueIds: ReadonlyArray<string>,
  ) {
    if (valueIds.length === 0) return new Set<string>();
    const rows = yield* sql<{ readonly valueId: string }>`
      SELECT e.value_id AS "valueId" FROM vault_entries e
      JOIN users u ON u.user_id = e.updated_by AND u.is_owner = 1
      WHERE e.value_id IN ${sql.in(valueIds)}
    `.pipe(Effect.catch(storage("check who set the Thread's secrets")));
    return new Set(rows.map((row) => row.valueId));
  });

  const machineName = (environmentId: EnvironmentId) =>
    sql<{ readonly name: string }>`
      SELECT name FROM environments WHERE environment_id = ${environmentId}
    `.pipe(
      Effect.map((rows) => rows[0]?.name),
      Effect.orElseSucceed(() => undefined),
    );

  const forProcess = Effect.fn("SecretDelivery.forProcess")(function* (input: {
    readonly threadId: ThreadId;
    readonly actingUserId: UserId | undefined;
    readonly target: SecretTarget;
  }) {
    if (input.actingUserId === undefined) return undefined;
    const set = yield* effective
      .forThread({ threadId: input.threadId, actingUserId: input.actingUserId })
      .pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason === "not-found",
          () => Effect.succeedNone,
        ),
      );
    if (Option.isNone(set) || set.value.variables.length === 0) return undefined;
    // A machine that does not run this Space's Threads gets nothing (spec 3, ticket 12).
    if (input.target.environmentId !== HUB_MACHINE_ENVIRONMENT_ID) {
      const serves = yield* servesSpace(
        input.target.environmentId,
        set.value.spaceId,
        input.threadId,
      ).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catch(storage("check the machine's Space")),
      );
      if (!serves) return undefined;
    }
    if (input.target.contractVersion < SECRET_ENV_CONTRACT_VERSION) {
      const environmentName = yield* machineName(input.target.environmentId);
      return yield* new SecretDeliveryError({
        reason: "outdated-machine",
        ...(environmentName === undefined ? {} : { environmentName }),
      });
    }
    const trusted = yield* ownerSet(
      set.value.variables.filter((v) => v.dangerous).map((v) => v.valueId),
    );
    const delivered: Array<{ name: string; valueId: string; value: string }> = [];
    for (const variable of set.value.variables) {
      if (variable.dangerous && !trusted.has(variable.valueId)) continue;
      const bytes = yield* values
        .get(variable.valueId)
        .pipe(Effect.catch(storage("read the Thread's secrets")));
      // A value gone from the store (a race with a delete) is left out, never sent empty.
      if (Option.isNone(bytes)) continue;
      delivered.push({
        name: variable.name,
        valueId: variable.valueId,
        value: new TextDecoder().decode(bytes.value),
      });
    }
    if (delivered.length === 0) return undefined;
    return {
      fingerprint: fingerprintOf(input.actingUserId, delivered),
      variables: delivered.map(({ name, value }) => ({ name, value })),
    } satisfies SecretEnv;
  });

  const forTurn = Effect.fn("SecretDelivery.forTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly target: SecretTarget;
  }) {
    const owner = yield* turnOwner(input.threadId);
    return yield* forProcess({
      threadId: input.threadId,
      actingUserId: Option.getOrUndefined(owner),
      target: input.target,
    });
  });

  const receivesSecrets = Effect.fn("SecretDelivery.receivesSecrets")(function* (
    threadId: ThreadId,
  ) {
    const owner = yield* turnOwner(threadId);
    if (Option.isNone(owner)) return false;
    return yield* effective.forThread({ threadId, actingUserId: owner.value }).pipe(
      Effect.map((set) => set.variables.length > 0),
      Effect.catchIf(
        (error) => error.reason === "not-found",
        () => Effect.succeed(false),
      ),
    );
  });

  return SecretDelivery.of({ turnOwner, forProcess, receivesSecrets, forTurn });
});

export const layer = Layer.effect(SecretDelivery, make);

/** The fingerprint a process started with `secretEnv` has. */
export const fingerprintOfEnv = (secretEnv: SecretEnv | undefined): string =>
  secretEnv?.fingerprint ?? NO_SECRETS_FINGERPRINT;
