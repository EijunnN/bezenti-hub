import {
  type AuthAccount,
  type AuthPasskeyAuthenticationResponse,
  type AuthPasskeyRegistrationCeremony,
  type AuthPasskeyRegistrationResponse,
  type AuthPasskeySignInCeremony,
  type AuthPasswordSignInRequest,
  type AuthResetLinkStatus,
  type AuthSetPasswordRequest,
  type AuthTotpEnrollment,
  type AuthUser,
  UserId,
} from "@t3tools/contracts";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import * as Context from "effect/Context";
import * as Aead from "effect/crypto/Aead";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Users from "../persistence/Users.ts";
import * as AccountCredentials from "./AccountCredentials.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const CEREMONY_TTL = Duration.minutes(5);
// Sign-in challenges are unauthenticated, so they get their own bounded store; an Owner
// registration needs the bootstrap link and can never be evicted by them.
const MAX_PENDING_SIGN_INS = 1_000;
const MAX_PENDING_OWNER_REGISTRATIONS = 16;
const TOTP_ENROLLMENT_TTL = Duration.minutes(10);
const RESET_LINK_TTL = Duration.hours(1);
const CREDENTIAL_KEY_SECRET_NAME = "user-credential-key";
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 10;
// Crockford base32: 32 symbols, so `byte & 31` is unbiased; no I, L, O or U to misread.
const RECOVERY_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// COSE ES256, EdDSA and RS256: what platform authenticators and security keys produce.
const SUPPORTED_ALGORITHMS = [-7, -8, -257];

export class OwnerAlreadyClaimedError extends Schema.TaggedError<OwnerAlreadyClaimedError>()(
  "OwnerAlreadyClaimedError",
  {},
) {
  override get message(): string {
    return "This Installation already has an Owner.";
  }
}

export class PasskeyRejectedError extends Schema.TaggedError<PasskeyRejectedError>()(
  "PasskeyRejectedError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Passkey rejected: ${this.reason}.`;
  }
}

export class RecoveryCodeRejectedError extends Schema.TaggedError<RecoveryCodeRejectedError>()(
  "RecoveryCodeRejectedError",
  {},
) {
  override get message(): string {
    return "That recovery code is unknown or was already used.";
  }
}

/** A signed-in User's change to their own credentials that the account's rules refuse. */
export class AccountChangeRefusedError extends Schema.TaggedError<AccountChangeRefusedError>()(
  "AccountChangeRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class LoginNameTakenError extends Schema.TaggedError<LoginNameTakenError>()(
  "LoginNameTakenError",
  {},
) {
  override get message(): string {
    return "Another account already uses that sign-in name.";
  }
}

export class PasswordRejectedError extends Schema.TaggedError<PasswordRejectedError>()(
  "PasswordRejectedError",
  {},
) {
  override get message(): string {
    return "That sign-in name, password or code is not right.";
  }
}

export class ResetLinkRejectedError extends Schema.TaggedError<ResetLinkRejectedError>()(
  "ResetLinkRejectedError",
  {},
) {
  override get message(): string {
    return "This reset link expired or was already used.";
  }
}

export class NoOwnerError extends Schema.TaggedError<NoOwnerError>()("NoOwnerError", {}) {
  override get message(): string {
    return "This Installation has no Owner yet. Open the first-run setup link instead.";
  }
}

export class UserDirectoryStorageError extends Schema.TaggedError<UserDirectoryStorageError>()(
  "UserDirectoryStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read or write user accounts.";
  }
}

/** A verified Owner passkey registration, not yet stored. */
export interface PendingOwner {
  readonly userId: UserId;
  readonly displayName: string;
  readonly passkey: Users.CreateOwnerInput["passkey"];
}

/** A verified passkey registration for an existing User, not yet stored. */
export interface PendingPasskey {
  readonly userId: UserId;
  readonly passkey: Users.CreateOwnerInput["passkey"];
}

