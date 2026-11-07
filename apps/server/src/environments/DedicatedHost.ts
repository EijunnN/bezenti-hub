/**
 * A dedicated machine's joined server runs no work itself: it keeps one Sandbox running for the
 * Space the Hub names, with the runtime and rules a Hub runs a Space's Sandbox with, whose server
 * holds the machine's credential and is the one connected. See docs/internals/sandboxes.md.
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
import { dedicatedRuntimeFromConfig } from "../sandboxes/sandboxRuntimeFromConfig.ts";
import {
  type SandboxLimits,
  SandboxRuntime,
  type SandboxRuntimeError,
} from "../sandboxes/SandboxRuntime.ts";
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

/**
 * The runtime's defaults. The Installation's Sandbox limits (spec 3 ticket 05) live on the Hub,
 * which does not send them to a machine it does not run; this is where they would go in.
 */
const DEDICATED_LIMITS: SandboxLimits = {
  cpus: null,
  memoryBytes: null,
  pids: null,
  diskBytes: null,
};

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
      readonly spaceId: string | null;
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
            }))
          : Effect.succeed({ _tag: "unreachable" }),
    ),
    Effect.timeout("10 seconds"),
    Effect.provide(FetchHttpClient.layer),
    Effect.orElseSucceed((): HubAnswer => ({ _tag: "unreachable" })),
  );

/**
 * Keeps a Sandbox running for the Space the Hub names, asked at start and after each end of its
 * server: another Space gets a new home and the old one goes (as does any other left on disk);
 * personal, the home goes and `becomePersonal` takes over. Too many ends leave it failed.
 */
export const superviseDedicatedSandbox = Effect.fn("DedicatedHost.supervise")(function* <R>(input: {
  readonly joined: JoinedHubState;
  readonly credential: string;
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
    if (answer._tag === "removed") {
      yield* set({
        state: "failed",
        message: "the Hub no longer accepts this machine. Run `t3 join` again.",
      });
      return "stop" as const;
    }
    if (answer.mode !== "dedicated" || answer.spaceId === null) {
      if (current.spaceId !== undefined) yield* remove(dedicatedSandboxIdOf(current.spaceId));
      const { spaceId: _spaceId, ...rest } = current;
      const personal: JoinedHubState = { ...rest, mode: "personal" };
      yield* input.persist(personal);
      yield* input.becomePersonal(personal);
      return "stop" as const;
    }
    if (answer.spaceId !== current.spaceId) {
      if (current.spaceId !== undefined) yield* remove(dedicatedSandboxIdOf(current.spaceId));
      current = { ...current, mode: "dedicated", spaceId: answer.spaceId };
      yield* input.persist(current);
    }
    return "go" as const;
  });

  if ((yield* follow(yield* input.askHub)) === "stop") return;
  while (current.spaceId === undefined) {
    yield* set({
      state: "restarting",
      message: "waiting for the Hub to say which Space it serves.",
    });
    yield* Effect.sleep(HUB_RETRY_MS);
    if ((yield* follow(yield* input.askHub)) === "stop") return;
  }
  // Homes of other Spaces (an earlier dedication, a change cut short) are never reused.
  for (const sandboxId of yield* input.homesOnDisk) {
    if (
      sandboxId.startsWith(DEDICATED_PREFIX) &&
      sandboxId !== dedicatedSandboxIdOf(current.spaceId)
    ) {
      yield* remove(sandboxId);
    }
  }

  const ends: Array<number> = [];
  let created: string | undefined;
  while (true) {
    const spaceId: string = current.spaceId ?? "";
    const sandboxId = dedicatedSandboxIdOf(spaceId);
    if (created !== sandboxId) {
      const made = yield* runtime
        .create({
          sandboxId,
          spaceId: SpaceId.make(spaceId),
          environmentId: current.environmentId,
          name: current.name,
          hubEnvironmentId: current.hubEnvironmentId,
          credential: Redacted.make(input.credential),
          limits: DEDICATED_LIMITS,
        })
        .pipe(Effect.result);
      if (Result.isFailure(made)) {
        return yield* set({ state: "failed", message: failedWith(made.failure) });
      }
      created = sandboxId;
    }
    yield* set({ state: "starting", message: null });
    const started = yield* runtime.start(sandboxId).pipe(Effect.result);
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
      const runtime = yield* dedicatedRuntimeFromConfig(joined.hubUrl);
      if (Result.isFailure(runtime)) {
        yield* Effect.logWarning(`This dedicated machine runs nothing: ${runtime.failure}`);
        yield* fail(runtime.failure);
        return connector;
      }
      const scope = yield* Effect.scope;
      const context = yield* Layer.build(runtime.success);
      const rootDir = path.join(
        path.dirname(config.baseDir),
        `${path.basename(config.baseDir)}-sandboxes`,
      );
      // `layerPersonal` is built only once the Hub made the machine personal.
      const layerPersonal = (personal: JoinedHubState) => JoinedHub.layer(personal);
      yield* superviseDedicatedSandbox({
        joined,
        credential: credential.value,
        state,
        askHub: askHubAt(joined.hubUrl, credential.value),
        homesOnDisk: fs.readDirectory(rootDir).pipe(Effect.orElseSucceed(() => [])),
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
      }).pipe(Effect.provide(context), Effect.forkScoped);
      return connector;
    }),
  );
