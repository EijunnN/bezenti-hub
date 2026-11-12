// @effect-diagnostics nodeBuiltinImport:off -- the gateway's files, processes and listening sockets, checked from outside.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { AiGatewayError, type AiGatewayStatus } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
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

import * as AuditLog from "../audit/AuditLog.ts";
import { SecretStorePersistError, ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import type { JoinedHubState } from "../environments/joinedHubState.ts";
import * as AiGateway from "./AiGateway.ts";
import {
  type FakeCliproxyMode,
  type FakeRelease,
  fakeCliproxyRelease,
  fakeReleases,
  LEAKY_LINE,
  memorySecretStore,
  pinsOf,
} from "./AiGateway.testkit.ts";
import { identityOf } from "./childProcessFacts.ts";
import {
  type CliproxyPlatform,
  cliproxyPlatformOf,
  PINNED_CLIPROXY_RELEASES,
} from "./cliproxyRelease.ts";
import {
  CliproxyReleases,
  collectLimited,
  layer as CliproxyReleasesLayer,
} from "./CliproxyReleases.ts";
import { filterGatewayLine } from "./gatewayLogFilter.ts";

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
    .filter((name) => /^run-[0-9a-f]{12}\.pid$/u.test(name))
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
  /** While true, the encrypted store refuses writes. */
  failWrites: boolean;
}

const makeHarness = (): Harness => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ai-gateway-"));
  const stateDir = NodePath.join(dir, "state");
  const runDir = NodePath.join(dir, "memory");
  NodeFS.mkdirSync(stateDir, { mode: 0o700 });
  return {
    dir,
    stateDir,
    runDir,
    store: memorySecretStore(),
    audits: [],
    logs: [],
    spans: [],
    failWrites: false,
  };
};

const release = (harness: Harness, version: string, mode: FakeCliproxyMode = "serve") =>
  fakeCliproxyRelease(
    NodeFS.mkdtempSync(NodePath.join(harness.dir, `release-${version}-`)),
    version,
    mode,
  );

const servicesFor = (harness: Harness, releases: CliproxyReleases["Service"]) =>
  Layer.mergeAll(
    Layer.succeed(
      ServerSecretStore,
      ServerSecretStore.of({
        ...harness.store.service,
        set: (name, value) =>
          harness.failWrites
            ? Effect.fail(new SecretStorePersistError({ resource: name, cause: "disk full" }))
            : harness.store.service.set(name, value),
      }),
    ),
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
  );

const tracerFor = (harness: Harness) =>
  Tracer.make({
    span: (spanOptions) => {
      const span = new Tracer.NativeSpan(spanOptions);
      harness.spans.push(span);
      return span;
    },
  });