export type PasswordCheck =
  | { readonly _tag: "verified"; readonly user: AuthUser }
  | { readonly _tag: "totp-required" };

/**
 * Accounts that may use a password only together with TOTP. Today that is the Owner; Admins join
 * when Roles exist (see the sign-in rules in docs/internals/environment-auth.md).
 */
const passwordRequiresTotp = (user: Pick<Users.UserRecord, "isOwner">): boolean => user.isOwner;

interface Ceremony {
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
  readonly expiresAt: DateTime.DateTime;
}

interface OwnerRegistrationCeremony extends Ceremony {
  readonly userId: UserId;
  readonly displayName: string;
}

/**
 * Pending WebAuthn ceremonies, single use. Every entry has the same TTL, so insertion order is
 * expiry order and pruning stops at the first live entry.
 */
const makeCeremonyStore = <C extends Ceremony>(capacity: number) => {
  const entries = new Map<string, C>();
  return {
    put: (ceremonyId: string, ceremony: C, now: DateTime.DateTime) =>
      Effect.sync(() => {
        for (const [id, entry] of entries) {
          if (entries.size < capacity && DateTime.isGreaterThan(entry.expiresAt, now)) break;
          entries.delete(id);
        }
        entries.set(ceremonyId, ceremony);
      }),
    take: (ceremonyId: string, origin: string, now: DateTime.DateTime) =>
      Effect.sync(() => {
        const ceremony = entries.get(ceremonyId);
        entries.delete(ceremonyId);
        return ceremony !== undefined &&
          ceremony.origin === origin &&
          DateTime.isGreaterThan(ceremony.expiresAt, now)
          ? ceremony
          : undefined;
      }),
  };
};

export class UserDirectory extends Context.Service<
  UserDirectory,
  {
    readonly hasOwner: () => Effect.Effect<boolean, UserDirectoryStorageError>;
    readonly startOwnerRegistration: (input: {
      readonly displayName: string;
      readonly origin: string;
    }) => Effect.Effect<
      AuthPasskeyRegistrationCeremony,
      OwnerAlreadyClaimedError | UserDirectoryStorageError
    >;
    /** Checks the passkey without writing, so a rejected attempt leaves the bootstrap link unspent. */
    readonly verifyOwnerRegistration: (input: {
      readonly ceremonyId: string;
      readonly origin: string;
      readonly response: AuthPasskeyRegistrationResponse;
    }) => Effect.Effect<PendingOwner, PasskeyRejectedError>;
    readonly createOwner: (
      owner: PendingOwner,
    ) => Effect.Effect<
      { readonly user: AuthUser; readonly recoveryCodes: ReadonlyArray<string> },
      OwnerAlreadyClaimedError | UserDirectoryStorageError
    >;
    readonly startPasskeySignIn: (input: {
      readonly origin: string;
    }) => Effect.Effect<AuthPasskeySignInCeremony>;
    readonly finishPasskeySignIn: (input: {
      readonly ceremonyId: string;
      readonly origin: string;
      readonly response: AuthPasskeyAuthenticationResponse;
    }) => Effect.Effect<AuthUser, PasskeyRejectedError | UserDirectoryStorageError>;
    readonly redeemRecoveryCode: (
      code: string,
    ) => Effect.Effect<AuthUser, RecoveryCodeRejectedError | UserDirectoryStorageError>;
    readonly getAccount: (
      userId: UserId,
    ) => Effect.Effect<AuthAccount, AccountChangeRefusedError | UserDirectoryStorageError>;
    readonly setPassword: (
      userId: UserId,
      input: AuthSetPasswordRequest,
    ) => Effect.Effect<
      AuthAccount,
      AccountChangeRefusedError | LoginNameTakenError | UserDirectoryStorageError
    >;
    /** A new secret held until a code from it confirms the enrollment. */
    readonly startTotpEnrollment: (
      userId: UserId,
    ) => Effect.Effect<AuthTotpEnrollment, AccountChangeRefusedError | UserDirectoryStorageError>;
    readonly confirmTotpEnrollment: (
      userId: UserId,
      code: string,
    ) => Effect.Effect<AuthAccount, AccountChangeRefusedError | UserDirectoryStorageError>;
    readonly checkPassword: (
      input: AuthPasswordSignInRequest,
    ) => Effect.Effect<PasswordCheck, PasswordRejectedError | UserDirectoryStorageError>;
    /** A single-use link that lets the Owner register a new passkey; the token is shown once. */
    readonly issueOwnerResetLink: () => Effect.Effect<
      { readonly token: string; readonly expiresAt: DateTime.Utc; readonly user: AuthUser },
      NoOwnerError | UserDirectoryStorageError
    >;
    readonly getResetLinkStatus: (
      token: string,
    ) => Effect.Effect<AuthResetLinkStatus, UserDirectoryStorageError>;
    readonly startResetRegistration: (input: {
      readonly token: string;
      readonly origin: string;
    }) => Effect.Effect<
      AuthPasskeyRegistrationCeremony,
      ResetLinkRejectedError | UserDirectoryStorageError
    >;
    readonly verifyResetRegistration: (input: {
      readonly ceremonyId: string;
      readonly origin: string;
      readonly response: AuthPasskeyRegistrationResponse;
    }) => Effect.Effect<PendingPasskey, PasskeyRejectedError>;
    /** Spends the link and stores the passkey; run it in the transaction that issues the session. */
    readonly redeemResetLink: (input: {
      readonly token: string;
      readonly pending: PendingPasskey;
    }) => Effect.Effect<AuthUser, ResetLinkRejectedError | UserDirectoryStorageError>;
  }
