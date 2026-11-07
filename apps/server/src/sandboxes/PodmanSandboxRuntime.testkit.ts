// @effect-diagnostics nodeBuiltinImport:off -- builds the dev image and drives test containers.
/**
 * Podman for tests: whether rootless Podman is here, the dev Sandbox image until ticket 06's
 * (Debian, git and this Node; kept between runs), and cleanup of only what a test run made.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { podmanGlobalArgs } from "./PodmanSandboxRuntime.ts";

/** The label on every container a test run makes, with the run's id. */
const TEST_RUN_LABEL = "io.t3code.test";
const DEV_IMAGE = `localhost/t3code-sandbox-dev:node-${process.versions.node}`;

const podmanSync = (args: ReadonlyArray<string>, timeout = 600_000) =>
  NodeChildProcess.execFileSync("podman", [...podmanGlobalArgs(), ...args], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Whether rootless Podman runs here; integration tests skip cleanly without it. */
export const rootlessPodmanAvailable = (() => {
  if (HostProcess.Platform.defaultValue() !== "linux") return false;
  try {
    return (
      podmanSync(["info", "--format", "{{.Host.Security.Rootless}}"], 30_000).trim() === "true"
    );
  } catch {
    return false;
  }
})();

/** Builds the dev image once per Node version: Debian slim, git, and this Node. */
export const ensureDevImage = () => {
  try {
    podmanSync(["image", "exists", DEV_IMAGE]);
    return DEV_IMAGE;
  } catch {
    // Not built yet.
  }
  const context = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-dev-image-"));
  try {
    NodeFS.copyFileSync(process.execPath, NodePath.join(context, "node"));
    NodeFS.writeFileSync(
      NodePath.join(context, "Containerfile"),
      [
        "FROM docker.io/library/debian:bookworm-slim",
        "RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libatomic1 && rm -rf /var/lib/apt/lists/*",
        "COPY node /usr/local/bin/node",
        "",
      ].join("\n"),
    );
    podmanSync([
      "build",
      "--quiet",
      "--label",
      "io.t3code.test-image=sandbox-dev",
      "--tag",
      DEV_IMAGE,
      context,
    ]);
  } finally {
    NodeFS.rmSync(context, { recursive: true, force: true });
  }
  return DEV_IMAGE;
};

/** A fresh test run: its container name prefix and its label value. */
export const makeTestRun = () => {
  const runId = NodeCrypto.randomBytes(4).toString("hex");
  return {
    runId,
    namePrefix: `t3test-${runId}-`,
    labels: { [TEST_RUN_LABEL]: runId },
  };
};

/** Removes the containers this run made, by its label and name prefix, and nothing else. */
export const removeTestRunContainers = (run: { runId: string; namePrefix: string }) => {
  try {
    const names = podmanSync([
      "ps",
      "--all",
      "--filter",
      `label=${TEST_RUN_LABEL}=${run.runId}`,
      "--format",
      "{{.Names}}",
    ])
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.startsWith(run.namePrefix));
    if (names.length > 0) podmanSync(["rm", "--force", ...names]);
  } catch (error) {
    process.stderr.write(
      `Could not remove the test run's containers (${run.namePrefix}*): ${String(error)}
`,
    );
  }
};

/** Runs `podman` and returns its exit code and output, failing on nothing. */
export const podmanResult = (args: ReadonlyArray<string>, timeout = 60_000) => {
  const result = NodeChildProcess.spawnSync("podman", [...podmanGlobalArgs(), ...args], {
    encoding: "utf8",
    timeout,
  });
  return { exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
