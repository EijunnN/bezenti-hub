// @effect-diagnostics nodeBuiltinImport:off -- runs CLIProxyAPI as a child process with its own folders, checked without following links.
/**
 * The Hub's AI gateway: a pinned CLIProxyAPI release, verified, run on loopback with a clean
 * environment, checked to listen only there before any key is sent, restarted and stopped with
 * the Hub. Only on a Hub, never on a joined machine (docs/internals/ai-gateway.md).
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
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
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
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  identityOf,
  listeningAddressesOf,
  onlyLoopback,
  startTimeOf,
} from "./childProcessFacts.ts";
import { CLIPROXY_HOST, renderCliproxyConfig } from "./cliproxyConfig.ts";
import {
  binaryPathOf,
  CliproxyRefusedError,
  type InstalledCliproxy,
  installCliproxy,
  ownedFolder,
  pruneInstalled,
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
  PINNED_CLIPROXY_RELEASES,
  type PinnedCliproxyRelease,
} from "./cliproxyRelease.ts";
import { CliproxyReleases } from "./CliproxyReleases.ts";
import { filterGatewayLine } from "./gatewayLogFilter.ts";

export class AiGateway extends Context.Service<
  AiGateway,
  {
    readonly status: Effect.Effect<AiGatewayStatus>;
    /** The status now, then each change: what `aiGateway.status` streams to the Owner. */
    readonly changes: Stream.Stream<AiGatewayStatus>;
    /** The newest pinned release against the one in use; nothing is asked of GitHub. */
    readonly checkForUpdates: Effect.Effect<AiGatewayUpdateCheck, AiGatewayError>;
    /** Moves to a pinned `version`: started beside the running one, switched once it answers. */
    readonly update: (version: string) => Effect.Effect<AiGatewayStatus, AiGatewayError>;
    /** Back to the pinned release before the last switch, the same way. */
    readonly rollback: Effect.Effect<AiGatewayStatus, AiGatewayError>;
    /** Where the Owner decides: run it on this machine or not. */
    readonly setEnabled: (enabled: boolean) => Effect.Effect<AiGatewayStatus, AiGatewayError>;
    /** Where the running CLIProxyAPI answers and the Hub's keys for it; none while it does not. */
    readonly endpoint: Effect.Effect<Option.Option<CliproxyEndpoint>>;
  }
>()("t3/ai/AiGateway") {}

const MANAGEMENT_KEY_SECRET = "ai-gateway-management-key";
const RELEASES_SECRET = "ai-gateway-releases";
/** Names one start of CLIProxyAPI, so a Hub that restarts recognizes its leftover. */
const START_TOKEN_VARIABLE = "T3CODE_AI_GATEWAY_START_TOKEN";
const STOP_GRACE_MS = 5_000;

/**
 * The installed releases (the one in use and the one «Roll back» returns to), whether the Owner
 * chose the one in use (then a Hub upgrade does not move past it), and the Owner's on/off.
 */
const ReleaseRecord = Schema.Struct({ version: Schema.String, binarySha256: Schema.String });
const ReleasesRecord = Schema.Struct({
  active: Schema.NullOr(ReleaseRecord),
  previous: Schema.NullOr(ReleaseRecord),
  chosenByOwner: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
type ReleasesRecord = typeof ReleasesRecord.Type;
const ReleasesJson = Schema.fromJsonString(ReleasesRecord);
const decodeReleases = Schema.decodeUnknownOption(ReleasesJson);
const encodeReleases = Schema.encodeSync(ReleasesJson);

const PidRecordJson = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Number,
    startToken: Schema.String,
    startTime: Schema.String,
    executable: Schema.String,
  }),
);
const decodePidRecord = Schema.decodeUnknownOption(PidRecordJson);
const encodePidRecord = Schema.encodeSync(PidRecordJson);

/**
 * Whether this server may run the gateway. `never`: a joined machine (a Sandbox's server
 * included), which never runs or downloads it. `forced`: `T3CODE_AI_GATEWAY` decides. `owner`:
 * the Owner turns it on or off in Settings; `defaultEnabled` until they do.
 */
