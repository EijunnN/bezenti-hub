// @effect-diagnostics nodeBuiltinImport:off - temp names and import suffixes use node:crypto.
/**
 * The master key file and the startup that checks it against every entry before writing, seals
 * entries left in clear, and finishes a rotation that stopped. Never creates a key over sealed
 * values. Each step and its crash behaviour: docs/internals/secrets.md.
 */
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as SecretCipher from "./SecretCipher.ts";

/** Sealed by the key it checks; beside the entries but never one of them (no `.bin`). */
const KEY_CHECK_FILE = "master-key.check";
const KEY_CHECK_TEXT = "t3code master key check";
const ENTRY_FILE = /^(.+)\.bin$/;
/** Temporary files older than this belong to a write that stopped; newer ones may be in flight. */
const STALE_TEMP_MS = 60_000;

const RESTORE_HINT =
  "Restore the master key from your backup with `t3 secrets key import <file>`, or point T3CODE_MASTER_KEY_FILE at it.";

export class MasterKeyError extends Schema.TaggedError<MasterKeyError>()("MasterKeyError", {
  reason: Schema.Literals([
    "missing",
    "wrong-key",
    "permissions",
    "unreadable",
    "unknown-format",
    "damaged",
    "not-encrypted",
    "io",
  ]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (reason: MasterKeyError["reason"], detail: string, cause?: unknown) =>
  Effect.fail(new MasterKeyError({ reason, detail, ...(cause === undefined ? {} : { cause }) }));

/** Where the master key lives: `T3CODE_MASTER_KEY_FILE`, or `<stateDir>/master.key`. */
export const masterKeyPath = Effect.fn("MasterKeyFile.masterKeyPath")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return config.masterKeyFile ?? path.join(config.stateDir, "master.key");
});

const io = (what: string) => (cause: unknown) => fail("io", `Could not ${what}.`, cause);

const readKeyFile = Effect.fn("MasterKeyFile.readKeyFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file).pipe(Effect.catch(io(`check ${file}`))))) {
    return Option.none<SecretCipher.MasterKey>();
  }
  // On Windows mode bits mean nothing: the file inherits its folder's ACL (the user's profile).
  if ((yield* HostProcess.Platform) !== "win32") {
    const info = yield* fs.stat(file).pipe(Effect.catch(io(`read ${file}`)));
    if ((info.mode & 0o077) !== 0) {
      return yield* fail(
        "permissions",
        `The master key ${file} can be read by other users of this machine. Run \`chmod 600 ${file}\` and start again.`,
      );
    }
  }
  const text = yield* fs.readFileString(file).pipe(Effect.catch(io(`read ${file}`)));
  const key = SecretCipher.MasterKey.parse(text);
  if (key === undefined) {
    return yield* fail("unreadable", `${file} is not a T3 Code master key.`);
  }
  return Option.some(key);
});

const tempPathOf = (target: string) => `${target}.${NodeCrypto.randomUUID()}.tmp`;

const writeTemp = Effect.fn("MasterKeyFile.writeTemp")(function* (temp: string, bytes: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(temp, { flag: "wx", mode: 0o600 });
      yield* file.writeAll(bytes);
      yield* file.sync;
    }),
  );
  yield* fs.chmod(temp, 0o600);
});

/** Replaces `target` whole: a reader sees the old bytes or the new ones, never a mix. */
const writeAtomically = Effect.fn("MasterKeyFile.writeAtomically")(function* (
  target: string,
  bytes: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const temp = tempPathOf(target);
  yield* Effect.gen(function* () {
    yield* writeTemp(temp, bytes);
    yield* fs.rename(temp, target);
  }).pipe(Effect.onError(() => fs.remove(temp).pipe(Effect.ignore)));
});

/** Publishes `target` only if nothing is there yet (fails with AlreadyExists otherwise). */
const createExclusively = Effect.fn("MasterKeyFile.createExclusively")(function* (
  target: string,
  bytes: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const temp = tempPathOf(target);
  yield* Effect.gen(function* () {
    yield* writeTemp(temp, bytes);
    yield* fs.link(temp, target);
  }).pipe(Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)));
});

