// @effect-diagnostics nodeBuiltinImport:off -- the gateway's files, processes and listening sockets, checked from outside.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import type { AiGatewayStatus } from "@t3tools/contracts";

import * as AuditLog from "../audit/AuditLog.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as AiGateway from "./AiGateway.ts";
import {
  type FakeRelease,
  fakeCliproxyRelease,
  fakeReleases,
  memorySecretStore,
} from "./AiGateway.testkit.ts";
import { type CliproxyPlatform, cliproxyPlatformOf } from "./cliproxyRelease.ts";
import { CliproxyReleases } from "./CliproxyReleases.ts";

const os = HostProcess.Platform.defaultValue();
const platform = cliproxyPlatformOf(os, HostProcess.Architecture.defaultValue());
const posix = os === "linux" || os === "darwin";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Resolves once `read` gives a value, checked by `expect.poll`. */
const pollFor = <A>(read: () => A | undefined) =>
  Effect.promise(async () => {
    await expect.poll(() => read() !== undefined, { timeout: 20_000 }).toBe(true);
    return read()!;
  });

/** One GET from outside the Hub: its status, or null when nothing answered. */
const httpGet = (url: string, bearer?: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request =
      bearer === undefined
        ? HttpClientRequest.get(url)
        : HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(bearer));
    return yield* client.execute(request).pipe(
      Effect.map((response) => ({
        status: response.status as number | null,
        version: response.headers["x-cpa-version"],
      })),
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => ({ status: null, version: undefined })),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

/** The PIDs of the gateway's running starts, from its PID files. */
const runningPids = (stateDir: string) => {
  const root = NodePath.join(stateDir, "ai-gateway");
  if (!NodeFS.existsSync(root)) return [];
  return NodeFS.readdirSync(root)
    .filter((name) => name.endsWith(".pid"))
    .map(
      (name) =>
        (JSON.parse(NodeFS.readFileSync(NodePath.join(root, name), "utf8")) as { pid: number }).pid,
    );
};

interface Harness {
  readonly dir: string;
  readonly stateDir: string;
  readonly runDir: string;
  readonly store: ReturnType<typeof memorySecretStore>;
  readonly audits: Array<AuditLog.AuditRecord>;
  readonly logs: Array<string>;
  readonly spans: Array<Tracer.NativeSpan>;
}

const makeHarness = (): Harness => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ai-gateway-"));
  const stateDir = NodePath.join(dir, "state");
  const runDir = NodePath.join(dir, "memory");
  NodeFS.mkdirSync(stateDir, { mode: 0o700 });
  return { dir, stateDir, runDir, store: memorySecretStore(), audits: [], logs: [], spans: [] };
};

/** Starts the gateway in its own scope, as a Hub would, with these releases standing for GitHub. */
const startGateway = (
  harness: Harness,
  releases: CliproxyReleases["Service"],
  options: {
    readonly pinned: FakeRelease;
    readonly mode?: "managed" | "off";
    readonly platform?: CliproxyPlatform | undefined;
  },
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const gateway = yield* AiGateway.make({
      mode: options.mode ?? "managed",
      os,
      stateDir: harness.stateDir,
      platform: "platform" in options ? options.platform : platform,
      pinned: {
        version: options.pinned.version,
        sha256: {
          "linux-amd64": options.pinned.sha256,
          "linux-arm64": options.pinned.sha256,
          "darwin-amd64": options.pinned.sha256,
          "darwin-arm64": options.pinned.sha256,
        },
      },
      runtimeFolder: { directory: harness.runDir, inMemory: true },
      restartDelay: { initialMs: 200, maxMs: 1_000 },
      startTimeoutMs: 15_000,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ServerSecretStore, harness.store.service),
          Layer.succeed(CliproxyReleases, releases),
          Layer.succeed(
            AuditLog.AuditLog,
            AuditLog.AuditLog.of({
              record: (entry) => Effect.sync(() => void harness.audits.push(entry)),
              list: () => Effect.die("not used"),
            }),
          ),
          FetchHttpClient.layer,
          Logger.layer(
            [
              Logger.make(({ message }) => {
                harness.logs.push(JSON.stringify(message));
              }),
            ],
            { mergeWithExisting: false },
          ),
        ),
      ),
      Scope.provide(scope),
      Effect.withTracer(
        Tracer.make({
          span: (spanOptions) => {
            const span = new Tracer.NativeSpan(spanOptions);
            harness.spans.push(span);
            return span;
          },
        }),
      ),
    );
    return { gateway, scope };
  });

