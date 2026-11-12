// @effect-diagnostics nodeBuiltinImport:off -- the backup file, stdin, and whether this machine joined.
/**
 * `t3 secrets key export|import|rotate`: the master key that encrypts the Hub's secrets. Export
 * works beside a running Hub; import and rotate take the server's ownership lock, so the Hub must
 * be stopped. The key never goes through argv. See docs/internals/secrets.md.
 */
import * as NodeFS from "node:fs";

import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as AuditLog from "../audit/AuditLog.ts";
import * as MasterKeyBackup from "../auth/MasterKeyBackup.ts";
import * as MasterKeyFile from "../auth/MasterKeyFile.ts";
import { backupProofOf } from "../auth/SecretCipher.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VaultKeyCheck from "../vaults/VaultKeyCheck.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";

const userError = (message: string) => new CliError.UserError({ cause: message });

const JOINED =
  "This machine is joined to a Hub: its secrets are not encrypted with a master key. Run this on the Hub.";

/** The Hub's state directory, never a joined machine's. */
const hubConfig = Effect.fn("cli.secrets.hubConfig")(function* (
  flags: Parameters<typeof resolveCliAuthConfig>[0],
) {
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
    quietLogs: true,
  });
  if (NodeFS.existsSync(config.joinedHubPath)) return yield* userError(JOINED);
  return config;
});

const keyError = (error: MasterKeyFile.MasterKeyError) => userError(error.message);

/** Recorded like the Hub records it; a log it cannot write never undoes the rotation done. */
const auditRotation = Effect.fn("cli.secrets.auditRotation")(function* (
  config: ServerConfig.ServerConfig["Service"],
  entry: AuditLog.AuditRecord,
) {
  yield* Effect.flatMap(AuditLog.AuditLog, (log) => log.record(entry)).pipe(
    Effect.provide(
      AuditLog.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerConfig),
        Layer.provideMerge(ServerConfig.layer(config)),
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not record it in the audit log", { cause }),
    ),
  );
});

/**
 * The database's key check follows the key, so the next start opens it even once the previous key
 * is deleted. A failure here is finished by that start while the previous key is kept.
 */
const resealDatabaseCheck = Effect.fn("cli.secrets.resealDatabaseCheck")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  yield* MasterKeyFile.openKeyring("owner").pipe(
    Effect.flatMap(VaultKeyCheck.checkDatabaseKey),
    Effect.provide(
      SqlitePersistence.layerConfig.pipe(Layer.provideMerge(ServerConfig.layer(config))),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "Could not re-encrypt the database's key check; the Hub's next start does it while master.key.previous is kept",
        { cause },
      ),
    ),
  );
});

/** An unreachable server may still be running: never rewrite keys behind it. */
const requireHubStopped = Effect.fn("cli.secrets.requireHubStopped")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  yield* ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath).pipe(
    Effect.provide(ProcessRunner.layer),
    Effect.mapError(() =>
      userError(
        `The Hub for ${config.baseDir} is running. Stop it first: it encrypts with the key it loaded.`,
      ),
    ),
  );
});

/** Resolves once stdout took every byte; a closed pipe fails rather than counting as a backup. */
const writeStdout = (text: string) =>
  Effect.callback<void, CliError.UserError>((resume) => {
    process.stdout.write(text, (error) =>
      resume(
        error === undefined || error === null
          ? Effect.void
          : Effect.fail(userError("Could not write the key to stdout; it is not backed up.")),
      ),
    );
  });

const writeNewFile = Effect.fn("cli.secrets.writeNewFile")(function* (file: string, text: string) {
  yield* Effect.try({
    try: () => {
      const fd = NodeFS.openSync(file, "wx", 0o600);
      try {
        NodeFS.writeFileSync(fd, text);
        NodeFS.fsyncSync(fd);
      } finally {
        NodeFS.closeSync(fd);
      }
    },
    catch: (cause) =>
      userError(
        (cause as NodeJS.ErrnoException).code === "EEXIST"
          ? `${file} already exists; choose a new file.`
          : `Could not write ${file}; the key is not backed up.`,
      ),
  });
});

const outputFlag = Flag.String("output").pipe(
  Flag.withDescription(
    "Write the key to this new file (owner-only; an existing file is never overwritten) instead of printing it.",
  ),
  Flag.optional,
);

