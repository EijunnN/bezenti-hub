// @effect-diagnostics nodeBuiltinImport:off -- hashes, gunzip, and owner-only files checked without following links.
/**
 * Installs a release only once its archive matches its `checksums.txt` and, when pinned, the
 * pinned hash; its binary goes 0700 to `<stateDir>/ai-gateway/bin/<version>/` and is hashed again
 * before every start, so nothing changed on disk is ever run.
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
  cliproxyAssetName,
  parseChecksums,
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
 * A release the Hub will not run: its archive or binary is not the one verified. Trying again
 * would not change that, so the Hub stops trying until the Owner acts.
 */
export class CliproxyRefusedError extends Schema.TaggedError<CliproxyRefusedError>()(
  "CliproxyRefusedError",
  { message: Schema.String },
) {}

const refuse = (message: string) => new CliproxyRefusedError({ message });

const sha256Hex = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const binaryPathOf = (binRoot: string, version: string) =>
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
  readonly version: string;
  readonly platform: CliproxyPlatform;
  /** The hash the code pins for this release and platform, when it pins this one. */
  readonly pinnedSha256: string | undefined;
}) {
  const name = cliproxyAssetName(input.version, input.platform);
  const listed = parseChecksums(yield* input.releases.checksums(input.version)).get(name);
  if (listed === undefined) {
    return yield* refuse(
      `CLIProxyAPI ${input.version} lists no checksum for ${name}; not installed.`,
    );
  }
  if (input.pinnedSha256 !== undefined && listed !== input.pinnedSha256) {
    return yield* refuse(
      `The checksum GitHub lists for CLIProxyAPI ${input.version} is not the one this Hub pins; not installed.`,
    );
  }
  const archive = yield* input.releases.archive(input.version, input.platform);
  if (sha256Hex(archive) !== listed) {
    return yield* refuse(
      `The download of CLIProxyAPI ${input.version} does not match its checksum; not installed.`,
    );
  }
  const binary = yield* Effect.try({
    try: () => binaryFromTar(NodeZlib.gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 })),
    catch: () => refuse(`The archive of CLIProxyAPI ${input.version} could not be read.`),
  });
  if (binary === undefined) {
    return yield* refuse(
      `The archive of CLIProxyAPI ${input.version} has no ${CLIPROXY_BINARY_NAME}.`,
    );
  }
  const target = binaryPathOf(input.binRoot, input.version);
  yield* Effect.try({
    try: () => {
      ownedFolder(input.binRoot);
      ownedFolder(NodePath.dirname(target));
      // Written beside its final name and renamed over it, so a half-written binary never runs.
      const temporary = `${target}.tmp-${NodeCrypto.randomBytes(6).toString("hex")}`;
      const fd = NodeFS.openSync(temporary, "wx", 0o700);
      try {
        NodeFS.writeSync(fd, binary);
        NodeFS.fsyncSync(fd);
      } finally {
        NodeFS.closeSync(fd);
      }
      NodeFS.renameSync(temporary, target);
    },
    catch: (cause) =>
      fail(`Could not write CLIProxyAPI ${input.version}: ${String((cause as Error).message)}`),
  });
  return { version: input.version, binarySha256: sha256Hex(binary) } satisfies InstalledCliproxy;
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
  return yield* Effect.try({
    try: () => {
      const info = NodeFS.lstatSync(path);
      const uid = process.getuid?.();
      if (!info.isFile() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o022) !== 0) {
        throw new Error("not the Hub's own file");
      }
      if (sha256Hex(NodeFS.readFileSync(path)) !== installed.binarySha256) {
        throw new Error("changed on disk");
      }
      return path;
    },
    catch: (cause) =>
      refuse(
        `CLIProxyAPI ${installed.version} on disk is not the one the Hub verified (${String((cause as Error).message)}); it was not started.`,
      ),
  });
});
