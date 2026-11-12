// @effect-diagnostics nodeBuiltinImport:off -- runs CLIProxyAPI as a child process with its own folders, checked without following links.
/**
 * The Hub's AI gateway: CLIProxyAPI installed, verified, run on loopback with `-config` alone and a
 * clean environment, restarted and stopped with the Hub; its config and credentials in memory
 * when possible, its keys only in the encrypted store (docs/internals/ai-gateway.md).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import {
  AiGatewayError,
  type AiGatewayState,
  type AiGatewayStatus,
  type AiGatewayUpdateCheck,
  HUB_MACHINE_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as AuditLog from "../audit/AuditLog.ts";
import * as ServerConfig from "../config.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { CLIPROXY_HOST, renderCliproxyConfig } from "./cliproxyConfig.ts";
import {
  CliproxyRefusedError,
  type InstalledCliproxy,
  installCliproxy,
  ownedFolder,
  verifiedBinary,
} from "./cliproxyInstall.ts";
import {
  type CliproxyEndpoint,
  type CliproxyManagement,
  makeCliproxyManagement,
} from "./CliproxyManagement.ts";
import {
  type CliproxyPlatform,
  cliproxyPlatformOf,
  compareVersions,
  PINNED_CLIPROXY_RELEASE,
  type PinnedCliproxyRelease,
} from "./cliproxyRelease.ts";
import { CliproxyReleases, layer as CliproxyReleasesLayer } from "./CliproxyReleases.ts";

export class AiGateway extends Context.Service<
  AiGateway,
  {
    readonly status: Effect.Effect<AiGatewayStatus>;
    /** The status now, then each change. */
    readonly changes: Stream.Stream<AiGatewayStatus>;
    /** Asks GitHub for the newest release: only when the Owner opens the section or asks. */
    readonly checkForUpdates: Effect.Effect<AiGatewayUpdateCheck, AiGatewayError>;
    /** Installs and verifies `version`, starts it beside the running one, and switches once it answers. */
    readonly update: (version: string) => Effect.Effect<AiGatewayStatus, AiGatewayError>;
    /** Back to the release before the last update, the same way. */
    readonly rollback: Effect.Effect<AiGatewayStatus, AiGatewayError>;
    /** Where the running CLIProxyAPI answers and the Hub's keys for it; none while it does not. */
    readonly endpoint: Effect.Effect<Option.Option<CliproxyEndpoint>>;
  }
>()("t3/ai/AiGateway") {}

const MANAGEMENT_KEY_SECRET = "ai-gateway-management-key";
const CLIENT_KEY_SECRET = "ai-gateway-client-key";
const RELEASES_SECRET = "ai-gateway-releases";
/** Names one start of CLIProxyAPI, so a Hub that restarts recognizes its leftover. */
const START_TOKEN_VARIABLE = "T3CODE_AI_GATEWAY_START_TOKEN";
const STOP_GRACE_MS = 5_000;
const MAX_LOG_LINE = 400;

/** The installed releases: the one in use and the one «Roll back» returns to. */
const ReleaseRecord = Schema.Struct({ version: Schema.String, binarySha256: Schema.String });
const ReleasesRecord = Schema.Struct({
  active: Schema.NullOr(ReleaseRecord),
  previous: Schema.NullOr(ReleaseRecord),
});
type ReleasesRecord = typeof ReleasesRecord.Type;
const ReleasesJson = Schema.fromJsonString(ReleasesRecord);
const decodeReleases = Schema.decodeUnknownOption(ReleasesJson);
const encodeReleases = Schema.encodeSync(ReleasesJson);

const PidRecordJson = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Number, startToken: Schema.String }),
);
const decodePidRecord = Schema.decodeUnknownOption(PidRecordJson);
const encodePidRecord = Schema.encodeSync(PidRecordJson);