const exportCommand = Command.make("export", { ...authLocationFlags, output: outputFlag }).pipe(
  Command.withDescription(
    "Back up the master key: print it, or write it to --output. Keep it off this server's disk.",
  ),
  Command.withHandler(
    Effect.fn("cli.secrets.key.export")(function* (flags) {
      const config = yield* hubConfig(flags);
      return yield* Effect.gen(function* () {
        const backup = yield* MasterKeyBackup.MasterKeyBackup;
        // Audited before it leaves; recorded as a backup only once it was written whole.
        const exported = yield* backup.export({ actor: AuditLog.cliActor, via: "cli" });
        const text = Redacted.value(exported.key);
        if (Option.isSome(flags.output)) {
          yield* writeNewFile(flags.output.value, text);
        } else {
          yield* writeStdout(text);
        }
        const status = yield* backup.confirm({
          keyId: exported.keyId,
          proof: Redacted.make(backupProofOf(text)),
          at: DateTime.formatIso(yield* DateTime.now),
        });
        yield* Console.error(
          `Backed up master key ${status.keyId}${Option.isSome(flags.output) ? ` to ${flags.output.value}` : ""}. Anyone with it can read this Hub's secrets from a copy of its disk.`,
        );
      }).pipe(
        Effect.provide(
          MasterKeyBackup.layer.pipe(
            Layer.provideMerge(AuditLog.layer),
            Layer.provideMerge(SqlitePersistence.layerConfig),
            Layer.provideMerge(ServerSecretStore.layerClient),
            Layer.provideMerge(ServerConfig.layer(config)),
          ),
        ),
        Effect.catchTags({ MasterKeyError: (error) => Effect.fail(keyError(error)) }),
      );
    }),
  ),
);

const fileArgument = Argument.String("file").pipe(
  Argument.withDescription(
    "The backup `t3 secrets key export` wrote, or `-` to read it from stdin.",
  ),
);

const importCommand = Command.make("import", { ...authLocationFlags, file: fileArgument }).pipe(
  Command.withDescription(
    "Restore the master key from a backup, with the Hub stopped. Refused when it does not open the secrets here; a key it replaces is kept beside it.",
  ),
  Command.withHandler(
    Effect.fn("cli.secrets.key.import")(function* (flags) {
      const config = yield* hubConfig(flags);
      yield* requireHubStopped(config);
      const text = yield* Effect.try({
        try: () => NodeFS.readFileSync(flags.file === "-" ? 0 : flags.file, "utf8"),
        catch: () => userError(`Could not read ${flags.file === "-" ? "stdin" : flags.file}.`),
      });
      const imported = yield* MasterKeyFile.importKey(Redacted.make(text)).pipe(
        Effect.provide(ServerConfig.layer(config)),
        Effect.mapError(keyError),
      );
      yield* Console.log(
        `Imported master key ${imported.keyId} into ${imported.keyFile}.${imported.replaced ? " The key it replaced is kept beside it (.replaced-<id>)." : ""}`,
      );
    }),
  ),
);

const rotateCommand = Command.make("rotate", { ...authLocationFlags }).pipe(
  Command.withDescription(
    "Encrypt every secret with a new master key, with the Hub stopped. The old key stays as master.key.previous until you delete it.",
  ),
  Command.withHandler(
    Effect.fn("cli.secrets.key.rotate")(function* (flags) {
      const config = yield* hubConfig(flags);
      yield* requireHubStopped(config);
      const rotated = yield* MasterKeyFile.rotate().pipe(
        Effect.provide(ServerConfig.layer(config)),
        Effect.mapError(keyError),
      );
      yield* resealDatabaseCheck(config);
      yield* auditRotation(config, {
        actor: AuditLog.cliActor,
        action: "secret.master_key.rotate",
        target: { kind: "secret", id: "master-key", name: "Master key" },
        detail: { via: "cli", from: rotated.previousKeyId, keyId: rotated.keyId },
      });
      yield* Console.log(
        `Rotated the master key: ${rotated.previousKeyId} → ${rotated.keyId}. The old key is kept as ${rotated.keyFile}.previous until you delete it. Back up the new one with \`t3 secrets key export\`.`,
      );
    }),
  ),
);

export const secretsCommand = Command.make("secrets").pipe(
  Command.withDescription("The Hub's secrets at rest."),
  Command.withSubcommands([
    Command.make("key").pipe(
      Command.withDescription("The master key that encrypts every secret this Hub stores."),
      Command.withSubcommands([exportCommand, importCommand, rotateCommand]),
    ),
  ]),
);
