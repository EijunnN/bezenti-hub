/**
 * The master key's backup, the same for every door (Settings over HTTP, `t3 secrets key export`):
 * `export` audits, then hands the key out; `confirm` records the backup only once the Owner shows
 * they hold it (the key's first characters). Until then Settings keeps warning.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

import * as AuditLog from "../audit/AuditLog.ts";
import * as ServerConfig from "../config.ts";
import * as MasterKeyFile from "./MasterKeyFile.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

export interface MasterKeyStatus {
  readonly keyFile: string;
  readonly keyId: string;
  /** When the Owner confirmed holding a backup of this key; null until then. */
  readonly backedUpAt: string | null;
}

export class MasterKeyBackup extends Context.Service<
  MasterKeyBackup,
  {
    readonly status: Effect.Effect<MasterKeyStatus, MasterKeyFile.MasterKeyError>;
    /** Audited first: a key whose export could not be recorded is not handed out. */
    readonly export: (input: {
      readonly actor: AuditLog.AuditActor;
      readonly via: "settings" | "cli";
    }) => Effect.Effect<
      { readonly key: Redacted.Redacted<string>; readonly keyId: string },
      MasterKeyFile.MasterKeyError
    >;
    /** The Owner holds the key: its first characters match. Records the backup at `at`. */
    readonly confirm: (input: {
      readonly keyId: string;
      readonly proof: Redacted.Redacted<string>;
      readonly at: string;
    }) => Effect.Effect<MasterKeyStatus, MasterKeyFile.MasterKeyError>;
  }
>()("t3/auth/MasterKeyBackup") {}

const notEncrypted = new MasterKeyFile.MasterKeyError({
  reason: "not-encrypted",
  detail: "This machine is joined to a Hub: its secrets are not encrypted with a master key.",
});

const make = Effect.gen(function* () {
  const { keyring, unavailable } = yield* ServerSecretStore.MasterKeyring;
  const audit = yield* AuditLog.AuditLog;
  // The record lives beside the entries: read and written with the store's own file system.
  const context = yield* Effect.context<
    ServerConfig.ServerConfig | Path.Path | FileSystem.FileSystem
  >();

  const requireKeyring = Effect.fromOption(keyring).pipe(
    Effect.mapError(() => Option.getOrElse(unavailable, () => notEncrypted)),
  );

  const statusOf = (current: MasterKeyFile.Keyring) =>
    MasterKeyFile.readBackupRecord(current).pipe(
      Effect.map((backedUpAt): MasterKeyStatus => ({
        keyFile: current.keyFile,
        keyId: current.current.id,
        backedUpAt: Option.getOrNull(backedUpAt),
      })),
      Effect.provide(context),
    );

  return MasterKeyBackup.of({
    status: Effect.flatMap(requireKeyring, statusOf).pipe(
      Effect.withSpan("MasterKeyBackup.status"),
    ),
    export: Effect.fn("MasterKeyBackup.export")(function* ({ actor, via }) {
      const current = yield* requireKeyring;
      yield* audit
        .record({
          actor,
          action: "secret.master_key.export",
          target: { kind: "secret", id: "master-key", name: "Master key" },
          detail: { via, keyId: current.current.id },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MasterKeyFile.MasterKeyError({
                reason: "io",
                detail: "Could not record the export in the audit log; the key was not handed out.",
                cause,
              }),
          ),
        );
      return { key: Redacted.make(current.current.exportText()), keyId: current.current.id };
    }),
    confirm: Effect.fn("MasterKeyBackup.confirm")(function* ({ keyId, proof, at }) {
      const current = yield* requireKeyring;
      if (keyId !== current.current.id || !current.current.matchesProof(Redacted.value(proof))) {
        return yield* new MasterKeyFile.MasterKeyError({
          reason: "proof",
          detail:
            "That is not the start of this master key. Open the backup you saved and type its first 8 characters after `t3-master-key-v1:`.",
        });
      }
      yield* MasterKeyFile.writeBackupRecord(current, at).pipe(Effect.provide(context));
      return yield* statusOf(current);
    }),
  });
});

export const layer = Layer.effect(MasterKeyBackup, make);
