import {
  type AuthPasskeyAuthenticationResponse,
  type AuthPasskeyRegistrationCeremony,
  type AuthPasskeyRegistrationResponse,
  type AuthPasskeySignInCeremony,
  type AuthUser,
  UserId,
} from "@t3tools/contracts";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Users from "../persistence/Users.ts";

const CEREMONY_TTL = Duration.minutes(5);
// Sign-in challenges are unauthenticated, so they get their own bounded store; an Owner
// registration needs the bootstrap link and can never be evicted by them.
const MAX_PENDING_SIGN_INS = 1_000;
const MAX_PENDING_OWNER_REGISTRATIONS = 16;
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
  }
>()("t3/auth/UserDirectory") {}

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
    return {
      ceremonyId,
      options: {
        challenge,
        rp: { id: rpId, name: "T3 Code" },
        user: {
          id: isoBase64URL.fromUTF8String(userId),
          name: displayName,
          displayName,
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
    } satisfies AuthPasskeyRegistrationCeremony;
  });

  const verifyOwnerRegistration: UserDirectory["Service"]["verifyOwnerRegistration"] = Effect.fn(
    "UserDirectory.verifyOwnerRegistration",
  )(function* ({ ceremonyId, origin, response }) {
    const ceremony = yield* takeCeremony(ownerRegistrations, ceremonyId, origin);
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
      userId: ceremony.userId,
      displayName: ceremony.displayName,
      passkey: {
        credentialId: credential.id,
        publicKey: isoBase64URL.fromBuffer(credential.publicKey),
        signCount: credential.counter,
        transports: credential.transports ?? [],
        rpId: ceremony.rpId,
      },
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
  });
});

export const layer = Layer.effect(UserDirectory, make).pipe(Layer.provideMerge(Users.layer));
