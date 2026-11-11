/**
 * The Hub's secrets, one file per name in `<stateDir>/secrets`, each sealed with the master key
 * without its callers knowing. A joined machine keeps the credential its Hub writes as written (a
 * Sandbox mounts it read-only): see docs/internals/secrets.md.
 */
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { createExclusively, writeAtomically } from "./atomicFile.ts";
import * as MasterKeyFile from "./MasterKeyFile.ts";
import * as SecretCipher from "./SecretCipher.ts";

const secretStoreErrorContext = {
  resource: Schema.String,
  cause: Schema.Defect(),
};

export class SecretStoreSecureError extends Schema.TaggedError<SecretStoreSecureError>()(
  "SecretStoreSecureError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to secure ${this.resource}.`;
  }
}

export class SecretStoreReadError extends Schema.TaggedError<SecretStoreReadError>()(
  "SecretStoreReadError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource}.`;
  }
}

export class SecretStoreTemporaryPathError extends Schema.TaggedError<SecretStoreTemporaryPathError>()(
  "SecretStoreTemporaryPathError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to create temporary path for ${this.resource}.`;
  }
}

export class SecretStorePersistError extends Schema.TaggedError<SecretStorePersistError>()(
  "SecretStorePersistError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to persist ${this.resource}.`;
  }
}

export class SecretStoreRandomGenerationError extends Schema.TaggedError<SecretStoreRandomGenerationError>()(
  "SecretStoreRandomGenerationError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to generate random bytes for ${this.resource}.`;
  }
}

export class SecretStoreConcurrentReadError extends Schema.TaggedError<SecretStoreConcurrentReadError>()(
  "SecretStoreConcurrentReadError",
  {
    resource: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource} after concurrent creation.`;
  }
}

export class SecretStoreRemoveError extends Schema.TaggedError<SecretStoreRemoveError>()(
  "SecretStoreRemoveError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to remove ${this.resource}.`;
  }
}

export class SecretStoreDecodeError extends Schema.TaggedError<SecretStoreDecodeError>()(
  "SecretStoreDecodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource}.`;
  }
}

export class SecretStoreEncodeError extends Schema.TaggedError<SecretStoreEncodeError>()(
  "SecretStoreEncodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to encode ${this.resource}.`;
  }
}

export const SecretStoreError = Schema.Union([
  SecretStoreSecureError,
  SecretStoreReadError,
  SecretStoreTemporaryPathError,
  SecretStorePersistError,
  SecretStoreRandomGenerationError,
  SecretStoreConcurrentReadError,
  SecretStoreRemoveError,
  SecretStoreDecodeError,
  SecretStoreEncodeError,
]);
export type SecretStoreError = typeof SecretStoreError.Type;
export const isSecretStoreError = Schema.is(SecretStoreError);

const isPlatformError = (value: unknown): value is PlatformError.PlatformError =>
  Predicate.isTagged(value, "PlatformError");

export const isSecretAlreadyExistsError = (error: SecretStoreError): boolean =>
  "cause" in error && isPlatformError(error.cause) && error.cause.reason._tag === "AlreadyExists";

export class ServerSecretStore extends Context.Service<
  ServerSecretStore,
  {
    readonly directory?: string;
    readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
    readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly create: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly getOrCreateRandom: (
      name: string,
      bytes: number,
    ) => Effect.Effect<Uint8Array, SecretStoreError>;
    readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
  }
>()("t3/auth/ServerSecretStore") {}

/** The master key the store opened with; none on a joined machine. */
export class MasterKeyring extends Context.Service<
  MasterKeyring,
  {
    readonly keyring: Option.Option<MasterKeyFile.Keyring>;
    /** Why a command beside a running server could not open it (the server's startup is due). */
    readonly unavailable: Option.Option<MasterKeyFile.MasterKeyError>;
  }
>()("t3/auth/ServerSecretStore/MasterKeyring") {}

/**
 * `owner`: a server (Hub or joined), which holds the ownership lock. `client`: a command beside
 * it, which takes the lock for its startup only when no server runs, and otherwise only reads.
 * `joined`: `t3 join`, about to make this machine a joined one.
 */
type StoreMode = "owner" | "client" | "joined";

