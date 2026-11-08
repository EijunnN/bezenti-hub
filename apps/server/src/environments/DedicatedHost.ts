/**
 * A dedicated machine's joined server runs no work itself: it keeps one Sandbox running for the
 * Space the Hub names, with the runtime and rules a Hub runs a Space's Sandbox with, whose server
 * is the one connected, with a credential the Hub issues it for that Space (never the machine's,
 * which stays with this host). See docs/internals/sandboxes.md.
 */
import { EnvironmentSelfResult, SpaceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  dedicatedRuntimeFromConfig,
  type DedicatedRuntimeRefusal,
} from "../sandboxes/sandboxRuntimeFromConfig.ts";
import {
  type SandboxLimits,
  SandboxRuntime,
  type SandboxRuntimeError,
} from "../sandboxes/SandboxRuntime.ts";
import { NO_LIMITS } from "../sandboxes/sandboxLimits.ts";
import * as JoinedHub from "./JoinedHub.ts";
import {
  DEDICATED_CREDENTIAL_SECRET,
  ENVIRONMENT_CREDENTIAL_SECRET,
  type JoinedHubState,
  writeJoinedHubState,
} from "./joinedHubState.ts";

const DEDICATED_PREFIX = "dedicated-";

/** The Sandbox a dedicated machine runs for a Space: one home per Space, never shared. */
export const dedicatedSandboxIdOf = (spaceId: string) =>
  `${DEDICATED_PREFIX}${spaceId.replace(/[^A-Za-z0-9_.-]/gu, "-")}`;

/** As for a Hub's Sandbox: more than this many ends in the window, and it stays failed. */
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 10 * 60_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;
/** How long to wait between asks while the Hub has not said which Space this machine serves. */
const HUB_RETRY_MS = 10_000;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** What the Hub says of this machine now. */
export type HubAnswer =
  | {
      readonly _tag: "uses";
      readonly mode: EnvironmentSelfResult["mode"];
      /** Dedicated with none: its Space is gone, and it waits for the Owner. */
      readonly spaceId: string | null;
      /** The Space's Sandbox limits, as the Hub has them now; none from an older Hub. */
      readonly limits: SandboxLimits;
      /** A new credential for its Sandbox, for that Space only; the last one ends. */
      readonly sandboxCredential: string | undefined;
    }
  | { readonly _tag: "removed" }
  | { readonly _tag: "unreachable" };

const decodeSelf = HttpClientResponse.schemaBodyJson(EnvironmentSelfResult);

/** Asks the Hub how it uses this machine (`/api/environments/self`), with its credential. */
export const askHubAt = (hubUrl: string, credential: string): Effect.Effect<HubAnswer> =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.execute(
        HttpClientRequest.post(new URL("/api/environments/self", hubUrl).toString()).pipe(
          HttpClientRequest.bearerToken(credential),
        ),
      ),
    ),
    Effect.flatMap((response): Effect.Effect<HubAnswer, unknown> =>
      response.status === 401 || response.status === 403
        ? Effect.succeed({ _tag: "removed" })
        : response.status === 200
          ? Effect.map(decodeSelf(response), (self) => ({
              _tag: "uses" as const,
              mode: self.mode,
              spaceId: self.spaceId,
              limits: self.limits ?? NO_LIMITS,
              sandboxCredential: self.sandboxCredential,
            }))
          : Effect.succeed({ _tag: "unreachable" }),
    ),
    Effect.timeout("10 seconds"),
    Effect.provide(FetchHttpClient.layer),
    Effect.orElseSucceed((): HubAnswer => ({ _tag: "unreachable" })),
  );

/** The Sandbox homes on disk under `rootDir`: directories only (never its logs). */
export const dedicatedHomesIn = Effect.fn("DedicatedHost.dedicatedHomesIn")(
  function* (rootDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homes: Array<string> = [];
    for (const entry of yield* fs.readDirectory(rootDir)) {
      if (!entry.startsWith(DEDICATED_PREFIX)) continue;
      const info = yield* fs.stat(path.join(rootDir, entry)).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory") homes.push(entry);
    }
    return homes;
  },
  Effect.orElseSucceed((): ReadonlyArray<string> => []),
);

