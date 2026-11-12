/**
 * The CLIProxyAPI releases this Hub may run (router-for-me/CLIProxyAPI, MIT): only those pinned
 * here, each with the SHA-256 of every archive, downloaded from GitHub at addresses built from a
 * pinned version. A new pin comes with a Hub upgrade (docs/internals/ai-gateway.md).
 */
const REPOSITORY = "router-for-me/CLIProxyAPI";

/** Production platforms only: Windows Hubs are for development and run no gateway. */
export type CliproxyPlatform = "linux-amd64" | "linux-arm64" | "darwin-amd64" | "darwin-arm64";

export interface PinnedCliproxyRelease {
  readonly version: string;
  /** SHA-256 (hex) of each platform's archive. */
  readonly sha256: Readonly<Record<CliproxyPlatform, string>>;
}

/**
 * Oldest first; the last is the one a Hub runs unless its Owner chose another. Bumping it: the
 * four hashes from the release's `checksums.txt`, checked against a second download, and a live
 * pass. Keep the one before, so the Owner can roll back to it.
 */
export const PINNED_CLIPROXY_RELEASES: ReadonlyArray<PinnedCliproxyRelease> = [
  {
    version: "8.0.66",
    sha256: {
      "linux-amd64": "285e8a3be8996acfca9fce9cd4636c9adf15dd0574d1e0dbeafc7317a50dbfa2",
      "linux-arm64": "70515a991b434c54e9d2c3358f960a7e713a4d2426603163a00def5b86bc4975",
      "darwin-amd64": "76fcabc801e9de05849cd1029d435069911260da477a978aff4aa1fd33a185b9",
      "darwin-arm64": "638d25401ca319c919b1453530753c0d4812173646035b37fb8b0ccf2d04f7be",
    },
  },
  {
    version: "8.0.67",
    sha256: {
      "linux-amd64": "d22ec5c1a5c7cca7dc4a1bbea71e7a1acf11d22b2ca3d4177a6ee8179a4f8985",
      "linux-arm64": "704103eb8ce53946c1172fed835efcf966315f12a79a3f09a3fac0dd0f054b78",
      "darwin-amd64": "ca0600e743748afd6103d1fc57be93b59b211fa88d9215e1ff3462ab58ad4214",
      "darwin-arm64": "ea5bc14e874f422b0049ada5bcc0552636340fab0fac791d7dda6af4fe70fccf",
    },
  },
];

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

/**
 * The archive's name in a release. Linux takes the build without plugins (no code loaded at run
 * time besides the verified binary); macOS has only the one build.
 */
const cliproxyAssetName = (version: string, platform: CliproxyPlatform) => {
  const [os, cpu] = platform.split("-") as [string, string];
  const arch = cpu === "arm64" ? "aarch64" : cpu;
  const variant = os === "linux" ? "_no-plugin" : "";
  return `CLIProxyAPI_${version}_${os}_${arch}${variant}.tar.gz`;
};

/** Only for a pinned release: no address is ever built from a version the Hub does not pin. */
export const cliproxyAssetUrl = (release: PinnedCliproxyRelease, platform: CliproxyPlatform) =>
  `https://github.com/${REPOSITORY}/releases/download/v${release.version}/${encodeURIComponent(cliproxyAssetName(release.version, platform))}`;

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
