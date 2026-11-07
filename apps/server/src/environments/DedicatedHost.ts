/**
 * A dedicated machine's joined server runs no work itself: it keeps one Sandbox running, with the
 * runtime and rules a Hub runs a Space's Sandbox with, whose server holds this machine's
 * credential and is the one connected to the Hub. See docs/internals/sandboxes.md#dedicated-machines.
 */
import { SpaceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { dedicatedRuntimeFromConfig } from "../sandboxes/sandboxRuntimeFromConfig.ts";
import {
  type SandboxLimits,
  SandboxRuntime,
  type SandboxRuntimeError,
} from "../sandboxes/SandboxRuntime.ts";
import { HubConnector, type JoinedConnectionState, readCredential } from "./JoinedHub.ts";
import type { JoinedHubState } from "./joinedHubState.ts";

/** The one Sandbox a dedicated machine runs: its home is `<base dir>-sandboxes/dedicated`. */
const DEDICATED_SANDBOX_ID = "dedicated";

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

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Keeps the machine's Sandbox running: made (or given the current credential and Hub) once, then
 * started, and started again with a backoff whenever its server ends, until it ended more than
 * {@link CRASH_LIMIT} times in {@link CRASH_WINDOW_MS}. The runtime stops it with this server.
 */
export const superviseDedicatedSandbox = Effect.fn("DedicatedHost.supervise")(function* (input: {
  readonly joined: JoinedHubState;
  readonly credential: string;
  readonly state: Ref.Ref<JoinedConnectionState>;
}) {
  const runtime = yield* SandboxRuntime;
  const { joined, state } = input;
  const set = (next: {
    readonly state: "starting" | "running" | "restarting" | "failed";
    readonly message: string | null;
  }) => Effect.flatMap(nowIso, (since) => Ref.set(state, { _tag: "sandbox", since, ...next }));
  const failedWith = (error: SandboxRuntimeError) => error.detail;
  const created = yield* runtime
    .create({
      sandboxId: DEDICATED_SANDBOX_ID,
      spaceId: SpaceId.make(joined.spaceId ?? "unknown"),
      environmentId: joined.environmentId,
      name: joined.name,
      hubEnvironmentId: joined.hubEnvironmentId,
      credential: Redacted.make(input.credential),
      limits: DEDICATED_LIMITS,
    })
    .pipe(Effect.result);
  if (Result.isFailure(created)) {
    return yield* set({ state: "failed", message: failedWith(created.failure) });
  }
  const ends: Array<number> = [];
  while (true) {
    yield* set({ state: "starting", message: null });
    const started = yield* runtime.start(DEDICATED_SANDBOX_ID).pipe(Effect.result);
    let message: string;
    if (Result.isFailure(started)) {
      message = failedWith(started.failure);
    } else {
      yield* set({ state: "running", message: null });
      const exitCode = yield* started.success.exited;
      message = `its server ended with exit code ${exitCode ?? "unknown"}.`;
    }
    yield* Effect.logWarning("The dedicated machine's Sandbox ended", { message });
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
 * server's own. Without a runtime that isolates (no rootless Podman, no image) it runs nothing
 * and says why.
 */
export const layer = (joined: JoinedHubState) =>
  Layer.effect(
    HubConnector,
    Effect.gen(function* () {
      const state = yield* Ref.make<JoinedConnectionState>({
        _tag: "sandbox",
        state: "starting",
        since: yield* nowIso,
        message: null,
      });
      const fail = (message: string) =>
        Effect.flatMap(nowIso, (since) =>
          Ref.set(state, { _tag: "sandbox", state: "failed", since, message }),
        );
      const credential = yield* readCredential(yield* ServerSecretStore.ServerSecretStore);
      if (Option.isNone(credential)) {
        yield* fail("this machine has no Environment credential. Run `t3 join` again.");
        return HubConnector.of({ joined, state: Ref.get(state) });
      }
      const runtime = yield* dedicatedRuntimeFromConfig(joined.hubUrl);
      if (Result.isFailure(runtime)) {
        yield* Effect.logWarning(`This dedicated machine runs nothing: ${runtime.failure}`);
        yield* fail(runtime.failure);
        return HubConnector.of({ joined, state: Ref.get(state) });
      }
      const context = yield* Layer.build(runtime.success);
      yield* superviseDedicatedSandbox({ joined, credential: credential.value, state }).pipe(
        Effect.provide(context),
        Effect.forkScoped,
      );
      return HubConnector.of({ joined, state: Ref.get(state) });
    }),
  );