interface StoredEntry {
  readonly name: string;
  readonly file: string;
  readonly bytes: Uint8Array;
  readonly form: SecretCipher.StoredForm;
}

const readEntries = Effect.fn("MasterKeyFile.readEntries")(function* (secretsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(secretsDir).pipe(Effect.catch(io(`list ${secretsDir}`)));
  const entries: Array<StoredEntry> = [];
  for (const fileName of names.toSorted()) {
    const name = ENTRY_FILE.exec(fileName)?.[1];
    if (name === undefined) continue;
    const file = path.join(secretsDir, fileName);
    const bytes = yield* fs.readFile(file).pipe(
      Effect.asSome,
      // Removed meanwhile (a replay marker pruned): nothing to check.
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.catch(io(`read ${file}`)),
    );
    if (Option.isNone(bytes)) continue;
    entries.push({ name, file, bytes: bytes.value, form: SecretCipher.classify(bytes.value) });
  }
  return entries;
});

const readOptionalFile = Effect.fn("MasterKeyFile.readOptionalFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file).pipe(Effect.catch(io(`check ${file}`))))) {
    return Option.none<Uint8Array>();
  }
  return yield* fs.readFile(file).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.catch(io(`read ${file}`)),
  );
});

const removeStaleTemps = Effect.fn("MasterKeyFile.removeStaleTemps")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  for (const name of names) {
    if (!name.endsWith(".tmp")) continue;
    const file = path.join(dir, name);
    yield* fs.stat(file).pipe(
      Effect.flatMap((info) =>
        Option.exists(info.mtime, (mtime) => now - mtime.getTime() > STALE_TEMP_MS)
          ? fs.remove(file)
          : Effect.void,
      ),
      Effect.ignore,
    );
  }
});

export interface Keyring {
  /** Seals every new value. */
  readonly current: SecretCipher.MasterKey;
  /** Open values: the current key and, kept until the Owner removes it, the previous one. */
  readonly keys: ReadonlyArray<SecretCipher.MasterKey>;
  readonly keyFile: string;
}

interface KeyFiles {
  readonly keyFile: string;
  readonly nextFile: string;
  readonly previousFile: string;
}

const keyFilesOf = Effect.fn("MasterKeyFile.keyFiles")(function* () {
  const keyFile = yield* masterKeyPath();
  return { keyFile, nextFile: `${keyFile}.next`, previousFile: `${keyFile}.previous` } as KeyFiles;
});

const isAlreadyExists = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "reason" in error &&
  (error as { reason: { _tag?: string } }).reason._tag === "AlreadyExists";

/**
 * Loads the master key (creating it on a store with nothing encrypted), checks it opens every
 * entry, seals entries left in clear and finishes a rotation that stopped. Writes nothing until
 * every entry was checked.
 */