/** Starts the gateway in its own scope, as a Hub would, with these releases standing for GitHub. */
const startGateway = (
  harness: Harness,
  releases: CliproxyReleases["Service"],
  options: {
    readonly pinned: ReadonlyArray<FakeRelease>;
    readonly placement?: AiGateway.AiGatewayPlacement;
    readonly platform?: CliproxyPlatform | undefined;
    readonly startTimeoutMs?: number;
  },
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const gateway = yield* AiGateway.make({
      placement: options.placement ?? { _tag: "forced", enabled: true },
      os,
      stateDir: harness.stateDir,
      platform: "platform" in options ? options.platform : platform,
      pinned: pinsOf(options.pinned),
      runtimeFolder: { directory: harness.runDir, inMemory: true },
      restartDelay: { initialMs: 200, maxMs: 1_000 },
      startTimeoutMs: options.startTimeoutMs ?? 15_000,
    }).pipe(
      Effect.provide(servicesFor(harness, releases)),
      Scope.provide(scope),
      Effect.withTracer(tracerFor(harness)),
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

const fakeRecords = (harness: Harness) =>
  NodeFS.existsSync(harness.runDir)
    ? NodeFS.readdirSync(harness.runDir).filter((name) => /^fake-\d+\.json$/u.test(name))
    : [];

const installedVersions = (harness: Harness) => {
  const bin = NodePath.join(harness.stateDir, "ai-gateway", "bin");
  return NodeFS.existsSync(bin) ? NodeFS.readdirSync(bin).toSorted() : [];
};

const detailOf = (entry: AuditLog.AuditRecord) =>
  (entry.detail ?? {}) as { outcome?: string; version?: string; from?: string; to?: string };

describe("where the AI gateway runs", () => {
  it("only on a Hub: never on a joined machine; off by default in the desktop app and a dev Hub", () => {
    const base = { joined: false, desktop: false, dev: false, setting: undefined };
    assert.deepEqual(AiGateway.aiGatewayPlacement(base), { _tag: "owner", defaultEnabled: true });
    assert.equal(AiGateway.aiGatewayPlacement({ ...base, joined: true })._tag, "never");
    assert.equal(
      AiGateway.aiGatewayPlacement({ ...base, joined: true, setting: "managed" })._tag,
      "never",
    );
    assert.deepEqual(AiGateway.aiGatewayPlacement({ ...base, desktop: true }), {
      _tag: "owner",
      defaultEnabled: false,
    });
    assert.deepEqual(AiGateway.aiGatewayPlacement({ ...base, dev: true }), {
      _tag: "owner",
      defaultEnabled: false,
    });
    assert.deepEqual(AiGateway.aiGatewayPlacement({ ...base, setting: "off" }), {
      _tag: "forced",
      enabled: false,
    });
  });

  it.live("a joined server neither starts, downloads nor prepares anything", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const github = fakeReleases({ releases: [] });
      const joinedConfig = Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return {
            ...config,
            joinedHub: { hubUrl: "http://hub.test" } as unknown as JoinedHubState,
          };
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-ai-gateway-joined-" })),
        Layer.provide(NodeServices.layer),
      );
      const context = yield* Layer.build(
        AiGateway.layerFromConfig.pipe(
          Layer.provide(Layer.mergeAll(joinedConfig, servicesFor(harness, github.service))),
        ),
      ).pipe(Effect.scoped);
      const status = yield* Context.get(context, AiGateway.AiGateway).status;
      assert.equal(status.state, "off");
      assert.isFalse(status.switchable);
      assert.match(status.lastError ?? "", /joined/u);
      assert.deepEqual(github.downloads, []);
    }),
  );
});

describe("what CLIProxyAPI's output keeps", () => {
  it("credentials by name and by shape, underscores included, and the Hub's own keys", () => {
    const safe = filterGatewayLine(`${LEAKY_LINE} mine=hub-own-key-123`, ["hub-own-key-123"]);
    for (const leaked of [
      "1//0gLeakyRefreshToken_abc-123",
      "ya29.a0Leaky_Access-Token123",
      "AIzaSyLeaky_Google-Key1234567890",
      "sk-ant-leaky_key_1234567890",
      "GOCSPX-leaky_secret_123",
      "ghp_Leaky_Github_Token_1234567890",
      "hub-own-key-123",
    ]) {
      assert.notInclude(safe, leaked);
    }
    assert.include(safe, "token refresh");
    for (const [line, kept] of [
      ["Authorization: Bearer abcdefghijklmnop", "Authorization"],
      ["access_token=abc_def_ghi_jkl&x=1", "access_token="],
      ['"api_key": "short_but_secret"', '"api_key"'],
      ["x-goog-api-key: zzzzzzzzzzzz", "x-goog-api-key"],
    ] as const) {
      const filtered = filterGatewayLine(line, []);
      assert.include(filtered, kept, line);
      assert.include(filtered, "[redacted]", line);
    }
    assert.equal(
      filterGatewayLine("CLIProxyAPI Version: 8.0.67, Commit: 8bba7a77", []),
      "CLIProxyAPI Version: 8.0.67, Commit: 8bba7a77",
    );
  });
});

describe("a download", () => {
  it.effect("stops at the size limit, whatever the answer announced", () =>
    Effect.gen(function* () {
      const tooLarge = () => new AiGatewayError({ message: "too large" });
      const failed = yield* collectLimited(
        Stream.make(new Uint8Array(6), new Uint8Array(6)),
        10,
        tooLarge,
      ).pipe(Effect.flip);
      assert.equal(failed.message, "too large");
      const kept = yield* collectLimited(Stream.make(new Uint8Array(6)), 10, tooLarge);
      assert.equal(kept.bytes.byteLength, 6);
      assert.match(kept.sha256, /^[0-9a-f]{64}$/u);
    }),
  );
});

