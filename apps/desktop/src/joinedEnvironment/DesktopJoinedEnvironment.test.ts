import type { DesktopJoinedEnvironmentState } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopJoinedEnvironment from "./DesktopJoinedEnvironment.ts";

const HUB = "https://hub.example.com";
const APPROVAL = `${HUB}/register-environment?request=req-1`;
const PORT = 47123;

interface Run {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * A stand-in for the bundled server: `t3 join` prints its approval link and, once approved,
 * writes `joined-hub.json` as the CLI does; `t3 leave` removes it; the server runs until killed.
 */
const makeHarness = Effect.fn(function* (options?: {
  readonly joinOutcome?: "approve" | "deny";
  readonly connection?: Record<string, unknown>;
}) {
  const baseDir = "/home/me/.t3/joined-environment";
  const joinedHubPath = `${baseDir}/userdata/joined-hub.json`;
  // The joined server's T3 home, as the stand-in CLI leaves it.
  const files = new Map<string, string>([[baseDir, ""]]);
  const runs: Array<Run> = [];
  const opened: Array<string> = [];
  const approve = yield* Deferred.make<void>();
  const serverKills = yield* Ref.make(0);
  const joinKilled = yield* Deferred.make<void>();
  const servers = yield* Ref.make(0);

  const handle = (input: {
    readonly output?: Stream.Stream<Uint8Array>;
    readonly exitCode: Effect.Effect<number>;
    readonly kill?: Effect.Effect<void>;
  }) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242),
      stdout: input.output ?? Stream.empty,
      stderr: Stream.empty,
      all: input.output ?? Stream.empty,
      exitCode: input.exitCode.pipe(Effect.map(ChildProcessSpawner.ExitCode)),
      isRunning: Effect.succeed(true),
      kill: () => input.kill ?? Effect.void,
      stdin: Sink.drain,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  const lines = (...text: ReadonlyArray<string>) =>
    Stream.make(...text.map((line) => `${line}\n`)).pipe(Stream.encodeText);

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipe");
      runs.push({
        command: command.command,
        args: command.args.map((arg) => (typeof arg === "string" ? arg : "<redacted>")),
      });
      const [verb] = command.args;
      if (verb === "join") {
        return yield* Effect.acquireRelease(
          Effect.succeed(
            handle({
              output: Stream.concat(
                lines(
                  `Approve this machine on the Hub as its Owner, from any device. Open:`,
                  `  ${APPROVAL}`,
                ),
                Stream.fromEffect(Deferred.await(approve)).pipe(Stream.drain),
              ).pipe(
                Stream.concat(
                  options?.joinOutcome === "deny"
                    ? lines("The registration was cancelled on the Hub.")
                    : Stream.empty,
                ),
              ),
              exitCode: Deferred.await(approve).pipe(
                Effect.map(() => {
                  if (options?.joinOutcome === "deny") return 1;
                  files.set(
                    joinedHubPath,
                    JSON.stringify({
                      hubUrl: HUB,
                      hubEnvironmentId: "hub",
                      environmentId: "env-laptop",
                      name: "Laptop",
                      joinedAt: "2026-11-06T10:00:00.000Z",
                    }),
                  );
                  return 0;
                }),
              ),
            }),
          ),
          () => Deferred.succeed(joinKilled, undefined),
        );
      }
      if (verb === "leave") {
        files.delete(joinedHubPath);
        return handle({
          output: lines(`Left ${HUB}. Restart this machine's server…`),
          exitCode: Effect.succeed(0),
        });
      }
      // The managed server: runs until the manager kills it.
      yield* Ref.update(servers, (count) => count + 1);
      const exited = yield* Deferred.make<number>();
      return yield* Effect.acquireRelease(
        Effect.succeed(
          handle({
            exitCode: Deferred.await(exited),
            kill: Deferred.succeed(exited, 0).pipe(Effect.asVoid),
          }),
        ),
        () =>
          Ref.update(serverKills, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(exited, 0)),
          ),
      );
    }),
  );

  const connection = options?.connection ?? {
    _tag: "connected",
    since: "2026-11-06T10:00:01.000Z",
  };
  const httpClient = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ mode: "joined", hubUrl: HUB, name: "Laptop", connection }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );

  const stubLog: DesktopObservability.DesktopBackendOutputLogShape = {
    beginSession: () => Effect.void,
    writeOutputChunk: () => Effect.void,
    persistFailureSnapshot: () => Effect.void,
    persistFailure: () => Effect.void,
    discardSession: Effect.void,
  };
  const layer = Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HttpClient.HttpClient, httpClient),
    Layer.mock(NetService.NetService, { reserveLoopbackPort: () => Effect.succeed(PORT) }),
    Layer.mock(ElectronShell.ElectronShell, {
      openExternal: (url) => Effect.sync(() => opened.push(String(url))).pipe(Effect.as(true)),
    }),
    DesktopAppSettings.layerTest(),
    DesktopState.layer,
    Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
      forInstance: () => Effect.succeed(stubLog),
    }),
    Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
      latest: Effect.succeedNone,
      changes: Stream.empty,
      encoded: Stream.empty,
      handleControlForSource: () => Effect.void,
      removeControlSource: () => Effect.void,
    }),
    DesktopBrowserHost.layer,
    DesktopWslEnvironment.layerTest({}),
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(files.has(path)),
      readFileString: (path) => {
        const text = files.get(path);
        return text === undefined ? Effect.die(`unexpected read of ${path}`) : Effect.succeed(text);
      },
    }),
    Path.layer,
  );

  const context = yield* Layer.build(layer);
  const service = yield* DesktopJoinedEnvironment.make({
    baseDir,
    cli: (args) => ChildProcess.make("t3", args),
    serveConfig: (port) =>
      Effect.succeed({
        executablePath: "t3",
        args: ["serve", "--base-dir", baseDir],
        entryPath: baseDir,
        cwd: baseDir,
        env: {},
        extendEnv: true,
        bootstrap: {
          mode: "desktop",
          noBrowser: true,
          port,
          t3Home: baseDir,
          host: "127.0.0.1",
          desktopBootstrapToken: "token",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        },
        bootstrapDelivery: "fd3",
        httpBaseUrl: new URL(`http://127.0.0.1:${port}`),
        captureOutput: true,
        preflightFailure: Option.none(),
        readinessPath: "/health",
      }),
  }).pipe(Effect.provide(context));
  return {
    service,
    context,
    baseDir,
    joinedHubPath,
    runs,
    opened,
    approve,
    serverKills,
    joinKilled,
    servers,
  };
});

