// @effect-diagnostics nodeBuiltinImport:off - temporary names come from node:crypto.
/**
 * Owner-only secret files written so a reader or a crash sees the old bytes or the new ones, never
 * a mix: a `wx` temp file, fsync, rename (replace) or link (create only), fsync of the folder. The
 * secret store and the master key file share it.
 */
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** `<target>.<uuid>.tmp`: what a write leaves behind if its process dies. */
export const TEMP_FILE = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

const writeTemp = Effect.fn("atomicFile.writeTemp")(function* (
  temp: string,
  bytes: Uint8Array,
  times: { readonly atime: Date; readonly mtime: Date } | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(temp, { flag: "wx", mode: 0o600 });
      yield* file.writeAll(bytes);
      yield* file.sync;
    }),
  );
  yield* fs.chmod(temp, 0o600);
  if (times !== undefined) yield* fs.utimes(temp, times.atime, times.mtime);
});

/** The folder's new entry survives a power loss too; a platform that cannot sync one skips it. */
const syncFolderOf = Effect.fn("atomicFile.syncFolderOf")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.scoped(
    Effect.flatMap(fs.open(path.dirname(target), { flag: "r" }), (folder) => folder.sync),
  ).pipe(Effect.ignore);
});

/** Replaces `target` whole, optionally with the times of the file it replaces. */
export const writeAtomically = Effect.fn("atomicFile.writeAtomically")(function* (
  target: string,
  bytes: Uint8Array,
  times?: { readonly atime: Date; readonly mtime: Date },
) {
  const fs = yield* FileSystem.FileSystem;
  const temp = `${target}.${NodeCrypto.randomUUID()}.tmp`;
  yield* Effect.gen(function* () {
    yield* writeTemp(temp, bytes, times);
    yield* fs.rename(temp, target);
  }).pipe(Effect.onError(() => fs.remove(temp).pipe(Effect.ignore)));
  yield* syncFolderOf(target);
});

/** Publishes `target` only if nothing is there yet; fails with AlreadyExists otherwise. */
export const createExclusively = Effect.fn("atomicFile.createExclusively")(function* (
  target: string,
  bytes: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const temp = `${target}.${NodeCrypto.randomUUID()}.tmp`;
  yield* Effect.gen(function* () {
    yield* writeTemp(temp, bytes, undefined);
    yield* fs.link(temp, target);
  }).pipe(Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)));
  yield* syncFolderOf(target);
});

/**
 * Reads a whole file through one handle (no exists-then-read race), with its handle's stat. No
 * span of its own: what it returns may be a key, and a span would hold it as its result.
 */
export const readIfPresent = (file: string, limit?: number) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(file, { flag: "r" });
        const info = yield* handle.stat;
        const size = limit ?? Number(info.size);
        const read = size === 0 ? Option.none<Uint8Array>() : yield* handle.readAlloc(size);
        return { bytes: Option.getOrElse(read, () => new Uint8Array()), info };
      }),
    ).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    ),
  );