export const openKeyring = Effect.fn("MasterKeyFile.openKeyring")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const { keyFile, nextFile, previousFile } = yield* keyFilesOf();
  const secretsDir = config.secretsDir;
  const checkFile = path.join(secretsDir, KEY_CHECK_FILE);

  const [found, next, previous] = yield* Effect.all([
    readKeyFile(keyFile),
    readKeyFile(nextFile),
    readKeyFile(previousFile),
  ]);
  const entries = yield* readEntries(secretsDir);
  const check = yield* readOptionalFile(checkFile);

  let current: SecretCipher.MasterKey;
  if (Option.isSome(found)) {
    current = found.value;
  } else {
    const encrypted = entries.filter((entry) => entry.form._tag !== "plain").length;
    if (encrypted > 0 || Option.isSome(check) || Option.isSome(next) || Option.isSome(previous)) {
      return yield* fail(
        "missing",
        `The master key ${keyFile} is missing, but ${secretsDir} holds secrets encrypted with one${encrypted > 0 ? ` (${encrypted})` : ""}. The Hub does not start without it and never creates a new key over them. ${RESTORE_HINT}`,
      );
    }
    yield* fs
      .makeDirectory(path.dirname(keyFile), { recursive: true, mode: 0o700 })
      .pipe(Effect.catch(io(`create the folder of ${keyFile}`)));
    const created = SecretCipher.MasterKey.generate();
    current = yield* createExclusively(
      keyFile,
      new TextEncoder().encode(created.exportText()),
    ).pipe(
      Effect.as(created),
      Effect.catch((error) =>
        // Another process (a CLI beside the server) made it first: use theirs.
        isAlreadyExists(error)
          ? readKeyFile(keyFile).pipe(
              Effect.flatMap(
                Option.match({
                  onSome: Effect.succeed,
                  onNone: () => fail("io", `${keyFile} vanished while it was created.`),
                }),
              ),
            )
          : fail("io", `Could not create ${keyFile}.`, error),
      ),
    );
    yield* Effect.logInfo("Created the master key that encrypts the Hub's secrets.", {
      keyFile,
      keyId: current.id,
    });
  }
  const keys = [current, ...Option.toArray(next), ...Option.toArray(previous)];

  // Check everything before writing anything.
  for (const entry of entries) {
    const form = entry.form;
    if (form._tag === "unknown-format") {
      return yield* fail(
        "unknown-format",
        `${entry.file} was written by a newer T3 Code; this version cannot read it.`,
      );
    }
    if (form._tag === "sealed" && !keys.some((key) => key.id === form.keyId)) {
      return yield* fail(
        "wrong-key",
        `The master key ${keyFile} (id ${current.id}) is not the key that encrypted ${entry.file} (id ${form.keyId}). The Hub does not start and changed nothing. ${RESTORE_HINT}`,
      );
    }
  }
  if (Option.isSome(check)) {
    const opened = SecretCipher.open(keys, "key-check", KEY_CHECK_FILE, check.value);
    if (opened._tag !== "opened" || new TextDecoder().decode(opened.plaintext) !== KEY_CHECK_TEXT) {
      return yield* fail(
        "wrong-key",
        `The master key ${keyFile} (id ${current.id}) does not open the key check ${checkFile}: it is not the key these secrets were encrypted with. The Hub does not start and changed nothing. ${RESTORE_HINT}`,
      );
    }
  }

  // A rotation that stopped finishes toward its new key; otherwise everything ends under the
  // current one.
  const target = Option.getOrElse(next, () => current);
  let sealed = 0;
  for (const entry of entries) {
    if (entry.form._tag === "sealed" && entry.form.keyId === target.id) continue;
    let plaintext = entry.bytes;
    if (entry.form._tag === "sealed") {
      const opened = SecretCipher.open(keys, "server-secret", entry.name, entry.bytes);
      if (opened._tag !== "opened") {
        return yield* fail(
          "damaged",
          `${entry.file} does not open with its key: it was altered or moved from another name. Remove it, or restore it from a backup.`,
        );
      }
      plaintext = opened.plaintext;
    }
    yield* writeAtomically(
      entry.file,
      SecretCipher.seal(target, "server-secret", entry.name, plaintext),
    ).pipe(Effect.catch(io(`encrypt ${entry.file}`)));
    sealed += 1;
  }
  const checkSealed = SecretCipher.seal(
    target,
    "key-check",
    KEY_CHECK_FILE,
    new TextEncoder().encode(KEY_CHECK_TEXT),
  );
  if (Option.isNone(check)) {
    yield* createExclusively(checkFile, checkSealed).pipe(
      Effect.catchIf(isAlreadyExists, () => Effect.void),
      Effect.catch(io(`write ${checkFile}`)),
    );
  } else {
    const form = SecretCipher.classify(check.value);
    if (form._tag !== "sealed" || form.keyId !== target.id) {
      yield* writeAtomically(checkFile, checkSealed).pipe(Effect.catch(io(`write ${checkFile}`)));
    }
  }

  if (Option.isSome(next)) {
    // Every entry is under the new key: keep the old one, then put the new one in place.
    yield* writeAtomically(previousFile, new TextEncoder().encode(current.exportText())).pipe(
      Effect.catch(io(`write ${previousFile}`)),
    );
    yield* fs.rename(nextFile, keyFile).pipe(Effect.catch(io(`replace ${keyFile}`)));
    yield* Effect.logInfo("Finished rotating the master key.", {
      keyFile,
      keyId: target.id,
      previousKeyId: current.id,
      resealed: sealed,
    });
  } else if (sealed > 0) {
    yield* Effect.logInfo("Encrypted secrets stored before encryption.", { count: sealed });
  }
  yield* removeStaleTemps(secretsDir);

  const previousKey = Option.isSome(next) ? Option.some(current) : previous;
  return {
    current: target,
    keys: [target, ...Option.toArray(previousKey)],
    keyFile,
  } satisfies Keyring;
});