export interface AiGatewayOptions {
  /** `off`: this Hub runs no gateway. */
  readonly mode: "managed" | "off";
  /** The Hub's operating system. */
  readonly os: NodeJS.Platform;
  readonly stateDir: string;
  /** Undefined: no release for this platform. */
  readonly platform: CliproxyPlatform | undefined;
  readonly pinned: PinnedCliproxyRelease;
  /** Config, `auth-dir` and CLIProxyAPI's own state; `inMemory` false when on the disk. */
  readonly runtimeFolder: { readonly directory: string; readonly inMemory: boolean };
  readonly restartDelay?: { readonly initialMs: number; readonly maxMs: number };
  /** How long a start may take before its management API answers. */
  readonly startTimeoutMs?: number;
  /** A run longer than this resets the restart delay. */
  readonly stableAfterMs?: number;
}

/** A running CLIProxyAPI: closing its scope stops it. */
interface Running {
  readonly installed: InstalledCliproxy;
  readonly endpoint: CliproxyEndpoint;
  readonly pid: number | null;
  readonly startedAt: DateTime.Utc;
  readonly exited: Effect.Effect<number | null>;
  readonly scope: Scope.Closeable;
}

class StartFailure extends Schema.TaggedError<StartFailure>()("StartFailure", {
  message: Schema.String,
  /** False for what trying again would not fix: a binary that is not the one verified. */
  retry: Schema.Boolean,
}) {}