export type AiGatewayPlacement =
  | { readonly _tag: "never"; readonly reason: string }
  | { readonly _tag: "forced"; readonly enabled: boolean }
  | { readonly _tag: "owner"; readonly defaultEnabled: boolean };

/** The one rule: a Hub runs it; the desktop app and a dev Hub only once the Owner turns it on. */
export const aiGatewayPlacement = (server: {
  readonly joined: boolean;
  readonly desktop: boolean;
  readonly dev: boolean;
  /** `T3CODE_AI_GATEWAY`. */
  readonly setting: string | undefined;
}): AiGatewayPlacement => {
  if (server.joined) {
    return { _tag: "never", reason: "A machine joined to a Hub runs no AI gateway; its Hub does." };
  }
  if (server.setting === "managed") return { _tag: "forced", enabled: true };
  if (server.setting === "off") return { _tag: "forced", enabled: false };
  return { _tag: "owner", defaultEnabled: !server.desktop && !server.dev };
};

export interface AiGatewayOptions {
  readonly placement: AiGatewayPlacement;
  /** The Hub's operating system. */
  readonly os: NodeJS.Platform;
  readonly stateDir: string;
  /** Undefined: no release for this platform. */
  readonly platform: CliproxyPlatform | undefined;
  /** Oldest first; the last is the default. */
  readonly pinned: ReadonlyArray<PinnedCliproxyRelease>;
  /** Config, `auth-dir` and CLIProxyAPI's own state; `inMemory` false when on the disk. */
  readonly runtimeFolder: { readonly directory: string; readonly inMemory: boolean };
  readonly restartDelay?: { readonly initialMs: number; readonly maxMs: number };
  /** How long a start may take before it listens and its management API answers. */
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

const retryable = (error: AiGatewayError) =>
  new StartFailure({ message: error.message, retry: true });

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

/** Signals the child's whole process group (it leads one), then the child itself. */
const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
    } catch {
      // Already gone (ESRCH) or not ours (EPERM): nothing to stop.
    }
  }
};