/**
 * Keeps a Sandbox running for the Space the Hub names, asked at start and after each end of its
 * server, each start with the Sandbox credential of the last answer: another Space gets a new
 * home and the old one goes (as does any other left on disk); no Space (deleted) leaves it
 * waiting; personal, the home goes and `becomePersonal` takes over. Too many ends leave it failed.
 */
export const superviseDedicatedSandbox = Effect.fn("DedicatedHost.supervise")(function* <R>(input: {
  readonly joined: JoinedHubState;
  readonly state: Ref.Ref<JoinedHub.JoinedConnectionState>;
  readonly askHub: Effect.Effect<HubAnswer>;
  /** The Sandbox ids with a home on disk. */
  readonly homesOnDisk: Effect.Effect<ReadonlyArray<string>>;
  /** Writes the machine's joined state as the Hub answered it. */
  readonly persist: (joined: JoinedHubState) => Effect.Effect<void>;
  /** The Hub made the machine personal: its server serves as one from now on. */
  readonly becomePersonal: (joined: JoinedHubState) => Effect.Effect<void, never, R>;
}) {
  const runtime = yield* SandboxRuntime;
  const { state } = input;
  let current = input.joined;
  // Asked of the Hub with each answer, so a change applies on the Sandbox's next start.
  let limits: SandboxLimits = NO_LIMITS;
  // The Sandbox's own credential, for `current.spaceId`: none until the Hub gives one.
  let sandboxCredential: string | undefined;
  const set = (next: {
    readonly state: "starting" | "running" | "restarting" | "failed";
    readonly message: string | null;
  }) => Effect.flatMap(nowIso, (since) => Ref.set(state, { _tag: "sandbox", since, ...next }));
  const failedWith = (error: SandboxRuntimeError) => error.detail;
  const remove = (sandboxId: string) =>
    runtime.delete(sandboxId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not delete a dedicated Sandbox's home", {
          sandboxId,
          detail: error.detail,
        }),
      ),
    );

  /** Follows the Hub's answer: "stop" once this Sandbox has nothing more to run. */
  const follow = Effect.fn("DedicatedHost.follow")(function* (answer: HubAnswer) {
    if (answer._tag === "unreachable") return "go" as const;
    // Its credential is refused: it was removed (a deleted Space answers, with no Space).
    if (answer._tag === "removed") {
      yield* set({
        state: "failed",
        message: "the Hub no longer accepts this machine. Run `t3 join` again.",
      });
      return "stop" as const;
    }
    limits = answer.limits;
    if (answer.mode !== "dedicated") {
      if (current.spaceId !== undefined) yield* remove(dedicatedSandboxIdOf(current.spaceId));
      const { spaceId: _spaceId, ...rest } = current;
      const personal: JoinedHubState = { ...rest, mode: "personal" };
      yield* input.persist(personal);
      yield* input.becomePersonal(personal);
      return "stop" as const;
    }
    if (answer.spaceId !== (current.spaceId ?? null)) {
      if (current.spaceId !== undefined) yield* remove(dedicatedSandboxIdOf(current.spaceId));
      const { spaceId: _spaceId, ...rest } = current;
      current =
        answer.spaceId === null
          ? { ...rest, mode: "dedicated" }
          : { ...rest, mode: "dedicated", spaceId: answer.spaceId };
      yield* input.persist(current);
    }
    sandboxCredential = answer.sandboxCredential;
    return "go" as const;
  });

  if ((yield* follow(yield* input.askHub)) === "stop") return;
  // Homes of other Spaces (an earlier dedication, a change cut short) are never reused.
  for (const sandboxId of yield* input.homesOnDisk) {
    if (
      sandboxId.startsWith(DEDICATED_PREFIX) &&
      (current.spaceId === undefined || sandboxId !== dedicatedSandboxIdOf(current.spaceId))
    ) {
      yield* remove(sandboxId);
    }
  }

  /** The Space to run and its Sandbox's credential, once the Hub gave both. */
  const runnable = () =>
    current.spaceId === undefined || sandboxCredential === undefined
      ? undefined
      : { spaceId: current.spaceId, credential: sandboxCredential };

  const ends: Array<number> = [];
  while (true) {
    // Nothing runs until the Hub names a Space and gives its Sandbox a credential for it.
    let next = runnable();
    while (next === undefined) {
      yield* set({
        state: "restarting",
        message:
          current.spaceId === undefined
            ? "waiting for the Hub to say which Space it serves."
            : "waiting for the Hub to give its Sandbox a credential.",
      });
      yield* Effect.sleep(HUB_RETRY_MS);
      if ((yield* follow(yield* input.askHub)) === "stop") return;
      next = runnable();
    }
    const { spaceId, credential } = next;
    const sandboxId = dedicatedSandboxIdOf(spaceId);
    // Made (or its credential and Hub replaced) before every start: each answer issues another.
    const made = yield* runtime
      .create({
        sandboxId,
        spaceId: SpaceId.make(spaceId),
        environmentId: current.environmentId,
        name: current.name,
        hubEnvironmentId: current.hubEnvironmentId,
        credential: Redacted.make(credential),
      })
      .pipe(Effect.result);
    if (Result.isFailure(made)) {
      return yield* set({ state: "failed", message: failedWith(made.failure) });
    }
    yield* set({ state: "starting", message: null });
    // The same start options a Hub gives its own Sandboxes: the runtime passes what it enforces.
    const started = yield* runtime.start(sandboxId, { limits }).pipe(Effect.result);
    let message: string;
    if (Result.isFailure(started)) {
      message = failedWith(started.failure);
    } else {
      yield* set({ state: "running", message: null });
      const exitCode = yield* started.success.exited;
      message = `its server ended with exit code ${exitCode ?? "unknown"}.`;
    }
    yield* Effect.logWarning("The dedicated machine's Sandbox ended", { message });
    // It may have ended because the Hub changed this machine: the Hub's answer decides.
    if ((yield* follow(yield* input.askHub)) === "stop") return;
    if (current.spaceId !== spaceId) continue;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    ends.push(nowMs);
    while (ends.length > 0 && (ends[0] ?? nowMs) < nowMs - CRASH_WINDOW_MS) ends.shift();
    if (ends.length > CRASH_LIMIT) {
      return yield* set({
        state: "failed",
        message: `${message} It ended ${ends.length} times in 10 minutes; restart \`t3 serve\` to try again.`,
      });
    }
    yield* set({ state: "restarting", message });
    yield* Effect.sleep(Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (ends.length - 1)));
  }
});