describe.skipIf(!posix || platform === undefined)("the Hub's AI gateway (CLIProxyAPI)", () => {
  it.live(
    "installs the pinned release, runs it on loopback with -config, its keys nowhere but its config",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const v1 = release(harness, "1.0.0");
        const github = fakeReleases({ releases: [v1] });
        const { gateway, scope } = yield* startGateway(harness, github.service, { pinned: [v1] });
        const status = yield* running(gateway);
        assert.equal(status.version, "1.0.0");
        assert.deepEqual(status.pinnedVersions, ["1.0.0"]);
        assert.isTrue(status.credentialsInMemory);
        assert.deepEqual(github.downloads, ["1.0.0"]);

        const endpoint = Option.getOrThrow(yield* gateway.endpoint);
        assert.match(endpoint.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
        const managementKey = Buffer.from(
          harness.store.entries.get("ai-gateway-management-key")!,
        ).toString("base64url");
        const clientKey = Redacted.value(endpoint.clientKey);
        assert.equal(Redacted.value(endpoint.managementKey), managementKey);

        // The config: 0600, loopback, management local only, nothing upstream, no logs of prompts.
        const configs = NodeFS.readdirSync(harness.runDir).filter((name) => name.endsWith(".yaml"));
        assert.lengthOf(configs, 1);
        const configPath = NodePath.join(harness.runDir, configs[0]!);
        assert.equal(NodeFS.statSync(configPath).mode & 0o777, 0o600);
        assert.equal(NodeFS.statSync(harness.runDir).mode & 0o777, 0o700);
        const config = NodeFS.readFileSync(configPath, "utf8");
        for (const line of [
          "config-version: 8",
          "host: 127.0.0.1",
          "allow-remote: false",
          "disable-control-panel: true",
          "disable-auto-update-panel: true",
          "usage-statistics-enabled: false",
          "request-log: false",
          `auth-dir: ${NodePath.join(harness.runDir, "auth")}`,
        ]) {
          assert.include(config, line);
        }

        const without = yield* httpGet(`${endpoint.baseUrl}/v8/management/config`);
        assert.equal(without.status, 401);
        const withKey = yield* httpGet(`${endpoint.baseUrl}/v8/management/config`, managementKey);
        assert.equal(withKey.status, 200);

        // Its arguments: `-config <path> -local-model` (embedded model catalogs, nothing fetched).
        const [pid] = runningPids(harness.stateDir);
        const record = JSON.parse(
          NodeFS.readFileSync(NodePath.join(harness.runDir, `fake-${pid}.json`), "utf8"),
        ) as { argv: Array<string>; env: Array<string> };
        assert.deepEqual(record.argv, ["-config", configPath, "-local-model"]);
        assert.sameMembers(
          record.env.filter((name) => !name.startsWith("FAKE_CLIPROXY_") && name !== "PWD"),
          ["PATH", "HOME", "T3CODE_AI_GATEWAY_START_TOKEN"],
        );
        if (os === "linux") {
          const cmdline = NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8");
          assert.notInclude(cmdline, managementKey);
          assert.notInclude(cmdline, clientKey);
        }

        // Not on any other address of this machine.
        const port = new URL(endpoint.baseUrl).port;
        for (const other of Object.values(NodeOS.networkInterfaces())
          .flat()
          .filter((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4")) {
          const reached = yield* httpGet(`http://${other!.address}:${port}/v8/management/config`);
          assert.isNull(reached.status, other!.address);
        }

        // Its output reached the Hub's logs, without the keys or the tokens it printed.
        yield* pollFor(() =>
          harness.logs.some((line) => line.includes("token refresh")) ? true : undefined,
        );
        assert.isTrue(harness.logs.some((line) => line.includes("CLIProxyAPI Version: 1.0.0")));
        for (const line of harness.logs) {
          for (const secret of [
            managementKey,
            clientKey,
            "1//0gLeaky",
            "ya29.a0Leaky",
            "AIzaSyLeaky",
          ]) {
            assert.notInclude(line, secret);
          }
        }
        const traced = harness.spans.flatMap((span) => [
          span.name,
          ...Array.from(span.attributes.values(), (value) => JSON.stringify(value)),
        ]);
        assert.include(traced, "CliproxyManagement.health");
        for (const value of traced) {
          assert.notInclude(value, managementKey);
          assert.notInclude(value, clientKey);
        }
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.live("refuses, and never runs, a download that is not the pinned archive", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const v1 = release(harness, "1.0.0");
      const other = release(harness, "1.0.0");
      const github = fakeReleases({ releases: [v1], served: { "1.0.0": other.archive } });
      const { gateway, scope } = yield* startGateway(harness, github.service, { pinned: [v1] });
      const status = yield* settled(gateway, "failed");
      assert.match(status.lastError ?? "", /not the archive this Hub pins/u);
      assert.deepEqual(installedVersions(harness), []);
      assert.lengthOf(fakeRecords(harness), 0);
      assert.lengthOf(runningPids(harness.stateDir), 0);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.live("never runs a binary changed on disk after it was verified", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const v1 = release(harness, "1.0.0");
      const github = fakeReleases({ releases: [v1] });
      const first = yield* startGateway(harness, github.service, { pinned: [v1] });
      yield* running(first.gateway);
      yield* Scope.close(first.scope, Exit.void);
      const binary = NodePath.join(harness.stateDir, "ai-gateway", "bin", "1.0.0", "cli-proxy-api");
      NodeFS.appendFileSync(binary, "\necho changed\n");
      const before = fakeRecords(harness).length;

      const second = yield* startGateway(harness, github.service, { pinned: [v1] });
      const status = yield* settled(second.gateway, "failed");
      assert.match(status.lastError ?? "", /not the one the Hub verified/u);
      assert.lengthOf(fakeRecords(harness), before);
      yield* Scope.close(second.scope, Exit.void);
    }),
  );

  it.live(
    "sends no key to a port another process took, and stops one listening beyond loopback",
    () =>
      Effect.gen(function* () {
        // A release that leaves its port to another process (as a local process that won the race
        // for the port would hold it): the Hub never asks that process anything.
        const harness = makeHarness();
        const decoy = release(harness, "1.0.0", "decoy");
        const first = yield* startGateway(harness, fakeReleases({ releases: [decoy] }).service, {
          pinned: [decoy],
          startTimeoutMs: 2_000,
        });
        const waiting = yield* reaches(first.gateway, (status) =>
          /did not listen/u.test(status.lastError ?? ""),
        );
        assert.notEqual(waiting.state, "running");
        const seen = NodePath.join(harness.runDir, "decoy-seen.jsonl");
        assert.isTrue(NodeFS.existsSync(NodePath.join(harness.runDir, "decoy-pid")));
        assert.isFalse(
          NodeFS.existsSync(seen),
          NodeFS.existsSync(seen) ? NodeFS.readFileSync(seen, "utf8") : "",
        );
        yield* Scope.close(first.scope, Exit.void);
        const decoyPid = Number(
          NodeFS.readFileSync(NodePath.join(harness.runDir, "decoy-pid"), "utf8"),
        );
        yield* pollFor(() => (isAlive(decoyPid) ? undefined : true));

        // A release listening on every address: stopped, and not started again.
        const wideHarness = makeHarness();
        const wide = release(wideHarness, "1.0.0", "wide");
        const second = yield* startGateway(
          wideHarness,
          fakeReleases({ releases: [wide] }).service,
          {
            pinned: [wide],
          },
        );
        const failed = yield* settled(second.gateway, "failed");
        assert.match(failed.lastError ?? "", /listened beyond loopback \(0\.0\.0\.0:\d+\)/u);
        assert.lengthOf(runningPids(wideHarness.stateDir), 0);
        for (const name of fakeRecords(wideHarness)) {
          assert.isFalse(isAlive(Number(/\d+/u.exec(name)![0])), name);
        }
        yield* Scope.close(second.scope, Exit.void);
      }),
  );

  it.live(
    "starts it again when it dies, and stops it with the Hub, leaving no process or config",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const v1 = release(harness, "1.0.0");
        const { gateway, scope } = yield* startGateway(
          harness,
          fakeReleases({ releases: [v1] }).service,
          { pinned: [v1] },
        );
        yield* running(gateway);
        const firstKey = Redacted.value(Option.getOrThrow(yield* gateway.endpoint).clientKey);
        const [first] = runningPids(harness.stateDir);
        process.kill(first!, "SIGKILL");
        const status = yield* reaches(
          gateway,
          (next) => next.state === "running" && next.restarts === 1,
        );
        assert.equal(status.restarts, 1);
        const [pid] = runningPids(harness.stateDir);
        assert.notEqual(pid, first);
        assert.isTrue(isAlive(pid!));
        // Each start has its own client key: one an earlier process knew is useless now.
        assert.notEqual(
          Redacted.value(Option.getOrThrow(yield* gateway.endpoint).clientKey),
          firstKey,
        );

        yield* Scope.close(scope, Exit.void);
        assert.isFalse(isAlive(pid!));
        assert.lengthOf(runningPids(harness.stateDir), 0);
        assert.lengthOf(
          NodeFS.readdirSync(harness.runDir).filter((name) => name.endsWith(".yaml")),
          0,
        );
      }),
  );

  it.live(
    "at the next start stops a leftover whose start time and executable match, never another, and never fails over a bad record",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const root = NodePath.join(harness.stateDir, "ai-gateway");
        NodeFS.mkdirSync(root, { recursive: true });
        const spawn = () =>
          NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
          });
        const leftover = spawn();
        const stranger = spawn();
        const leftoverExited = new Promise((resolve) => leftover.once("exit", resolve));
        try {
          const seen = yield* pollFor(() => identityOf(leftover.pid!, os));
          NodeFS.writeFileSync(
            NodePath.join(root, "run-aaaaaaaaaaaa.pid"),
            JSON.stringify({ pid: leftover.pid, startToken: "a", ...seen }),
          );
          // The PID of another process now, which started at another time: never stopped.
          NodeFS.writeFileSync(
            NodePath.join(root, "run-bbbbbbbbbbbb.pid"),
            JSON.stringify({
              pid: stranger.pid,
              startToken: "b",
              startTime: "1",
              executable: seen.executable,
            }),
          );
          // Records that cannot be read or removed: logged, and the Hub starts anyway.
          NodeFS.writeFileSync(NodePath.join(root, "run-cccccccccccc.pid"), "not json");
          NodeFS.mkdirSync(NodePath.join(root, "run-dddddddddddd.pid", "inside"), {
            recursive: true,
          });
          const v1 = release(harness, "1.0.0");
          const { gateway, scope } = yield* startGateway(
            harness,
            fakeReleases({ releases: [v1] }).service,
            { pinned: [v1] },
          );
          yield* running(gateway);
          yield* Effect.promise(() => leftoverExited);
          assert.isTrue(isAlive(stranger.pid!));
          assert.isTrue(harness.logs.some((line) => line.includes("Could not clear a leftover")));
          yield* Scope.close(scope, Exit.void);
        } finally {
          leftover.kill("SIGKILL");
          stranger.kill("SIGKILL");
        }
      }),
  );

  it.live(
    "moves to a newer pin with a Hub upgrade, keeps the Owner's roll back through a crash and a restart, and keeps only two releases",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const v1 = release(harness, "1.0.0");
        const v2 = release(harness, "1.1.0");
        const v3 = release(harness, "1.2.0");
        const github = fakeReleases({ releases: [v1, v2, v3] });

        // A Hub pinning 1.0.0, then upgraded to one pinning 1.1.0 as well: it moves to 1.1.0.
        const old = yield* startGateway(harness, github.service, { pinned: [v1] });
        yield* running(old.gateway);
        yield* Scope.close(old.scope, Exit.void);
        const upgraded = yield* startGateway(harness, github.service, { pinned: [v1, v2] });
        const moved = yield* running(upgraded.gateway);
        assert.equal(moved.version, "1.1.0");
        assert.equal(moved.previousVersion, "1.0.0");

        // The Owner rolls back: the old one runs until the new one answers and is recorded.
        const [before] = runningPids(harness.stateDir);
        const rolledBack = yield* upgraded.gateway.rollback;
        assert.equal(rolledBack.version, "1.0.0");
        assert.equal(rolledBack.previousVersion, "1.1.0");
        assert.isFalse(isAlive(before!));
        const endpoint = Option.getOrThrow(yield* upgraded.gateway.endpoint);
        const answer = yield* httpGet(
          `${endpoint.baseUrl}/v8/management/config`,
          Redacted.value(endpoint.managementKey),
        );
        assert.equal(answer.version, "1.0.0");

        // A crash does not move past the Owner's choice, nor does a restart of the Hub.
        const [crashed] = runningPids(harness.stateDir);
        process.kill(crashed!, "SIGKILL");
        const again = yield* reaches(
          upgraded.gateway,
          (status) => status.state === "running" && status.restarts === 1,
        );
        assert.equal(again.version, "1.0.0");
        yield* Scope.close(upgraded.scope, Exit.void);
        const restarted = yield* startGateway(harness, github.service, { pinned: [v1, v2, v3] });
        assert.equal((yield* running(restarted.gateway)).version, "1.0.0");

        // Updating to the newest pin: back to following the pins; only two releases on disk.
        const check = yield* restarted.gateway.checkForUpdates;
        assert.deepEqual(check, {
          currentVersion: "1.0.0",
          latestVersion: "1.2.0",
          updateAvailable: true,
        });
        const updated = yield* restarted.gateway.update("1.2.0");
        assert.equal(updated.version, "1.2.0");
        assert.equal(updated.previousVersion, "1.0.0");
        assert.deepEqual(installedVersions(harness), ["1.0.0", "1.2.0"]);
        assert.deepEqual(
          harness.audits.map((entry) => [entry.action, detailOf(entry)]),
          [
            ["ai_gateway.rollback", { from: "1.1.0", version: "1.0.0", outcome: "rolled-back" }],
            ["ai_gateway.update", { from: "1.0.0", version: "1.2.0", outcome: "updated" }],
          ],
        );
        yield* Scope.close(restarted.scope, Exit.void);
        assert.lengthOf(runningPids(harness.stateDir), 0);
      }),
  );

  it.live("refuses a version it does not pin, and keeps the running one when a pin fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const v1 = release(harness, "1.0.0");
      const broken = release(harness, "1.2.0", "exit");
      const unpinned = release(harness, "9.9.9");
      const github = fakeReleases({ releases: [v1, broken, unpinned] });
      const { gateway, scope } = yield* startGateway(harness, github.service, {
        pinned: [broken, v1],
      });
      yield* running(gateway);
      const [pid] = runningPids(harness.stateDir);

      const refused = yield* gateway.update("9.9.9").pipe(Effect.flip);
      assert.match(refused.message, /not a release this Hub pins/u);
      assert.notInclude(github.downloads, "9.9.9");
      const failed = yield* gateway.update("1.2.0").pipe(Effect.flip);
      assert.match(failed.message, /exited while starting/u);

      const status = yield* gateway.status;
      assert.equal(status.state, "running");
      assert.equal(status.version, "1.0.0");
      assert.isNull(status.previousVersion);
      assert.deepEqual(runningPids(harness.stateDir), [pid]);
      assert.deepEqual(
        harness.audits.map((entry) => [
          entry.action,
          detailOf(entry).outcome,
          detailOf(entry).version,
        ]),
        [
          ["ai_gateway.update", "failed", "9.9.9"],
          ["ai_gateway.update", "failed", "1.2.0"],
        ],
      );
      yield* gateway.rollback.pipe(Effect.flip);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.live("keeps the old release running and recorded when the new one cannot be recorded", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const v1 = release(harness, "1.0.0");
      const v2 = release(harness, "1.1.0");
      const { gateway, scope } = yield* startGateway(
        harness,
        fakeReleases({ releases: [v1, v2] }).service,
        { pinned: [v2, v1] },
      );
      yield* running(gateway);
      const [pid] = runningPids(harness.stateDir);
      harness.failWrites = true;
      const failed = yield* gateway.update("1.1.0").pipe(Effect.flip);
      harness.failWrites = false;
      assert.match(failed.message, /could not be written/u);
      const status = yield* gateway.status;
      assert.equal(status.state, "running");
      assert.equal(status.version, "1.0.0");
      assert.isTrue(isAlive(pid!));
      assert.deepEqual(runningPids(harness.stateDir), [pid]);
      const endpoint = Option.getOrThrow(yield* gateway.endpoint);
      const answer = yield* httpGet(
        `${endpoint.baseUrl}/v8/management/config`,
        Redacted.value(endpoint.managementKey),
      );
      assert.equal(answer.version, "1.0.0");
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.live("where the Owner decides, stays off until turned on, and turns off again", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const v1 = release(harness, "1.0.0");
      const github = fakeReleases({ releases: [v1] });
      const { gateway, scope } = yield* startGateway(harness, github.service, {
        pinned: [v1],
        placement: { _tag: "owner", defaultEnabled: false },
      });
      const off = yield* gateway.status;
      assert.equal(off.state, "off");
      assert.isTrue(off.switchable);
      assert.deepEqual(github.downloads, []);
      yield* gateway.update("1.0.0").pipe(Effect.flip);

      yield* gateway.setEnabled(true);
      yield* running(gateway);
      yield* gateway.setEnabled(false);
      assert.equal((yield* gateway.status).state, "off");
      assert.lengthOf(runningPids(harness.stateDir), 0);
      assert.deepEqual(
        harness.audits
          .filter((entry) => entry.action === "ai_gateway.enable")
          .map((entry) => [entry.action, detailOf(entry).to]),
        [
          ["ai_gateway.enable", "on"],
          ["ai_gateway.enable", "off"],
        ],
      );
      yield* Scope.close(scope, Exit.void);

      // The choice is kept: the next start stays off.
      const next = yield* startGateway(harness, github.service, {
        pinned: [v1],
        placement: { _tag: "owner", defaultEnabled: true },
      });
      assert.equal((yield* next.gateway.status).state, "off");
      yield* Scope.close(next.scope, Exit.void);

      // Where the environment decides, the Owner cannot.
      const forced = yield* startGateway(makeHarness(), github.service, {
        pinned: [v1],
        placement: { _tag: "forced", enabled: false },
      });
      assert.isFalse((yield* forced.gateway.status).switchable);
      yield* forced.gateway.setEnabled(true).pipe(Effect.flip);
      yield* Scope.close(forced.scope, Exit.void);
    }),
  );
});

