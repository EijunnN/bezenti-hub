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
import * as MasterKeyFile from "../auth/MasterKeyFile.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
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

/** Recorded like the Hub records it; a log it cannot write never undoes what was done. */
const audit = (config: ServerConfig.ServerConfig["Service"], entry: AuditLog.AuditRecord) =>
  Effect.flatMap(AuditLog.AuditLog, (log) => log.record(entry)).pipe(
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

/** An unreachable server may still be running: never rewrite keys behind it. */
const requireHubStopped = (config: ServerConfig.ServerConfig["Service"]) =>
  ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath).pipe(
    Effect.provide(ProcessRunner.layer),
    Effect.mapError(() =>
      userError(
        `The Hub for ${config.baseDir} is running. Stop it first: it encrypts with the key it loaded.`,
      ),
    ),
  );

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
        const backup = yield* ServerSecretStore.MasterKeyBackup;
        const key = yield* backup.readKey.pipe(Effect.mapError(keyError));
        if (Option.isSome(flags.output)) {
          const file = flags.output.value;
          yield* Effect.try({
            try: () => NodeFS.writeFileSync(file, Redacted.value(key), { flag: "wx", mode: 0o600 }),
            catch: (cause) =>
              userError(
                (cause as NodeJS.ErrnoException).code === "EEXIST"
                  ? `${file} already exists; choose a new file.`
                  : `Could not write ${file}.`,
              ),
          });
        } else {
          yield* Effect.sync(() => process.stdout.write(Redacted.value(key)));
        }
        const status = yield* backup
          .recordBackup(DateTime.formatIso(yield* DateTime.now))
          .pipe(Effect.mapError(keyError));
        yield* audit(config, {
          actor: AuditLog.cliActor,
          action: "secret.master_key.export",
          target: { kind: "secret", id: "master-key", name: "Master key" },
          detail: { via: "cli", keyId: status.keyId },
        });
        yield* Console.error(
          `Backed up master key ${status.keyId}${Option.isSome(flags.output) ? ` to ${flags.output.value}` : ""}. Anyone with it can read this Hub's secrets from a copy of its disk.`,
        );
      }).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(Layer.provideMerge(ServerConfig.layer(config))),
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
      yield* audit(config, {
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