/** How often a dedicated machine waiting for its Sandbox image asks Podman again. */
export const DEDICATED_IMAGE_RECHECK_MS = 15_000;

/**
 * The runtime once it can run. A missing image is waited for, Podman asked again every
 * {@link DEDICATED_IMAGE_RECHECK_MS} (so `t3 sandbox image build` is picked up without a restart);
 * any other reason is final, as its message.
 */
export const awaitDedicatedRuntime = Effect.fn("DedicatedHost.awaitDedicatedRuntime")(function* <
  A,
  R,
>(input: {
  readonly check: (
    recheck: boolean,
  ) => Effect.Effect<Result.Result<A, DedicatedRuntimeRefusal>, never, R>;
  readonly onWaiting: (message: string) => Effect.Effect<void>;
}) {
  let recheck = false;
  while (true) {
    const checked = yield* input.check(recheck);
    if (Result.isSuccess(checked)) return Result.succeed(checked.success);
    if (!checked.failure.waits) return Result.fail(checked.failure.message);
    if (!recheck) {
      yield* input.onWaiting(
        `${checked.failure.message} Its Sandbox starts by itself once it is built.`,
      );
    }
    recheck = true;
    yield* Effect.sleep(DEDICATED_IMAGE_RECHECK_MS);
  }
});

