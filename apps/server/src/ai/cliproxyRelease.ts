/**
 * The pinned CLIProxyAPI release (router-for-me/CLIProxyAPI, MIT) and its only source, GitHub, at
 * addresses built from a checked version. Bumping it: the four hashes from the release's
 * `checksums.txt` checked against a second download, and a live pass (docs/internals/ai-gateway.md).
 */
import { AiGatewayVersion } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const REPOSITORY = "router-for-me/CLIProxyAPI";

/** Production platforms only: Windows Hubs are for development and run no gateway. */
export type CliproxyPlatform = "linux-amd64" | "linux-arm64" | "darwin-amd64" | "darwin-arm64";

export interface PinnedCliproxyRelease {
  readonly version: string;
  /** SHA-256 (hex) of each platform's archive. */
  readonly sha256: Readonly<Record<CliproxyPlatform, string>>;
}

export const PINNED_CLIPROXY_RELEASE: PinnedCliproxyRelease = {
  version: "8.0.67",
  sha256: {
    "linux-amd64": "d22ec5c1a5c7cca7dc4a1bbea71e7a1acf11d22b2ca3d4177a6ee8179a4f8985",
    "linux-arm64": "704103eb8ce53946c1172fed835efcf966315f12a79a3f09a3fac0dd0f054b78",
    "darwin-amd64": "ca0600e743748afd6103d1fc57be93b59b211fa88d9215e1ff3462ab58ad4214",
    "darwin-arm64": "ea5bc14e874f422b0049ada5bcc0552636340fab0fac791d7dda6af4fe70fccf",
  },
};

/** The executable inside each archive. */
export const CLIPROXY_BINARY_NAME = "cli-proxy-api";

export const cliproxyPlatformOf = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): CliproxyPlatform | undefined => {
  const os = platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : undefined;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  return os === undefined || cpu === undefined ? undefined : `${os}-${cpu}`;
};

const isVersion = Schema.is(AiGatewayVersion);

/** Throws on anything but a plain `1.2.3`: no address is ever built from other text. */
const checkedVersion = (version: string) => {
  if (!isVersion(version)) throw new Error("Not a CLIProxyAPI release version.");
  return version;
};

/**
 * The archive's name in a release. Linux takes the build without plugins (no code loaded at run
 * time besides the verified binary); macOS has only the one build.
 */
export const cliproxyAssetName = (version: string, platform: CliproxyPlatform) => {
  const [os, cpu] = platform.split("-") as [string, string];
  const arch = cpu === "arm64" ? "aarch64" : cpu;
  const variant = os === "linux" ? "_no-plugin" : "";
  return `CLIProxyAPI_${checkedVersion(version)}_${os}_${arch}${variant}.tar.gz`;
};

const releaseFile = (version: string, name: string) =>
  `https://github.com/${REPOSITORY}/releases/download/v${checkedVersion(version)}/${encodeURIComponent(name)}`;

export const cliproxyChecksumsUrl = (version: string) => releaseFile(version, "checksums.txt");

export const cliproxyAssetUrl = (version: string, platform: CliproxyPlatform) =>
  releaseFile(version, cliproxyAssetName(version, platform));

export const CLIPROXY_LATEST_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

/** `v8.0.67` (a release's tag) as `8.0.67`; undefined for anything else. */
export const versionOfTag = (tag: string): string | undefined => {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  return isVersion(version) ? version : undefined;
};

/** A release's `checksums.txt`: `<sha256>  <file>` per line. */
export const parseChecksums = (text: string): ReadonlyMap<string, string> => {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/u.exec(line.trim());
    if (match !== null) entries.set(match[2]!, match[1]!);
  }
  return entries;
};

/** Negative when `a` is older than `b`. */
export const compareVersions = (a: string, b: string) => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};