const makeWith = Effect.fn("ServerSecretStore.make")(function* (mode: StoreMode) {
  const crypto = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;

  yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true });
  yield* fileSystem.chmod(serverConfig.secretsDir, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreSecureError({
          resource: `secrets directory ${serverConfig.secretsDir}`,
          cause,
        }),
    ),
  );

  const joinedMachine =
    mode === "joined" ||
    serverConfig.joinedHub !== undefined ||
    (yield* fileSystem.exists(serverConfig.joinedHubPath).pipe(Effect.orElseSucceed(() => false)));
  // A joined machine that was a Hub keeps its key: what that Hub sealed opens, and new values are
  // sealed too. One that never was keeps the credential its Hub writes in clear.
  const encrypted = !joinedMachine || (yield* MasterKeyFile.holdsEncryptedSecrets());
  const openAsClient = Effect.scoped(
    Effect.gen(function* () {
      // Loaded here: the ownership module reaches much of the server, which reaches this store.
      const [ServerOwnership, ProcessRunner] = yield* Effect.promise(() =>
        Promise.all([import("../serverOwnership.ts"), import("../processRunner.ts")]),
      );
      const owned = yield* ServerOwnership.acquireServerOwnership(
        serverConfig.serverRuntimeStatePath,
      ).pipe(Effect.provide(ProcessRunner.layer), Effect.option);
      return yield* MasterKeyFile.openKeyring(Option.isSome(owned) ? "owner" : "client");
    }),
  );
  // Beside a running server whose store needs its startup, a command still runs; only what reads
  // or writes a secret fails, saying so.
  const opened = !encrypted
    ? undefined
    : mode === "owner"
      ? yield* MasterKeyFile.openKeyring("owner").pipe(Effect.map(Result.succeed))
      : yield* openAsClient.pipe(
          Effect.map(Result.succeed),
          Effect.catchIf(
            (error) => error.reason === "needs-hub",
            (error) => Effect.succeed(Result.fail(error)),
          ),
        );
  const keyring = opened !== undefined && Result.isSuccess(opened) ? opened.success : undefined;
  const unavailable = opened !== undefined && Result.isFailure(opened) ? opened.failure : undefined;

  const sealedPath = (name: string) =>
    path.join(serverConfig.secretsDir, `${name}${MasterKeyFile.SEALED_EXTENSION}`);
  const plainPath = (name: string) =>
    path.join(serverConfig.secretsDir, `${name}${MasterKeyFile.PLAIN_EXTENSION}`);
  /** Where this store writes `name`: sealed on a Hub, in clear on a joined machine. */
  const entryPath = keyring === undefined ? plainPath : sealedPath;

  const notReadable = (name: string, cause: string) =>
    new SecretStoreDecodeError({ resource: `secret ${name}`, cause });

  const isPresent = (name: string, file: string) =>
    fileSystem.stat(file).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      Effect.mapError((cause) => new SecretStoreReadError({ resource: `secret ${name}`, cause })),
    );

  const readOptional = (name: string, file: string) =>
    fileSystem.readFile(file).pipe(
      Effect.map((bytes) => Option.some(Uint8Array.from(bytes))),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeedNone
          : Effect.fail(new SecretStoreReadError({ resource: `secret ${name}`, cause })),
      ),
    );

  const getSealed = Effect.fn("ServerSecretStore.getSealed")(function* (
    current: MasterKeyFile.Keyring,
    name: string,
  ) {
    const stored = yield* readOptional(name, sealedPath(name));
    if (Option.isNone(stored)) {
      // Never accepted: an entry in clear after the startup was planted, or is from before it.
      if (yield* isPresent(name, plainPath(name))) {
        return yield* notReadable(name, "stored in clear; restart the Hub to encrypt it");
      }
      return Option.none<Uint8Array>();
    }
    const opened = SecretCipher.open(current.keys, "server-secret", name, stored.value);
    switch (opened._tag) {
      case "opened":
        return Option.some(opened.plaintext);
      case "unknown-key":
        return yield* notReadable(name, `sealed by another master key (id ${opened.keyId})`);
      case "unknown-format":
        return yield* notReadable(name, "of a format this version cannot read");
      case "rejected":
        return yield* notReadable(name, "altered, or moved from another name");
    }
  });

  const getPlain = Effect.fn("ServerSecretStore.getPlain")(function* (name: string) {
    // Sealed bytes are never a value: without the key that sealed them, nothing comes back.
    if (yield* isPresent(name, sealedPath(name))) {
      return yield* notReadable(name, "sealed with a master key this machine no longer has");
    }
    return yield* readOptional(name, plainPath(name));
  });

  /** Every operation fails, saying why, while the store could not be opened beside a server. */
  const whenOpen = <A, E>(
    name: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | SecretStoreReadError> =>
    unavailable === undefined
      ? effect
      : Effect.fail(new SecretStoreReadError({ resource: `secret ${name}`, cause: unavailable }));

  const get: ServerSecretStore["Service"]["get"] = (name) =>
    whenOpen(name, keyring === undefined ? getPlain(name) : getSealed(keyring, name)).pipe(
      Effect.withSpan("ServerSecretStore.get"),
    );

  const sealFor = (name: string, value: Uint8Array) =>
    keyring === undefined
      ? value
      : SecretCipher.seal(keyring.current, "server-secret", name, value);

  const withFiles = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const set: ServerSecretStore["Service"]["set"] = (name, value) =>
    whenOpen(name, withFiles(writeAtomically(entryPath(name), sealFor(name, value)))).pipe(
      Effect.mapError(
        (cause) => new SecretStorePersistError({ resource: `secret ${name}`, cause }),
      ),
      Effect.withSpan("ServerSecretStore.set"),
    );

  // `link` publishes the fully written temp file under the final name, or fails with
  // AlreadyExists, so a concurrent reader never observes a partially written secret.
  const create: ServerSecretStore["Service"]["create"] = (name, value) =>
    whenOpen(name, withFiles(createExclusively(entryPath(name), sealFor(name, value)))).pipe(
      Effect.mapError(
        (cause) => new SecretStorePersistError({ resource: `secret ${name}`, cause }),
      ),
      Effect.withSpan("ServerSecretStore.create"),
    );

  const getOrCreateRandom: ServerSecretStore["Service"]["getOrCreateRandom"] = (name, bytes) =>
    get(name).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            crypto.randomBytes(bytes).pipe(
              Effect.mapError(
                (cause) =>
                  new SecretStoreRandomGenerationError({
                    resource: `secret ${name}`,
                    cause,
                  }),
              ),
              Effect.flatMap((generated) =>
                create(name, generated).pipe(
                  Effect.as(Uint8Array.from(generated)),
                  Effect.catchIf(isSecretStoreError, (error) =>
                    isSecretAlreadyExistsError(error)
                      ? get(name).pipe(
                          Effect.flatMap(
                            Option.match({
                              onSome: Effect.succeed,
                              onNone: () =>
                                Effect.fail(
                                  new SecretStoreConcurrentReadError({
                                    resource: `secret ${name}`,
                                  }),
                                ),
                            }),
                          ),
                        )
                      : Effect.fail(error),
                  ),
                ),
              ),
            ),
        }),
      ),
      Effect.withSpan("ServerSecretStore.getOrCreateRandom"),
    );

  const removeFile = (name: string, file: string) =>
    fileSystem
      .remove(file)
      .pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.void
            : Effect.fail(new SecretStoreRemoveError({ resource: `secret ${name}`, cause })),
        ),
      );

  const remove: ServerSecretStore["Service"]["remove"] = (name) =>
    whenOpen(name, removeFile(name, sealedPath(name))).pipe(
      Effect.andThen(removeFile(name, plainPath(name))),
      Effect.withSpan("ServerSecretStore.remove"),
    );

  return Context.make(
    ServerSecretStore,
    ServerSecretStore.of({
      directory: serverConfig.secretsDir,
      get,
      set,
      create,
      getOrCreateRandom,
      remove,
    }),
  ).pipe(
    Context.add(
      MasterKeyring,
      MasterKeyring.of({
        keyring: Option.fromUndefinedOr(keyring),
        unavailable: Option.fromUndefinedOr(unavailable),
      }),
    ),
  );
});

/** @public */
export const make = Effect.map(makeWith("owner"), Context.get(ServerSecretStore));

/** The Hub's store; the Hub holds the server's ownership lock (server.ts). */
export const layer = Layer.effectContext(makeWith("owner"));

/** A command beside the Hub (`t3 ...`): opens read-only while a Hub runs. */
export const layerClient = Layer.effectContext(makeWith("client"));

/** `t3 join`: the credential is kept as the joined machine will keep it (see `makeWith`). */
export const layerJoinedMachine = Layer.effectContext(makeWith("joined"));
