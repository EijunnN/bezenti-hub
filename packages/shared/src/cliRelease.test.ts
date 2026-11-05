import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliReleaseAssetUrl,
  cliReleaseSource,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("has no release source unless one is configured, never upstream's", () => {
    expect(cliReleaseSource({})).toBeUndefined();
    expect(cliReleaseSource({ T3CODE_RELEASE_BASE_URL: "  " })).toBeUndefined();
    const source = cliReleaseSource({
      T3CODE_RELEASE_BASE_URL: " https://releases.example.com/t3/?token=abc ",
    });
    expect(source).toEqual({ baseUrl: "https://releases.example.com/t3/?token=abc" });
    expect(cliReleaseAssetUrl(source!, "1.2.3", "SHA256SUMS")).toBe(
      "https://releases.example.com/t3/v1.2.3/SHA256SUMS?token=abc",
    );
  });
});
