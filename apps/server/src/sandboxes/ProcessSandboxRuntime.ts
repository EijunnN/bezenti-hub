// @effect-diagnostics nodeBuiltinImport:off -- the child's stdio goes to a log file descriptor.
/**
 * The process Sandbox runtime, for tests and development only (`T3CODE_SANDBOX_RUNTIME=process`):
 * each Sandbox is a joined T3 server run as a child of the Hub, with `--base-dir` its own home
 * beside the Hub's home. It isolates nothing from the Hub's user; the Podman runtime does.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import {
  ENVIRONMENT_CREDENTIAL_SECRET,
  readJoinedHubState,
  writeJoinedHubState,
} from "../environments/joinedHubState.ts";
import {
  type SandboxExit,
  SandboxHubAddress,
  SandboxRuntime,
  SandboxRuntimeError,
  type SandboxState,
} from "./SandboxRuntime.ts";

/** The setting that turns the process runtime on; off by default, so no build offers it. */
const SANDBOX_RUNTIME_SETTING = "T3CODE_SANDBOX_RUNTIME";
/** Names one start of a Sandbox's server, so a Hub that restarts recognizes its leftover. */
const START_TOKEN_VARIABLE = "T3CODE_SANDBOX_START_TOKEN";

/** What a launcher starts: the Sandbox's joined server over its home. */
export interface SandboxLaunch {
  readonly sandboxId: string;
  readonly homePath: string;
  /** Where the server's output goes, beside its home rather than in it. */
  readonly logPath: string;
  /** Put in the server's environment, so a restarted Hub can tell its process from any other. */
  readonly startToken: string;
}

export interface LaunchedSandbox {
  readonly pid: number | null;
  /** Completes with its exit code when the server ends, however it ends. */
  readonly exited: Effect.Effect<number | null>;
}

/** Starts the server; closing the scope stops it. */
export type SandboxLauncher = (
  launch: SandboxLaunch,
) => Effect.Effect<LaunchedSandbox, SandboxRuntimeError, Scope.Scope>;

const STOP_GRACE_MS = 5_000;

/** The Hub's environment a Sandbox may see: never its secrets, tokens or ports. */
const childEnvironment = (launch: SandboxLaunch) => {
  const env: Record<string, string> = {
    HOME: launch.homePath,
    USERPROFILE: launch.homePath,
    [START_TOKEN_VARIABLE]: launch.startToken,
  };
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "SYSTEMROOT",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
};

/**
 * Runs `t3 serve --base-dir <home>` as a child of the Hub: the Hub's own entry point under its
 * own Node, and `--dev-url` for a dev Hub so its Sandboxes have the Replay provider too.
 */
export const childProcessLauncher =
  (options: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly devUrl?: string | undefined;
  }): SandboxLauncher =>
  (launch) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          const log = NodeFS.openSync(launch.logPath, "a", 0o600);
          try {
            const child = NodeChildProcess.spawn(
              options.command,
              [
                ...options.args,
                "serve",
                "--base-dir",
                launch.homePath,
                "--no-browser",
                ...(options.devUrl === undefined ? [] : ["--dev-url", options.devUrl]),
              ],
              { cwd: launch.homePath, env: childEnvironment(launch), stdio: ["ignore", log, log] },
            );
            const exited = new Promise<number | null>((resolve) => {
              child.once("exit", (code) => resolve(code));
              child.once("error", () => resolve(null));
            });
            return { child, exited };
          } finally {
            NodeFS.closeSync(log);
          }
        },
        catch: (cause) =>
          new SandboxRuntimeError({
            operation: "start",
            sandboxId: launch.sandboxId,
            detail: String(cause),
          }),
      }),
      ({ child, exited }) =>
        Effect.gen(function* () {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          const ended = yield* Effect.promise(() => exited).pipe(
            Effect.timeoutOption(STOP_GRACE_MS),
          );
          if (Option.isSome(ended)) return;
          child.kill("SIGKILL");
          yield* Effect.promise(() => exited);
        }),
    ).pipe(
      Effect.map(({ child, exited }) => ({
        pid: child.pid ?? null,
        exited: Effect.promise(() => exited),
      })),
    );

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The Hub's own address for its Sandboxes: always loopback. A Hub bound only to another address
 * has none, and offers no Sandbox (a container reaches a UNIX socket instead).
 */
