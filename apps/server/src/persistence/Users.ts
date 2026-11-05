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
  loginName: Schema.NullOr(Schema.String),
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

export const UserCredentials = Schema.Struct({
  passwordHash: Schema.NullOr(Schema.String),
  totpSecretCiphertext: Schema.NullOr(Schema.String),
});
export type UserCredentials = typeof UserCredentials.Type;

const SetPasswordInput = Schema.Struct({
  userId: UserId,
  loginName: Schema.String,
  passwordHash: Schema.String,
  updatedAt: Schema.DateTimeUtcFromString,
});

const SetTotpInput = Schema.Struct({
  userId: UserId,
  secretCiphertext: Schema.String,
  step: Schema.Int,
  enrolledAt: Schema.DateTimeUtcFromString,
});

const RecordTotpStepInput = Schema.Struct({ userId: UserId, step: Schema.Int });

const CreateResetLinkInput = Schema.Struct({
  linkId: Schema.String,
  userId: UserId,
  tokenHash: Schema.String,
  createdBy: Schema.NullOr(UserId),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});

const ResetLinkLookup = Schema.Struct({
  tokenHash: Schema.String,
  now: Schema.DateTimeUtcFromString,
});

const AddPasskeyInput = Schema.Struct({
  userId: UserId,
  passkey: Schema.Struct(PasskeyFields),
  createdAt: Schema.DateTimeUtcFromString,
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
    readonly getOwner: () => Effect.Effect<Option.Option<UserRecord>, UserRepositoryError>;
    readonly getByLoginName: (
      loginName: string,
    ) => Effect.Effect<Option.Option<UserRecord>, UserRepositoryError>;
    readonly getCredentials: (
      userId: UserId,
    ) => Effect.Effect<UserCredentials, UserRepositoryError>;
    /** Sets the login name and password together; false when another User has that name. */
    readonly setPassword: (
      input: typeof SetPasswordInput.Type,
    ) => Effect.Effect<boolean, UserRepositoryError>;
    readonly setTotp: (input: typeof SetTotpInput.Type) => Effect.Effect<void, UserRepositoryError>;
    /** Records a used TOTP step; false when that step or a later one was already used. */
    readonly recordTotpStep: (
      input: typeof RecordTotpStepInput.Type,
    ) => Effect.Effect<boolean, UserRepositoryError>;
    readonly createResetLink: (
      input: typeof CreateResetLinkInput.Type,
    ) => Effect.Effect<void, UserRepositoryError>;
    /** The User of an unused, unexpired reset link. */
    readonly findResetLink: (
      input: typeof ResetLinkLookup.Type,
    ) => Effect.Effect<Option.Option<UserId>, UserRepositoryError>;
    /** Marks an unused, unexpired link used and returns its User. */
    readonly consumeResetLink: (
      input: typeof ResetLinkLookup.Type,
    ) => Effect.Effect<Option.Option<UserId>, UserRepositoryError>;
    readonly addPasskey: (
      input: typeof AddPasskeyInput.Type,
    ) => Effect.Effect<void, UserRepositoryError>;
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

  const userColumns = sql.literal(`
    user_id AS "userId",
    display_name AS "displayName",
    login_name AS "loginName",
    is_owner AS "isOwner",
    created_at AS "createdAt",
    disabled_at AS "disabledAt",
    removed_at AS "removedAt"
  `);

  const findUserById = SqlSchema.findOneOption({
    Request: UserId,
    Result: UserRecord,
    execute: (userId) => sql`SELECT ${userColumns} FROM users WHERE user_id = ${userId}`,
  });

  const findOwnerRecord = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: UserRecord,
    execute: () => sql`SELECT ${userColumns} FROM users WHERE is_owner = 1`,
  });

  const findUserByLoginName = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: UserRecord,
    execute: (loginName) => sql`SELECT ${userColumns} FROM users WHERE login_name = ${loginName}`,
  });

  const findCredentials = SqlSchema.findOne({
    Request: UserId,
    Result: UserCredentials,
    execute: (userId) => sql`
      SELECT
        (SELECT password_hash FROM user_passwords WHERE user_id = ${userId}) AS "passwordHash",
        (SELECT secret_ciphertext FROM user_totp WHERE user_id = ${userId}) AS "totpSecretCiphertext"
    `,
  });

  const writePassword = SqlSchema.void({
    Request: SetPasswordInput,
    execute: Effect.fn("UserRepository.writePassword")(function* (input) {
      yield* sql`UPDATE users SET login_name = ${input.loginName} WHERE user_id = ${input.userId}`;
      yield* sql`
        INSERT INTO user_passwords (user_id, password_hash, updated_at)
        VALUES (${input.userId}, ${input.passwordHash}, ${input.updatedAt})
        ON CONFLICT (user_id) DO UPDATE
        SET password_hash = excluded.password_hash, updated_at = excluded.updated_at
      `;
    }),
  });

  const writeTotp = SqlSchema.void({
    Request: SetTotpInput,
    execute: (input) => sql`
      INSERT INTO user_totp (user_id, secret_ciphertext, enrolled_at, last_used_step)
      VALUES (${input.userId}, ${input.secretCiphertext}, ${input.enrolledAt}, ${input.step})
      ON CONFLICT (user_id) DO UPDATE
      SET
        secret_ciphertext = excluded.secret_ciphertext,
        enrolled_at = excluded.enrolled_at,
        last_used_step = excluded.last_used_step
    `,
  });

  const advanceTotpStep = SqlSchema.findOneOption({
    Request: RecordTotpStepInput,
    Result: Schema.Struct({ userId: UserId }),
    execute: ({ userId, step }) => sql`
      UPDATE user_totp
      SET last_used_step = ${step}
      WHERE user_id = ${userId} AND last_used_step < ${step}
      RETURNING user_id AS "userId"
    `,
  });

  const insertResetLink = SqlSchema.void({
    Request: CreateResetLinkInput,
    execute: (input) => sql`
      INSERT INTO user_reset_links (
        link_id, user_id, token_hash, created_by, created_at, expires_at
      )
      VALUES (
        ${input.linkId},
        ${input.userId},
        ${input.tokenHash},
        ${input.createdBy},
        ${input.createdAt},
        ${input.expiresAt}
      )
    `,
  });

  // ISO-8601 UTC strings of one width compare in time order.
  const findLiveResetLink = SqlSchema.findOneOption({
    Request: ResetLinkLookup,
    Result: Schema.Struct({ userId: UserId }),
    execute: ({ tokenHash, now }) => sql`
      SELECT user_id AS "userId"
      FROM user_reset_links
      WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > ${now}
    `,
  });

  const useResetLink = SqlSchema.findOneOption({
    Request: ResetLinkLookup,
    Result: Schema.Struct({ userId: UserId }),
    execute: ({ tokenHash, now }) => sql`
      UPDATE user_reset_links
      SET used_at = ${now}
      WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > ${now}
      RETURNING user_id AS "userId"
    `,
  });

  const insertPasskey = SqlSchema.void({
    Request: AddPasskeyInput,
    execute: ({ userId, passkey, createdAt }) => sql`
      INSERT INTO user_passkeys (
        credential_id, user_id, public_key, sign_count, transports, rp_id, created_at
      )
      VALUES (
        ${passkey.credentialId},
        ${userId},
        ${passkey.publicKey},
        ${passkey.signCount},
        ${passkey.transports},
        ${passkey.rpId},
        ${createdAt}
      )
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
    getOwner: Effect.fn("UserRepository.getOwner")(function () {
      return findOwnerRecord(undefined).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toUserRepositoryError("UserRepository.getOwner")),
      );
    }),
    getByLoginName: Effect.fn("UserRepository.getByLoginName")(function (loginName) {
      return findUserByLoginName(loginName).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toUserRepositoryError("UserRepository.getByLoginName")),
      );
    }),
    getCredentials: Effect.fn("UserRepository.getCredentials")(function (userId) {
      return findCredentials(userId).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toUserRepositoryError("UserRepository.getCredentials")),
      );
    }),
    setPassword: Effect.fn("UserRepository.setPassword")(function (input) {
      return sql.withTransaction(writePassword(input)).pipe(
        Effect.as(true),
        // Another User already signs in with this login name.
        Effect.catchIf(
          (error) => !Schema.isSchemaError(error) && error.reason._tag === "UniqueViolation",
          () => Effect.succeed(false),
        ),
        Effect.mapError(toUserRepositoryError("UserRepository.setPassword")),
      );
    }),
    setTotp: Effect.fn("UserRepository.setTotp")(function (input) {
      return writeTotp(input).pipe(
        Effect.mapError(toUserRepositoryError("UserRepository.setTotp")),
      );
    }),
    recordTotpStep: Effect.fn("UserRepository.recordTotpStep")(function (input) {
      return advanceTotpStep(input).pipe(
        Effect.map(Option.isSome),
        Effect.mapError(toUserRepositoryError("UserRepository.recordTotpStep")),
      );
    }),
    createResetLink: Effect.fn("UserRepository.createResetLink")(function (input) {
      return insertResetLink(input).pipe(
        Effect.mapError(toUserRepositoryError("UserRepository.createResetLink")),
      );
    }),
    findResetLink: Effect.fn("UserRepository.findResetLink")(function (input) {
      return findLiveResetLink(input).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.map((row) => row.userId)),
        Effect.mapError(toUserRepositoryError("UserRepository.findResetLink")),
      );
    }),
    consumeResetLink: Effect.fn("UserRepository.consumeResetLink")(function (input) {
      return useResetLink(input).pipe(
        Effect.map(Option.map((row) => row.userId)),
        Effect.mapError(toUserRepositoryError("UserRepository.consumeResetLink")),
      );
    }),
    addPasskey: Effect.fn("UserRepository.addPasskey")(function (input) {
      return insertPasskey(input).pipe(
        Effect.mapError(toUserRepositoryError("UserRepository.addPasskey")),
      );
    }),
  });
});

export const layer = Layer.effect(UserRepository, make);
