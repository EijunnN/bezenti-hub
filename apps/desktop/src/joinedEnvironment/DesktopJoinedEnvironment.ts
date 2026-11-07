/**
 * «Use this computer as an Environment»: the desktop app joins its Hub with the same flow as
 * `t3 join` and runs a joined-mode server as a managed child process, in a T3 home of its own so
 * it never touches the app's local backend. The app stays a client of the Hub at the same time.
 * See docs/internals/environment-auth.md#joined-environments.
 */
import * as NodeOS from "node:os";

import type { DesktopJoinedEnvironmentState } from "@t3tools/contracts";
import { readEnvironmentJoinConfirmationPrompt } from "@t3tools/shared/environmentJoin";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import type { BackendInstanceFactoryRequirements } from "../backend/DesktopBackendPool.ts";

/** Not in the backend pool: the renderer must never take this server for a local environment. */
const JOINED_ENVIRONMENT_INSTANCE_ID =
  DesktopBackendManager.BackendInstanceId("joined-environment");
/** Under the app's T3 home, apart from its `userdata`. */
const JOINED_ENVIRONMENT_DIRECTORY = "joined-environment";
const HEALTH_PATH = "/health";
const HEALTH_TIMEOUT = Duration.seconds(2);
const STOP_TIMEOUT = Duration.seconds(8);
const ERROR_TAIL_LINES = 3;
const APPROVAL_LINK = /(https?:\/\/\S+)/g;
const REGISTER_PATH = "/register-environment";
/** After the manager's own stop (SIGTERM, then kill after its grace), how long to see it gone. */
const EXIT_CHECKS = 10;
const EXIT_CHECK_INTERVAL = Duration.millis(200);
// Strips terminal colors from CLI output.
const ANSI = /\x1b\[[0-9;]*m/g;

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger(
  "desktop-joined-environment",
);

export class DesktopJoinedEnvironmentError extends Schema.TaggedError<DesktopJoinedEnvironmentError>()(
  "DesktopJoinedEnvironmentError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

type State = DesktopJoinedEnvironmentState;

export class DesktopJoinedEnvironment extends Context.Service<
  DesktopJoinedEnvironment,
  {
    readonly state: Effect.Effect<State>;
    /** Starts `t3 join` in the background and opens its approval page in the system browser. */
    readonly join: (input: {
      readonly hubUrl: string;
      readonly name?: string;
    }) => Effect.Effect<State, DesktopJoinedEnvironmentError>;
    /**
     * Once the Hub says who approved this computer, accept them (it registers as theirs) or not.
     */
    readonly confirmJoin: (accept: boolean) => Effect.Effect<State, DesktopJoinedEnvironmentError>;
    readonly cancelJoin: Effect.Effect<State>;
    readonly setEnabled: (enabled: boolean) => Effect.Effect<State, DesktopJoinedEnvironmentError>;
    readonly setKeepRunning: (keep: boolean) => Effect.Effect<State, DesktopJoinedEnvironmentError>;
    /** Stops the server and runs `t3 leave`: the Hub forgets this computer and so does it. */
    readonly leave: Effect.Effect<State, DesktopJoinedEnvironmentError>;
    /** Runs the server when it is enabled and joined, stops it otherwise. */
    readonly reconcile: Effect.Effect<void>;
    readonly stop: Effect.Effect<void>;
  }
>()("@t3tools/desktop/joinedEnvironment/DesktopJoinedEnvironment") {}

/** How to run the server bundled with the app, for one T3 home. */
export interface JoinedEnvironmentLaunch {
  readonly baseDir: string;
  /** A `t3 <args>` command run by the bundled server entry. */
  readonly cli: (args: ReadonlyArray<string>) => ChildProcess.Command;
  /** The managed server, listening on `port` on loopback. */
  readonly serveConfig: (
    port: number,
  ) => Effect.Effect<DesktopBackendManager.DesktopBackendStartConfig, PlatformError.PlatformError>;
}

/** The joined server's process, by the PID the manager started. */
export interface ProcessControl {
  readonly isAlive: (pid: number) => boolean;
  readonly kill: (pid: number) => void;
}

const nodeProcesses: ProcessControl = {
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  kill: (pid) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  },
};

/** The approval page `t3 join` prints, on the Hub the User named; any other link is ignored. */
export const approvalLinkIn = (line: string, hubOrigin: string): string | null => {
  for (const [candidate] of line.replace(ANSI, "").matchAll(APPROVAL_LINK)) {
    if (!URL.canParse(candidate)) continue;
    const url = new URL(candidate);
    if (url.origin === hubOrigin && url.pathname === REGISTER_PATH) return url.href;
  }
  return null;
};

type JoinedHubRead =
  | { readonly _tag: "none" }
  | { readonly _tag: "joined"; readonly hub: { readonly url: string; readonly name: string } }
  | { readonly _tag: "unreadable" };

/** What the CLI keeps in `joined-hub.json`; only what this app shows. */
const JoinedHub = Schema.fromJsonString(
  Schema.Struct({ hubUrl: Schema.String, name: Schema.String }),
);
const decodeJoinedHub = Schema.decodeUnknownEffect(JoinedHub);

const HealthBody = Schema.Struct({
  connection: Schema.StructWithRest(Schema.Struct({ _tag: Schema.String }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
});

const describeConnection = (
  connection: typeof HealthBody.Type.connection,
): NonNullable<State["connection"]> => {
  switch (connection._tag) {
    case "connected":
      return {
        status: "connected",
        detail: typeof connection.since === "string" ? connection.since : null,
      };
    case "stopped":
      return {
        status: "refused",
        detail: typeof connection.message === "string" ? connection.message : null,
      };
    default:
      return {
        status: "connecting",
        detail: typeof connection.lastError === "string" ? connection.lastError : null,
      };
  }
};

const tailOf = (lines: ReadonlyArray<string>) =>
  lines
    .map((line) => line.replace(ANSI, "").trim())
    .filter((line) => line.length > 0)
    .slice(-ERROR_TAIL_LINES)
    .join("\n");

/** One CLI run: its output lines as they come, then its exit code. `input` is written to it. */
const runCli = Effect.fn("desktop.joinedEnvironment.runCli")(function* (
  command: ChildProcess.Command,
  onLine: (line: string) => Effect.Effect<void> = () => Effect.void,
  input?: Stream.Stream<string>,
) {
  const lines: Array<string> = [];
  const handle = yield* command;
  if (input !== undefined) {
    yield* input.pipe(
      Stream.encodeText,
      Stream.run(handle.stdin),
      Effect.ignore,
      Effect.forkScoped,
    );
  }
  yield* handle.all.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.sync(() => lines.push(line)).pipe(Effect.andThen(onLine(line))),
    ),
    Effect.ignore,
  );
  const exitCode = yield* handle.exitCode;
  return { exitCode: Number(exitCode), lines };
}, Effect.scoped);

export const make = Effect.fn("desktop.joinedEnvironment.make")(function* (
  launch: JoinedEnvironmentLaunch,
  processes: ProcessControl = nodeProcesses,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;
  const shell = yield* ElectronShell.ElectronShell;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const desktopState = yield* DesktopState.DesktopState;
  const layerScope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);

  const joinedHubPath = path.join(launch.baseDir, "userdata", "joined-hub.json");
  const joining = yield* Ref.make(
    Option.none<{
      readonly hubUrl: string;
      readonly approvalUrl: string | null;
      /** Who approved it on the Hub, once `t3 join` asks whether to accept them. */
      readonly approvedBy: string | null;
      /** Answers for `t3 join`'s question, written to its input. */
      readonly answers: Queue.Queue<string>;
      readonly fiber: Fiber.Fiber<void> | null;
    }>(),
  );
  const lastError = yield* Ref.make<string | null>(null);
  const startupFailure = yield* Ref.make<string | null>(null);

  const provideSpawner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

  const server = yield* DesktopBackendManager.makeBackendInstance({
    id: JOINED_ENVIRONMENT_INSTANCE_ID,
    label: Effect.succeed("This computer as an Environment"),
    configResolve: net.reserveLoopbackPort("127.0.0.1").pipe(
      Effect.mapError((cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "DesktopJoinedEnvironment",
          method: "reserveLoopbackPort",
          description: cause.message,
          cause,
        }),
      ),
      Effect.flatMap(launch.serveConfig),
    ),
    onReady: () => Ref.set(startupFailure, null),
    onStartupFailure: (failure) =>
      Ref.set(startupFailure, tailOf([failure.reason, ...failure.output.split("\n")])),
    onStateDirOwned: () =>
      Ref.set(
        startupFailure,
        `Another T3 Code server is using ${launch.baseDir}. Stop it, then turn this on again.`,
      ),
  });

  const readJoinedHub: Effect.Effect<JoinedHubRead> = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(joinedHubPath).pipe(Effect.orElseSucceed(() => false)))) {
      return { _tag: "none" } as const;
    }
    const hub = yield* fileSystem
      .readFileString(joinedHubPath)
      .pipe(Effect.flatMap(decodeJoinedHub));
    return { _tag: "joined", hub: { url: hub.hubUrl, name: hub.name } } as const;
  }).pipe(
    // As `t3 join` and `t3 leave` do: no server starts on it, joining replaces it, leaving
    // forgets it.
    Effect.orElseSucceed((): JoinedHubRead => ({ _tag: "unreadable" })),
  );
  const unreadableMessage = `${joinedHubPath} is unreadable, so this computer's Environment server does not start. Join again to replace it, or Leave to forget it.`;

  const readConnection = Effect.gen(function* () {
    const config = yield* server.currentConfig;
    if (Option.isNone(config)) return null;
    return yield* httpClient.get(new URL(HEALTH_PATH, config.value.httpBaseUrl)).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(HealthBody)),
      Effect.map((body) => describeConnection(body.connection)),
      Effect.timeout(HEALTH_TIMEOUT),
      Effect.orElseSucceed(() => null),
    );
  });

  const state: Effect.Effect<State> = Effect.gen(function* () {
    const settings = yield* appSettings.get;
    const hub = yield* readJoinedHub;
    const snapshot = yield* server.snapshot;
    const failure = yield* Ref.get(startupFailure);
    const pending = yield* Ref.get(joining);
    const process: State["process"] = snapshot.ready
      ? "running"
      : snapshot.desiredRunning
        ? failure === null
          ? "starting"
          : "failed"
        : "stopped";
    return {
      hub: hub._tag === "joined" ? hub.hub : null,
      repair: hub._tag === "unreadable" ? unreadableMessage : null,
      enabled: settings.joinedEnvironmentEnabled,
      keepRunningWhenClosed: settings.joinedEnvironmentKeepRunning,
      process,
      connection: snapshot.ready ? yield* readConnection : null,
      joining: Option.match(pending, {
        onNone: () => null,
        onSome: ({ hubUrl, approvalUrl, approvedBy }) => ({ hubUrl, approvalUrl, approvedBy }),
      }),
      error: (process === "failed" ? failure : null) ?? (yield* Ref.get(lastError)),
      baseDir: launch.baseDir,
    } satisfies State;
  });

  const syncKeepRunning = appSettings.get.pipe(
    Effect.flatMap((settings) =>
      Ref.set(
        desktopState.keepRunningWithoutWindows,
        settings.joinedEnvironmentEnabled && settings.joinedEnvironmentKeepRunning,
      ),
    ),
  );

  const stopServer = server.stop({ timeout: STOP_TIMEOUT });

  const reconcileBody = Effect.gen(function* () {
    const settings = yield* appSettings.get;
    const hub = yield* readJoinedHub;
    yield* syncKeepRunning;
    if (settings.joinedEnvironmentEnabled && hub._tag === "joined") {
      const snapshot = yield* server.snapshot;
      if (!snapshot.desiredRunning) {
        yield* Ref.set(startupFailure, null);
        yield* logInfo("starting the joined Environment server", { baseDir: launch.baseDir });
      }
      yield* server.start;
      return;
    }
    const snapshot = yield* server.snapshot;
    if (snapshot.desiredRunning || Option.isSome(snapshot.activePid)) {
      yield* logInfo("stopping the joined Environment server");
      yield* stopServer;
    }
  });
  const reconcile = mutex
    .withPermits(1)(reconcileBody)
    .pipe(
      Effect.catchCause((cause) =>
        logWarning("joined Environment reconcile failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.withSpan("desktop.joinedEnvironment.reconcile"),
    );

  const saveSettings = (input: { readonly enabled?: boolean; readonly keepRunning?: boolean }) =>
    appSettings
      .setJoinedEnvironment(input)
      .pipe(
        Effect.mapError((cause) => new DesktopJoinedEnvironmentError({ detail: cause.message })),
      );

  const runJoin = Effect.fn("desktop.joinedEnvironment.runJoin")(function* (input: {
    readonly hubUrl: string;
    readonly hubOrigin: string;
    readonly name?: string;
    readonly answers: Queue.Queue<string>;
  }) {
    const name = input.name?.trim() || NodeOS.hostname() || "This computer";
    const result = yield* runCli(
      launch.cli([
        "join",
        input.hubUrl,
        "--base-dir",
        launch.baseDir,
        "--no-browser",
        // Whoever approved it is shown here and accepted (or not) before anything registers.
        "--confirm-on-stdin",
        "--name",
        name.slice(0, 64),
      ]),
      (line) => {
        const approvedBy = readEnvironmentJoinConfirmationPrompt(line.replace(ANSI, ""));
        if (approvedBy !== null) {
          return Ref.update(
            joining,
            Option.map((pending) => ({ ...pending, approvedBy })),
          );
        }
        const approvalUrl = approvalLinkIn(line, input.hubOrigin);
        if (approvalUrl === null) return Effect.void;
        return Ref.modify(joining, (current) => {
          const pending = Option.getOrNull(current);
          // Opened once: the first approval page on the Hub the User named.
          if (pending === null || pending.approvalUrl !== null) return [false, current] as const;
          return [true, Option.some({ ...pending, approvalUrl })] as const;
        }).pipe(
          Effect.flatMap((first) => (first ? shell.openExternal(approvalUrl) : Effect.void)),
          Effect.asVoid,
        );
      },
      Stream.fromQueue(input.answers),
    ).pipe(provideSpawner);
    if (result.exitCode !== 0) {
      yield* Ref.set(lastError, tailOf(result.lines) || `t3 join ended with ${result.exitCode}.`);
      return;
    }
    yield* logInfo("joined the Hub as an Environment", { hubUrl: input.hubUrl });
    yield* appSettings.setJoinedEnvironment({ enabled: true });
    yield* reconcile;
  });

  const join: DesktopJoinedEnvironment["Service"]["join"] = Effect.fn(
    "desktop.joinedEnvironment.join",
  )(function* (input) {
    if (Option.isSome(yield* Ref.get(joining))) {
      return yield* new DesktopJoinedEnvironmentError({
        detail: "Already joining; approve or cancel that first.",
      });
    }
    // An unreadable `joined-hub.json` is joined over, as `t3 join` does.
    if ((yield* readJoinedHub)._tag === "joined") {
      return yield* new DesktopJoinedEnvironmentError({
        detail: "This computer is already an Environment of a Hub. Leave it first.",
      });
    }
    if (!URL.canParse(input.hubUrl)) {
      return yield* new DesktopJoinedEnvironmentError({
        detail: "Enter the Hub's address, like https://hub.example.com.",
      });
    }
    const hubOrigin = new URL(input.hubUrl).origin;
    const answers = yield* Queue.unbounded<string>();
    yield* Ref.set(lastError, null);
    yield* Ref.set(
      joining,
      Option.some({
        hubUrl: input.hubUrl,
        approvalUrl: null,
        approvedBy: null,
        answers,
        fiber: null,
      }),
    );
    const fiber = yield* runJoin({ ...input, hubOrigin, answers }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Ref.set(lastError, "Could not run the join. Try again.").pipe(
              Effect.andThen(logWarning("join failed", { cause: Cause.pretty(cause) })),
            ),
      ),
      Effect.ensuring(Ref.set(joining, Option.none())),
      Effect.forkIn(layerScope),
    );
    // A join that already ended has cleared `joining`; this then leaves it cleared.
    yield* Ref.update(
      joining,
      Option.map((pending) => ({ ...pending, fiber })),
    );
    return yield* state;
  });

  /** The User answers `t3 join`'s question: register this computer as the approver's, or not. */
  const confirmJoin: DesktopJoinedEnvironment["Service"]["confirmJoin"] = Effect.fn(
    "desktop.joinedEnvironment.confirmJoin",
  )(function* (accept) {
    const pending = Option.getOrNull(yield* Ref.get(joining));
    if (pending === null || pending.approvedBy === null) {
      return yield* new DesktopJoinedEnvironmentError({
        detail: "Nobody has approved this computer on the Hub yet.",
      });
    }
    yield* Queue.offer(pending.answers, accept ? "y\n" : "n\n");
    // Asked once: the answer is on its way.
    yield* Ref.update(
      joining,
      Option.map((current) => ({ ...current, approvedBy: null })),
    );
    return yield* state;
  });

  const cancelJoin = Effect.gen(function* () {
    const pending = yield* Ref.get(joining);
    const fiber = Option.getOrNull(pending)?.fiber;
    if (fiber) yield* Fiber.interrupt(fiber);
    yield* Ref.set(joining, Option.none());
    return yield* state;
  });

  const setEnabled = Effect.fn("desktop.joinedEnvironment.setEnabled")(function* (
    enabled: boolean,
  ) {
    const hub: JoinedHubRead["_tag"] = enabled ? (yield* readJoinedHub)._tag : "joined";
    if (hub === "none") {
      return yield* new DesktopJoinedEnvironmentError({
        detail: "Join a Hub first: this computer is not one of its Environments yet.",
      });
    }
    if (hub === "unreadable") {
      return yield* new DesktopJoinedEnvironmentError({ detail: unreadableMessage });
    }
    yield* Ref.set(lastError, null);
    yield* saveSettings({ enabled });
    yield* reconcile;
    return yield* state;
  });

  const setKeepRunning = Effect.fn("desktop.joinedEnvironment.setKeepRunning")(function* (
    keepRunning: boolean,
  ) {
    yield* saveSettings({ keepRunning });
    yield* syncKeepRunning;
    return yield* state;
  });

  /** The server's process is gone: killed by PID if the manager's stop did not end it. */
  const confirmStopped = Effect.gen(function* () {
    const pid = Option.getOrNull((yield* server.snapshot).activePid);
    if (pid === null || !processes.isAlive(pid)) return;
    yield* logWarning("the joined Environment server outlived its stop; killing it", { pid });
    processes.kill(pid);
    for (let check = 0; check < EXIT_CHECKS; check += 1) {
      if (!processes.isAlive(pid)) return;
      yield* Effect.sleep(EXIT_CHECK_INTERVAL);
    }
    return yield* new DesktopJoinedEnvironmentError({
      detail: `This computer's Environment server (process ${pid}) did not stop, so it still holds ${launch.baseDir}. Quit T3 Code, then Leave again.`,
    });
  });

  const leave = Effect.gen(function* () {
    yield* saveSettings({ enabled: false });
    yield* reconcile;
    // `t3 leave` beside a server still running there would orphan it with the state dir.
    yield* confirmStopped;
    yield* Ref.set(lastError, null);
    const result = yield* runCli(launch.cli(["leave", "--base-dir", launch.baseDir])).pipe(
      provideSpawner,
      Effect.mapError(
        (cause) =>
          new DesktopJoinedEnvironmentError({
            detail: `Could not run the leave: ${cause.message}`,
          }),
      ),
    );
    const said = tailOf(result.lines);
    // `t3 leave` forgets the Hub here either way; it says when the Hub did not confirm.
    if (result.exitCode !== 0 || !said.startsWith("Left ")) {
      yield* Ref.set(lastError, said || `t3 leave ended with ${result.exitCode}.`);
    }
    return yield* state;
  }).pipe(Effect.withSpan("desktop.joinedEnvironment.leave"));

  return DesktopJoinedEnvironment.of({
    state,
    join,
    confirmJoin,
    cancelJoin,
    setEnabled,
    setKeepRunning,
    leave,
    reconcile,
    stop: cancelJoin.pipe(Effect.andThen(stopServer), Effect.asVoid),
  });
});

