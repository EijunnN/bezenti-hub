import {
  type AuthAccount,
  type AuthSessionId,
  type AuthPasskeyAuthenticationResponse,
  type AuthPasskeyRegistrationCeremony,
  type AuthPasskeyRegistrationResponse,
  type AuthPasskeySignInCeremony,
  type AuthPasswordSignInRequest,
  type AuthReauth,
  type AuthResetLinkStatus,
  type AuthSetPasswordRequest,
  type AuthTotpConfirmRequest,
  type AuthTotpEnrollment,
  type AuthTotpSignInRequest,
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
import * as Semaphore from "effect/Semaphore";

import * as Users from "../persistence/Users.ts";
import * as AccountCredentials from "./AccountCredentials.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { makeSignInThrottle } from "./signInThrottle.ts";

const CEREMONY_TTL = Duration.minutes(5);
// Sign-in challenges are unauthenticated, so they get their own bounded store; an Owner
// registration needs the bootstrap link and can never be evicted by them.
const MAX_PENDING_SIGN_INS = 1_000;
const MAX_PENDING_OWNER_REGISTRATIONS = 16;
const TOTP_ENROLLMENT_TTL = Duration.minutes(10);
const MAX_PENDING_TOTP = 1_000;
const MAX_TOTP_ATTEMPTS = 5;
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

/** The right password for an account that may use one only with TOTP, which it has not set up. */
export class SecondFactorMissingError extends Schema.TaggedError<SecondFactorMissingError>()(
  "SecondFactorMissingError",
  {},
) {
  override get message(): string {
    return "This account needs an authenticator app with its password. Sign in with your passkey, then add one under Settings → Access.";
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

export class SignInThrottledError extends Schema.TaggedError<SignInThrottledError>()(
  "SignInThrottledError",
  { retryAfterSeconds: Schema.Number },
) {
  override get message(): string {
    return `Too many failed attempts. Try again in ${formatWait(this.retryAfterSeconds)}.`;
  }
}

const formatWait = (seconds: number) =>
  seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;

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

/** A verified passkey registration from a reset link, not yet stored. */
export interface PendingResetPasskey {
  readonly userId: UserId;
  readonly passkey: Users.CreateOwnerInput["passkey"];
  /** The link the registration started from; only that link can finish it. */
  readonly tokenHash: string;
}

export type PasswordCheck =
  | { readonly _tag: "verified"; readonly user: AuthUser }
  | { readonly _tag: "totp-required"; readonly challengeId: string };

/** A signed-in User changing their own credentials, from one session and page origin. */
export interface AccountActor {
  readonly userId: UserId;
  readonly sessionId: AuthSessionId;
  readonly origin: string;
}

/**
 * Accounts that may use a password only together with TOTP: the Owner and every Admin (see the
 * sign-in rules in docs/internals/environment-auth.md).
 */
const passwordRequiresTotp = (
  user: Pick<Users.UserRecord, "isOwner">,
  credentials: Pick<Users.UserCredentials, "isAdmin">,
): boolean => user.isOwner || credentials.isAdmin;

/** A User an Invitation creates, verified and hashed but not stored yet. */
export interface PendingInvitee {
  readonly userId: UserId;
  readonly displayName: string;
  /** The Invitation it was prepared for; only that one can create it. */
  readonly tokenHash: string;
  readonly passkey: Users.CreateOwnerInput["passkey"] | null;
  readonly password: { readonly loginName: string; readonly passwordHash: string } | null;
  readonly totpSecretCiphertext: string | null;
  /** The step of the code that confirmed the enrollment, so it cannot also sign in. */
  readonly totpStep: number | null;
}

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

/** Started from a reset link or an Invitation: bound to the token it came from. */
interface ResetRegistrationCeremony extends OwnerRegistrationCeremony {
  readonly tokenHash: string;
}

/**
 * Short-lived pending entries keyed by a random id. Every entry in one store has the same TTL, so
 * insertion order is expiry order and pruning stops at the first live entry.
 */
const makeExpiringStore = <V extends { readonly expiresAt: DateTime.DateTime }>(
  capacity: number,
) => {
  const entries = new Map<string, V>();
  return {
    put: (id: string, value: V, now: DateTime.DateTime) =>
      Effect.sync(() => {
        for (const [key, entry] of entries) {
          if (entries.size < capacity && DateTime.isGreaterThan(entry.expiresAt, now)) break;
          entries.delete(key);
        }
        entries.set(id, value);
      }),
    get: (id: string, now: DateTime.DateTime) =>
      Effect.sync(() => {
        const value = entries.get(id);
        return value !== undefined && DateTime.isGreaterThan(value.expiresAt, now)
          ? value
          : undefined;
      }),
    delete: (id: string) =>
      Effect.sync(() => {
        entries.delete(id);
      }),
  };
};

/** Pending WebAuthn ceremonies, single use and bound to the origin that started them. */
const makeCeremonyStore = <C extends Ceremony>(capacity: number) => {
  const store = makeExpiringStore<C>(capacity);
  return {
    put: store.put,
    take: (ceremonyId: string, origin: string, now: DateTime.DateTime) =>
      store.get(ceremonyId, now).pipe(
        Effect.tap(() => store.delete(ceremonyId)),
        Effect.map((ceremony) => (ceremony?.origin === origin ? ceremony : undefined)),
      ),
  };
};

export class UserDirectory extends Context.Service<
  UserDirectory,
  {
    readonly hasOwner: () => Effect.Effect<boolean, UserDirectoryStorageError>;
    /** The User a session with no User of its own belongs to once the Installation has one. */
    readonly ownerId: () => Effect.Effect<Option.Option<UserId>, UserDirectoryStorageError>;
    readonly findUser: (
      userId: UserId,
    ) => Effect.Effect<Option.Option<AuthUser>, UserDirectoryStorageError>;
    /** Display names of the Users that exist among the given ids. */
    readonly displayNames: (
      userIds: ReadonlyArray<UserId>,
    ) => Effect.Effect<ReadonlyMap<UserId, string>, UserDirectoryStorageError>;
    /** The User unless they were disabled or removed. */
    readonly findActiveUser: (
      userId: UserId,
    ) => Effect.Effect<Option.Option<AuthUser>, UserDirectoryStorageError>;
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
      actor: AccountActor,
      input: AuthSetPasswordRequest,
    ) => Effect.Effect<AuthAccount, AccountChangeError | LoginNameTakenError>;
    readonly removePassword: (
      actor: AccountActor,
      reauth: AuthReauth,
    ) => Effect.Effect<AuthAccount, AccountChangeError>;
    /** A new secret, held under the returned id until a code from it confirms the enrollment. */
    readonly startTotpEnrollment: (
      userId: UserId,
    ) => Effect.Effect<AuthTotpEnrollment, AccountChangeRefusedError | UserDirectoryStorageError>;
    readonly confirmTotpEnrollment: (
      actor: AccountActor,
      input: AuthTotpConfirmRequest,
    ) => Effect.Effect<AuthAccount, AccountChangeError>;
    readonly removeTotp: (
      actor: AccountActor,
      reauth: AuthReauth,
    ) => Effect.Effect<AuthAccount, AccountChangeError>;
    readonly checkPassword: (
      input: AuthPasswordSignInRequest,
      clientIp: string | undefined,
    ) => Effect.Effect<
      PasswordCheck,
      | PasswordRejectedError
      | SecondFactorMissingError
      | SignInThrottledError
      | UserDirectoryStorageError
    >;
    readonly checkTotp: (
      input: AuthTotpSignInRequest,
      clientIp: string | undefined,
    ) => Effect.Effect<
      AuthUser,
      PasswordRejectedError | SignInThrottledError | UserDirectoryStorageError
    >;
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
    }) => Effect.Effect<PendingResetPasskey, PasskeyRejectedError>;
    /** A passkey registration for a new User an Invitation (by its token hash) creates. */
    readonly startInviteeRegistration: (input: {
      readonly displayName: string;
      readonly origin: string;
      readonly tokenHash: string;
    }) => Effect.Effect<AuthPasskeyRegistrationCeremony>;
    readonly verifyInviteeRegistration: (input: {
      readonly ceremonyId: string;
      readonly origin: string;
      readonly response: AuthPasskeyRegistrationResponse;
    }) => Effect.Effect<PendingInvitee, PasskeyRejectedError>;
    /** A TOTP secret for an invitee, held until the accept that confirms it with a code. */
    readonly startInviteeTotpEnrollment: (input: {
      readonly tokenHash: string;
      readonly label: string;
    }) => Effect.Effect<AuthTotpEnrollment, UserDirectoryStorageError>;
    /** Hashes the password and checks the TOTP code, outside the transaction that stores them. */
    readonly prepareInviteePassword: (input: {
      readonly tokenHash: string;
      readonly displayName: string;
      readonly loginName: string;
      readonly password: string;
      readonly totp: { readonly enrollmentId: string; readonly code: string } | undefined;
    }) => Effect.Effect<
      PendingInvitee,
      AccountChangeRefusedError | LoginNameTakenError | UserDirectoryStorageError
    >;
    /** Stores a prepared invitee; run it in the transaction that spends the Invitation. */
    readonly createInvitedUser: (
      pending: PendingInvitee,
    ) => Effect.Effect<AuthUser, LoginNameTakenError | UserDirectoryStorageError>;
    /** Whether the User signs in with more than a password: a passkey or TOTP. */
    readonly hasStrongSignIn: (userId: UserId) => Effect.Effect<boolean, UserDirectoryStorageError>;
    /**
     * Spends the link, replaces every passkey with the new one and ends the User's sessions; run
     * it in the transaction that issues the new session.
     */
    readonly redeemResetLink: (input: {
      readonly token: string;
      readonly pending: PendingResetPasskey;
    }) => Effect.Effect<AuthUser, ResetLinkRejectedError | UserDirectoryStorageError>;
  }