/** A refused release is not tried again; anything else (GitHub down, a crash) is, after a pause. */
const startFailure = (error: AiGatewayError | CliproxyRefusedError) =>
  new StartFailure({ message: error.message, retry: error._tag !== "CliproxyRefusedError" });

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const freeLoopbackPort = Effect.callback<number, AiGatewayError>((resume) => {
  const server = NodeNet.createServer();
  server.once("error", () =>
    resume(Effect.fail(new AiGatewayError({ message: "No free loopback port." }))),
  );
  server.listen(0, CLIPROXY_HOST, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});

/** On Linux the child gets SIGKILL when the Hub's process ends, however it ends. */
const parentDeathLauncherOn = (os: NodeJS.Platform) => {
  if (os !== "linux") return undefined;
  for (const candidate of ["/usr/bin/setpriv", "/bin/setpriv"]) {
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return undefined;
};

/** One line of CLIProxyAPI's output, safe for the Hub's logs. */
const filterGatewayLine = (line: string, secrets: ReadonlyArray<string>) => {
  let safe = line;
  for (const secret of secrets) {
    if (secret.length > 0) safe = safe.split(secret).join("[redacted]");
  }
  safe = safe.replace(/(bearer\s+|key["'=:\s]+)[A-Za-z0-9._~+/=-]{12,}/giu, "$1[redacted]");
  return safe.length > MAX_LOG_LINE ? `${safe.slice(0, MAX_LOG_LINE)}…` : safe;
};

export const make = Effect.fn("AiGateway.make")(function* (options: AiGatewayOptions) {
  const store = yield* ServerSecretStore;
  const releases = yield* CliproxyReleases;
  const audit = yield* AuditLog.AuditLog;
  const management: CliproxyManagement = yield* makeCliproxyManagement;
  const layerScope = yield* Scope.Scope;
  const parentDeathLauncher = parentDeathLauncherOn(options.os);
  const actions = yield* Semaphore.make(1);
  const restartDelay = options.restartDelay ?? { initialMs: 1_000, maxMs: 60_000 };
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  const stableAfterMs = options.stableAfterMs ?? 300_000;

  const root = NodePath.join(options.stateDir, "ai-gateway");
  const binRoot = NodePath.join(root, "bin");
  const runDir = options.runtimeFolder.directory;
  const authDir = NodePath.join(runDir, "auth");

  let state: AiGatewayState =
    options.mode === "off" ? "off" : options.platform === undefined ? "unsupported" : "starting";
  let lastError: string | null =
    state === "unsupported" ? `No CLIProxyAPI release for ${options.os}.` : null;
  let restarts = 0;
  let current: Running | undefined;
  let activeVersion: string | null = null;
  let previousVersion: string | null = null;
  let supervisor: Fiber.Fiber<void> | undefined;

  const statusNow = (): AiGatewayStatus => ({
    state,
    version: current?.installed.version ?? activeVersion,
    pinnedVersion: options.pinned.version,
    previousVersion,
    startedAt:
      state === "running" && current !== undefined ? DateTime.formatIso(current.startedAt) : null,
    restarts,
    lastError,
    credentialsInMemory: options.runtimeFolder.inMemory,
  });
  const statusRef = yield* SubscriptionRef.make(statusNow());
  /** After every change of the fields above. */
  const publish = Effect.suspend(() => SubscriptionRef.set(statusRef, statusNow()));

  const keyOf = (name: string) =>
    store.getOrCreateRandom(name, 32).pipe(
      Effect.map((bytes) => Redacted.make(Buffer.from(bytes).toString("base64url"))),
      Effect.mapError(
        () => new AiGatewayError({ message: "The Hub's encrypted store could not be read." }),
      ),
    );

  const readReleases = store.get(RELEASES_SECRET).pipe(
    Effect.map((bytes) =>
      Option.flatMap(bytes, (value) => decodeReleases(Buffer.from(value).toString("utf8"))),
    ),
    Effect.map(Option.getOrElse((): ReleasesRecord => ({ active: null, previous: null }))),
    Effect.mapError(
      () => new AiGatewayError({ message: "The Hub's encrypted store could not be read." }),
    ),
  );
  const writeReleases = (record: ReleasesRecord) =>
    store.set(RELEASES_SECRET, new TextEncoder().encode(encodeReleases(record))).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          activeVersion = record.active?.version ?? null;
          previousVersion = record.previous?.version ?? null;
        }),
      ),
      Effect.andThen(publish),
      Effect.mapError(
        () => new AiGatewayError({ message: "The Hub's encrypted store could not be written." }),
      ),
    );

  const install = Effect.fn("AiGateway.install")(function* (version: string) {
    if (options.platform === undefined) {
      return yield* new AiGatewayError({ message: lastError ?? "Unsupported platform." });
    }
    return yield* installCliproxy({
      releases,
      binRoot,
      version,
      platform: options.platform,
      pinnedSha256:
        version === options.pinned.version ? options.pinned.sha256[options.platform] : undefined,
    });
  });

  /** The binary of `installed`, installed again only when it is gone from the disk. */
  const binaryOf = Effect.fn("AiGateway.binaryOf")(function* (installed: InstalledCliproxy) {
    const path = NodePath.join(binRoot, installed.version, "cli-proxy-api");
    if (!NodeFS.existsSync(path)) {
      const again = yield* install(installed.version);
      if (again.binarySha256 !== installed.binarySha256) {
        return yield* new AiGatewayError({
          message: `CLIProxyAPI ${installed.version} downloaded again is not the one installed before; not started.`,
        });
      }
    }
    return yield* verifiedBinary(binRoot, installed);
  });

  /**
   * CLIProxyAPI left by a Hub that was killed (where no parent-death signal stopped it): stopped,
   * by its verified PID, before another starts; its config, which holds keys, removed.
   */
  const stopLeftovers = Effect.sync(() => {
    let names: ReadonlyArray<string> = [];
    try {
      names = NodeFS.readdirSync(root).filter((name) => /^run-[0-9a-f]{12}\.pid$/u.test(name));
    } catch {
      return;
    }
    for (const name of names) {
      const pidPath = NodePath.join(root, name);
      let text = "";
      try {
        text = NodeFS.readFileSync(pidPath, "utf8");
      } catch {
        continue;
      }
      const record = decodePidRecord(text);
      if (Option.isSome(record) && options.os === "linux" && isAlive(record.value.pid)) {
        let environment = "";
        try {
          environment = NodeFS.readFileSync(`/proc/${record.value.pid}/environ`, "utf8");
        } catch {
          // Not ours to read: not ours to stop.
        }
        if (
          environment.split("\0").includes(`${START_TOKEN_VARIABLE}=${record.value.startToken}`)
        ) {
          process.kill(record.value.pid, "SIGKILL");
        }
      }
      NodeFS.rmSync(pidPath, { force: true });
      NodeFS.rmSync(NodePath.join(runDir, `config-${name.slice(4, 16)}.yaml`), { force: true });
    }
  });

  const prepareRunDir = Effect.try({
    try: () => {
      ownedFolder(root);
      ownedFolder(runDir);
      ownedFolder(authDir);
    },
    catch: (cause) =>
      new AiGatewayError({
        message: `The gateway's folders could not be prepared: ${String((cause as Error).message)}`,
      }),
  });

  /** Starts `installed` on a free port with a fresh config, and waits for its management API. */
  const launch = Effect.fn("AiGateway.launch")(function* (installed: InstalledCliproxy) {
    const scope = yield* Scope.make();
    return yield* launchIn(installed, scope).pipe(
      // Failed or interrupted (an update that stops the supervisor mid-start): nothing stays up.
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
  });

  const launchIn = Effect.fn("AiGateway.launchIn")(function* (
    installed: InstalledCliproxy,
    scope: Scope.Closeable,
  ) {
    const binary = yield* binaryOf(installed).pipe(Effect.mapError(startFailure));
    yield* prepareRunDir.pipe(
      Effect.mapError((error) => new StartFailure({ message: error.message, retry: true })),
    );
    const managementKey = yield* keyOf(MANAGEMENT_KEY_SECRET).pipe(
      Effect.mapError((error) => new StartFailure({ message: error.message, retry: true })),
    );
    const clientKey = yield* keyOf(CLIENT_KEY_SECRET).pipe(
      Effect.mapError((error) => new StartFailure({ message: error.message, retry: true })),
    );
    const port = yield* freeLoopbackPort.pipe(
      Effect.mapError((error) => new StartFailure({ message: error.message, retry: true })),
    );
    const startToken = NodeCrypto.randomBytes(16).toString("hex");
    // One config and one PID file per start: a release starting beside the running one (an
    // update) never rewrites the file the running one watches.
    const configPath = NodePath.join(runDir, `config-${startToken.slice(0, 12)}.yaml`);
    const pidPath = NodePath.join(root, `run-${startToken.slice(0, 12)}.pid`);
    const secrets = [Redacted.value(managementKey), Redacted.value(clientKey)];
    const endpoint: CliproxyEndpoint = {
      baseUrl: `http://${CLIPROXY_HOST}:${port}`,
      managementKey,
      clientKey,
    };

    const lines = yield* Queue.unbounded<string>();
    yield* Queue.take(lines).pipe(
      Effect.flatMap((line) =>
        Effect.logInfo(`CLIProxyAPI: ${line}`).pipe(
          Effect.annotateLogs({ aiGateway: installed.version }),
        ),
      ),
      Effect.forever,
      Effect.forkIn(scope),
    );
    const started = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          NodeFS.writeFileSync(
            configPath,
            renderCliproxyConfig({
              port,
              managementKey: secrets[0]!,
              clientKey: secrets[1]!,
              authDir,
            }),
            { mode: 0o600 },
          );
          NodeFS.chmodSync(configPath, 0o600);
          const command = parentDeathLauncher ?? binary;
          const args = [
            ...(parentDeathLauncher === undefined ? [] : ["--pdeathsig", "KILL", "--", binary]),
            "-config",
            configPath,
          ];
          const child = NodeChildProcess.spawn(command, args, {
            cwd: runDir,
            // Nothing of the Hub's environment: none of its secrets reach CLIProxyAPI.
            env: { PATH: "/usr/bin:/bin", HOME: runDir, [START_TOKEN_VARIABLE]: startToken },
            stdio: ["ignore", "pipe", "pipe"],
          });
          const exited = new Promise<number | null>((resolve) => {
            child.once("exit", (code) => resolve(code));
            child.once("error", () => resolve(null));
          });
          for (const stream of [child.stdout, child.stderr]) {
            if (stream === null) continue;
            NodeReadline.createInterface({ input: stream }).on("line", (line) => {
              if (line.trim().length > 0)
                Queue.offerUnsafe(lines, filterGatewayLine(line, secrets));
            });
          }
          if (child.pid !== undefined) {
            NodeFS.writeFileSync(pidPath, encodePidRecord({ pid: child.pid, startToken }), {
              mode: 0o600,
            });
          }
          return { child, exited };
        },
        catch: (cause) =>
          new StartFailure({
            message: `CLIProxyAPI could not be started: ${String((cause as Error).message)}`,
            retry: true,
          }),
      }),
      ({ child, exited }) =>
        Effect.gen(function* () {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            const ended = yield* Effect.promise(() => exited).pipe(
              Effect.timeoutOption(STOP_GRACE_MS),
            );
            if (Option.isNone(ended)) {
              child.kill("SIGKILL");
              yield* Effect.promise(() => exited);
            }
          }
          yield* Effect.sync(() => {
            NodeFS.rmSync(pidPath, { force: true });
            NodeFS.rmSync(configPath, { force: true });
          });
        }),
    ).pipe(Scope.provide(scope));

    // Healthy once the management API answers with the Hub's key; a start that exits or never
    // answers is stopped and reported.
    const deadline = (yield* Clock.currentTimeMillis) + startTimeoutMs;
    while (true) {
      const answer = yield* management.health(endpoint);
      if (answer.status === 200) break;
      if (started.child.exitCode !== null || started.child.signalCode !== null) {
        return yield* new StartFailure({
          message: `CLIProxyAPI ${installed.version} exited while starting (code ${String(started.child.exitCode ?? started.child.signalCode)}).`,
          retry: true,
        });
      }
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* new StartFailure({
          message: `CLIProxyAPI ${installed.version} did not answer within ${Math.round(startTimeoutMs / 1000)} s${answer.status === null ? "" : ` (HTTP ${answer.status})`}.`,
          retry: true,
        });
      }
      yield* Effect.sleep(Duration.millis(150));
    }
    return {
      installed,
      endpoint,
      pid: started.child.pid ?? null,
      startedAt: yield* DateTime.now,
      exited: Effect.promise(() => started.exited),
      scope,
    } satisfies Running;
  });

  /** The release to run at start: the pinned one on first start, or when the code pins a newer one. */
  const activeRelease = Effect.gen(function* () {
    const record = yield* readReleases;
    activeVersion = record.active?.version ?? null;
    previousVersion = record.previous?.version ?? null;
    if (
      record.active !== null &&
      compareVersions(record.active.version, options.pinned.version) >= 0
    ) {
      return record.active;
    }
    state = "installing";
    yield* publish;
    const installed = yield* install(options.pinned.version);
    yield* writeReleases({ active: installed, previous: record.active ?? record.previous });
    return installed;
  });

  /** Keeps CLIProxyAPI running: restarts it with a growing pause each time it stops. */
  const supervise = Effect.fn("AiGateway.supervise")(
    function* (adopted: Running | undefined) {
      let next = adopted;
      let delay = restartDelay.initialMs;
      while (true) {
        if (next === undefined) {
          state = state === "restarting" ? "restarting" : "starting";
          yield* publish;
          const started = yield* activeRelease.pipe(
            Effect.mapError(startFailure),
            Effect.flatMap((installed) => launch(installed)),
            Effect.result,
          );
          if (started._tag === "Failure") {
            lastError = started.failure.message;
            yield* Effect.logWarning("The AI gateway did not start", { reason: lastError });
            if (!started.failure.retry) {
              state = "failed";
              yield* publish;
              return;
            }
            state = "restarting";
            yield* publish;
            yield* Effect.sleep(Duration.millis(delay));
            delay = Math.min(delay * 2, restartDelay.maxMs);
            continue;
          }
          next = started.success;
        }
        current = next;
        state = "running";
        lastError = null;
        yield* publish;
        yield* Effect.logInfo("The AI gateway is running", {
          version: next.installed.version,
          pid: next.pid,
        });
        const code = yield* next.exited;
        yield* Scope.close(next.scope, Exit.void);
        const ranMs = (yield* Clock.currentTimeMillis) - DateTime.toEpochMillis(next.startedAt);
        if (ranMs > stableAfterMs) delay = restartDelay.initialMs;
        current = undefined;
        next = undefined;
        restarts += 1;
        state = "restarting";
        lastError = `CLIProxyAPI stopped (code ${String(code)}); starting it again.`;
        yield* publish;
        yield* Effect.logWarning("The AI gateway stopped; starting it again", {
          code,
          inMs: delay,
        });
        yield* Effect.sleep(Duration.millis(delay));
        delay = Math.min(delay * 2, restartDelay.maxMs);
      }
    },
    Effect.ensuring(
      Effect.suspend(() => {
        const running = current;
        current = undefined;
        return running === undefined ? Effect.void : Scope.close(running.scope, Exit.void);
      }),
    ),
  );

  const startSupervisor = Effect.fn("AiGateway.startSupervisor")(function* (
    adopted: Running | undefined,
  ) {
    supervisor = yield* supervise(adopted).pipe(Effect.forkIn(layerScope));
  });

  const stopSupervisor = Effect.suspend(() => {
    const fiber = supervisor;
    supervisor = undefined;
    return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
  });

  const target = {
    kind: "environment",
    id: HUB_MACHINE_ENVIRONMENT_ID,
    name: "AI gateway",
  } as const;

  /**
   * Starts `next` beside the running release, checks its management API and its model list,
   * then stops the old one and keeps `next`. A failure leaves the old one running.
   */
  const switchTo = (
    action: "ai_gateway.update" | "ai_gateway.rollback",
    next: Effect.Effect<InstalledCliproxy, AiGatewayError | CliproxyRefusedError>,
    record: (installed: InstalledCliproxy, before: ReleasesRecord) => ReleasesRecord,
  ) =>
    actions.withPermits(1)(
      Effect.gen(function* () {
        if (options.mode === "off" || options.platform === undefined) {
          return yield* new AiGatewayError({ message: "This Hub runs no AI gateway." });
        }
        const actor = yield* AuditLog.currentActor;
        const before = yield* readReleases;
        const from = current?.installed.version ?? before.active?.version ?? null;
        const outcome = yield* Effect.gen(function* () {
          const installed = yield* next.pipe(
            Effect.mapError((error) => new AiGatewayError({ message: error.message })),
          );
          const candidate = yield* launch(installed).pipe(
            Effect.mapError((failure) => new AiGatewayError({ message: failure.message })),
          );
          yield* Effect.gen(function* () {
            const models = yield* management.models(candidate.endpoint);
            if (models.status !== 200) {
              return yield* new AiGatewayError({
                message: `CLIProxyAPI ${installed.version} started but did not list its models${models.status === null ? "" : ` (HTTP ${models.status})`}; kept ${from ?? "the current release"}.`,
              });
            }
            yield* stopSupervisor;
            yield* writeReleases(record(installed, before));
            restarts = 0;
            current = candidate;
            state = "running";
            lastError = null;
            yield* publish;
            yield* startSupervisor(candidate);
          }).pipe(
            // Not adopted (a failed check, or the Hub stopping meanwhile): stopped here.
            Effect.onError(() =>
              current === candidate ? Effect.void : Scope.close(candidate.scope, Exit.void),
            ),
          );
          return installed;
        }).pipe(Effect.result);
        yield* audit
          .record({
            actor,
            action,
            target,
            detail:
              outcome._tag === "Success"
                ? { from, version: outcome.success.version, outcome: "updated" }
                : { from, outcome: "failed", reason: outcome.failure.message.slice(0, 200) },
          })
          .pipe(Effect.ignore({ log: true }));
        if (outcome._tag === "Failure") return yield* outcome.failure;
        return statusNow();
      }),
    );

  // With the Hub: the supervisor, then whatever runs, even if the supervisor never got to start.
  yield* Effect.addFinalizer(() =>
    stopSupervisor.pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const running = current;
          current = undefined;
          return running === undefined ? Effect.void : Scope.close(running.scope, Exit.void);
        }),
      ),
    ),
  );

  if (state === "starting") {
    yield* stopLeftovers;
    yield* startSupervisor(undefined);
  }

  return AiGateway.of({
    status: Effect.sync(statusNow),
    changes: SubscriptionRef.changes(statusRef),
    checkForUpdates: Effect.gen(function* () {
      if (options.mode === "off" || options.platform === undefined) {
        return yield* new AiGatewayError({ message: "This Hub runs no AI gateway." });
      }
      const latestVersion = yield* releases.latestVersion;
      const currentVersion = current?.installed.version ?? activeVersion;
      return {
        currentVersion,
        latestVersion,
        updateAvailable:
          currentVersion === null || compareVersions(latestVersion, currentVersion) > 0,
      };
    }).pipe(Effect.withSpan("AiGateway.checkForUpdates")),
    update: Effect.fn("AiGateway.update")(function* (version: string) {
      return yield* switchTo("ai_gateway.update", install(version), (installed, before) => ({
        active: installed,
        previous:
          before.active !== null && before.active.version !== installed.version
            ? before.active
            : before.previous,
      }));
    }),
    rollback: Effect.suspend(() =>
      switchTo(
        "ai_gateway.rollback",
        readReleases.pipe(
          Effect.flatMap((record) =>
            record.previous === null
              ? Effect.fail(
                  new AiGatewayError({ message: "There is no earlier release to roll back to." }),
                )
              : Effect.succeed(record.previous),
          ),
        ),
        (installed, before) => ({ active: installed, previous: before.active }),
      ),
    ).pipe(Effect.withSpan("AiGateway.rollback")),
    endpoint: Effect.sync(() =>
      state === "running" && current !== undefined ? Option.some(current.endpoint) : Option.none(),
    ),
  });
});

