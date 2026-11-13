import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// Revealing a value and the master key backup exist on web and desktop only (spec 5, «Clientes»).
const FORBIDDEN = [
  /vaultsReveal/,
  /vaults\.reveal/,
  /revealVaultSecret/,
  /masterKeyBackup/,
  /masterKeyStatus/,
  /downloadMasterKeyBackup/,
  /vaults\/master-key/,
];

const sourceRoot = NodePath.resolve(__dirname, "../..");

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/noReveal\.test\.ts$/.test(entry.name)) yield full;
  }
}

describe("the mobile client never reveals a secret or the master key", () => {
  it("has no call to vaults.reveal or the master key backup", () => {
    const offenders = [...sourceFiles(sourceRoot)].flatMap((file) => {
      const text = NodeFS.readFileSync(file, "utf8");
      return FORBIDDEN.filter((pattern) => pattern.test(text)).map(
        (pattern) => `${NodePath.relative(sourceRoot, file)}: ${pattern}`,
      );
    });
    expect(offenders).toEqual([]);
  });
});
