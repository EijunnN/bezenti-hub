// @effect-diagnostics nodeBuiltinImport:off - the folder's name is a hash of the state directory.
/**
 * Where a `file` answer of request_secret goes for the agent's own shell: a folder in memory
 * (`$XDG_RUNTIME_DIR`, else `/dev/shm`), owner-only, never the Hub's disk. Without one (macOS,
 * Windows) file delivery is refused and a secretRef still works. See docs/internals/secrets.md.
 */
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** A folder chosen by the caller (tests); otherwise one in memory is found. */
export class SecretFilesDirectory extends Context.Service<
  SecretFilesDirectory,
  { readonly directory: string }
>()("t3/secrets/SecretFilesDirectory") {}

export const resolveSecretFilesDirectory = Effect.fn("SecretFilesDirectory.resolve")(function* (
  secretsDir: string,
) {
  const configured = yield* Effect.serviceOption(SecretFilesDirectory);
  if (Option.isSome(configured)) return Option.some(configured.value.directory);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const uid = yield* HostProcess.UserId;
  if (uid === undefined) return Option.none<string>();
  // One folder per state directory, so two Hubs of one user never share answers.
  const name = `t3code-secret-files-${NodeCrypto.createHash("sha256").update(secretsDir).digest("hex").slice(0, 16)}`;
  for (const base of [environment.XDG_RUNTIME_DIR, "/dev/shm"]) {
    if (base === undefined || base.length === 0 || !path.isAbsolute(base)) continue;
    const baseInfo = yield* fs.stat(base).pipe(Effect.option);
    if (Option.isNone(baseInfo) || baseInfo.value.type !== "Directory") continue;
    const directory = path.join(base, name);
    yield* fs.makeDirectory(directory, { mode: 0o700 }).pipe(Effect.ignore);
    const info = yield* fs.stat(directory).pipe(Effect.option);
    // Someone else's folder under that name (planted in a shared /dev/shm) is never used.
    if (
      Option.isSome(info) &&
      info.value.type === "Directory" &&
      Option.contains(info.value.uid, uid) &&
      (info.value.mode & 0o077) === 0
    ) {
      return Option.some(directory);
    }
  }
  return Option.none<string>();
});