// The real pinned release from GitHub: downloads 25 MB, so only when asked
// (`T3CODE_TEST_LIVE_CLIPROXY=1`); the fake release above covers the rest without a network.
describe.skipIf(
  !posix ||
    platform === undefined ||
    HostProcess.Environment.defaultValue().T3CODE_TEST_LIVE_CLIPROXY !== "1",
)("the pinned CLIProxyAPI release", () => {
  it.live(
    "downloads, verifies and runs on loopback, refusing the management API without its key",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const scope = yield* Scope.make();
        const gateway = yield* AiGateway.make({
          placement: { _tag: "forced", enabled: true },
          os,
          stateDir: harness.stateDir,
          platform,
          pinned: PINNED_CLIPROXY_RELEASES,
          runtimeFolder: { directory: harness.runDir, inMemory: true },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ServerSecretStore, harness.store.service),
              CliproxyReleasesLayer.pipe(Layer.provide(FetchHttpClient.layer)),
              Layer.succeed(
                AuditLog.AuditLog,
                AuditLog.AuditLog.of({
                  record: () => Effect.void,
                  list: () => Effect.die("not used"),
                }),
              ),
              FetchHttpClient.layer,
            ),
          ),
          Scope.provide(scope),
        );
        const status = yield* running(gateway);
        assert.equal(status.version, PINNED_CLIPROXY_RELEASES.at(-1)!.version);
        const endpoint = Option.getOrThrow(yield* gateway.endpoint);
        const without = yield* httpGet(`${endpoint.baseUrl}/v8/management/config`);
        assert.equal(without.status, 401);
        const withKey = yield* httpGet(
          `${endpoint.baseUrl}/v8/management/config`,
          Redacted.value(endpoint.managementKey),
        );
        assert.equal(withKey.status, 200);
        yield* Scope.close(scope, Exit.void);
        assert.lengthOf(runningPids(harness.stateDir), 0);
      }),
  );
});