export const sandboxHubLoopbackUrl = (config: {
  readonly host?: string | undefined;
  readonly port: number;
}): string | undefined => {
  const host = config.host;
  if (host === undefined || host === "0.0.0.0" || host === "::" || host === "localhost") {
    return `http://127.0.0.1:${config.port}`;
  }
  if (/^127\.\d+\.\d+\.\d+$/u.test(host)) return `http://${host}:${config.port}`;
  if (host === "::1") return `http://[::1]:${config.port}`;
  return undefined;
};

interface Running {
  readonly scope: Scope.Closeable;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly exited: Deferred.Deferred<number | null>;
  /** Set before `stop` closes the scope, so the end is not reported as a crash. */
  stopping: boolean;
}

const PidRecord = Schema.Struct({ pid: Schema.Number, startToken: Schema.String });
type PidRecord = typeof PidRecord.Type;
const PidRecordJson = Schema.fromJsonString(PidRecord);
const decodePidRecord = Schema.decodeEffect(PidRecordJson);
const encodePidRecord = Schema.encodeEffect(PidRecordJson);

export const make = Effect.fn("ProcessSandboxRuntime.make")(function* (options: {
  readonly launcher: SandboxLauncher;
  /** Default: beside the Hub's home, `<Hub home>-sandboxes`, so no Sandbox is inside it. */
  readonly rootDir?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const address = yield* SandboxHubAddress;
  const rootDir =
    options.rootDir ??
    path.join(path.dirname(config.baseDir), `${path.basename(config.baseDir)}-sandboxes`);
  const runtimeScope = yield* Effect.scope;
  // Launches run with the runtime's own services, never those of whoever asked for the start.
  const runtimeContext = yield* Effect.context<never>();
  const running = new Map<string, Running>();
  const exits = yield* PubSub.unbounded<SandboxExit>();
  const lock = yield* Semaphore.make(1);

  const homeOf = (sandboxId: string) => path.join(rootDir, sandboxId);
  // Beside the home, not in it: the Sandbox's own server must not be able to rewrite it.
  const pidPathOf = (sandboxId: string) => path.join(rootDir, `${sandboxId}.pid`);
  const failure = (operation: string, sandboxId: string) => (cause: unknown) =>
    new SandboxRuntimeError({ operation, sandboxId, detail: String(cause) });
  const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  /** Its server's paths, as `t3 serve --base-dir <home>` derives them. */
  const pathsOf = (sandboxId: string) =>
    withPlatform(
      ServerConfig.deriveServerPaths(homeOf(sandboxId), undefined, { baseDirIsExplicit: true }),
    );

  /** Whether `pid` is that start's server over that home: its command line and its token. */
  const isTheServer = Effect.fn("ProcessSandboxRuntime.isTheServer")(function* (
    sandboxId: string,
    record: PidRecord,
  ) {
    if (!isAlive(record.pid)) return false;
    const read = (file: string) =>
      fs.readFileString(`/proc/${record.pid}/${file}`).pipe(Effect.orElseSucceed(() => ""));
    const args = (yield* read("cmdline")).split("\0");
    const baseDir = args[args.indexOf("--base-dir") + 1];
    const environment = (yield* read("environ")).split("\0");
    return (
      args.includes("--base-dir") &&
      baseDir === homeOf(sandboxId) &&
      environment.includes(`${START_TOKEN_VARIABLE}=${record.startToken}`)
    );
  });

  /**
   * A server this runtime started before the Hub went down may still run over the home: it is
   * stopped, by its verified PID, before another starts, so no home ever has two servers.
   */
  const stopLeftover = Effect.fn("ProcessSandboxRuntime.stopLeftover")(function* (
    sandboxId: string,
  ) {
    const pidPath = pidPathOf(sandboxId);
    const text = yield* fs.readFileString(pidPath).pipe(Effect.option);
    if (Option.isNone(text)) return;
    const record = yield* decodePidRecord(text.value).pipe(Effect.option);
    if (Option.isSome(record) && (yield* isTheServer(sandboxId, record.value))) {
      yield* Effect.logWarning("Stopping a Sandbox server left by an earlier Hub", {
        sandboxId,
        pid: record.value.pid,
      });
      process.kill(record.value.pid, "SIGTERM");
      for (let waited = 0; waited < STOP_GRACE_MS && isAlive(record.value.pid); waited += 100) {
        yield* Effect.sleep(100);
      }
      if (isAlive(record.value.pid)) process.kill(record.value.pid, "SIGKILL");
    }
    yield* fs.remove(pidPath, { force: true }).pipe(Effect.ignore);
  });

  const create: SandboxRuntime["Service"]["create"] = Effect.fn("ProcessSandboxRuntime.create")(
    function* (spec) {
      const paths = yield* pathsOf(spec.sandboxId);
      yield* fs.makeDirectory(rootDir, { recursive: true, mode: 0o700 });
      yield* fs.makeDirectory(paths.secretsDir, { recursive: true, mode: 0o700 });
      yield* fs.chmod(homeOf(spec.sandboxId), 0o700);
      const credentialPath = path.join(paths.secretsDir, `${ENVIRONMENT_CREDENTIAL_SECRET}.bin`);
      yield* fs.writeFileString(credentialPath, Redacted.value(spec.credential), { mode: 0o600 });
      yield* fs.chmod(credentialPath, 0o600);
      yield* withPlatform(
        writeJoinedHubState(paths.joinedHubPath, {
          hubUrl: yield* address.loopbackUrl,
          hubEnvironmentId: spec.hubEnvironmentId,
          environmentId: spec.environmentId,
          name: spec.name,
          joinedAt: DateTime.formatIso(yield* DateTime.now),
        }),
      );
    },
    (effect, spec) => Effect.mapError(effect, failure("be created", spec.sandboxId)),
  );

  const stopLocked = (sandboxId: string) =>
    Effect.suspend(() => {
      const current = running.get(sandboxId);
      if (current === undefined) return Effect.void;
      current.stopping = true;
      running.delete(sandboxId);
      return Scope.close(current.scope, Exit.void);
    });

  const start: SandboxRuntime["Service"]["start"] = Effect.fn("ProcessSandboxRuntime.start")(
    function* (sandboxId) {
      const current = running.get(sandboxId);
      if (current !== undefined) return { exited: Deferred.await(current.exited) };
      const paths = yield* pathsOf(sandboxId);
      const joined = yield* withPlatform(readJoinedHubState(paths.joinedHubPath)).pipe(
        Effect.mapError(failure("start", sandboxId)),
      );
      if (Option.isNone(joined)) {
        return yield* failure("start", sandboxId)("its home has no Hub; create it first.");
      }
      yield* stopLeftover(sandboxId);
      // A dev Hub can come back on another port: the Sandbox follows it.
      const hubUrl = yield* address.loopbackUrl;
      if (joined.value.hubUrl !== hubUrl) {
        yield* withPlatform(
          writeJoinedHubState(paths.joinedHubPath, { ...joined.value, hubUrl }),
        ).pipe(Effect.mapError(failure("start", sandboxId)));
      }
      const startToken = NodeCrypto.randomUUID();
      const scope = yield* Scope.fork(runtimeScope);
      const launched = yield* options
        .launcher({
          sandboxId,
          homePath: homeOf(sandboxId),
          logPath: path.join(rootDir, `${sandboxId}.log`),
          startToken,
        })
        .pipe(
          Effect.provideContext(Context.add(runtimeContext, Scope.Scope, scope)),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
      if (launched.pid !== null) {
        const record: PidRecord = { pid: launched.pid, startToken };
        yield* encodePidRecord(record).pipe(
          Effect.flatMap((text) => fs.writeFileString(pidPathOf(sandboxId), text, { mode: 0o600 })),
          Effect.mapError(failure("start", sandboxId)),
        );
        yield* Scope.addFinalizer(
          scope,
          fs.remove(pidPathOf(sandboxId), { force: true }).pipe(Effect.ignore),
        );
      }
      const entry: Running = {
        scope,
        pid: launched.pid,
        startedAt: DateTime.formatIso(yield* DateTime.now),
        exited: yield* Deferred.make<number | null>(),
        stopping: false,
      };
      running.set(sandboxId, entry);
      yield* launched.exited.pipe(
        Effect.flatMap((exitCode) =>
          Deferred.succeed(entry.exited, exitCode).pipe(
            Effect.andThen(
              entry.stopping
                ? Effect.void
                : Effect.suspend(() => {
                    if (running.get(sandboxId) === entry) running.delete(sandboxId);
                    return PubSub.publish(exits, { sandboxId, exitCode }).pipe(
                      Effect.andThen(Scope.close(scope, Exit.void)),
                    );
                  }),
            ),
          ),
        ),
        Effect.forkIn(runtimeScope),
      );
      return { exited: Deferred.await(entry.exited) };
    },
    (effect) => lock.withPermits(1)(effect),
  );

  const stop: SandboxRuntime["Service"]["stop"] = (sandboxId) =>
    lock.withPermits(1)(stopLocked(sandboxId)).pipe(Effect.withSpan("ProcessSandboxRuntime.stop"));

  const remove: SandboxRuntime["Service"]["delete"] = Effect.fn("ProcessSandboxRuntime.delete")(
    function* (sandboxId) {
      yield* stopLocked(sandboxId);
      yield* stopLeftover(sandboxId);
      yield* fs
        .remove(homeOf(sandboxId), { recursive: true, force: true })
        .pipe(Effect.mapError(failure("be deleted", sandboxId)));
      yield* fs.remove(path.join(rootDir, `${sandboxId}.log`), { force: true }).pipe(Effect.ignore);
    },
    (effect) => lock.withPermits(1)(effect),
  );

  const inspect: SandboxRuntime["Service"]["inspect"] = Effect.fn("ProcessSandboxRuntime.inspect")(
    function* (sandboxId) {
      const homePath = homeOf(sandboxId);
      const current = running.get(sandboxId);
      const state: SandboxState =
        current !== undefined
          ? { _tag: "running", pid: current.pid, startedAt: current.startedAt }
          : (yield* fs.exists(homePath).pipe(Effect.orElseSucceed(() => false)))
            ? { _tag: "stopped" }
            : { _tag: "missing" };
      return { state, homePath };
    },
  );

  // The Hub's servers end with it: a Sandbox left running would outlive what started it.
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...running.keys()], stopLocked, { discard: true }),
  );

  return SandboxRuntime.of({
    kind: "process",
    create,
    start,
    stop,
    delete: remove,
    inspect,
    exits: Stream.fromPubSub(exits),
  });
});

export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(SandboxRuntime, make(options));

/**
 * The process runtime when `T3CODE_SANDBOX_RUNTIME=process` and the Hub answers on loopback;
 * None otherwise, and the Hub offers no Sandbox. It runs the Hub's own entry point with its Node.
 */
export const fromConfig = Effect.gen(function* () {
  const setting = yield* Config.String(SANDBOX_RUNTIME_SETTING).pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  if (Option.isNone(setting) || setting.value !== "process") return Option.none();
  const config = yield* ServerConfig.ServerConfig;
  const hubUrl = sandboxHubLoopbackUrl(config);
  const entry = process.argv[1];
  if (hubUrl === undefined || entry === undefined) {
    yield* Effect.logWarning("Sandboxes are off: the Hub does not listen on loopback.");
    return Option.none();
  }
  return Option.some(
    layer({
      launcher: childProcessLauncher({
        command: process.execPath,
        args: [entry],
        devUrl: config.devUrl?.toString(),
      }),
    }).pipe(
      Layer.provide(
        Layer.succeed(
          SandboxHubAddress,
          SandboxHubAddress.of({ loopbackUrl: Effect.succeed(hubUrl) }),
        ),
      ),
    ),
  );
});