// The join and the manager run on fibers of their own; the test clock lets them through.
const settle = TestClock.adjust("10 millis");
/** Polls the state until `done` holds; the join and the manager run in the background. */
const waitUntil = (
  service: DesktopJoinedEnvironment.DesktopJoinedEnvironment["Service"],
  done: (state: DesktopJoinedEnvironmentState) => boolean,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const state = yield* service.state;
      if (done(state)) return state;
      yield* settle;
    }
    return yield* Effect.fail(`timed out; last state: ${JSON.stringify(yield* service.state)}`);
  });

describe("DesktopJoinedEnvironment", () => {
  it.effect(
    "joins through the system browser, then runs the joined server and shows its connection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const { service } = harness;

          const started = yield* service.join({ hubUrl: HUB, name: "Laptop" });
          assert.equal(started.joining?.hubUrl, HUB);
          assert.isNull(started.hub);

          const waiting = yield* waitUntil(
            service,
            (state) => state.joining?.approvalUrl === APPROVAL,
          );
          assert.deepEqual(harness.opened, [APPROVAL]);
          assert.equal(waiting.process, "stopped");
          assert.deepEqual(harness.runs[0], {
            command: "t3",
            args: ["join", HUB, "--base-dir", harness.baseDir, "--no-browser", "--name", "Laptop"],
          });

          yield* Deferred.succeed(harness.approve, undefined);
          const running = yield* waitUntil(service, (state) => state.process === "running");
          assert.deepEqual(running.hub, { url: HUB, name: "Laptop" });
          assert.isNull(running.joining);
          assert.isTrue(running.enabled);
          assert.deepEqual(running.connection, {
            status: "connected",
            detail: "2026-11-06T10:00:01.000Z",
          });
          assert.deepEqual(harness.runs[1], {
            command: "t3",
            args: ["serve", "--base-dir", harness.baseDir],
          });
          // The default preference keeps the app (and so this server) up with no window.
          const desktopState = yield* DesktopState.DesktopState.pipe(
            Effect.provide(harness.context),
          );
          assert.isTrue(yield* Ref.get(desktopState.keepRunningWithoutWindows));
        }),
      ),
  );

  it.effect("turning it off stops the server, turning it on starts it again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { service } = harness;
        yield* service.join({ hubUrl: HUB });
        yield* Deferred.succeed(harness.approve, undefined);
        yield* waitUntil(service, (state) => state.process === "running");

        const off = yield* service.setEnabled(false);
        assert.equal(off.process, "stopped");
        assert.isFalse(off.enabled);
        assert.isNull(off.connection);
        assert.equal(yield* Ref.get(harness.serverKills), 1);
        assert.deepEqual(off.hub, { url: HUB, name: "Laptop" }, "still joined, only stopped");

        yield* service.setEnabled(true);
        yield* waitUntil(service, (state) => state.process === "running");
        assert.equal(yield* Ref.get(harness.servers), 2);
      }),
    ),
  );

  it.effect("starts with the app when it was left on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.join({ hubUrl: HUB });
        yield* Deferred.succeed(harness.approve, undefined);
        yield* waitUntil(harness.service, (state) => state.process === "running");
        // The next launch: same T3 home and settings, a fresh manager.
        yield* harness.service.stop;
        assert.equal(yield* Ref.get(harness.serverKills), 1);
        const settings = yield* DesktopAppSettings.DesktopAppSettings.pipe(
          Effect.provide(harness.context),
        );
        assert.isTrue((yield* settings.get).joinedEnvironmentEnabled);
        yield* harness.service.reconcile;
        yield* waitUntil(harness.service, (state) => state.process === "running");
        assert.equal(yield* Ref.get(harness.servers), 2);
      }),
    ),
  );

  it.effect("Leave stops the server and removes this computer from the Hub", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { service } = harness;
        yield* service.join({ hubUrl: HUB });
        yield* Deferred.succeed(harness.approve, undefined);
        yield* waitUntil(service, (state) => state.process === "running");

        const left = yield* service.leave;
        assert.equal(yield* Ref.get(harness.serverKills), 1);
        assert.deepEqual(harness.runs.at(-1), {
          command: "t3",
          args: ["leave", "--base-dir", harness.baseDir],
        });
        assert.isNull(left.hub);
        assert.isFalse(left.enabled);
        assert.equal(left.process, "stopped");
        assert.isNull(left.error);
        const desktopState = yield* DesktopState.DesktopState.pipe(Effect.provide(harness.context));
        assert.isFalse(yield* Ref.get(desktopState.keepRunningWithoutWindows));
      }),
    ),
  );

  it.effect("a join the Hub refused says why and starts nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ joinOutcome: "deny" });
        const { service } = harness;
        yield* service.join({ hubUrl: HUB });
        yield* Deferred.succeed(harness.approve, undefined);
        const done = yield* waitUntil(service, (state) => state.joining === null);
        assert.include(done.error ?? "", "The registration was cancelled on the Hub.");
        assert.isNull(done.hub);
        assert.isFalse(done.enabled);
        assert.equal(yield* Ref.get(harness.servers), 0);
      }),
    ),
  );

  it.effect("cancelling a join ends `t3 join`", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { service } = harness;
        yield* service.join({ hubUrl: HUB });
        yield* waitUntil(service, (state) => state.joining?.approvalUrl === APPROVAL);
        const cancelled = yield* service.cancelJoin;
        assert.isNull(cancelled.joining);
        assert.isTrue(yield* Deferred.isDone(harness.joinKilled));
        assert.isNull(cancelled.hub);
      }),
    ),
  );

  it.effect("refuses to turn on before joining, and to join twice", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { service } = harness;
        const notJoined = yield* service.setEnabled(true).pipe(Effect.flip);
        assert.include(notJoined.message, "Join a Hub first");
        yield* service.join({ hubUrl: HUB });
        const twice = yield* service.join({ hubUrl: HUB }).pipe(Effect.flip);
        assert.include(twice.message, "Already joining");
        yield* Deferred.succeed(harness.approve, undefined);
        yield* waitUntil(service, (state) => state.process === "running");
        const again = yield* service.join({ hubUrl: HUB }).pipe(Effect.flip);
        assert.include(again.message, "already an Environment");
      }),
    ),
  );

  it.effect("shows a refused connection and the keep-running preference", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          connection: { _tag: "stopped", reason: "revoked", message: "This machine was removed." },
        });
        const { service } = harness;
        yield* service.join({ hubUrl: HUB });
        yield* Deferred.succeed(harness.approve, undefined);
        const running = yield* waitUntil(service, (state) => state.process === "running");
        assert.deepEqual(running.connection, {
          status: "refused",
          detail: "This machine was removed.",
        });
        const kept = yield* service.setKeepRunning(false);
        assert.isFalse(kept.keepRunningWhenClosed);
        const desktopState = yield* DesktopState.DesktopState.pipe(Effect.provide(harness.context));
        assert.isFalse(yield* Ref.get(desktopState.keepRunningWithoutWindows));
      }),
    ),
  );

  it.effect("runs the bundled server in a T3 home of its own, answering on loopback /health", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const launch = DesktopJoinedEnvironment.launchFor(
        {
          path,
          baseDir: "/home/me/.t3",
          isPackaged: false,
          compileCachePath: "/unused",
          backendEntryPath: "/app/server/bin.mjs",
          backendCwd: "/app/server",
        },
        Effect.succeed("token"),
      );
      assert.equal(launch.baseDir, "/home/me/.t3/joined-environment");
      const config = yield* launch.serveConfig(PORT);
      assert.deepEqual(config.args, [
        "/app/server/bin.mjs",
        "--bootstrap-fd",
        "3",
        "--base-dir",
        "/home/me/.t3/joined-environment",
      ]);
      assert.equal(config.bootstrap.t3Home, "/home/me/.t3/joined-environment");
      assert.equal(config.bootstrap.host, "127.0.0.1");
      assert.equal(config.readinessPath, "/health");
      assert.equal(config.httpBaseUrl.href, `http://127.0.0.1:${PORT}/`);
      assert.equal(config.env.ELECTRON_RUN_AS_NODE, "1");
      const join = launch.cli(["join", HUB]);
      assert.equal(join._tag, "StandardCommand");
      if (join._tag === "StandardCommand") {
        assert.deepEqual(join.args, ["/app/server/bin.mjs", "join", HUB]);
      }
    }).pipe(Effect.provide(Path.layer)),
  );
});
