/**
 * The orchestration's side of moving a Project to another Space (`ProjectMoveHooks`): running
 * Threads stop first; a released Thread is cut off its machine. See docs/internals/sandboxes.md,
 * «Moving a Project to another Space».
 */
import {
  CommandId,
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProjectMoveHooks from "../project/ProjectMoveHooks.ts";
import * as EventSink from "./EventSink.ts";
import { interruptRunsOnHub } from "./HubRunInterrupt.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { LIVE_WORK_FIELDS, LIVE_WORK_FILTER, threadHasLiveWork } from "./threadLiveWork.ts";

/** How long the move waits for stopped turns to end on their machines before ending them here. */
const STOP_WAIT = Duration.seconds(15);
/** After ending them on the Hub, how long it waits for that to settle. */
const FORCED_WAIT = Duration.seconds(5);
const DETACH_TIMEOUT = Duration.seconds(10);
const DETACH_DETAIL = "The Thread's Project moved to a Space its machine does not serve.";

const decodeSessionIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

type StopInput = Parameters<ProjectMoveHooks.ProjectMoveWork["stopThreads"]>[0];

interface ReleaseRow {
  readonly threadId: string;
  readonly environmentId: string;
  readonly sessions: string;
}

export const layer: Layer.Layer<
  never,
  never,
  | ProjectMoveHooks.ProjectMoveHooks
  | Orchestrator.OrchestratorV2
  | ProjectionStore.ProjectionStoreV2
  | EventSink.EventSinkV2
  | EnvironmentExecutor.EnvironmentExecutorRegistry
  | ProviderSessionManager.ProviderSessionManagerV2
  | SqlClient.SqlClient
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const hooks = yield* ProjectMoveHooks.ProjectMoveHooks;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const executors = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const sql = yield* SqlClient.SqlClient;
    // The server provides these; an orchestration-only host joins no machines and runs no MCP.
    const remote = yield* Effect.serviceOption(RemoteEnvironments.RemoteEnvironments);
    const mcp = yield* Effect.serviceOption(McpSessionRegistry.McpSessionRegistry);
    const scope = yield* Effect.scope;

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

    /** The Threads still running once they all stopped, or `within` passed: woken by events. */
    const awaitStopped = Effect.fn("ProjectMoveThreads.awaitStopped")(function* (
      threadIds: ReadonlyArray<ThreadId>,
      within: Duration.Duration,
    ) {
      // Read before checking, so an event between the check and the stream is not missed.
      const after = yield* Effect.forEach(threadIds, (threadId) =>
        eventSink.latestSequence({ threadId }).pipe(
          Effect.orElseSucceed(() => 0),
          Effect.map((afterSequence) => ({ threadId, afterSequence })),
        ),
      );
      if ((yield* Effect.filter(threadIds, stillRunning)).length === 0) return [];
      yield* Stream.mergeAll(
        after.map((input) => orchestrator.streamStoredEventsFrom(input)),
        { concurrency: "unbounded" },
      ).pipe(
        Stream.mapEffect(() => Effect.filter(threadIds, stillRunning)),
        Stream.filter((running) => running.length === 0),
        Stream.runHead,
        Effect.timeoutOption(within),
        Effect.ignore,
      );
      return yield* Effect.filter(threadIds, stillRunning);
    });

    /** Its machine is away, or it has none: its sessions and turns end on the Hub. */
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
          // A Thread with no Environment (needs one) has no machine to stop it: it ends here now.
          if (thread.activeEnvironmentId === null) {
            yield* endOnHub(threadId, reason, `project-move:${at}`);
            continue;
          }
          // Absent is the Hub machine, which is always reachable.
          const environmentId = thread.activeEnvironmentId ?? HUB_MACHINE_ENVIRONMENT_ID;
          const reachable = Option.isSome(yield* executors.get(environmentId).pipe(Effect.option));
          if (!reachable) {
            yield* endOnHub(threadId, reason, `project-move:${at}`);
            continue;
          }
          yield* orchestrator
            .dispatch({
              type: "thread.stop",
              commandId: CommandId.make(`server:project-move-stop:${threadId}:${at}`),
              threadId,
              reason,
            })
            .pipe(logged("Could not stop a moving Project's Thread", { threadId }));
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

    /** One recorded release: the machine is cut off, then the record goes. */
    const release = Effect.fn("ProjectMoveThreads.release")(function* (row: ReleaseRow) {
      const threadId = ThreadId.make(row.threadId);
      const environmentId = EnvironmentId.make(row.environmentId);
      // Its events, attachment reads, terminals and previews from there are decided anew.
      if (Option.isSome(remote)) yield* remote.value.threadMoved(threadId);
      // An agent there loses its MCP credential at once, whatever it was scoped to.
      if (Option.isSome(mcp)) yield* mcp.value.revokeThread(threadId);
      const sessionIds = (yield* decodeSessionIds(row.sessions)).map((id) =>
        ProviderSessionId.make(id),
      );
      yield* Effect.forEach(
        sessionIds,
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
      yield* sql`
        DELETE FROM thread_environment_releases
        WHERE thread_id = ${row.threadId} AND environment_id = ${row.environmentId}
      `;
    });

    const drainReleases = Effect.fn("ProjectMoveThreads.drainReleases")(
      function* (threadIds: ReadonlyArray<ThreadId> | "all") {
        if (threadIds !== "all" && threadIds.length === 0) return;
        const rows = yield* sql<ReleaseRow>`
          SELECT thread_id AS "threadId", environment_id AS "environmentId",
            provider_session_ids_json AS sessions
          FROM thread_environment_releases
          WHERE ${threadIds === "all" ? sql`1 = 1` : sql.in("thread_id", threadIds)}
          ORDER BY released_at ASC
        `;
        // Each on its own: one that fails stays recorded for the next drain, the rest go on.
        yield* Effect.forEach(
          rows,
          (row) =>
            release(row).pipe(
              logged("Could not release a moved Project's Thread", {
                threadId: row.threadId,
                environmentId: row.environmentId,
              }),
            ),
          { discard: true },
        );
      },
      (effect) => effect.pipe(logged("Could not read a moved Project's releases", {})),
    );

    yield* hooks.register({ stopThreads, drainReleases });
    // Releases a Hub stopped in the middle of are finished as it starts.
    yield* drainReleases("all").pipe(Effect.forkIn(scope));
  }),
);
