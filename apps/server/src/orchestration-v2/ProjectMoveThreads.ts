/**
 * The orchestration's side of moving a Project to another Space (`ProjectMoveHooks`): running
 * Threads stop first; a released Thread is cut off its machine. See docs/internals/sandboxes.md,
 * «Moving a Project to another Space».
 */
import { CommandId, HUB_MACHINE_ENVIRONMENT_ID, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProjectMoveHooks from "../project/ProjectMoveHooks.ts";
import { interruptRunsOnHub } from "./HubRunInterrupt.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { LIVE_WORK_FIELDS, LIVE_WORK_FILTER, threadHasLiveWork } from "./threadLiveWork.ts";

/** How long the move waits for stopped turns to end on their machines before ending them here. */
const STOP_WAIT = Duration.seconds(15);
/** After ending them on the Hub, how long it waits for that to settle. */
const FORCED_WAIT = Duration.seconds(5);
const POLL = Duration.millis(200);
const DETACH_TIMEOUT = Duration.seconds(10);
const DETACH_DETAIL = "The Thread's Project moved to a Space its machine does not serve.";

type StopInput = Parameters<ProjectMoveHooks.ProjectMoveWork["stopThreads"]>[0];
type ReleaseInput = Parameters<ProjectMoveHooks.ProjectMoveWork["threadReleased"]>[0];

export const layer: Layer.Layer<
  never,
  never,
  | Orchestrator.OrchestratorV2
  | ProjectionStore.ProjectionStoreV2
  | EnvironmentExecutor.EnvironmentExecutorRegistry
  | ProviderSessionManager.ProviderSessionManagerV2
> = Layer.effectDiscard(
  Effect.gen(function* () {
    // The server's one ProjectMoveHooks, shared with its Project service; none, nothing to do.
    const hooks = yield* Effect.serviceOption(ProjectMoveHooks.ProjectMoveHooks);
    if (Option.isNone(hooks)) return;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const executors = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    // The server provides these; an orchestration-only host joins no machines and runs no MCP.
    const remote = yield* Effect.serviceOption(RemoteEnvironments.RemoteEnvironments);
    const mcp = yield* Effect.serviceOption(McpSessionRegistry.McpSessionRegistry);

    const logged =
      (message: string, detail: Record<string, unknown>) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(message, { ...detail, cause: Cause.pretty(cause) }),
          ),
          Effect.asVoid,
        );

    /** Whether anything still runs in the Thread, a move between machines included. */
    const stillRunning = (threadId: ThreadId) =>
      projections.getThreadRecords(threadId, LIVE_WORK_FIELDS, LIVE_WORK_FILTER).pipe(
        Effect.map(
          (records) => threadHasLiveWork(records) || records.thread.move?.status === "running",
        ),
        // A Thread that cannot be read counts as running: the move checks it again and refuses.
        Effect.orElseSucceed(() => true),
      );

    /** The Threads still running once they all stopped, or `within` passed. */
    const awaitStopped = Effect.fn("ProjectMoveThreads.awaitStopped")(function* (
      threadIds: ReadonlyArray<ThreadId>,
      within: Duration.Duration,
    ) {
      const settled = yield* Effect.gen(function* () {
        while ((yield* Effect.filter(threadIds, stillRunning)).length > 0) {
          yield* Effect.sleep(POLL);
        }
      }).pipe(Effect.timeoutOption(within));
      return Option.isSome(settled) ? [] : yield* Effect.filter(threadIds, stillRunning);
    });

    /** Its machine is away (or the turn would not stop there): its sessions end here. */
    const endOnHub = Effect.fn("ProjectMoveThreads.endOnHub")(
      function* (threadId: ThreadId, reason: string, key: string) {
        const { thread } = yield* projections.getThreadRecords(threadId, []);
        const environmentId = thread.activeEnvironmentId;
        if (Option.isSome(remote) && environmentId !== undefined && environmentId !== null) {
          yield* remote.value.abandonSessions(environmentId, threadId);
        }
        yield* interruptRunsOnHub(orchestrator, { threadId, reason, key });
      },
      (effect, threadId) =>
        effect.pipe(logged("Could not end a moving Project's Thread on the Hub", { threadId })),
    );

    const stopThreads = Effect.fn("ProjectMoveThreads.stopThreads")(
      function* ({ threadIds, reason }: StopInput) {
        const at = yield* Clock.currentTimeMillis;
        for (const threadId of threadIds) {
          const read = yield* projections.getThreadRecords(threadId, []).pipe(Effect.option);
          if (Option.isNone(read)) continue;
          const { thread } = read.value;
          // A move between machines that has not switched yet stops; the Thread stays put.
          if (thread.move?.status === "running") {
            yield* orchestrator
              .dispatch({
                type: "thread.move.cancel",
                commandId: CommandId.make(`server:project-move-cancel:${threadId}:${at}`),
                threadId,
              })
              .pipe(logged("Could not cancel a moving Project's Thread move", { threadId }));
          }
          const environmentId = thread.activeEnvironmentId ?? HUB_MACHINE_ENVIRONMENT_ID;
          const reachable =
            environmentId === null ||
            Option.isSome(yield* executors.get(environmentId).pipe(Effect.option));
          if (reachable) {
            yield* orchestrator
              .dispatch({
                type: "thread.stop",
                commandId: CommandId.make(`server:project-move-stop:${threadId}:${at}`),
                threadId,
                reason,
              })
              .pipe(logged("Could not stop a moving Project's Thread", { threadId }));
          } else {
            yield* endOnHub(threadId, reason, `project-move:${at}`);
          }
        }
        const left = yield* awaitStopped(threadIds, STOP_WAIT);
        if (left.length === 0) return;
        // Whatever did not stop in time ends on the Hub, as Force stop does.
        for (const threadId of left) {
          yield* endOnHub(threadId, reason, `project-move-forced:${at}`);
        }
        yield* awaitStopped(left, FORCED_WAIT);
      },
      (effect, input) =>
        effect.pipe(
          logged("Could not stop a moving Project's Threads", { threadIds: input.threadIds }),
        ),
    );

    const threadReleased = Effect.fn("ProjectMoveThreads.threadReleased")(
      function* ({ threadId, environmentId, providerSessionIds }: ReleaseInput) {
        // Its events, attachment reads, terminals and previews from there are decided anew.
        if (Option.isSome(remote)) yield* remote.value.threadMoved(threadId);
        // An agent there loses its MCP credential at once, whatever it was scoped to.
        if (Option.isSome(mcp)) yield* mcp.value.revokeThread(threadId);
        yield* Effect.forEach(
          providerSessionIds,
          (providerSessionId) =>
            sessions
              .detach({
                providerSessionId,
                threadId,
                detail: DETACH_DETAIL,
                revokeMcpCredential: true,
              })
              .pipe(
                Effect.timeout(DETACH_TIMEOUT),
                Effect.catchCause((cause) =>
                  Effect.logInfo("A moved Project's Thread did not detach from its machine", {
                    threadId,
                    providerSessionId,
                    cause: Cause.pretty(cause),
                  }),
                ),
              ),
          { concurrency: "unbounded", discard: true },
        );
        // What the Hub still holds of its sessions there goes too (one away drops them on return).
        if (Option.isSome(remote)) yield* remote.value.abandonSessions(environmentId, threadId);
      },
      (effect, input) =>
        effect.pipe(
          logged("Could not release a moved Project's Thread", {
            threadId: input.threadId,
            environmentId: input.environmentId,
          }),
        ),
    );

    yield* hooks.value.register({ stopThreads, threadReleased });
  }),
);
