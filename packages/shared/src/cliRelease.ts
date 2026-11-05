export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";

/**
 * The seam for this fork's own release channel. Upstream's releases (pingdotgg's GitHub and npm)
 * are never a source (ADR 0007): without a configured source, nothing downloads a `t3` runtime.
 * A source is laid out like GitHub release downloads, `<baseUrl>/v<version>/<file>`, and may carry
 * a query, such as a signed mirror token.
 */
export const CLI_RELEASE_SOURCE_ENV = "T3CODE_RELEASE_BASE_URL";

export interface CliReleaseSource {
  readonly baseUrl: string;
}

export function cliReleaseSourceFromUrl(baseUrl: string | undefined): CliReleaseSource | undefined {
  const trimmed = baseUrl?.trim();
  return trimmed ? { baseUrl: trimmed } : undefined;
}

/** Assets live at `${prefix}/v<version>/<file>${query}`, for builders that cannot run this module. */
export function cliReleaseSourceParts(source: CliReleaseSource): {
  readonly prefix: string;
  readonly query: string;
} {
  const url = new URL(source.baseUrl);
  const query = url.search;
  url.search = "";
  url.hash = "";
  return { prefix: url.toString().replace(/\/+$/, ""), query };
}

/** A file of release `version` from `source`, keeping the source's query. */
export function cliReleaseAssetUrl(
  source: CliReleaseSource,
  version: string,
  fileName: string,
): string {
  const { prefix, query } = cliReleaseSourceParts(source);
  return `${prefix}/${encodeURIComponent(`v${version}`)}/${encodeURIComponent(fileName)}${query}`;
}

// Keep archive keys aligned with the Linux matrix, Windows ARM64 build, and cli_archive rows in release.yml.
// Node single-executables do not support darwin-x64 and segfault at startup.
const CLI_ARCHIVE_PLATFORM_KEYS = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
] as const;
export type CliArchivePlatformKey = (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number];

export function cliArchivePlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): CliArchivePlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return CLI_ARCHIVE_PLATFORM_KEYS.find((candidate) => candidate === key);
}

/** Use System32 bsdtar on Windows; Git-for-Windows GNU tar cannot open zip archives. */
export function cliArchiveTarCommand(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

export function cliArchiveFileName(version: string, platformKey: CliArchivePlatformKey): string {
  return `t3-${version}-${platformKey}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;
}

export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

export type CliReleaseChannel = "stable" | "nightly" | "preview";

export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}