/**
 * Joined mode on a dedicated machine: `/health` reports the Sandbox, not a connection of this
 * server's own. Without a runtime that isolates (no rootless Podman, no image, ports of the host
 * open to the container) it runs nothing and says why. Made personal on the Hub, it serves as a
 * personal machine from then on, without a restart.
 */
export const layer = (joined: JoinedHubState) =>
  Layer.effect(
    JoinedHub.HubConnector,
    Effect.gen(function* () {
      const state = yield* Ref.make<JoinedHub.JoinedConnectionState>({
        _tag: "sandbox",
        state: "starting",
        since: yield* nowIso,
        message: null,
      });
      // Until it turns personal, the Sandbox's state; then that server's own connection.
      const reported = yield* Ref.make<Effect.Effect<JoinedHub.JoinedConnectionState>>(
        Ref.get(state),
      );
      const connector = JoinedHub.HubConnector.of({
        joined,
        state: Effect.flatten(Ref.get(reported)),
      });
      const fail = (message: string) =>
        Effect.flatMap(nowIso, (since) =>
          Ref.set(state, { _tag: "sandbox", state: "failed", since, message }),
        );
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const credential = yield* JoinedHub.readCredential(secrets, DEDICATED_CREDENTIAL_SECRET);
      if (Option.isNone(credential)) {
        yield* fail("this machine has no dedicated credential. Run `t3 join --dedicated` again.");
        return connector;
      }
      const scope = yield* Effect.scope;
      // The runtime's own root, as it derives it.
      const rootDir = path.join(
        path.dirname(config.baseDir),
        `${path.basename(config.baseDir)}-sandboxes`,
      );
      // `layerPersonal` is built only once the Hub made the machine personal.
      const layerPersonal = (personal: JoinedHubState) => JoinedHub.layer(personal);
      // Waited for in its own fiber: `/health` answers meanwhile, saying why it runs nothing yet.
      const supervise = Effect.gen(function* () {
        const runtime = yield* awaitDedicatedRuntime({
          check: (recheck) => dedicatedRuntimeFromConfig(joined.hubUrl, { recheck }),
          onWaiting: (message) =>
            Effect.logWarning(`This dedicated machine runs nothing yet: ${message}`).pipe(
              Effect.andThen(nowIso),
              Effect.flatMap((since) =>
                Ref.set(state, { _tag: "sandbox", state: "restarting", since, message }),
              ),
            ),
        });
        if (Result.isFailure(runtime)) {
          yield* Effect.logWarning(`This dedicated machine runs nothing: ${runtime.failure}`);
          return yield* fail(runtime.failure);
        }
        const context = yield* Layer.buildWithScope(runtime.success, scope);
        yield* superviseDedicatedSandbox({
          joined,
          state,
          askHub: askHubAt(joined.hubUrl, credential.value),
          homesOnDisk: dedicatedHomesIn(rootDir).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
          persist: (next) =>
            writeJoinedHubState(config.joinedHubPath, next).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.ignore,
            ),
          becomePersonal: Effect.fn("DedicatedHost.becomePersonal")(
            function* (personal: JoinedHubState) {
              yield* secrets
                .set(ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode(credential.value))
                .pipe(Effect.andThen(secrets.remove(DEDICATED_CREDENTIAL_SECRET)), Effect.ignore);
              yield* Effect.logInfo("The Hub made this machine personal; it serves as one now.");
              const served = yield* Layer.buildWithScope(layerPersonal(personal), scope);
              yield* Ref.set(reported, Context.get(served, JoinedHub.HubConnector).state);
            },
            Effect.catchCause((cause) => Effect.logError("Could not turn personal", cause)),
          ),
        }).pipe(Effect.provide(context));
      });
      yield* supervise.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("The dedicated machine's Sandbox could not run", cause).pipe(
            Effect.andThen(fail("its Sandbox runtime could not start; see the server log.")),
          ),
        ),
        Effect.forkScoped,
      );
      return connector;
    }),
  );