/**
 * Starts a rotation (the new key beside the old one) and runs the startup that finishes it. The
 * Hub must be stopped: it seals with the key it loaded.
 */
export const rotate = Effect.fn("MasterKeyFile.rotate")(function* () {
  const { nextFile } = yield* keyFilesOf();
  const before = yield* openKeyring();
  const fresh = SecretCipher.MasterKey.generate();
  yield* writeAtomically(nextFile, new TextEncoder().encode(fresh.exportText())).pipe(
    Effect.catch(io(`write ${nextFile}`)),
  );
  const after = yield* openKeyring();
  return { previousKeyId: before.current.id, keyId: after.current.id, keyFile: after.keyFile };
});

/**
 * Puts a backed-up key in place. Refused when it does not open the secrets here; a key it replaces
 * is kept beside it (`master.key.replaced-<id>`), never discarded.
 */
export const importKey = Effect.fn("MasterKeyFile.importKey")(function* (
  text: Redacted.Redacted<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const { keyFile, nextFile } = yield* keyFilesOf();
  const key = SecretCipher.MasterKey.parse(Redacted.value(text));
  if (key === undefined) {
    return yield* fail("unreadable", "That is not a T3 Code master key backup.");
  }
  if (yield* fs.exists(nextFile).pipe(Effect.catch(io(`check ${nextFile}`)))) {
    return yield* fail(
      "io",
      `A rotation of the master key has not finished (${nextFile}). Run \`t3 secrets key rotate\` or start the Hub once, then import.`,
    );
  }
  const current = yield* readKeyFile(keyFile).pipe(
    // A damaged or too-open key file is replaced like a missing one (it is kept beside).
    Effect.catchTags({
      MasterKeyError: (error) => (error.reason === "io" ? Effect.fail(error) : Effect.succeedNone),
    }),
  );
  if (Option.isSome(current) && current.value.id === key.id) {
    return { keyId: key.id, keyFile, replaced: false };
  }
  const entries = yield* readEntries(config.secretsDir);
  const check = yield* readOptionalFile(path.join(config.secretsDir, KEY_CHECK_FILE));
  const sealedIds = new Set(
    entries.flatMap((entry) => (entry.form._tag === "sealed" ? [entry.form.keyId] : [])),
  );
  const checkOpens =
    Option.isNone(check) ||
    SecretCipher.open([key], "key-check", KEY_CHECK_FILE, check.value)._tag === "opened";
  if (!checkOpens || [...sealedIds].some((id) => id !== key.id)) {
    const currentOpens =
      Option.isSome(current) && [...sealedIds].every((id) => id === current.value.id);
    return yield* fail(
      "wrong-key",
      currentOpens
        ? `The secrets in ${config.secretsDir} are encrypted with the current master key (id ${current.value.id}), not with that one (id ${key.id}). Nothing changed; \`t3 secrets key rotate\` changes keys.`
        : `That master key (id ${key.id}) does not open the secrets in ${config.secretsDir}. Nothing changed.`,
    );
  }
  yield* fs
    .makeDirectory(path.dirname(keyFile), { recursive: true, mode: 0o700 })
    .pipe(Effect.catch(io(`create the folder of ${keyFile}`)));
  const replaced = yield* fs.readFile(keyFile).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.catch(io(`read ${keyFile}`)),
  );
  if (Option.isSome(replaced)) {
    const keptAs = `${keyFile}.replaced-${Option.match(current, {
      onSome: (old) => old.id,
      onNone: () => NodeCrypto.randomBytes(4).toString("hex"),
    })}`;
    yield* writeAtomically(keptAs, replaced.value).pipe(Effect.catch(io(`write ${keptAs}`)));
  }
  yield* writeAtomically(keyFile, new TextEncoder().encode(key.exportText())).pipe(
    Effect.catch(io(`write ${keyFile}`)),
  );
  return { keyId: key.id, keyFile, replaced: Option.isSome(replaced) };
});