/**
 * The bundled server, run the way the app runs its local backend: the same executable, entry and
 * launcher environment, in desktop mode so it ends when the app is gone. `--base-dir` wins over a
 * `T3CODE_HOME` the app itself may run under, so the two servers never share a T3 home.
 */
export const launchFor = (
  environment: Pick<
    DesktopEnvironment.DesktopEnvironment["Service"],
    "path" | "baseDir" | "isPackaged" | "compileCachePath" | "backendEntryPath" | "backendCwd"
  >,
  bootstrapToken: Effect.Effect<string, PlatformError.PlatformError>,
): JoinedEnvironmentLaunch => {
  const baseDir = environment.path.join(environment.baseDir, JOINED_ENVIRONMENT_DIRECTORY);
  const entryArgs = [
    ...(environment.isPackaged ? ["--require", environment.compileCachePath] : []),
    environment.backendEntryPath,
  ];
  const env = { ...DesktopBackendConfiguration.backendChildEnvPatch(), ELECTRON_RUN_AS_NODE: "1" };
  return {
    baseDir,
    cli: (args) =>
      ChildProcess.make(process.execPath, [...entryArgs, ...args], {
        cwd: environment.backendCwd,
        env,
        extendEnv: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    serveConfig: (port) =>
      bootstrapToken.pipe(
        Effect.map((desktopBootstrapToken): DesktopBackendManager.DesktopBackendStartConfig => ({
          executablePath: process.execPath,
          args: [...entryArgs, "--bootstrap-fd", "3", "--base-dir", baseDir],
          entryPath: environment.backendEntryPath,
          cwd: environment.backendCwd,
          env,
          extendEnv: true,
          bootstrap: {
            mode: "desktop",
            noBrowser: true,
            port,
            t3Home: baseDir,
            host: "127.0.0.1",
            desktopBootstrapToken,
            tailscaleServeEnabled: false,
            tailscaleServePort: 443,
          },
          bootstrapDelivery: "fd3",
          httpBaseUrl: new URL(`http://127.0.0.1:${port}`),
          captureOutput: true,
          preflightFailure: Option.none(),
          readinessPath: HEALTH_PATH,
        })),
      ),
  };
};

export const layer = Layer.effect(
  DesktopJoinedEnvironment,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    return yield* make(launchFor(environment, configuration.currentBootstrapToken));
  }),
);

export type DesktopJoinedEnvironmentRequirements =
  | BackendInstanceFactoryRequirements
  | Path.Path
  | NetService.NetService
  | ElectronShell.ElectronShell
  | DesktopAppSettings.DesktopAppSettings
  | DesktopState.DesktopState
  | Scope.Scope;