/** The first status the gateway reaches that matches, from its stream of changes. */
const reaches = (
  gateway: AiGateway.AiGateway["Service"],
  matches: (status: AiGatewayStatus) => boolean,
) => gateway.changes.pipe(Stream.filter(matches), Stream.runHead, Effect.map(Option.getOrThrow));

const running = (gateway: AiGateway.AiGateway["Service"]) =>
  reaches(gateway, (status) => status.state === "running" || status.state === "failed").pipe(
    Effect.tap((status) =>
      status.state === "failed"
        ? Effect.die(new Error(`failed: ${status.lastError}`))
        : Effect.void,
    ),
  );

const settled = (gateway: AiGateway.AiGateway["Service"], state: AiGatewayStatus["state"]) =>
  reaches(gateway, (status) => status.state === state);

const keysOf = (harness: Harness) =>
  ["ai-gateway-management-key", "ai-gateway-client-key"].map((name) =>
    Buffer.from(harness.store.entries.get(name)!).toString("base64url"),
  );

const fakeRecords = (harness: Harness) =>
  NodeFS.existsSync(harness.runDir)
    ? NodeFS.readdirSync(harness.runDir).filter((name) => name.startsWith("fake-"))
    : [];

describe.skipIf(!posix || platform === undefined)("the Hub's AI gateway (CLIProxyAPI)", () => {
  it.live(
    "installs the pinned release, runs it on loopback with only -config, its keys nowhere but its config",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const v1 = fakeCliproxyRelease(harness.dir, "1.0.0");
        const github = fakeReleases({ platform: platform!, releases: [v1], latest: "1.0.0" });
        const { gateway, scope } = yield* startGateway(harness, github.service, { pinned: v1 });
        const status = yield* running(gateway);
        assert.equal(status.version, "1.0.0");
        assert.equal(status.pinnedVersion, "1.0.0");
        assert.isTrue(status.credentialsInMemory);
        assert.deepEqual(github.downloads, ["1.0.0"]);

        const endpoint = Option.getOrThrow(yield* gateway.endpoint);
        assert.match(endpoint.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
        const [managementKey, clientKey] = keysOf(harness);
        assert.equal(Redacted.value(endpoint.managementKey), managementKey);

        // The config: 0600, loopback, management local only, no panel, stats or request logs.
        const configs = NodeFS.readdirSync(harness.runDir).filter((name) => name.endsWith(".yaml"));
        assert.lengthOf(configs, 1);
        const configPath = NodePath.join(harness.runDir, configs[0]!);
        assert.equal(NodeFS.statSync(configPath).mode & 0o777, 0o600);
        assert.equal(NodeFS.statSync(harness.runDir).mode & 0o777, 0o700);
        const config = NodeFS.readFileSync(configPath, "utf8");
        for (const line of [
          "host: 127.0.0.1",
          "allow-remote: false",
          "disable-control-panel: true",
          "usage-statistics-enabled: false",
          "request-log: false",
          `auth-dir: ${NodePath.join(harness.runDir, "auth")}`,
        ]) {
          assert.include(config, line);
        }

        // The management API refuses without the Hub's key; the model list without its client key.
        const without = yield* httpGet(`${endpoint.baseUrl}/v8/management/config`);
        assert.equal(without.status, 401);
        const withKey = yield* httpGet(`${endpoint.baseUrl}/v8/management/config`, managementKey);
        assert.equal(withKey.status, 200);

        // Its arguments: `-config <path>` only; its environment: nothing of the Hub's.
        const [pid] = runningPids(harness.stateDir);
        const record = JSON.parse(
          NodeFS.readFileSync(NodePath.join(harness.runDir, `fake-${pid}.json`), "utf8"),
        ) as { argv: Array<string>; env: Array<string> };
        assert.deepEqual(record.argv, ["-config", configPath]);
        assert.sameMembers(
          record.env.filter((name) => !name.startsWith("FAKE_CLIPROXY_") && name !== "PWD"),
          ["PATH", "HOME", "T3CODE_AI_GATEWAY_START_TOKEN"],
        );
        if (os === "linux") {
          const cmdline = NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8");
          assert.notInclude(cmdline, managementKey!);
          assert.notInclude(cmdline, clientKey!);
        }

        // Not on any other address of this machine.
        const others = Object.values(NodeOS.networkInterfaces())
          .flat()
          .filter((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4");
        for (const other of others) {
          const port = new URL(endpoint.baseUrl).port;
          const reached = yield* httpGet(`http://${other!.address}:${port}/v8/management/config`);
          assert.isNull(reached.status, other!.address);
        }

        // Its output reached the Hub's logs, without the keys it printed.
        yield* pollFor(() =>
          harness.logs.some((line) => line.includes("CLIProxyAPI Version: 1.0.0"))
            ? true
            : undefined,
        );
        for (const line of harness.logs) {
          assert.notInclude(line, managementKey!);
          assert.notInclude(line, clientKey!);
        }
        // Nor in a span: the health checks are traced, their keys are not.
        const traced = harness.spans.flatMap((span) => [
          span.name,
          ...Array.from(span.attributes.values(), (value) => JSON.stringify(value)),
        ]);
        assert.include(traced, "CliproxyManagement.health");
        for (const value of traced) {
          assert.notInclude(value, managementKey!);
          assert.notInclude(value, clientKey!);
        }
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.live("refuses, and never runs, an archive that is not the pinned one", () =>
    Effect.gen(function* () {
      for (const tamper of ["pinned", "listed", "unlisted"] as const) {
        const harness = makeHarness();
        const v1 = fakeCliproxyRelease(harness.dir, "1.0.0");
        const other = fakeCliproxyRelease(
          NodeFS.mkdtempSync(NodePath.join(harness.dir, "x")),
          "1.0.0",
        );
        const github =
          tamper === "pinned"
            ? // GitHub serves and lists another archive than the one the code pins.
              fakeReleases({ platform: platform!, releases: [other], latest: "1.0.0" })
            : tamper === "listed"
              ? // The download is not what the release's checksums.txt lists.
                fakeReleases({
                  platform: platform!,
                  releases: [{ ...other, sha256: v1.sha256 }],
                  latest: "1.0.0",
                })
              : // The release lists no checksum for this platform's archive.
                fakeReleases({
                  platform: platform!,
                  releases: [v1],
                  latest: "1.0.0",
                  listed: { "1.0.0": null },
                });
        const { gateway, scope } = yield* startGateway(harness, github.service, { pinned: v1 });
        const status = yield* settled(gateway, "failed");
        assert.match(status.lastError ?? "", /not installed/u, tamper);
        assert.isFalse(
          NodeFS.existsSync(
            NodePath.join(harness.stateDir, "ai-gateway", "bin", "1.0.0", "cli-proxy-api"),
          ),
          tamper,
        );
        assert.lengthOf(fakeRecords(harness), 0, tamper);
        assert.lengthOf(runningPids(harness.stateDir), 0, tamper);
        yield* Scope.close(scope, Exit.void);
      }
    }),
  );

  it.live("never runs a binary changed on disk after it was verified", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const v1 = fakeCliproxyRelease(harness.dir, "1.0.0");
      const github = fakeReleases({ platform: platform!, releases: [v1], latest: "1.0.0" });
      const first = yield* startGateway(harness, github.service, { pinned: v1 });
      yield* running(first.gateway);
      yield* Scope.close(first.scope, Exit.void);
      const binary = NodePath.join(harness.stateDir, "ai-gateway", "bin", "1.0.0", "cli-proxy-api");
      NodeFS.appendFileSync(binary, "\necho changed\n");
      const before = fakeRecords(harness).length;

      const second = yield* startGateway(harness, github.service, { pinned: v1 });
      const status = yield* settled(second.gateway, "failed");
      assert.match(status.lastError ?? "", /not the one the Hub verified/u);
      assert.lengthOf(fakeRecords(harness), before);
      yield* Scope.close(second.scope, Exit.void);
    }),
  );

  it.live(
    "starts it again when it dies, and stops it with the Hub, leaving no process or config",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const v1 = fakeCliproxyRelease(harness.dir, "1.0.0");
        const github = fakeReleases({ platform: platform!, releases: [v1], latest: "1.0.0" });
        const { gateway, scope } = yield* startGateway(harness, github.service, { pinned: v1 });
        yield* running(gateway);
        const [first] = runningPids(harness.stateDir);
        process.kill(first!, "SIGKILL");
        const pid = yield* pollFor(() => {
          const pids = runningPids(harness.stateDir);
          return pids.length === 1 && pids[0] !== first ? pids[0] : undefined;
        });
        const status = yield* reaches(
          gateway,
          (next) => next.state === "running" && next.restarts === 1,
        );
        assert.equal(status.restarts, 1);
        assert.isTrue(isAlive(pid!));

        yield* Scope.close(scope, Exit.void);
        assert.isFalse(isAlive(pid!));
        assert.lengthOf(runningPids(harness.stateDir), 0);
        assert.lengthOf(
          NodeFS.readdirSync(harness.runDir).filter((name) => name.endsWith(".yaml")),
          0,
        );
      }),
  );

  it.live.skipIf(os !== "linux")(
    "stops one left by a killed Hub at the next start, by its verified PID only",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const root = NodePath.join(harness.stateDir, "ai-gateway");
        NodeFS.mkdirSync(root, { recursive: true });
        const spawn = (token: string) =>
          NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            env: { T3CODE_AI_GATEWAY_START_TOKEN: token },
            stdio: "ignore",
          });
        const leftover = spawn("a".repeat(32));
        const leftoverExited = new Promise((resolve) => leftover.once("exit", resolve));
        const stranger = spawn("someone-else");
        try {
          NodeFS.writeFileSync(
            NodePath.join(root, "run-aaaaaaaaaaaa.pid"),
            JSON.stringify({ pid: leftover.pid, startToken: "a".repeat(32) }),
          );
          // A PID file naming a process that is not the one it started: never stopped.
          NodeFS.writeFileSync(
            NodePath.join(root, "run-bbbbbbbbbbbb.pid"),
            JSON.stringify({ pid: stranger.pid, startToken: "b".repeat(32) }),
          );
          const v1 = fakeCliproxyRelease(harness.dir, "1.0.0");
          const github = fakeReleases({ platform: platform!, releases: [v1], latest: "1.0.0" });
          const { gateway, scope } = yield* startGateway(harness, github.service, { pinned: v1 });
          yield* running(gateway);
          yield* Effect.promise(() => leftoverExited);
          assert.isTrue(isAlive(stranger.pid!));
          yield* Scope.close(scope, Exit.void);
        } finally {
          leftover.kill("SIGKILL");
          stranger.kill("SIGKILL");
        }
      }),
  );

  it.live(
    "updates to a newer release beside the running one, keeps the old for roll back, and audits both",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const v1 = fakeCliproxyRelease(harness.dir, "1.0.0");
        const v2 = fakeCliproxyRelease(
          NodeFS.mkdtempSync(NodePath.join(harness.dir, "v2")),
          "1.1.0",
        );
        const github = fakeReleases({ platform: platform!, releases: [v1, v2], latest: "1.1.0" });
        const { gateway, scope } = yield* startGateway(harness, github.service, { pinned: v1 });
        yield* running(gateway);
        const [oldPid] = runningPids(harness.stateDir);

        const check = yield* gateway.checkForUpdates;
        assert.deepEqual(check, {
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          updateAvailable: true,
        });

        const updated = yield* gateway.update("1.1.0");
        assert.equal(updated.state, "running");
        assert.equal(updated.version, "1.1.0");
        assert.equal(updated.previousVersion, "1.0.0");
        assert.isFalse(isAlive(oldPid!));
        const endpoint = Option.getOrThrow(yield* gateway.endpoint);
        const answer = yield* httpGet(
          `${endpoint.baseUrl}/v8/management/config`,
          Redacted.value(endpoint.managementKey),
        );
        assert.equal(answer.version, "1.1.0");

        const rolledBack = yield* gateway.rollback;
        assert.equal(rolledBack.version, "1.0.0");
        assert.equal(rolledBack.previousVersion, "1.1.0");
        // The old release came from the disk, verified again: not downloaded twice.
        assert.deepEqual(github.downloads, ["1.0.0", "1.1.0"]);
        assert.deepEqual(
          harness.audits.map((entry) => [entry.action, entry.detail]),
          [
            ["ai_gateway.update", { from: "1.0.0", version: "1.1.0", outcome: "updated" }],
            ["ai_gateway.rollback", { from: "1.1.0", version: "1.0.0", outcome: "updated" }],
          ],
        );
        yield* Scope.close(scope, Exit.void);
        assert.lengthOf(runningPids(harness.stateDir), 0);
      }),
  );

  it.live("keeps the running release when the new one does not start or is not listed", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const v1 = fakeCliproxyRelease(harness.dir, "1.0.0");
      const broken = fakeCliproxyRelease(
        NodeFS.mkdtempSync(NodePath.join(harness.dir, "b")),
        "1.2.0",
        "exit",
      );
      const unlisted = fakeCliproxyRelease(
        NodeFS.mkdtempSync(NodePath.join(harness.dir, "u")),
        "1.3.0",
      );
      const github = fakeReleases({
        platform: platform!,
        releases: [v1, broken, unlisted],
        latest: "1.3.0",
        listed: { "1.3.0": null },
      });
      const { gateway, scope } = yield* startGateway(harness, github.service, { pinned: v1 });
      yield* running(gateway);
      const [pid] = runningPids(harness.stateDir);

      const failed = yield* gateway.update("1.2.0").pipe(Effect.flip);
      assert.match(failed.message, /exited while starting/u);
      const refused = yield* gateway.update("1.3.0").pipe(Effect.flip);
      assert.match(refused.message, /lists no checksum/u);
      assert.notInclude(github.downloads, "1.3.0");

      const status = yield* gateway.status;
      assert.equal(status.state, "running");
      assert.equal(status.version, "1.0.0");
      assert.deepEqual(runningPids(harness.stateDir), [pid]);
      assert.deepEqual(
        harness.audits.map((entry) => {
          const detail = (entry.detail ?? {}) as { outcome?: string; version?: string };
          return [entry.action, detail.outcome, detail.version];
        }),
        [
          ["ai_gateway.update", "failed", undefined],
          ["ai_gateway.update", "failed", undefined],
        ],
      );
      yield* gateway.rollback.pipe(Effect.flip);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.live("runs nothing and downloads nothing when off", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const v1 = fakeCliproxyRelease(harness.dir, "1.0.0");
      const github = fakeReleases({ platform: platform!, releases: [v1], latest: "1.0.0" });
      const { gateway, scope } = yield* startGateway(harness, github.service, {
        pinned: v1,
        mode: "off",
      });
      const status = yield* gateway.status;
      assert.equal(status.state, "off");
      yield* gateway.update("1.0.0").pipe(Effect.flip);
      yield* gateway.checkForUpdates.pipe(Effect.flip);
      assert.deepEqual(github.downloads, []);
      assert.isFalse(NodeFS.existsSync(NodePath.join(harness.stateDir, "ai-gateway")));
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
