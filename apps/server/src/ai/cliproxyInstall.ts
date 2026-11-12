// @effect-diagnostics nodeBuiltinImport:off -- hashes, gunzip, and owner-only files checked without following links.
/**
 * Installs only a pinned release, once its archive matches the hash pinned in the code; its binary
 * goes 0700 to `<stateDir>/ai-gateway/bin/<version>/` and is hashed again (streamed) before every
 * start, so nothing changed on disk is ever run. Gunzip runs off the event loop.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { AiGatewayError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CLIPROXY_BINARY_NAME,
  type CliproxyPlatform,
  type PinnedCliproxyRelease,
} from "./cliproxyRelease.ts";
import type { CliproxyReleases } from "./CliproxyReleases.ts";

/** What the Hub keeps of an installed release. */
export interface InstalledCliproxy {
  readonly version: string;
  /** SHA-256 of the binary written, checked before every start. */
  readonly binarySha256: string;
}

const fail = (message: string) => new AiGatewayError({ message });

/**
 * A release the Hub will not run: not pinned, or its archive or binary is not the one verified.
 * Trying again would not change that, so the Hub stops trying until the Owner acts.
 */
export class CliproxyRefusedError extends Schema.TaggedError<CliproxyRefusedError>()(
  "CliproxyRefusedError",
  { message: Schema.String },
) {}

const refuse = (message: string) => new CliproxyRefusedError({ message });

export const binaryPathOf = (binRoot: string, version: string) =>
  NodePath.join(binRoot, version, CLIPROXY_BINARY_NAME);

/**
 * The one regular file named {@link CLIPROXY_BINARY_NAME} at the top of a tar archive, or
 * undefined. Links, folders and anything nested are never taken.
 */
const binaryFromTar = (tar: Uint8Array): Uint8Array | undefined => {
  const text = (start: number, length: number) => {
    const field = tar.subarray(start, start + length);
    const end = field.indexOf(0);
    return Buffer.from(end === -1 ? field : field.subarray(0, end)).toString("utf8");
  };
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const name = text(offset, 100);
    if (name.length === 0) return undefined;
    const prefix = text(offset + 345, 155);
    const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(tar[offset + 156] ?? 0);
    if (!Number.isFinite(size) || size < 0) return undefined;
    const path = (prefix.length > 0 ? `${prefix}/${name}` : name).replace(/^\.\//u, "");
    const start = offset + 512;
    if ((type === "0" || type === "\0") && path === CLIPROXY_BINARY_NAME) {
      return start + size <= tar.length ? tar.slice(start, start + size) : undefined;
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return undefined;
};

/** Gunzip in libuv's thread pool, never on the event loop; at most 512 MB out. */
const gunzip = (archive: Uint8Array) =>
  Effect.callback<Buffer, Error>((resume) => {
    NodeZlib.gunzip(archive, { maxOutputLength: 512 * 1024 * 1024 }, (error, result) =>
      resume(error === null ? Effect.succeed(result) : Effect.fail(error)),
    );
  });

/** A file's SHA-256, read as a stream. */
const hashFile = (path: string) =>
  Effect.callback<string, Error>((resume) => {
    const hash = NodeCrypto.createHash("sha256");
    const stream = NodeFS.createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", (error) => resume(Effect.fail(error)));
    stream.on("end", () => resume(Effect.succeed(hash.digest("hex"))));
    return Effect.sync(() => stream.destroy());
  });

/**
 * A folder of this user, never through a symlink, that nobody else may write: made 0700 when
 * missing. Anything else refuses, since what is in it is run.
 */
export const ownedFolder = (directory: string) => {
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = NodeFS.lstatSync(directory);
  const uid = process.getuid?.();
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`${directory} is not a folder of the Hub's user.`);
  }
  if ((info.mode & 0o077) !== 0) NodeFS.chmodSync(directory, 0o700);
};

export const installCliproxy = Effect.fn("cliproxyInstall.install")(function* (input: {
  readonly releases: CliproxyReleases["Service"];
  readonly binRoot: string;
  readonly release: PinnedCliproxyRelease;
  readonly platform: CliproxyPlatform;
}) {
  const { release } = input;
  const pinned = release.sha256[input.platform];
  const archive = yield* input.releases.archive(release, input.platform);
  if (archive.sha256 !== pinned) {
    return yield* refuse(
      `The download of CLIProxyAPI ${release.version} is not the archive this Hub pins; not installed.`,
    );
  }
  const binary = yield* gunzip(archive.bytes).pipe(
    Effect.map(binaryFromTar),
    Effect.mapError(() =>
      refuse(`The archive of CLIProxyAPI ${release.version} could not be read.`),
    ),
  );
  if (binary === undefined) {
    return yield* refuse(
      `The archive of CLIProxyAPI ${release.version} has no ${CLIPROXY_BINARY_NAME}.`,
    );
  }
  const target = binaryPathOf(input.binRoot, release.version);
  yield* Effect.tryPromise({
    try: async () => {
      ownedFolder(input.binRoot);
      ownedFolder(NodePath.dirname(target));
      // Written beside its final name and renamed over it, so a half-written binary never runs.
      const temporary = `${target}.tmp-${NodeCrypto.randomBytes(6).toString("hex")}`;
      const handle = await NodeFS.promises.open(temporary, "wx", 0o700);
      try {
        await handle.writeFile(binary);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await NodeFS.promises.rename(temporary, target);
    },
    catch: (cause) =>
      fail(`Could not write CLIProxyAPI ${release.version}: ${String((cause as Error).message)}`),
  });
  return {
    version: release.version,
    binarySha256: NodeCrypto.createHash("sha256").update(binary).digest("hex"),
  } satisfies InstalledCliproxy;
});

/**
 * The binary to run, once it is a regular file of the Hub's user, writable by no one else, whose
 * hash is still the one installed. Otherwise the Hub refuses to run it.
 */
export const verifiedBinary = Effect.fn("cliproxyInstall.verify")(function* (
  binRoot: string,
  installed: InstalledCliproxy,
) {
  const path = binaryPathOf(binRoot, installed.version);
  const refused = (why: string) =>
    refuse(
      `CLIProxyAPI ${installed.version} on disk is not the one the Hub verified (${why}); it was not started.`,
    );
  const info = yield* Effect.try({
    try: () => NodeFS.lstatSync(path),
    catch: () => refused("missing"),
  });
  const uid = process.getuid?.();
  if (!info.isFile() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o022) !== 0) {
    return yield* refused("not the Hub's own file");
  }
  const hash = yield* hashFile(path).pipe(Effect.mapError(() => refused("unreadable")));
  if (hash !== installed.binarySha256) return yield* refused("changed on disk");
  return path;
});

const removeAllBut = (binRoot: string, keep: ReadonlyArray<string>) => {
  const left: Array<string> = [];
  let names: Array<string> = [];
  try {
    names = NodeFS.readdirSync(binRoot);
  } catch {
    return left;
  }
  for (const name of names) {
    if (keep.includes(name)) continue;
    try {
      NodeFS.rmSync(NodePath.join(binRoot, name), { recursive: true, force: true });
    } catch {
      left.push(name);
    }
  }
  return left;
};

/** Removes installed releases other than `keep`; what cannot be removed is left and logged. */
export const pruneInstalled = Effect.fn("cliproxyInstall.prune")(function* (
  binRoot: string,
  keep: ReadonlyArray<string>,
) {
  const left = removeAllBut(binRoot, keep);
  if (left.length > 0) {
    yield* Effect.logWarning("Could not remove old AI gateway releases", { left });
  }
  return left;
});