/**
 * A folder of this user in memory for the gateway's config and credentials, one per state
 * directory (`$XDG_RUNTIME_DIR`, else `/dev/shm`); else `<stateDir>/ai-gateway/run` on the disk.
 * `T3CODE_SHM_DIR` stands in for /dev/shm in tests and live passes only.
 */
const runtimeFolderFor = (
  stateDir: string,
  os: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
) => {
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
  for (const base of [environment.XDG_RUNTIME_DIR, environment.T3CODE_SHM_DIR ?? "/dev/shm"]) {
    if (base === undefined || !NodePath.isAbsolute(base) || os === "win32") continue;
    try {
      if (!NodeFS.statSync(base).isDirectory()) continue;
      const directory = NodePath.join(base, `t3code-ai-gateway-${hash}`);
      ownedFolder(directory);
      return { directory, inMemory: true };
    } catch {
      // Not usable (someone else's, a link): the next one.
    }
  }
  return { directory: NodePath.join(stateDir, "ai-gateway", "run"), inMemory: false };
};

/**
 * The Hub's gateway. `T3CODE_AI_GATEWAY`: `managed` runs it, `off` does not; unset, a production
 * Hub runs it and a dev Hub does not (so a dev Hub downloads nothing unless asked).
 */
export const layerFromConfig = Layer.effect(
  AiGateway,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const os = yield* HostProcess.Platform;
    const setting = yield* Config.String("T3CODE_AI_GATEWAY").pipe(
      Config.option,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const mode = Option.match(setting, {
      onNone: () => (config.devUrl === undefined ? "managed" : "off"),
      onSome: (value) => (value === "managed" ? "managed" : "off"),
    }) satisfies AiGatewayOptions["mode"];
    return yield* make({
      mode,
      stateDir: config.stateDir,
      os,
      platform: cliproxyPlatformOf(os, yield* HostProcess.Architecture),
      pinned: PINNED_CLIPROXY_RELEASE,
      runtimeFolder: runtimeFolderFor(config.stateDir, os, yield* HostProcess.Environment),
    });
  }),
).pipe(Layer.provide(CliproxyReleasesLayer));
