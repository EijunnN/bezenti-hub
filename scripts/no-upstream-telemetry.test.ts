// @effect-diagnostics nodeBuiltinImport:off - walks the source tree with node:fs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

// ADR 0007: no client, server, build, or release step sends usage events or traces to
// pingdotgg's services. T3 Connect's relay (infra/relay) and the marketing site are gone.
const UPSTREAM_TELEMETRY =
  /ingest\.t3\.codes|T3CODE_POSTHOG_|api\.axiom\.co|X-Axiom-Dataset|from "expo-observe"|"expo-observe":|RELAY_CLIENT_OTLP|relay-client-tracing/i;
const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../..");
const SHIPPED_SOURCES = [
  "apps/server",
  "apps/web",
  "apps/desktop",
  "apps/mobile",
  "packages",
  "scripts",
  ".github",
];
// Dependencies, vendored repos, build output, and generated third-party schemas.
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".repos",
  ".git",
  ".turbo",
  ".expo",
  "dist",
  "dist-electron",
  "build",
  "Pods",
]);
const THIS_FILE = NodeURL.fileURLToPath(import.meta.url);

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* sourceFiles(path);
    } else if (entry.isFile() && !entry.name.endsWith(".graphql") && path !== THIS_FILE) {
      yield path;
    }
  }
}

describe("upstream telemetry", () => {
  it("is not reachable from any shipped app, package, script, or workflow", () => {
    const matches: Array<string> = [];
    for (const root of SHIPPED_SOURCES) {
      for (const file of sourceFiles(NodePath.join(REPO_ROOT, root))) {
        const text = NodeFS.readFileSync(file, "utf8");
        if (text.includes("\0")) continue;
        text.split("\n").forEach((line, index) => {
          if (UPSTREAM_TELEMETRY.test(line)) {
            matches.push(`${NodePath.relative(REPO_ROOT, file)}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(matches).toEqual([]);
  });
});