export const make = Effect.fn("AiGateway.make")(function* (options: AiGatewayOptions) {
  const store = yield* ServerSecretStore;
  const releases = yield* CliproxyReleases;
  const audit = yield* AuditLog.AuditLog;
  const management: CliproxyManagement = yield* makeCliproxyManagement;
  const layerScope = yield* Scope.Scope;
  const parentDeathLauncher = parentDeathLauncherOn(options.os);
  /** One at a time: the record's read-modify-write, a switch, turning it on or off. */
  const lock = yield* Semaphore.make(1);
  const restartDelay = options.restartDelay ?? { initialMs: 1_000, maxMs: 60_000 };
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  const stableAfterMs = options.stableAfterMs ?? 300_000;
  const newest = options.pinned.at(-1);
  const pinnedNamed = (version: string) =>
    options.pinned.find((release) => release.version === version);

  const root = NodePath.join(options.stateDir, "ai-gateway");
  const binRoot = NodePath.join(root, "bin");
  const runDir = options.runtimeFolder.directory;
  const authDir = NodePath.join(runDir, "auth");
  const placement = options.placement;
  const switchable = placement._tag === "owner" && options.platform !== undefined;

  let state: AiGatewayState = "off";
  let lastError: string | null = null;
  let restarts = 0;
  let current: Running | undefined;
  let activeVersion: string | null = null;
  let previousVersion: string | null = null;
  let supervisor: Fiber.Fiber<void> | undefined;

  const statusNow = (): AiGatewayStatus => ({
    state,
    version: current?.installed.version ?? activeVersion,
    pinnedVersion: newest?.version ?? "",
    previousVersion,
    startedAt:
      state === "running" && current !== undefined ? DateTime.formatIso(current.startedAt) : null,
    restarts,
    lastError,
    credentialsInMemory: options.runtimeFolder.inMemory,
    pinnedVersions: options.pinned.map((release) => release.version),
    switchable,
  });
  const statusRef = yield* SubscriptionRef.make(statusNow());
  /** After every change of the fields above. */
  const publish = Effect.suspend(() => SubscriptionRef.set(statusRef, statusNow()));

  const storeError = (what: string) => () =>
    new AiGatewayError({ message: `The Hub's encrypted store could not be ${what}.` });

  const readReleases = store.get(RELEASES_SECRET).pipe(
    Effect.map((bytes) =>
      Option.flatMap(bytes, (value) => decodeReleases(Buffer.from(value).toString("utf8"))),
    ),
    Effect.map(Option.getOrElse((): ReleasesRecord => ({ active: null, previous: null }))),
    Effect.tap((record) =>
      Effect.sync(() => {
        activeVersion = record.active?.version ?? null;
        previousVersion = record.previous?.version ?? null;
      }),
    ),
    Effect.mapError(storeError("read")),
  );
  const writeReleases = (record: ReleasesRecord) =>
    store.set(RELEASES_SECRET, new TextEncoder().encode(encodeReleases(record))).pipe(
      Effect.mapError(storeError("written")),
      Effect.tap(() =>
        Effect.sync(() => {
          activeVersion = record.active?.version ?? null;
          previousVersion = record.previous?.version ?? null;
        }),
      ),
      Effect.andThen(publish),
      // Only the releases in use and to roll back to stay on the disk.
      Effect.andThen(
        pruneInstalled(
          binRoot,
          [record.active?.version, record.previous?.version].filter(
            (version): version is string => version !== undefined,
          ),
        ),
      ),
    );

  /** Only a pinned version; anything else is refused before any download. */
  const install = Effect.fn("AiGateway.install")(function* (version: string) {
    const release = pinnedNamed(version);
    if (release === undefined) {
      return yield* new CliproxyRefusedError({
        message: `CLIProxyAPI ${version} is not a release this Hub pins.`,
      });
    }
    if (options.platform === undefined) {
      return yield* new AiGatewayError({ message: "No CLIProxyAPI release for this platform." });
    }
    return yield* installCliproxy({ releases, binRoot, release, platform: options.platform });
  });

  /** The binary of `installed`, installed again (pinned only) when it is gone from the disk. */
  const binaryOf = Effect.fn("AiGateway.binaryOf")(function* (installed: InstalledCliproxy) {
    if (pinnedNamed(installed.version) === undefined) {
      return yield* new CliproxyRefusedError({
        message: `CLIProxyAPI ${installed.version} is no longer pinned by this Hub; not started.`,
      });
    }
    if (!NodeFS.existsSync(binaryPathOf(binRoot, installed.version))) {
      const again = yield* install(installed.version);
      if (again.binarySha256 !== installed.binarySha256) {
        return yield* new CliproxyRefusedError({
          message: `CLIProxyAPI ${installed.version} downloaded again is not the one installed before; not started.`,
        });
      }
    }
    return yield* verifiedBinary(binRoot, installed);
  });

  /**
   * CLIProxyAPI left by a Hub that was killed (where no parent-death signal stopped it): stopped,
   * with its process group, only when its PID still has the start time and executable recorded;
   * its config, which held keys, removed. Never fails: what it cannot do is logged.
   */
  const clearLeftovers = () => {
    const stopped: Array<number> = [];
    const problems: Array<string> = [];
    let names: ReadonlyArray<string> = [];
    try {
      names = NodeFS.readdirSync(root).filter((name) => /^run-[0-9a-f]{12}\.pid$/u.test(name));
    } catch {
      return { stopped, problems };
    }
    for (const name of names) {
      const pidPath = NodePath.join(root, name);
      try {
        const record = decodePidRecord(NodeFS.readFileSync(pidPath, "utf8"));
        if (Option.isSome(record)) {
          const seen = identityOf(record.value.pid, options.os);
          if (
            seen !== undefined &&
            seen.startTime === record.value.startTime &&
            seen.executable.startsWith(record.value.executable)
          ) {
            signalGroup(record.value.pid, "SIGKILL");
            stopped.push(record.value.pid);
          }
        }
      } catch (cause) {
        problems.push(`read ${name}: ${String((cause as Error).message)}`);
      }
      for (const path of [pidPath, NodePath.join(runDir, `config-${name.slice(4, 16)}.yaml`)]) {
        try {
          NodeFS.rmSync(path, { force: true });
        } catch (cause) {
          problems.push(`remove ${path}: ${String((cause as Error).message)}`);
        }
      }
    }
    return { stopped, problems };
  };
  const stopLeftovers = Effect.gen(function* () {
    const { stopped, problems } = clearLeftovers();
    if (stopped.length > 0) {
      yield* Effect.logWarning("Stopped a CLIProxyAPI left by an earlier Hub", { pids: stopped });
    }
    if (problems.length > 0) {
      yield* Effect.logWarning("Could not clear a leftover of the AI gateway", { problems });
    }
  }).pipe(Effect.withSpan("AiGateway.stopLeftovers"));

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

  /** Starts `installed` and waits until it is safe and healthy; on any failure nothing stays up. */
  const launch = Effect.fn("AiGateway.launch")(function* (installed: InstalledCliproxy) {
    const scope = yield* Scope.make();
    return yield* launchIn(installed, scope).pipe(
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
  });

  const launchIn = Effect.fn("AiGateway.launchIn")(function* (
    installed: InstalledCliproxy,
    scope: Scope.Closeable,
  ) {
    const binary = yield* binaryOf(installed).pipe(Effect.mapError(startFailure));
    yield* prepareRunDir.pipe(Effect.mapError(retryable));
    const managementKey = yield* store.getOrCreateRandom(MANAGEMENT_KEY_SECRET, 32).pipe(
      Effect.map((bytes) => Redacted.make(Buffer.from(bytes).toString("base64url"))),
      Effect.mapError(() => retryable(storeError("read")())),
    );
    // A new client key for every start: one a leftover process still knows is useless.
    const clientKey = Redacted.make(NodeCrypto.randomBytes(32).toString("base64url"));
    const port = yield* freeLoopbackPort.pipe(Effect.mapError(retryable));
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
            // `-local-model`: its embedded model catalogs, never refreshed from the internet.
            "-config",
            configPath,
            "-local-model",
          ];
          const child = NodeChildProcess.spawn(command, args, {
            cwd: runDir,
            // Nothing of the Hub's environment: none of its secrets reach CLIProxyAPI.
            env: { PATH: "/usr/bin:/bin", HOME: runDir, [START_TOKEN_VARIABLE]: startToken },
            // Its own process group, stopped as one; only stdio is passed (Node opens every
            // other descriptor close-on-exec).
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const exited = new Promise<number | null>((resolve) => {
            child.once("exit", (code) => resolve(code));
            child.once("error", () => resolve(null));
          });
          for (const stream of [child.stdout, child.stderr]) {
            if (stream === null) continue;
            NodeReadline.createInterface({ input: stream }).on("line", (line) => {
              if (line.trim().length > 0) {
                Queue.offerUnsafe(lines, filterGatewayLine(line, secrets));
              }
            });
          }
          const startTime =
            child.pid === undefined ? undefined : startTimeOf(child.pid, options.os);
          if (child.pid !== undefined && startTime !== undefined) {
            NodeFS.writeFileSync(
              pidPath,
              encodePidRecord({ pid: child.pid, startToken, startTime, executable: binary }),
              { mode: 0o600 },
            );
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
          if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
            signalGroup(child.pid, "SIGTERM");
            const ended = yield* Effect.promise(() => exited).pipe(
              Effect.timeoutOption(STOP_GRACE_MS),
            );
            if (Option.isNone(ended)) {
              signalGroup(child.pid, "SIGKILL");
              yield* Effect.promise(() => exited);
            }
          }
          yield* Effect.sync(() => {
            for (const path of [pidPath, configPath]) {
              try {
                NodeFS.rmSync(path, { force: true });
              } catch {
                // Cleared at the next start.
              }
            }
          });
        }),
    ).pipe(Scope.provide(scope));

    const pid = started.child.pid;
    const exitedEarly = () => started.child.exitCode !== null || started.child.signalCode !== null;
    const deadline = (yield* Clock.currentTimeMillis) + startTimeoutMs;
    const timedOut = Effect.map(Clock.currentTimeMillis, (now) => now > deadline);
    // 1. Our own child listens on the port, and only on loopback: until then no key is sent,
    // so another process that took the port first never receives one.
    while (true) {
      if (pid === undefined || exitedEarly()) {
        return yield* new StartFailure({
          message: `CLIProxyAPI ${installed.version} exited while starting (code ${String(started.child.exitCode ?? started.child.signalCode)}).`,
          retry: true,
        });
      }
      const listening = listeningAddressesOf(pid, options.os);
      if (listening === undefined) {
        return yield* new StartFailure({
          message: "The Hub cannot see which addresses CLIProxyAPI listens on; it was stopped.",
          retry: false,
        });
      }
      if (listening.length > 0 && !onlyLoopback(listening)) {
        return yield* new StartFailure({
          message: `CLIProxyAPI ${installed.version} listened beyond loopback (${listening.join(", ")}); it was stopped and is not started again.`,
          retry: false,
        });
      }
      if (listening.includes(`${CLIPROXY_HOST}:${port}`)) break;
      if (yield* timedOut) {
        return yield* new StartFailure({
          message: `CLIProxyAPI ${installed.version} did not listen within ${Math.round(startTimeoutMs / 1000)} s.`,
          retry: true,
        });
      }
      yield* Effect.sleep(Duration.millis(100));
    }
    // 2. Healthy once its management API answers with the Hub's key.
    while (true) {
      const answer = yield* management.health(endpoint);
      if (answer.status === 200) break;
      if (exitedEarly()) {
        return yield* new StartFailure({
          message: `CLIProxyAPI ${installed.version} exited while starting.`,
          retry: true,
        });
      }
      if (yield* timedOut) {
        return yield* new StartFailure({
          message: `CLIProxyAPI ${installed.version} did not answer within ${Math.round(startTimeoutMs / 1000)} s${answer.status === null ? "" : ` (HTTP ${answer.status})`}.`,
          retry: true,
        });
      }
      yield* Effect.sleep(Duration.millis(150));
    }
    // 3. Still only on loopback once it is up.
    const after = listeningAddressesOf(pid, options.os) ?? [];
    if (!onlyLoopback(after)) {
      return yield* new StartFailure({
        message: `CLIProxyAPI ${installed.version} listened beyond loopback (${after.join(", ")}); it was stopped and is not started again.`,
        retry: false,
      });
    }
    return {
      installed,
      endpoint,
      pid,
      startedAt: yield* DateTime.now,
      exited: Effect.promise(() => started.exited),
      scope,
    } satisfies Running;
  });

  /**
   * The release to run at a start, read and written under the lock: the one in use if pinned and
   * the Owner chose it or it is the newest pin; otherwise the newest pin, installed.
   */
  const activeRelease = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const record = yield* readReleases;
        if (newest === undefined) {
          return yield* new CliproxyRefusedError({
            message: "This Hub pins no CLIProxyAPI release.",
          });
        }
        const active = record.active;
        if (
          active !== null &&
          pinnedNamed(active.version) !== undefined &&
          (record.chosenByOwner === true || compareVersions(active.version, newest.version) >= 0)
        ) {
          return active;
        }
        state = "installing";
        yield* publish;
        const installed = yield* install(newest.version);
        const kept = [active, record.previous].find(
          (release) =>
            release !== null &&
            release.version !== installed.version &&
            pinnedNamed(release.version) !== undefined,
        );
        yield* writeReleases({
          ...record,
          active: installed,
          previous: kept ?? null,
          chosenByOwner: false,
        });
        return installed;
      }),
    )
    .pipe(Effect.withSpan("AiGateway.activeRelease"));

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

  /** Stops the supervisor and whatever it runs. */
  const stopRunning = Effect.suspend(() => {
    const fiber = supervisor;
    supervisor = undefined;
    return (fiber === undefined ? Effect.void : Fiber.interrupt(fiber)).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const running = current;
          current = undefined;
          return running === undefined ? Effect.void : Scope.close(running.scope, Exit.void);
        }),
      ),
    );
  });

  const target = {
    kind: "environment",
    id: HUB_MACHINE_ENVIRONMENT_ID,
    name: "AI gateway",
  } as const;

  const refuseUnlessRunnable = Effect.suspend(() =>
    placement._tag === "never" || options.platform === undefined
      ? Effect.fail(new AiGatewayError({ message: "This machine runs no AI gateway." }))
      : supervisor === undefined && current === undefined
        ? Effect.fail(new AiGatewayError({ message: "The AI gateway is off on this Hub." }))
        : Effect.void,
  );

  /**
   * Starts `next` beside the running release and checks it, records it, and only then stops the
   * old one and keeps `next`. Any failure leaves the old one running and the record as it was.
   */
  const switchTo = Effect.fn("AiGateway.switchTo")(function* (
    action: "ai_gateway.update" | "ai_gateway.rollback",
    requested: string | null,
    next: (
      before: ReleasesRecord,
    ) => Effect.Effect<InstalledCliproxy, AiGatewayError | CliproxyRefusedError>,
    record: (installed: InstalledCliproxy, before: ReleasesRecord) => ReleasesRecord,
  ) {
    const actor = yield* AuditLog.currentActor;
    const from = current?.installed.version ?? activeVersion;
    const outcome = yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* refuseUnlessRunnable;
          const before = yield* readReleases;
          const installed = yield* next(before).pipe(
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
            yield* writeReleases(record(installed, before));
            // Recorded: now the old one goes and the new one is kept.
            yield* stopRunning;
            restarts = 0;
            current = candidate;
            state = "running";
            lastError = null;
            yield* publish;
            yield* startSupervisor(candidate);
          }).pipe(
            // Not adopted (a failed check or write, or the Hub stopping meanwhile): stopped here.
            Effect.onError(() =>
              current === candidate ? Effect.void : Scope.close(candidate.scope, Exit.void),
            ),
          );
          return installed;
        }),
      )
      .pipe(Effect.result);
    yield* audit
      .record({
        actor,
        action,
        target,
        detail:
          outcome._tag === "Success"
            ? {
                from,
                version: outcome.success.version,
                outcome: action === "ai_gateway.rollback" ? "rolled-back" : "updated",
              }
            : {
                from,
                ...(requested === null ? {} : { version: requested }),
                outcome: "failed",
                reason: outcome.failure.message.slice(0, 200),
              },
      })
      .pipe(Effect.ignore({ log: true }));
    yield* publish;
    if (outcome._tag === "Failure") return yield* outcome.failure;
    return statusNow();
  });

  const turnOn = Effect.gen(function* () {
    yield* stopLeftovers;
    lastError = null;
    state = "starting";
    yield* publish;
    yield* startSupervisor(undefined);
  });

  // With the Hub: the supervisor, then whatever runs, even if the supervisor never got to start.
  yield* Effect.addFinalizer(() => stopRunning);

  if (placement._tag === "never") {
    lastError = placement.reason;
  } else if (options.platform === undefined) {
    state = "unsupported";
    lastError = `No CLIProxyAPI release for ${options.os}.`;
  } else {
    const record = yield* readReleases.pipe(Effect.orElseSucceed(() => undefined));
    const enabled =
      placement._tag === "forced"
        ? placement.enabled
        : (record?.enabled ?? placement.defaultEnabled);
    if (enabled) yield* turnOn;
    else {
      yield* stopLeftovers;
      lastError =
        placement._tag === "forced"
          ? "Turned off by T3CODE_AI_GATEWAY=off."
          : "Off on this machine until the Owner turns it on.";
    }
  }
  yield* publish;

  return AiGateway.of({
    status: Effect.sync(statusNow),
    changes: SubscriptionRef.changes(statusRef),
    checkForUpdates: Effect.gen(function* () {
      if (placement._tag === "never" || options.platform === undefined || newest === undefined) {
        return yield* new AiGatewayError({ message: "This machine runs no AI gateway." });
      }
      const currentVersion = current?.installed.version ?? activeVersion;
      return {
        currentVersion,
        latestVersion: newest.version,
        updateAvailable:
          currentVersion === null || compareVersions(newest.version, currentVersion) > 0,
      };
    }).pipe(Effect.withSpan("AiGateway.checkForUpdates")),
    update: Effect.fn("AiGateway.update")(function* (version: string) {
      return yield* switchTo(
        "ai_gateway.update",
        version,
        () => install(version),
        (installed, before) => ({
          ...before,
          active: installed,
          previous:
            before.active !== null && before.active.version !== installed.version
              ? before.active
              : before.previous,
          // Not the newest pin: a later Hub upgrade does not move past the Owner's choice.
          chosenByOwner: installed.version !== newest?.version,
        }),
      );
    }),
    rollback: Effect.suspend(() =>
      switchTo(
        "ai_gateway.rollback",
        null,
        (before) =>
          before.previous === null
            ? Effect.fail(
                new AiGatewayError({ message: "There is no earlier release to roll back to." }),
              )
            : pinnedNamed(before.previous.version) === undefined
              ? Effect.fail(
                  new CliproxyRefusedError({
                    message: `CLIProxyAPI ${before.previous.version} is no longer pinned by this Hub.`,
                  }),
                )
              : Effect.succeed(before.previous),
        (installed, before) => ({
          ...before,
          active: installed,
          previous: before.active,
          chosenByOwner: true,
        }),
      ),
    ).pipe(Effect.withSpan("AiGateway.rollback")),
    setEnabled: Effect.fn("AiGateway.setEnabled")(function* (enabled: boolean) {
      if (!switchable) {
        return yield* new AiGatewayError({
          message:
            placement._tag === "forced"
              ? "T3CODE_AI_GATEWAY decides on this machine."
              : "This machine runs no AI gateway.",
        });
      }
      const actor = yield* AuditLog.currentActor;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* readReleases;
          yield* writeReleases({ ...record, enabled });
          const running = supervisor !== undefined || current !== undefined;
          if (enabled && !running) yield* turnOn;
          if (!enabled && running) {
            yield* stopRunning;
            state = "off";
            lastError = "Turned off by the Owner.";
            yield* publish;
          }
        }),
      );
      yield* audit
        .record({
          actor,
          action: "ai_gateway.enable",
          target,
          detail: { to: enabled ? "on" : "off" },
        })
        .pipe(Effect.ignore({ log: true }));
      return statusNow();
    }),
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
 * This server's gateway, where {@link aiGatewayPlacement} allows one. A joined machine builds
 * this layer too (its runtime is the Hub's) but never runs, downloads or prepares anything.
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
    const placement = aiGatewayPlacement({
      joined: config.joinedHub !== undefined,
      desktop: config.mode === "desktop",
      dev: config.devUrl !== undefined,
      setting: Option.getOrUndefined(setting),
    });
    return yield* make({
      placement,
      stateDir: config.stateDir,
      os,
      platform: cliproxyPlatformOf(os, yield* HostProcess.Architecture),
      pinned: PINNED_CLIPROXY_RELEASES,
      runtimeFolder:
        placement._tag === "never"
          ? { directory: NodePath.join(config.stateDir, "ai-gateway", "run"), inMemory: false }
          : runtimeFolderFor(config.stateDir, os, yield* HostProcess.Environment),
    });
  }),
);