>()("t3/auth/UserDirectory") {}

type AccountChangeError =
  | AccountChangeRefusedError
  | SignInThrottledError
  | UserDirectoryStorageError;

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
  const resetRegistrations = makeCeremonyStore<ResetRegistrationCeremony>(
    MAX_PENDING_OWNER_REGISTRATIONS,
  );
  // Each needs a live Invitation; the bound keeps a flood of them from growing memory.
  const inviteeRegistrations = makeCeremonyStore<ResetRegistrationCeremony>(MAX_PENDING_SIGN_INS);
  const inviteeTotpEnrollments = makeExpiringStore<{
    readonly tokenHash: string;
    readonly secret: Uint8Array;
    readonly expiresAt: DateTime.DateTime;
  }>(MAX_PENDING_TOTP);
  const totpEnrollments = makeExpiringStore<{
    readonly userId: UserId;
    readonly secret: Uint8Array;
    readonly expiresAt: DateTime.DateTime;
  }>(MAX_PENDING_TOTP);
  const totpChallenges = makeExpiringStore<{
    readonly userId: UserId;
    /** False for a decoy challenge after a wrong password: no code will pass it. */
    readonly passwordOk: boolean;
    readonly clientIp: string | undefined;
    attempts: number;
    readonly expiresAt: DateTime.DateTime;
  }>(MAX_PENDING_TOTP);
  const throttle = makeSignInThrottle();
  const sessions = yield* SessionStore.SessionStore;
  const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
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

  const verifyRegistration = Effect.fn("UserDirectory.verifyRegistration")(function* <
    C extends OwnerRegistrationCeremony,
  >(
    store: ReturnType<typeof makeCeremonyStore<C>>,
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

  let cachedCredentialKey: Uint8Array | undefined;
  const credentialKey = Effect.suspend(() =>
    cachedCredentialKey !== undefined
      ? Effect.succeed(cachedCredentialKey)
      : secretStore.getOrCreateRandom(CREDENTIAL_KEY_SECRET_NAME, 32).pipe(
          storage,
          Effect.tap((key) =>
            Effect.sync(() => {
              cachedCredentialKey = key;
            }),
          ),
        ),
  );

  // argon2id holds the event loop for tens of milliseconds and 19 MiB per run, so unauthenticated
  // sign-ins queue for a permit instead of piling up.
  const hashing = yield* Semaphore.make(2);
  const hashPassword = (password: string) =>
    hashing.withPermits(1)(AccountCredentials.hashPassword(password).pipe(withCrypto));
  const verifyPassword = (password: string, hash: string) =>
    hashing.withPermits(1)(AccountCredentials.verifyPassword(password, hash));
  // Unknown names still pay for one hash, so timing does not reveal which names exist.
  const decoyPasswordHash = yield* Effect.cached(hashPassword("decoy password"));

  const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const accountKey = (userId: UserId) => `user:${userId}`;
  const throttleKeys = (userId: UserId | undefined, clientIp: string | undefined) => [
    ...(userId === undefined ? [] : [accountKey(userId)]),
    ...(clientIp === undefined ? [] : [`ip:${clientIp}`]),
  ];
  const requireNotThrottled = Effect.fn("UserDirectory.requireNotThrottled")(function* (
    keys: ReadonlyArray<string>,
  ) {
    const now = yield* nowMillis;
    const lockedUntil = throttle.lockedUntil(keys, now);
    if (lockedUntil !== undefined) {
      return yield* new SignInThrottledError({
        retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000),
      });
    }
  });
  const recordFailure = (keys: ReadonlyArray<string>) =>
    nowMillis.pipe(Effect.map((now) => throttle.recordFailure(keys, now)));

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
      hasPasskey: credentials.hasPasskey,
      hasPassword: credentials.passwordHash !== null,
      totpEnrolled: credentials.totpSecretCiphertext !== null,
      passwordRequiresTotp: passwordRequiresTotp(user, credentials),
    } satisfies AuthAccount;
  });

  const getAccount: UserDirectory["Service"]["getAccount"] = Effect.fn("UserDirectory.getAccount")(
    function* (userId) {
      return yield* accountOf(yield* requireAccount(userId));
    },
  );

  const openTotpSecret = (userId: UserId, ciphertext: string) =>
    credentialKey.pipe(
      Effect.flatMap((key) => AccountCredentials.open(key, ciphertext, userId)),
      withCrypto,
      storage,
    );

  /** A code from the User's enrolled secret whose step was not used yet; records the step. */
  const acceptTotpCode = Effect.fn("UserDirectory.acceptTotpCode")(function* (
    userId: UserId,
    ciphertext: string,
    code: string,
  ) {
    const secret = yield* openTotpSecret(userId, ciphertext);
    const step = yield* AccountCredentials.matchTotpStep(secret, code, yield* nowMillis).pipe(
      withCrypto,
    );
    return step !== undefined && (yield* users.recordTotpStep({ userId, step }).pipe(storage));
  });

  const stepUpRefused = new AccountChangeRefusedError({
    reason: "Confirming it's you failed: check your password, code or passkey.",
  });

  /**
   * Credential changes need proof in the same request that the person can sign in now, so a
   * stolen session cannot install its own password or authenticator. An account with no way to
   * sign in yet has nothing to prove.
   */
  const requireStepUp = Effect.fn("UserDirectory.requireStepUp")(function* (
    actor: AccountActor,
    user: Users.UserRecord,
    reauth: AuthReauth | undefined,
  ) {
    const credentials = yield* users.getCredentials(user.userId).pipe(storage);
    if (!credentials.hasPasskey && credentials.passwordHash === null) return;
    const keys = [accountKey(user.userId)];
    yield* requireNotThrottled(keys);
    const verified =
      reauth === undefined
        ? false
        : reauth.method === "passkey"
          ? yield* finishPasskeySignIn({
              ceremonyId: reauth.ceremonyId,
              origin: actor.origin,
              response: reauth.response,
            }).pipe(
              Effect.map((signedIn) => signedIn.id === user.userId),
              Effect.catchTags({ PasskeyRejectedError: () => Effect.succeed(false) }),
            )
          : credentials.passwordHash !== null &&
            (yield* verifyPassword(reauth.password, credentials.passwordHash)) &&
            (credentials.totpSecretCiphertext === null ||
              (reauth.totpCode !== undefined &&
                (yield* acceptTotpCode(
                  user.userId,
                  credentials.totpSecretCiphertext,
                  reauth.totpCode,
                ))));
    if (!verified) {
      if (reauth !== undefined) yield* recordFailure(keys);
      return yield* stepUpRefused;
    }
    throttle.reset(keys);
  });

  // A credential change ends every other session and unspent link, which may belong to whoever
  // took the old one.
  const signOutOtherSessions = (actor: AccountActor) =>
    sessions
      .revokeAllForUser(actor.userId, { except: actor.sessionId })
      .pipe(Effect.andThen(pairingLinks.revokeAllForUser(actor.userId)), storage);

  const setPassword: UserDirectory["Service"]["setPassword"] = Effect.fn(
    "UserDirectory.setPassword",
  )(function* (actor, input) {
    const user = yield* requireAccount(actor.userId);
    const credentials = yield* users.getCredentials(actor.userId).pipe(storage);
    if (passwordRequiresTotp(user, credentials) && credentials.totpSecretCiphertext === null) {
      return yield* new AccountChangeRefusedError({
        reason: "Set up an authenticator app first: this account needs a code with its password.",
      });
    }
    yield* requireStepUp(actor, user, input.reauth);
    const passwordHash = yield* hashPassword(input.password);
    const saved = yield* users
      .setPassword({
        userId: actor.userId,
        loginName: normalizeLoginName(input.loginName),
        passwordHash,
        updatedAt: yield* DateTime.now,
      })
      .pipe(storage);
    if (!saved) {
      return yield* new LoginNameTakenError({});
    }
    yield* signOutOtherSessions(actor);
    return yield* accountOf(yield* requireAccount(actor.userId));
  });

  const removePassword: UserDirectory["Service"]["removePassword"] = Effect.fn(
    "UserDirectory.removePassword",
  )(function* (actor, reauth) {
    const user = yield* requireAccount(actor.userId);
    yield* requireStepUp(actor, user, reauth);
    const credentials = yield* users.getCredentials(actor.userId).pipe(storage);
    if (!credentials.hasPasskey) {
      return yield* new AccountChangeRefusedError({
        reason: "Your password is your only way to sign in. Add a passkey before removing it.",
      });
    }
    yield* users.removePassword(actor.userId).pipe(storage);
    yield* signOutOtherSessions(actor);
    return yield* accountOf(user);
  });

  const removeTotp: UserDirectory["Service"]["removeTotp"] = Effect.fn("UserDirectory.removeTotp")(
    function* (actor, reauth) {
      const user = yield* requireAccount(actor.userId);
      yield* requireStepUp(actor, user, reauth);
      const credentials = yield* users.getCredentials(actor.userId).pipe(storage);
      if (passwordRequiresTotp(user, credentials) && credentials.passwordHash !== null) {
        return yield* new AccountChangeRefusedError({
          reason: "Remove your password first: this account cannot use a password without a code.",
        });
      }
      if (!credentials.hasPasskey && credentials.passwordHash === null) {
        return yield* new AccountChangeRefusedError({
          reason: "Your authenticator app is part of your only way to sign in.",
        });
      }
      yield* users.removeTotp(actor.userId).pipe(storage);
      yield* signOutOtherSessions(actor);
      return yield* accountOf(user);
    },
  );

  const startTotpEnrollment: UserDirectory["Service"]["startTotpEnrollment"] = Effect.fn(
    "UserDirectory.startTotpEnrollment",
  )(function* (userId) {
    const user = yield* requireAccount(userId);
    const secret = yield* AccountCredentials.generateTotpSecret.pipe(withCrypto);
    const enrollmentId = yield* random.uuidV4();
    const now = yield* DateTime.now;
    yield* totpEnrollments.put(
      enrollmentId,
      {
        userId,
        secret,
        expiresAt: DateTime.add(now, { milliseconds: Duration.toMillis(TOTP_ENROLLMENT_TTL) }),
      },
      now,
    );
    return {
      enrollmentId,
      ...AccountCredentials.totpEnrollment(secret, user.loginName ?? user.displayName),
    };
  });

  const confirmTotpEnrollment: UserDirectory["Service"]["confirmTotpEnrollment"] = Effect.fn(
    "UserDirectory.confirmTotpEnrollment",
  )(function* (actor, input) {
    const user = yield* requireAccount(actor.userId);
    const now = yield* DateTime.now;
    const pending = yield* totpEnrollments.get(input.enrollmentId, now);
    if (pending === undefined || pending.userId !== actor.userId) {
      return yield* new AccountChangeRefusedError({
        reason: "This setup expired. Start again to get a new code.",
      });
    }
    yield* requireStepUp(actor, user, input.reauth);
    const step = yield* AccountCredentials.matchTotpStep(
      pending.secret,
      input.code,
      DateTime.toEpochMillis(now),
    ).pipe(withCrypto);
    if (step === undefined) {
      return yield* new AccountChangeRefusedError({
        reason: "That code did not match. Check the time on your device and try again.",
      });
    }
    const secretCiphertext = yield* credentialKey.pipe(
      Effect.flatMap((key) => AccountCredentials.seal(key, pending.secret, actor.userId)),
      withCrypto,
      storage,
    );
    // The enrollment code proves the app works; it is not a sign-in, so no step is spent.
    yield* users
      .setTotp({ userId: actor.userId, secretCiphertext, step: -1, enrolledAt: now })
      .pipe(storage);
    yield* totpEnrollments.delete(input.enrollmentId);
    yield* signOutOtherSessions(actor);
    return yield* accountOf(user);
  });

  const checkPassword: UserDirectory["Service"]["checkPassword"] = Effect.fn(
    "UserDirectory.checkPassword",
  )(function* (input, clientIp) {
    const found = yield* users.getByLoginName(normalizeLoginName(input.loginName)).pipe(storage);
    const user = Option.getOrUndefined(found);
    // Unknown names count only against the client, so they cannot evict real accounts' counters.
    const keys = throttleKeys(user?.userId, clientIp);
    yield* requireNotThrottled(keys);
    const credentials =
      user === undefined ? undefined : yield* users.getCredentials(user.userId).pipe(storage);
    const hash = credentials?.passwordHash ?? (yield* decoyPasswordHash);
    const passwordMatches =
      (yield* verifyPassword(input.password, hash)) && credentials?.passwordHash != null;
    const canSignIn =
      user !== undefined && user.disabledAt === null && user.removedAt === null && passwordMatches;
    const totpCiphertext = credentials?.totpSecretCiphertext ?? null;
    if (user !== undefined && totpCiphertext !== null) {
      // The code step comes whether or not the password was right, so this answer alone never
      // confirms a guessed password; a wrong one fails, and counts, at the code step.
      const challengeId = yield* random.uuidV4();
      const now = yield* DateTime.now;
      yield* totpChallenges.put(
        challengeId,
        {
          userId: user.userId,
          passwordOk: canSignIn,
          clientIp,
          attempts: 0,
          expiresAt: ceremonyExpiry(now),
        },
        now,
      );
      return { _tag: "totp-required", challengeId } as const;
    }
    if (!canSignIn || credentials === undefined) {
      yield* recordFailure(keys);
      return yield* new PasswordRejectedError({});
    }
    // A rule change (becoming an Admin) can leave a password-only account that now needs TOTP.
    // The password was right, so say why instead of counting a guess.
    if (passwordRequiresTotp(user, credentials)) {
      return yield* new SecondFactorMissingError({});
    }
    throttle.reset(keys);
    return { _tag: "verified", user: toAuthUser(user) } as const;
  });

  const checkTotp: UserDirectory["Service"]["checkTotp"] = Effect.fn("UserDirectory.checkTotp")(
    function* (input, clientIp) {
      const now = yield* DateTime.now;
      const challenge = yield* totpChallenges.get(input.challengeId, now);
      if (challenge === undefined) {
        return yield* new PasswordRejectedError({});
      }
      const keys = throttleKeys(challenge.userId, clientIp ?? challenge.clientIp);
      yield* requireNotThrottled(keys);
      challenge.attempts += 1;
      if (challenge.attempts >= MAX_TOTP_ATTEMPTS) {
        yield* totpChallenges.delete(input.challengeId);
      }
      const credentials = yield* users.getCredentials(challenge.userId).pipe(storage);
      const user = yield* activeUser(challenge.userId);
      const accepted =
        challenge.passwordOk &&
        Option.isSome(user) &&
        credentials.totpSecretCiphertext !== null &&
        (yield* acceptTotpCode(challenge.userId, credentials.totpSecretCiphertext, input.code));
      if (!accepted || Option.isNone(user)) {
        yield* recordFailure(keys);
        return yield* new PasswordRejectedError({});
      }
      yield* totpChallenges.delete(input.challengeId);
      throttle.reset(keys);
      return toAuthUser(user.value);
    },
  );

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
    const now = DateTime.toUtc(yield* DateTime.now);
    const expiresAt = DateTime.toUtc(
      DateTime.add(now, { milliseconds: Duration.toMillis(RESET_LINK_TTL) }),
    );
    // Only the newest link works, so an older one left in a terminal's history is harmless.
    yield* users.expireResetLinks({ userId: owner.value.userId, now }).pipe(storage);
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
      {
        challenge,
        origin,
        rpId,
        expiresAt: ceremonyExpiry(now),
        userId,
        displayName,
        tokenHash: yield* hashResetToken(token),
      },
      now,
    );
    return registrationCeremony({ ceremonyId, challenge, rpId, userId, displayName });
  });

  const verifyResetRegistration: UserDirectory["Service"]["verifyResetRegistration"] = Effect.fn(
    "UserDirectory.verifyResetRegistration",
  )(function* (input) {
    const { ceremony, passkey } = yield* verifyRegistration(resetRegistrations, input);
    return {
      userId: ceremony.userId,
      passkey,
      tokenHash: ceremony.tokenHash,
    } satisfies PendingResetPasskey;
  });

  const redeemResetLink: UserDirectory["Service"]["redeemResetLink"] = Effect.fn(
    "UserDirectory.redeemResetLink",
  )(function* ({ token, pending }) {
    const tokenHash = yield* hashResetToken(token);
    if (tokenHash !== pending.tokenHash) {
      return yield* new ResetLinkRejectedError({});
    }
    const now = yield* DateTime.now;
    const userId = yield* users.consumeResetLink({ tokenHash, now }).pipe(storage);
    if (Option.isNone(userId) || userId.value !== pending.userId) {
      return yield* new ResetLinkRejectedError({});
    }
    const user = yield* activeUser(userId.value);
    if (Option.isNone(user)) {
      return yield* new ResetLinkRejectedError({});
    }
    // A reset means the old passkeys are lost or stolen: they stop working, and so does every
    // session they opened.
    yield* users
      .addPasskey({ userId: userId.value, passkey: pending.passkey, createdAt: now })
      .pipe(storage);
    yield* users
      .removePasskeysExcept({ userId: userId.value, credentialId: pending.passkey.credentialId })
      .pipe(storage);
    yield* sessions.revokeAllForUser(userId.value).pipe(storage);
    yield* pairingLinks.revokeAllForUser(userId.value).pipe(storage);
    return toAuthUser(user.value);
  });

  const startInviteeRegistration: UserDirectory["Service"]["startInviteeRegistration"] = Effect.fn(
    "UserDirectory.startInviteeRegistration",
  )(function* ({ displayName, origin, tokenHash }) {
    const userId = UserId.make(yield* random.uuidV4());
    const challenge = yield* randomBase64Url(32);
    const rpId = new URL(origin).hostname;
    const ceremonyId = yield* random.uuidV4();
    const now = yield* DateTime.now;
    yield* inviteeRegistrations.put(
      ceremonyId,
      { challenge, origin, rpId, expiresAt: ceremonyExpiry(now), userId, displayName, tokenHash },
      now,
    );
    return registrationCeremony({ ceremonyId, challenge, rpId, userId, displayName });
  });

  const verifyInviteeRegistration: UserDirectory["Service"]["verifyInviteeRegistration"] =
    Effect.fn("UserDirectory.verifyInviteeRegistration")(function* (input) {
      const { ceremony, passkey } = yield* verifyRegistration(inviteeRegistrations, input);
      return {
        userId: ceremony.userId,
        displayName: ceremony.displayName,
        tokenHash: ceremony.tokenHash,
        passkey,
        password: null,
        totpSecretCiphertext: null,
        totpStep: null,
      } satisfies PendingInvitee;
    });

  const startInviteeTotpEnrollment: UserDirectory["Service"]["startInviteeTotpEnrollment"] =
    Effect.fn("UserDirectory.startInviteeTotpEnrollment")(function* ({ tokenHash, label }) {
      const secret = yield* AccountCredentials.generateTotpSecret.pipe(withCrypto);
      const enrollmentId = yield* random.uuidV4();
      const now = yield* DateTime.now;
      yield* inviteeTotpEnrollments.put(
        enrollmentId,
        {
          tokenHash,
          secret,
          expiresAt: DateTime.add(now, { milliseconds: Duration.toMillis(TOTP_ENROLLMENT_TTL) }),
        },
        now,
      );
      return { enrollmentId, ...AccountCredentials.totpEnrollment(secret, label) };
    });

  const prepareInviteePassword: UserDirectory["Service"]["prepareInviteePassword"] = Effect.fn(
    "UserDirectory.prepareInviteePassword",
  )(function* (input) {
    const loginName = normalizeLoginName(input.loginName);
    const userId = UserId.make(yield* random.uuidV4());
    let totpSecretCiphertext: string | null = null;
    let totpStep: number | null = null;
    if (input.totp !== undefined) {
      const now = yield* DateTime.now;
      const pending = yield* inviteeTotpEnrollments.get(input.totp.enrollmentId, now);
      if (pending === undefined || pending.tokenHash !== input.tokenHash) {
        return yield* new AccountChangeRefusedError({
          reason: "This authenticator setup expired. Start it again to get a new code.",
        });
      }
      const step = yield* AccountCredentials.matchTotpStep(
        pending.secret,
        input.totp.code,
        DateTime.toEpochMillis(now),
      ).pipe(withCrypto);
      if (step === undefined) {
        return yield* new AccountChangeRefusedError({
          reason: "That code did not match. Check the time on your device and try again.",
        });
      }
      totpStep = step;
      totpSecretCiphertext = yield* credentialKey.pipe(
        Effect.flatMap((key) => AccountCredentials.seal(key, pending.secret, userId)),
        withCrypto,
        storage,
      );
    }
    // Only after the code checks out, so the answer is no free probe of which names exist.
    if (Option.isSome(yield* users.getByLoginName(loginName).pipe(storage))) {
      return yield* new LoginNameTakenError({});
    }
    return {
      userId,
      displayName: input.displayName,
      tokenHash: input.tokenHash,
      passkey: null,
      password: { loginName, passwordHash: yield* hashPassword(input.password) },
      totpSecretCiphertext,
      totpStep,
    } satisfies PendingInvitee;
  });

  const createInvitedUser: UserDirectory["Service"]["createInvitedUser"] = Effect.fn(
    "UserDirectory.createInvitedUser",
  )(function* (pending) {
    const created = yield* users
      .createUser({
        userId: pending.userId,
        displayName: pending.displayName,
        createdAt: yield* DateTime.now,
        passkey: pending.passkey,
        password: pending.password,
        totp:
          pending.totpSecretCiphertext === null
            ? null
            : {
                secretCiphertext: pending.totpSecretCiphertext,
                lastUsedStep: pending.totpStep ?? -1,
              },
      })
      .pipe(storage);
    if (!created) return yield* new LoginNameTakenError({});
    return { id: pending.userId, displayName: pending.displayName, isOwner: false };
  });

  const hasStrongSignIn: UserDirectory["Service"]["hasStrongSignIn"] = Effect.fn(
    "UserDirectory.hasStrongSignIn",
  )(function* (userId) {
    const credentials = yield* users.getCredentials(userId).pipe(storage);
    return credentials.hasPasskey || credentials.totpSecretCiphertext !== null;
  });

  return UserDirectory.of({
    startInviteeRegistration,
    verifyInviteeRegistration,
    startInviteeTotpEnrollment,
    prepareInviteePassword,
    createInvitedUser,
    hasStrongSignIn,
    hasOwner: Effect.fn("UserDirectory.hasOwner")(function () {
      return users.hasOwner().pipe(storage);
    }),
    ownerId: Effect.fn("UserDirectory.ownerId")(function () {
      return users.getOwner().pipe(Effect.map(Option.map((owner) => owner.userId)), storage);
    }),
    findUser: Effect.fn("UserDirectory.findUser")(function (userId: UserId) {
      return users.getById(userId).pipe(Effect.map(Option.map(toAuthUser)), storage);
    }),
    displayNames: Effect.fn("UserDirectory.displayNames")(function (
      userIds: ReadonlyArray<UserId>,
    ) {
      return users.getByIds(userIds).pipe(
        Effect.map((found) => new Map(found.map((user) => [user.userId, user.displayName]))),
        storage,
      );
    }),
    findActiveUser: Effect.fn("UserDirectory.findActiveUser")(function (userId: UserId) {
      return activeUser(userId).pipe(Effect.map(Option.map(toAuthUser)));
    }),
    startOwnerRegistration,
    verifyOwnerRegistration,
    createOwner,
    startPasskeySignIn,
    finishPasskeySignIn,
    redeemRecoveryCode,
    getAccount,
    setPassword,
    removePassword,
    startTotpEnrollment,
    confirmTotpEnrollment,
    removeTotp,
    checkPassword,
    checkTotp,
    issueOwnerResetLink,
    getResetLinkStatus,
    startResetRegistration,
    verifyResetRegistration,
    redeemResetLink,
  });
});

export const layer = Layer.effect(UserDirectory, make).pipe(Layer.provideMerge(Users.layer));