>()("t3/auth/UserDirectory") {}

const registrationCeremony = (input: {
  readonly ceremonyId: string;
  readonly challenge: string;
  readonly rpId: string;
  readonly userId: UserId;
  readonly displayName: string;
}): AuthPasskeyRegistrationCeremony => ({
  ceremonyId: input.ceremonyId,
  options: {
    challenge: input.challenge,
    rp: { id: input.rpId, name: "T3 Code" },
    user: {
      id: isoBase64URL.fromUTF8String(input.userId),
      name: input.displayName,
      displayName: input.displayName,
    },
    pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ alg, type: "public-key" as const })),
    timeout: Duration.toMillis(CEREMONY_TTL),
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "preferred",
    },
    attestation: "none",
  },
});

const normalizeLoginName = (loginName: string) => loginName.trim().toLowerCase();

const toAuthUser = (user: Users.UserRecord): AuthUser => ({
  id: user.userId,
  displayName: user.displayName,
  isOwner: user.isOwner,
});

const normalizeRecoveryCode = (code: string) =>
  code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");

const make = Effect.gen(function* () {
  const users = yield* Users.UserRepository;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const ownerRegistrations = makeCeremonyStore<OwnerRegistrationCeremony>(
    MAX_PENDING_OWNER_REGISTRATIONS,
  );
  const signIns = makeCeremonyStore<Ceremony>(MAX_PENDING_SIGN_INS);
  // Gated by a live reset link, so the Owner-registration bound is plenty.
  const resetRegistrations = makeCeremonyStore<OwnerRegistrationCeremony>(
    MAX_PENDING_OWNER_REGISTRATIONS,
  );
  const pendingTotp = new Map<UserId, { secret: Uint8Array; expiresAt: DateTime.DateTime }>();
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const cryptoContext = yield* Effect.context<Mac.Mac | Aead.Aead | SecureRandom.SecureRandom>();
  const withCrypto = Effect.provide(cryptoContext);

  const storage = Effect.mapError((cause: unknown) => new UserDirectoryStorageError({ cause }));

  const randomBase64Url = (size: number) =>
    random
      .randomBytes(size)
      .pipe(Effect.map((bytes) => isoBase64URL.fromBuffer(new Uint8Array(bytes))));

  const hashRecoveryCode = (code: string) =>
    digest.digestHex(Digest.sha256, new TextEncoder().encode(normalizeRecoveryCode(code)));

  const ceremonyExpiry = (now: DateTime.DateTime) =>
    DateTime.add(now, { milliseconds: Duration.toMillis(CEREMONY_TTL) });

  const takeCeremony = Effect.fn("UserDirectory.takeCeremony")(function* <C extends Ceremony>(
    store: ReturnType<typeof makeCeremonyStore<C>>,
    ceremonyId: string,
    origin: string,
  ) {
    const ceremony = yield* store.take(ceremonyId, origin, yield* DateTime.now);
    if (ceremony === undefined) {
      return yield* new PasskeyRejectedError({ reason: "the sign-in attempt expired" });
    }
    return ceremony;
  });

  const startOwnerRegistration: UserDirectory["Service"]["startOwnerRegistration"] = Effect.fn(
    "UserDirectory.startOwnerRegistration",
  )(function* ({ displayName, origin }) {
    if (yield* users.hasOwner().pipe(storage)) {
      return yield* new OwnerAlreadyClaimedError({});
    }
    const userId = UserId.make(yield* random.uuidV4());
    const challenge = yield* randomBase64Url(32);
    const rpId = new URL(origin).hostname;
    const ceremonyId = yield* random.uuidV4();
    const now = yield* DateTime.now;
    yield* ownerRegistrations.put(
      ceremonyId,
      { challenge, origin, rpId, expiresAt: ceremonyExpiry(now), userId, displayName },
      now,
    );
    return registrationCeremony({ ceremonyId, challenge, rpId, userId, displayName });
  });

  const verifyRegistration = Effect.fn("UserDirectory.verifyRegistration")(function* (
    store: ReturnType<typeof makeCeremonyStore<OwnerRegistrationCeremony>>,
    input: {
      readonly ceremonyId: string;
      readonly origin: string;
      readonly response: AuthPasskeyRegistrationResponse;
    },
  ) {
    const { response } = input;
    const ceremony = yield* takeCeremony(store, input.ceremonyId, input.origin);
    const verification = yield* Effect.tryPromise({
      try: () =>
        verifyRegistrationResponse({
          response: {
            id: response.id,
            rawId: response.rawId,
            type: response.type,
            response: {
              clientDataJSON: response.response.clientDataJSON,
              attestationObject: response.response.attestationObject,
              ...(response.response.transports
                ? { transports: [...response.response.transports] }
                : {}),
            },
            clientExtensionResults: {},
          },
          expectedChallenge: ceremony.challenge,
          expectedOrigin: ceremony.origin,
          expectedRPID: ceremony.rpId,
          requireUserVerification: false,
          supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
        }),
      catch: (cause) => new PasskeyRejectedError({ reason: "the passkey did not verify", cause }),
    });
    if (!verification.verified) {
      return yield* new PasskeyRejectedError({ reason: "the passkey did not verify" });
    }
    const { credential } = verification.registrationInfo;
    return {
      ceremony,
      passkey: {
        credentialId: credential.id,
        publicKey: isoBase64URL.fromBuffer(credential.publicKey),
        signCount: credential.counter,
        transports: credential.transports ?? [],
        rpId: ceremony.rpId,
      },
    };
  });

  const verifyOwnerRegistration: UserDirectory["Service"]["verifyOwnerRegistration"] = Effect.fn(
    "UserDirectory.verifyOwnerRegistration",
  )(function* (input) {
    const { ceremony, passkey } = yield* verifyRegistration(ownerRegistrations, input);
    return {
      userId: ceremony.userId,
      displayName: ceremony.displayName,
      passkey,
    } satisfies PendingOwner;
  });

  const generateRecoveryCode = random.randomBytes(RECOVERY_CODE_LENGTH).pipe(
    Effect.map((bytes) => {
      const symbols = Array.from(bytes, (byte) => RECOVERY_CODE_ALPHABET[byte & 31]).join("");
      return `${symbols.slice(0, 5)}-${symbols.slice(5)}`;
    }),
  );

  const createOwner: UserDirectory["Service"]["createOwner"] = Effect.fn(
    "UserDirectory.createOwner",
  )(function* (owner) {
    const recoveryCodes = yield* Effect.replicateEffect(generateRecoveryCode, RECOVERY_CODE_COUNT);
    const recoveryCodeHashes = yield* Effect.forEach(recoveryCodes, hashRecoveryCode);
    const created = yield* users
      .createOwner({
        userId: owner.userId,
        displayName: owner.displayName,
        createdAt: yield* DateTime.now,
        passkey: owner.passkey,
        recoveryCodeHashes,
      })
      .pipe(storage);
    if (!created) {
      return yield* new OwnerAlreadyClaimedError({});
    }
    return {
      user: { id: owner.userId, displayName: owner.displayName, isOwner: true },
      recoveryCodes,
    };
  });

  const startPasskeySignIn: UserDirectory["Service"]["startPasskeySignIn"] = Effect.fn(
    "UserDirectory.startPasskeySignIn",
  )(function* ({ origin }) {
    const challenge = yield* randomBase64Url(32);
    const rpId = new URL(origin).hostname;
    const ceremonyId = yield* random.uuidV4();
    const now = yield* DateTime.now;
    yield* signIns.put(
      ceremonyId,
      { challenge, origin, rpId, expiresAt: ceremonyExpiry(now) },
      now,
    );
    return {
      ceremonyId,
      options: {
        challenge,
        rpId,
        timeout: Duration.toMillis(CEREMONY_TTL),
        userVerification: "preferred",
      },
    } satisfies AuthPasskeySignInCeremony;
  });

  const activeUser = (userId: UserId) =>
    users
      .getById(userId)
      .pipe(
        storage,
        Effect.map(Option.filter((user) => user.disabledAt === null && user.removedAt === null)),
      );

  const finishPasskeySignIn: UserDirectory["Service"]["finishPasskeySignIn"] = Effect.fn(
    "UserDirectory.finishPasskeySignIn",
  )(function* ({ ceremonyId, origin, response }) {
    const ceremony = yield* takeCeremony(signIns, ceremonyId, origin);
    const passkey = yield* users.getPasskey(response.id).pipe(storage);
    if (Option.isNone(passkey) || passkey.value.rpId !== ceremony.rpId) {
      return yield* new PasskeyRejectedError({ reason: "this passkey is not registered here" });
    }
    const verification = yield* Effect.tryPromise({
      try: () =>
        verifyAuthenticationResponse({
          response: {
            id: response.id,
            rawId: response.rawId,
            type: response.type,
            response: {
              clientDataJSON: response.response.clientDataJSON,
              authenticatorData: response.response.authenticatorData,
              signature: response.response.signature,
              ...(response.response.userHandle !== undefined
                ? { userHandle: response.response.userHandle }
                : {}),
            },
            clientExtensionResults: {},
          },
          expectedChallenge: ceremony.challenge,
          expectedOrigin: ceremony.origin,
          expectedRPID: ceremony.rpId,
          credential: {
            id: passkey.value.credentialId,
            publicKey: isoBase64URL.toBuffer(passkey.value.publicKey),
            counter: passkey.value.signCount,
            transports: [...passkey.value.transports],
          },
          requireUserVerification: false,
        }),
      catch: (cause) => new PasskeyRejectedError({ reason: "the passkey did not verify", cause }),
    });
    if (!verification.verified) {
      return yield* new PasskeyRejectedError({ reason: "the passkey did not verify" });
    }
    yield* users
      .recordPasskeyUse({
        credentialId: passkey.value.credentialId,
        signCount: verification.authenticationInfo.newCounter,
        usedAt: yield* DateTime.now,
      })
      .pipe(storage);
    const user = yield* activeUser(passkey.value.userId);
    if (Option.isNone(user)) {
      return yield* new PasskeyRejectedError({ reason: "this account cannot sign in" });
    }
    return toAuthUser(user.value);
  });

  const redeemRecoveryCode: UserDirectory["Service"]["redeemRecoveryCode"] = Effect.fn(
    "UserDirectory.redeemRecoveryCode",
  )(function* (code) {
    const userId = yield* users
      .consumeRecoveryCode({ codeHash: yield* hashRecoveryCode(code), usedAt: yield* DateTime.now })
      .pipe(storage);
    if (Option.isNone(userId)) {
      return yield* new RecoveryCodeRejectedError({});
    }
    const user = yield* activeUser(userId.value);
    if (Option.isNone(user)) {
      return yield* new RecoveryCodeRejectedError({});
    }
    return toAuthUser(user.value);
  });

  const credentialKey = secretStore.getOrCreateRandom(CREDENTIAL_KEY_SECRET_NAME, 32).pipe(storage);

  const requireAccount = (userId: UserId) =>
    activeUser(userId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AccountChangeRefusedError({ reason: "This account cannot sign in." })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const accountOf = Effect.fn("UserDirectory.accountOf")(function* (user: Users.UserRecord) {
    const credentials = yield* users.getCredentials(user.userId).pipe(storage);
    return {
      user: toAuthUser(user),
      loginName: user.loginName,
      hasPassword: credentials.passwordHash !== null,
      totpEnrolled: credentials.totpSecretCiphertext !== null,
      passwordRequiresTotp: passwordRequiresTotp(user),
    } satisfies AuthAccount;
  });

  const getAccount: UserDirectory["Service"]["getAccount"] = Effect.fn("UserDirectory.getAccount")(
    function* (userId) {
      return yield* accountOf(yield* requireAccount(userId));
    },
  );

  const setPassword: UserDirectory["Service"]["setPassword"] = Effect.fn(
    "UserDirectory.setPassword",
  )(function* (userId, input) {
    const user = yield* requireAccount(userId);
    const credentials = yield* users.getCredentials(userId).pipe(storage);
    if (passwordRequiresTotp(user) && credentials.totpSecretCiphertext === null) {
      return yield* new AccountChangeRefusedError({
        reason: "Set up an authenticator app first: this account needs a code with its password.",
      });
    }
    if (
      credentials.passwordHash !== null &&
      !(yield* AccountCredentials.verifyPassword(
        input.currentPassword ?? "",
        credentials.passwordHash,
      ))
    ) {
      return yield* new AccountChangeRefusedError({ reason: "Your current password is wrong." });
    }
    const passwordHash = yield* AccountCredentials.hashPassword(input.password).pipe(withCrypto);
    const saved = yield* users
      .setPassword({
        userId,
        loginName: normalizeLoginName(input.loginName),
        passwordHash,
        updatedAt: yield* DateTime.now,
      })
      .pipe(storage);
    if (!saved) {
      return yield* new LoginNameTakenError({});
    }
    return yield* accountOf(yield* requireAccount(userId));
  });

  const startTotpEnrollment: UserDirectory["Service"]["startTotpEnrollment"] = Effect.fn(
    "UserDirectory.startTotpEnrollment",
  )(function* (userId) {
    const user = yield* requireAccount(userId);
    const secret = yield* AccountCredentials.generateTotpSecret.pipe(withCrypto);
    const now = yield* DateTime.now;
    pendingTotp.set(userId, {
      secret,
      expiresAt: DateTime.add(now, { milliseconds: Duration.toMillis(TOTP_ENROLLMENT_TTL) }),
    });
    return AccountCredentials.totpEnrollment(secret, user.loginName ?? user.displayName);
  });

  const confirmTotpEnrollment: UserDirectory["Service"]["confirmTotpEnrollment"] = Effect.fn(
    "UserDirectory.confirmTotpEnrollment",
  )(function* (userId, code) {
    const user = yield* requireAccount(userId);
    const now = yield* DateTime.now;
    const pending = pendingTotp.get(userId);
    if (pending === undefined || !DateTime.isGreaterThan(pending.expiresAt, now)) {
      pendingTotp.delete(userId);
      return yield* new AccountChangeRefusedError({
        reason: "This setup expired. Start again to get a new code.",
      });
    }
    const step = yield* AccountCredentials.matchTotpStep(
      pending.secret,
      code,
      DateTime.toEpochMillis(now),
    ).pipe(withCrypto);
    if (step === undefined) {
      return yield* new AccountChangeRefusedError({
        reason: "That code did not match. Check the time on your device and try again.",
      });
    }
    const secretCiphertext = yield* credentialKey.pipe(
      Effect.flatMap((key) => AccountCredentials.seal(key, pending.secret, userId)),
      withCrypto,
      storage,
    );
    yield* users.setTotp({ userId, secretCiphertext, step, enrolledAt: now }).pipe(storage);
    pendingTotp.delete(userId);
    return yield* accountOf(user);
  });

  // Unknown names still pay for one hash, so timing does not reveal which names exist.
  const decoyPasswordHash = yield* Effect.cached(
    AccountCredentials.hashPassword("decoy password").pipe(withCrypto),
  );

  const checkPassword: UserDirectory["Service"]["checkPassword"] = Effect.fn(
    "UserDirectory.checkPassword",
  )(function* (input) {
    const found = yield* users.getByLoginName(normalizeLoginName(input.loginName)).pipe(storage);
    const credentials = Option.isSome(found)
      ? yield* users.getCredentials(found.value.userId).pipe(storage)
      : undefined;
    const hash = credentials?.passwordHash ?? (yield* decoyPasswordHash);
    const passwordMatches = yield* AccountCredentials.verifyPassword(input.password, hash);
    if (
      Option.isNone(found) ||
      credentials?.passwordHash == null ||
      !passwordMatches ||
      found.value.disabledAt !== null ||
      found.value.removedAt !== null
    ) {
      return yield* new PasswordRejectedError({});
    }
    const user = found.value;
    const totpSecretCiphertext = credentials.totpSecretCiphertext;
    if (totpSecretCiphertext === null) {
      // A rule change (a Role, later) can leave a password-only account that now needs TOTP.
      if (passwordRequiresTotp(user)) return yield* new PasswordRejectedError({});
      return { _tag: "verified", user: toAuthUser(user) } as const;
    }
    if (input.totpCode === undefined) {
      return { _tag: "totp-required" } as const;
    }
    const secret = yield* credentialKey.pipe(
      Effect.flatMap((key) => AccountCredentials.open(key, totpSecretCiphertext, user.userId)),
      withCrypto,
      storage,
    );
    const step = yield* AccountCredentials.matchTotpStep(
      secret,
      input.totpCode,
      DateTime.toEpochMillis(yield* DateTime.now),
    ).pipe(withCrypto);
    if (
      step === undefined ||
      !(yield* users.recordTotpStep({ userId: user.userId, step }).pipe(storage))
    ) {
      return yield* new PasswordRejectedError({});
    }
    return { _tag: "verified", user: toAuthUser(user) } as const;
  });

  const hashResetToken = (token: string) =>
    digest.digestHex(Digest.sha256, new TextEncoder().encode(token));

  const issueOwnerResetLink: UserDirectory["Service"]["issueOwnerResetLink"] = Effect.fn(
    "UserDirectory.issueOwnerResetLink",
  )(function* () {
    const owner = yield* users.getOwner().pipe(storage);
    if (Option.isNone(owner)) {
      return yield* new NoOwnerError({});
    }
    const token = yield* randomBase64Url(32);
    const now = yield* DateTime.now;
    const expiresAt = DateTime.toUtc(
      DateTime.add(now, { milliseconds: Duration.toMillis(RESET_LINK_TTL) }),
    );
    yield* users
      .createResetLink({
        linkId: yield* random.uuidV4(),
        userId: owner.value.userId,
        tokenHash: yield* hashResetToken(token),
        // Issued from the Hub's shell, not by a signed-in User.
        createdBy: null,
        createdAt: now,
        expiresAt,
      })
      .pipe(storage);
    return { token, expiresAt, user: toAuthUser(owner.value) };
  });

  const liveResetLinkUser = Effect.fn("UserDirectory.liveResetLinkUser")(function* (token: string) {
    const userId = yield* users
      .findResetLink({ tokenHash: yield* hashResetToken(token), now: yield* DateTime.now })
      .pipe(storage);
    return Option.isNone(userId) ? Option.none() : yield* activeUser(userId.value);
  });

  const getResetLinkStatus: UserDirectory["Service"]["getResetLinkStatus"] = Effect.fn(
    "UserDirectory.getResetLinkStatus",
  )(function* (token) {
    const user = yield* liveResetLinkUser(token);
    return Option.isSome(user)
      ? ({ status: "valid", displayName: user.value.displayName } as const)
      : ({ status: "invalid" } as const);
  });

  const startResetRegistration: UserDirectory["Service"]["startResetRegistration"] = Effect.fn(
    "UserDirectory.startResetRegistration",
  )(function* ({ token, origin }) {
    const user = yield* liveResetLinkUser(token);
    if (Option.isNone(user)) {
      return yield* new ResetLinkRejectedError({});
    }
    const challenge = yield* randomBase64Url(32);
    const rpId = new URL(origin).hostname;
    const ceremonyId = yield* random.uuidV4();
    const now = yield* DateTime.now;
    const { userId, displayName } = user.value;
    yield* resetRegistrations.put(
      ceremonyId,
      { challenge, origin, rpId, expiresAt: ceremonyExpiry(now), userId, displayName },
      now,
    );
    return registrationCeremony({ ceremonyId, challenge, rpId, userId, displayName });
  });

  const verifyResetRegistration: UserDirectory["Service"]["verifyResetRegistration"] = Effect.fn(
    "UserDirectory.verifyResetRegistration",
  )(function* (input) {
    const { ceremony, passkey } = yield* verifyRegistration(resetRegistrations, input);
    return { userId: ceremony.userId, passkey } satisfies PendingPasskey;
  });

  const redeemResetLink: UserDirectory["Service"]["redeemResetLink"] = Effect.fn(
    "UserDirectory.redeemResetLink",
  )(function* ({ token, pending }) {
    const now = yield* DateTime.now;
    const userId = yield* users
      .consumeResetLink({ tokenHash: yield* hashResetToken(token), now })
      .pipe(storage);
    if (Option.isNone(userId) || userId.value !== pending.userId) {
      return yield* new ResetLinkRejectedError({});
    }
    const user = yield* activeUser(userId.value);
    if (Option.isNone(user)) {
      return yield* new ResetLinkRejectedError({});
    }
    yield* users
      .addPasskey({ userId: userId.value, passkey: pending.passkey, createdAt: now })
      .pipe(storage);
    return toAuthUser(user.value);
  });

  return UserDirectory.of({
    hasOwner: Effect.fn("UserDirectory.hasOwner")(function () {
      return users.hasOwner().pipe(storage);
    }),
    startOwnerRegistration,
    verifyOwnerRegistration,
    createOwner,
    startPasskeySignIn,
    finishPasskeySignIn,
    redeemRecoveryCode,
    getAccount,
    setPassword,
    startTotpEnrollment,
    confirmTotpEnrollment,
    checkPassword,
    issueOwnerResetLink,
    getResetLinkStatus,
    startResetRegistration,
    verifyResetRegistration,
    redeemResetLink,
  });
});

export const layer = Layer.effect(UserDirectory, make).pipe(Layer.provideMerge(Users.layer));
