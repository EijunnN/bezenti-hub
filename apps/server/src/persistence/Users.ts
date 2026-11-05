import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { UserId } from "@t3tools/contracts";

import { PersistenceDecodeError, PersistenceSqlError, type UserRepositoryError } from "./Errors.ts";

export const UserRecord = Schema.Struct({
  userId: UserId,
  displayName: Schema.String,
  isOwner: Schema.BooleanFromBit,
  createdAt: Schema.DateTimeUtcFromString,
  disabledAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  removedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type UserRecord = typeof UserRecord.Type;

const PasskeyFields = {
  credentialId: Schema.String,
  /** Base64url COSE public key. */
  publicKey: Schema.String,
  signCount: Schema.Int,
  transports: Schema.fromJsonString(Schema.Array(Schema.String)),
  rpId: Schema.String,
};

export const PasskeyRecord = Schema.Struct({ ...PasskeyFields, userId: UserId });
export type PasskeyRecord = typeof PasskeyRecord.Type;

export const CreateOwnerInput = Schema.Struct({
  userId: UserId,
  displayName: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  passkey: Schema.Struct(PasskeyFields),
  recoveryCodeHashes: Schema.Array(Schema.String),
});
export type CreateOwnerInput = typeof CreateOwnerInput.Type;

const RecordPasskeyUseInput = Schema.Struct({
  credentialId: Schema.String,
  signCount: Schema.Int,
  usedAt: Schema.DateTimeUtcFromString,
});

const ConsumeRecoveryCodeInput = Schema.Struct({
  codeHash: Schema.String,
  usedAt: Schema.DateTimeUtcFromString,
});

export class UserRepository extends Context.Service<
  UserRepository,
  {
    readonly hasOwner: () => Effect.Effect<boolean, UserRepositoryError>;
    /** Creates the Owner with its first passkey and recovery codes; false when one exists. */
    readonly createOwner: (input: CreateOwnerInput) => Effect.Effect<boolean, UserRepositoryError>;
    readonly getById: (
      userId: UserId,
    ) => Effect.Effect<Option.Option<UserRecord>, UserRepositoryError>;
    readonly getPasskey: (
      credentialId: string,
    ) => Effect.Effect<Option.Option<PasskeyRecord>, UserRepositoryError>;
    readonly recordPasskeyUse: (
      input: typeof RecordPasskeyUseInput.Type,
    ) => Effect.Effect<void, UserRepositoryError>;
    /** Marks an unused code used and returns its User; none when unknown or already used. */
    readonly consumeRecoveryCode: (
      input: typeof ConsumeRecoveryCodeInput.Type,
    ) => Effect.Effect<Option.Option<UserId>, UserRepositoryError>;
  }
>()("t3/persistence/Users/UserRepository") {}

const toUserRepositoryError =
  (operation: string) =>
  (cause: unknown): UserRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findOwner = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ userId: UserId }),
    execute: () => sql`SELECT user_id AS "userId" FROM users WHERE is_owner = 1`,
  });

  const insertOwner = SqlSchema.void({
    Request: CreateOwnerInput,
    execute: Effect.fn("UserRepository.insertOwner")(function* (input) {
      yield* sql`
          INSERT INTO users (user_id, display_name, is_owner, created_at)
          VALUES (${input.userId}, ${input.displayName}, 1, ${input.createdAt})
        `;
      yield* sql`
          INSERT INTO user_passkeys (
            credential_id, user_id, public_key, sign_count, transports, rp_id, created_at
          )
          VALUES (
            ${input.passkey.credentialId},
            ${input.userId},
            ${input.passkey.publicKey},
            ${input.passkey.signCount},
            ${input.passkey.transports},
            ${input.passkey.rpId},
            ${input.createdAt}
          )
        `;
      yield* Effect.forEach(
        input.recoveryCodeHashes,
        (codeHash) => sql`
            INSERT INTO user_recovery_codes (code_hash, user_id, created_at)
            VALUES (${codeHash}, ${input.userId}, ${input.createdAt})
          `,
        { discard: true },
      );
    }),
  });

  const findUserById = SqlSchema.findOneOption({
    Request: UserId,
    Result: UserRecord,
    execute: (userId) => sql`
      SELECT
        user_id AS "userId",
        display_name AS "displayName",
        is_owner AS "isOwner",
        created_at AS "createdAt",
        disabled_at AS "disabledAt",
        removed_at AS "removedAt"
      FROM users
      WHERE user_id = ${userId}
    `,
  });

  const findPasskey = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: PasskeyRecord,
    execute: (credentialId) => sql`
      SELECT
        credential_id AS "credentialId",
        user_id AS "userId",
        public_key AS "publicKey",
        sign_count AS "signCount",
        transports AS "transports",
        rp_id AS "rpId"
      FROM user_passkeys
      WHERE credential_id = ${credentialId}
    `,
  });

  const updatePasskeyUse = SqlSchema.void({
    Request: RecordPasskeyUseInput,
    execute: ({ credentialId, signCount, usedAt }) => sql`
      UPDATE user_passkeys
      SET sign_count = ${signCount}, last_used_at = ${usedAt}
      WHERE credential_id = ${credentialId}
    `,
  });

  const useRecoveryCode = SqlSchema.findOneOption({
    Request: ConsumeRecoveryCodeInput,
    Result: Schema.Struct({ userId: UserId }),
    execute: ({ codeHash, usedAt }) => sql`
      UPDATE user_recovery_codes
      SET used_at = ${usedAt}
      WHERE code_hash = ${codeHash} AND used_at IS NULL
      RETURNING user_id AS "userId"
    `,
  });

  return UserRepository.of({
    hasOwner: Effect.fn("UserRepository.hasOwner")(function () {
      return findOwner(undefined).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.isSome),
        Effect.mapError(toUserRepositoryError("UserRepository.hasOwner")),
      );
    }),
    createOwner: Effect.fn("UserRepository.createOwner")(function (input) {
      return sql
        .withTransaction(
          findOwner(undefined).pipe(
            Effect.flatMap((owner) =>
              Option.isSome(owner)
                ? Effect.succeed(false)
                : insertOwner(input).pipe(Effect.as(true)),
            ),
          ),
        )
        .pipe(
          // Another writer created the Owner between the check and the insert.
          Effect.catchIf(
            (error) => !Schema.isSchemaError(error) && error.reason._tag === "UniqueViolation",
            () => Effect.succeed(false),
          ),
          Effect.mapError(toUserRepositoryError("UserRepository.createOwner")),
        );
    }),
    getById: Effect.fn("UserRepository.getById")(function (userId) {
      return findUserById(userId).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toUserRepositoryError("UserRepository.getById")),
      );
    }),
    getPasskey: Effect.fn("UserRepository.getPasskey")(function (credentialId) {
      return findPasskey(credentialId).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toUserRepositoryError("UserRepository.getPasskey")),
      );
    }),
    recordPasskeyUse: Effect.fn("UserRepository.recordPasskeyUse")(function (input) {
      return updatePasskeyUse(input).pipe(
        Effect.mapError(toUserRepositoryError("UserRepository.recordPasskeyUse")),
      );
    }),
    consumeRecoveryCode: Effect.fn("UserRepository.consumeRecoveryCode")(function (input) {
      return useRecoveryCode(input).pipe(
        Effect.map(Option.map((row) => row.userId)),
        Effect.mapError(toUserRepositoryError("UserRepository.consumeRecoveryCode")),
      );
    }),
  });
});

export const layer = Layer.effect(UserRepository, make);
