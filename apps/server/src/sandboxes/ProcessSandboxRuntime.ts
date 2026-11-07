// @effect-diagnostics nodeBuiltinImport:off -- the child's stdio goes to a log file descriptor.
/**
 * The process Sandbox runtime, for tests and development: each Sandbox is a joined T3 server run
 * as a child of the Hub, with `--base-dir` its own home under `<Hub home>/sandboxes`. Nothing
 * isolates it from the Hub's user beyond that; the Podman runtime does (ticket 04). Its servers
 * end with the Hub.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
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

/** What a launcher starts: the Sandbox's joined server over its home. */
export interface SandboxLaunch {
  readonly sandboxId: string;
  readonly homePath: string;
  /** Where the server's output goes, beside its home rather than in it. */
  readonly logPath: string;
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
const childEnvironment = (homePath: string) => {
  const env: Record<string, string> = { HOME: homePath, USERPROFILE: homePath };
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
              {
                cwd: launch.homePath,
                env: childEnvironment(launch.homePath),
                stdio: ["ignore", log, log],
              },
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

interface Running {
  readonly scope: Scope.Closeable;
  readonly pid: number | null;
  readonly startedAt: string;
  /** Set before `stop` closes the scope, so the end is not reported as a crash. */
  stopping: boolean;
}

export const make = Effect.fn("ProcessSandboxRuntime.make")(function* (options: {
  readonly launcher: SandboxLauncher;
  /** Default: `<Hub home>/sandboxes`. */
  readonly rootDir?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const address = yield* SandboxHubAddress;
  const rootDir = options.rootDir ?? path.join(config.baseDir, "sandboxes");
  const runtimeScope = yield* Effect.scope;
  const running = new Map<string, Running>();
  const exits = yield* PubSub.unbounded<SandboxExit>();
  const lock = yield* Semaphore.make(1);

  const homeOf = (sandboxId: string) => path.join(rootDir, sandboxId);
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

  const create: SandboxRuntime["Service"]["create"] = Effect.fn("ProcessSandboxRuntime.create")(
    function* (spec) {
      const paths = yield* pathsOf(spec.sandboxId);
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
      if (running.has(sandboxId)) return;
      const paths = yield* pathsOf(sandboxId);
      const joined = yield* withPlatform(readJoinedHubState(paths.joinedHubPath)).pipe(
        Effect.mapError(failure("start", sandboxId)),
      );
      if (Option.isNone(joined)) {
        return yield* failure("start", sandboxId)("its home has no Hub; create it first.");
      }
      // A dev Hub can come back on another port: the Sandbox follows it.
      const hubUrl = yield* address.loopbackUrl;
      if (joined.value.hubUrl !== hubUrl) {
        yield* withPlatform(
          writeJoinedHubState(paths.joinedHubPath, { ...joined.value, hubUrl }),
        ).pipe(Effect.mapError(failure("start", sandboxId)));
      }
      const scope = yield* Scope.fork(runtimeScope);
      const launched = yield* options
        .launcher({
          sandboxId,
          homePath: homeOf(sandboxId),
          logPath: path.join(rootDir, `${sandboxId}.log`),
        })
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
      const entry: Running = {
        scope,
        pid: launched.pid,
        startedAt: DateTime.formatIso(yield* DateTime.now),
        stopping: false,
      };
      running.set(sandboxId, entry);
      yield* launched.exited.pipe(
        Effect.flatMap((exitCode) =>
          entry.stopping
            ? Effect.void
            : Effect.suspend(() => {
                if (running.get(sandboxId) === entry) running.delete(sandboxId);
                return PubSub.publish(exits, { sandboxId, exitCode }).pipe(
                  Effect.andThen(Scope.close(scope, Exit.void)),
                );
              }),
        ),
        Effect.forkIn(runtimeScope),
      );
    },
    (effect) => lock.withPermits(1)(effect),
  );

  const stop: SandboxRuntime["Service"]["stop"] = (sandboxId) =>
    lock.withPermits(1)(stopLocked(sandboxId)).pipe(Effect.withSpan("ProcessSandboxRuntime.stop"));

  const remove: SandboxRuntime["Service"]["delete"] = Effect.fn("ProcessSandboxRuntime.delete")(
    function* (sandboxId) {
      yield* stopLocked(sandboxId);
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

/** The Hub's own port on loopback, or on the one address it listens on. */
const layerHubAddressFromConfig = Layer.effect(
  SandboxHubAddress,
  Effect.map(ServerConfig.ServerConfig, (config) => {
    const host =
      config.host === undefined || config.host === "0.0.0.0" || config.host === "::"
        ? "127.0.0.1"
        : config.host.includes(":")
          ? `[${config.host}]`
          : config.host;
    return SandboxHubAddress.of({ loopbackUrl: Effect.succeed(`http://${host}:${config.port}`) });
  }),
);

/** The Hub's own entry point, which a Sandbox server runs with the Hub's Node. */
export const layerChildProcess = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const entry = process.argv[1];
    if (entry === undefined) {
      return yield* Effect.die(new Error("The Hub's entry point is unknown."));
    }
    return layer({
      launcher: childProcessLauncher({
        command: process.execPath,
        args: [entry],
        devUrl: config.devUrl?.toString(),
      }),
    }).pipe(Layer.provide(layerHubAddressFromConfig));
  }),
);
