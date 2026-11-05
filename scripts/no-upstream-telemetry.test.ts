// @effect-diagnostics nodeBuiltinImport:off - scans tracked sources with git grep.
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

// ADR 0007: no client or server sends usage events or traces to pingdotgg's services.
// infra/ and apps/marketing are pingdotgg's own hosted services, removed separately.
const UPSTREAM_TELEMETRY = [
  "ingest\\.t3\\.codes",
  "T3CODE_POSTHOG_",
  "api\\.axiom\\.co",
  "X-Axiom-Dataset",
  'from "expo-observe"',
  '"expo-observe":',
];
const SHIPPED_SOURCES = [
  "apps/server",
  "apps/web",
  "apps/desktop",
  "apps/mobile",
  "packages",
  ":(exclude)*.graphql",
];

describe("upstream telemetry", () => {
  it("is not reachable from any shipped app or package", () => {
    const result = NodeChildProcess.spawnSync(
      "git",
      [
        "grep",
        "-n",
        "-I",
        "-i",
        ...UPSTREAM_TELEMETRY.flatMap((pattern) => ["-e", pattern]),
        "--",
        ...SHIPPED_SOURCES,
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
    // git grep exits 1 when nothing matches.
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
  });
});
