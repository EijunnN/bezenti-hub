/**
 * Runs each Thread's move to another Environment (`thread.move`), recording every step on the
 * Thread so clients see it and a restart resumes it; a failure before the switch leaves the
 * Thread on its source. See docs/internals/overview.md, «Moving a Thread».
 */
import {
  CheckpointRef,
  CommandId,
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  OrchestrationV2CheckpointJson,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2HistoricalMessage,
  type OrchestrationV2ThreadMove,
  type OrchestrationV2ThreadMoveCheckpoint,
  type OrchestrationV2ThreadMoveStep,
  type OrchestrationV2TurnItem,
  type ProviderSessionId,
  type RunId,
  ThreadId,
  TurnItemId,
  type UserId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { resolveProjectScripts, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AuditLog from "../audit/AuditLog.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as HubRunsAgents from "../environment/HubRunsAgents.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import type { MoveFetchInput } from "../environment/MovedWorkspace.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretMasker from "../vaults/SecretMasker.ts";
import { visibleConversationItems } from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import { interruptRunsOnHub } from "./HubRunInterrupt.ts";
import * as MoveHandoff from "./MoveHandoff.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const DETACH_TIMEOUT = Duration.seconds(30);
/** How long a machine may take to say hello again before the move treats it as away. */
const RECONNECT_GRACE = Duration.seconds(60);
/** A change to the Thread's runs wakes a move waiting for its turn; this only bounds the wait. */
const TURN_RECHECK = Duration.seconds(30);
const AUDIT_MESSAGE_CHARS = 300;
/** The one model call that writes a handoff summary; past it, the summary is assembled instead. */
const HANDOFF_TIMEOUT_MS = 180_000;
/** Read at each move (not once at startup), so it can be lowered without a restart. */
const handoffTimeoutMs = () => {
  const configured = Number.parseInt(process.env.T3CODE_MOVE_HANDOFF_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) ? Math.max(1_000, configured) : HANDOFF_TIMEOUT_MS;
};

const decodeCheckpoint = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointJson),
);

/** A step failed: the move stops there and the Thread stays where it was. */
class MoveStepFailure extends Schema.TaggedError<MoveStepFailure>()("MoveStepFailure", {
  message: Schema.String,
}) {}

/** The source went offline during its step: the move goes on from what it uploaded. */
class SourceOffline extends Schema.TaggedError<SourceOffline>()("SourceOffline", {}) {}

export interface ThreadMovesShape {
  /**
   * Runs (or resumes) the Thread's move, if one is running, in the background. After a restart
   * its machines may not have said hello yet: they get a grace period before counting as away.
   */
  readonly resume: (
    threadId: ThreadId,
    options?: { readonly restarted?: boolean },
  ) => Effect.Effect<void>;
}

export class ThreadMoves extends Context.Service<ThreadMoves, ThreadMovesShape>()(
  "t3/orchestration-v2/ThreadMoveService/ThreadMoves",
) {}

/** Where a move's final checkpoint is uploaded: one ref per move, so a fetch never sees a stale one. */
const finalCheckpointRef = (threadId: ThreadId, moveId: string) =>
  CheckpointRef.make(
    `${HubRepository.threadRefPrefixes(threadId)[0]}moves/${encodeURIComponent(moveId)}`,
  );

const messageOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const detail = (error as { readonly detail?: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
};

const isUnavailable = Schema.is(EnvironmentExecutor.EnvironmentExecutorUnavailableError);
const isMoveStepFailure = Schema.is(MoveStepFailure);
const isSourceOffline = Schema.is(SourceOffline);

const asFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      isMoveStepFailure(error) ? error : new MoveStepFailure({ message: messageOf(error) }),
    ),
  );

/** The first line of a message, trimmed, for the audit log (never a whole script's output). */
const auditMessage = (message: string) =>
  (message.split("\n")[0] ?? "").trim().slice(0, AUDIT_MESSAGE_CHARS);

const RUN_EVENTS: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "run.created",
  "run.updated",
  "thread.move-updated",
]);

export const layer: Layer.Layer<
  ThreadMoves,
  never,
  | EnvironmentExecutor.EnvironmentExecutorRegistry
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ThreadCommandExecutor.ThreadCommandExecutor
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | ProjectCheckouts.ProjectCheckouts
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | SqlClient.SqlClient
> = Layer.effect(
  ThreadMoves,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const registry = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
    // Without agents on the Hub machine, a summary its offline source cannot write is the target's.
    const hubRunsAgents = yield* HubRunsAgents.HubRunsAgents;
    const eventSink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const checkouts = yield* ProjectCheckouts.ProjectCheckouts;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    // The server provides these; orchestration-only hosts have no joined machines or audit log.
    const remote = yield* Effect.serviceOption(RemoteEnvironments.RemoteEnvironments);
    const audit = yield* Effect.serviceOption(AuditLog.AuditLog);
    const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    // A Thread without a Project moves its scratch workspace through its own repository.
    const repositories = yield* Effect.serviceOption(HubRepository.HubRepositories);
    // Spec 5 ticket 05: a handoff is stored with the Thread's secret values as `[NAME]`.
    const secretMasker = yield* Effect.serviceOption(SecretMasker.SecretMasker);
    const scratchOf = (thread: OrchestrationV2AppThread) =>
      Option.isNone(repositories)
        ? Effect.succeed(undefined)
        : repositories.value.threads
            .scratchWorkspaceOf(thread.id)
            .pipe(Effect.mapError((error) => new MoveStepFailure({ message: error.message })));
    const scope = yield* Effect.scope;
    const running = new Set<ThreadId>();

    const nameOf = Effect.fn("ThreadMoves.nameOf")(function* (environmentId: EnvironmentId | null) {
      if (environmentId === null) return "no Environment";
      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM environments WHERE environment_id = ${environmentId}
      `.pipe(Effect.orElseSucceed(() => []));
      return (
        rows[0]?.name ??
        (environmentId === HUB_MACHINE_ENVIRONMENT_ID ? "Hub machine" : environmentId)
      );
    });

    const actorNameOf = Effect.fn("ThreadMoves.actorNameOf")(function* (
      userId: UserId | undefined,
    ) {
      if (userId === undefined) return undefined;
      const rows = yield* sql<{ readonly name: string }>`
        SELECT display_name AS name FROM users WHERE user_id = ${userId}
      `.pipe(Effect.orElseSucceed(() => []));
      return rows[0]?.name;
    });

    /**
     * The Environment's executor once it is connected; with a grace, waits for it to say hello
     * (after a restart, or for a target), none when it does not in time.
     */
    const awaitExecutor = Effect.fn("ThreadMoves.awaitExecutor")(function* (
      environmentId: EnvironmentId,
      grace: Duration.Duration | null,
    ) {
      const now = yield* Effect.option(registry.get(environmentId));
      if (Option.isSome(now) || grace === null) return now;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* registry.changes;
          while (true) {
            const found = yield* Effect.option(registry.get(environmentId));
            if (Option.isSome(found)) return found;
            yield* PubSub.take(changes);
          }
        }),
      ).pipe(Effect.timeoutOption(grace), Effect.map(Option.flatten));
    });

    /** Waits, within the grace, for the Environment to connect again after it dropped. */
    const awaitReconnect = Effect.fn("ThreadMoves.awaitReconnect")(function* (
      environmentId: EnvironmentId,
    ) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* registry.changes;
          while (true) {
            yield* PubSub.take(changes);
            if (Option.isSome(yield* Effect.option(registry.get(environmentId)))) return;
          }
        }),
      ).pipe(Effect.timeoutOption(RECONNECT_GRACE));
    });

    /** The Thread and its move as the projection has them now; none once no move runs. */
    const current = Effect.fn("ThreadMoves.current")(function* (threadId: ThreadId) {
      const thread = yield* projections.getThread(threadId);
      const move = thread.move;
      if (move == null || move.status !== "running") return Option.none();
      return Option.some({ thread, move });
    });

    /** The latest run of the Thread: a move's timeline items go after its last turn. */
    const latestRunOf = Effect.fn("ThreadMoves.latestRunOf")(function* (threadId: ThreadId) {
      const { runs } = yield* projections
        .getThreadRecords(threadId, ["runs"], { turnItemTypes: [] })
        .pipe(Effect.orDie);
      return runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
    });

    /**
     * Records a change to the running move (and the events `build` adds), under the Thread's
     * lock, only while the move is still the one this run follows.
     */
    const update = Effect.fn("ThreadMoves.update")(function* (
      threadId: ThreadId,
      moveId: string,
      build: (input: {
        readonly thread: OrchestrationV2AppThread;
        readonly move: OrchestrationV2ThreadMove;
        readonly now: DateTime.Utc;
      }) => Effect.Effect<{
        readonly thread: OrchestrationV2AppThread;
        readonly extra?: ReadonlyArray<OrchestrationV2DomainEvent>;
      }>,
    ) {
      return yield* threadLocks.withLock(
        threadId,
        Effect.gen(function* () {
          const thread = yield* projections.getThread(threadId);
          const move = thread.move;
          if (move == null || move.id !== moveId || move.status !== "running") return false;
          const now = yield* DateTime.now;
          const built = yield* build({ thread, move, now });
          yield* eventSink.write({
            events: [
              {
                id: yield* ids.allocate.event({ threadId }),
                type: "thread.move-updated",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: now,
                payload: built.thread,
              },
              ...(built.extra ?? []),
            ],
          });
          return true;
        }),
      );
    });

    const advance = (
      threadId: ThreadId,
      moveId: string,
      changes: Partial<OrchestrationV2ThreadMove>,
      extra?: (now: DateTime.Utc) => Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>>,
    ) =>
      update(threadId, moveId, ({ thread, move, now }) =>
        Effect.gen(function* () {
          return {
            thread: {
              ...thread,
              move: { ...move, ...changes, updatedAt: DateTime.formatIso(now) },
            },
            ...(extra === undefined ? {} : { extra: yield* extra(now) }),
          };
        }),
      );

    /** A timeline item after the Thread's last turn. */
    const timelineEvent = Effect.fn("ThreadMoves.timelineEvent")(function* (
      thread: OrchestrationV2AppThread,
      now: DateTime.Utc,
      runId: RunId | null,
      item: (base: {
        readonly threadId: ThreadId;
        readonly runId: RunId | null;
        readonly nodeId: null;
        readonly providerThreadId: null;
        readonly providerTurnId: null;
        readonly nativeItemRef: null;
        readonly parentItemId: null;
        readonly ordinal: 0;
        readonly startedAt: DateTime.Utc;
        readonly completedAt: DateTime.Utc;
        readonly updatedAt: DateTime.Utc;
      }) => OrchestrationV2TurnItem,
    ) {
      return {
        id: yield* ids.allocate.event({ threadId: thread.id }).pipe(Effect.orDie),
        type: "turn-item.updated",
        threadId: thread.id,
        ...(runId === null ? {} : { runId }),
        providerInstanceId: thread.providerInstanceId,
        occurredAt: now,
        payload: item({
          threadId: thread.id,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        }),
      } satisfies OrchestrationV2DomainEvent;
    });

    const recordAudit = (
      thread: OrchestrationV2AppThread,
      move: OrchestrationV2ThreadMove,
      outcome: "started" | "switched" | "failed" | "cancelled",
    ) =>
      Option.match(audit, {
        onNone: () => Effect.void,
        onSome: (log) =>
          // A move always has its User (the Orchestrator refuses one without).
          move.actorUserId === undefined
            ? Effect.logWarning("A Thread move without its User was not audited", {
                threadId: thread.id,
              })
            : log
                .record({
                  actor: AuditLog.userActor(move.actorUserId),
                  action: "thread.move",
                  target: { kind: "thread", id: thread.id, name: thread.title },
                  ...(thread.spaceId === undefined ? {} : { spaceId: thread.spaceId }),
                  detail: {
                    from: move.sourceEnvironmentId,
                    to: move.targetEnvironmentId,
                    outcome,
                    ...(move.failure === undefined
                      ? {}
                      : {
                          failedStep: move.failure.step,
                          failureMessage: auditMessage(move.failure.message),
                        }),
                    ...(move.continuesFrom === undefined
                      ? {}
                      : {
                          continuesFrom: move.continuesFrom.kind,
                          continuesFromRef: move.continuesFrom.ref,
                        }),
                    ...(move.sourceOffline === undefined
                      ? {}
                      : { sourceOffline: move.sourceOffline }),
                    ...(move.setAsideRefs === undefined || move.setAsideRefs.length === 0
                      ? {}
                      : { setAside: move.setAsideRefs.join(" ").slice(0, 1_000) }),
                  },
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Could not record a Thread move in the audit log", {
                      threadId: thread.id,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                ),
      });

    /** The move ended without a switch, or with one: queued messages start where it now runs. */
    const resumeQueue = orchestrator.resumeQueuedRuns.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not resume queued runs after a Thread move", {
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.asVoid,
    );

    /** A move's written handoff is kept only until its switch (or its end without one). */
    const dropHandoff = (moveId: string) =>
      sql`DELETE FROM orchestration_v2_move_handoffs WHERE move_id = ${moveId}`.pipe(Effect.ignore);

    const fail = Effect.fn("ThreadMoves.fail")(function* (
      threadId: ThreadId,
      moveId: string,
      step: OrchestrationV2ThreadMoveStep,
      message: string,
    ) {
      yield* Effect.logWarning("A Thread move failed", { threadId, moveId, step, message });
      let failed:
        | { readonly thread: OrchestrationV2AppThread; readonly move: OrchestrationV2ThreadMove }
        | undefined;
      yield* update(threadId, moveId, ({ thread, move, now }) => {
        const next: OrchestrationV2ThreadMove = {
          ...move,
          status: "failed",
          updatedAt: DateTime.formatIso(now),
          failure: { step, message: message.slice(0, 4_000) },
        };
        failed = { thread, move: next };
        return Effect.succeed({ thread: { ...thread, move: next } });
      });
      if (failed !== undefined) yield* recordAudit(failed.thread, failed.move, "failed");
      yield* dropHandoff(moveId);
      yield* resumeQueue;
    });

    /**
     * Leaves `waiting-for-turn` through the Orchestrator, which decides it with the Thread's runs
     * (`thread.move.advance`), so no run starts between the check and the step. Until then it
     * wakes on each change to the Thread's runs; with `stop` it stops the turn once.
     */
    const waitForTurn = Effect.fn("ThreadMoves.waitForTurn")(function* (
      threadId: ThreadId,
      move: OrchestrationV2ThreadMove,
      restarted: boolean,
    ) {
      let stopped = false;
      for (let attempt = 1; ; attempt += 1) {
        const afterSequence = yield* eventSink.latestSequence({ threadId });
        const sourceOnline =
          move.sourceEnvironmentId !== null &&
          Option.isSome(
            yield* awaitExecutor(move.sourceEnvironmentId, restarted ? RECONNECT_GRACE : null),
          );
        const advanced = yield* orchestrator
          .dispatch({
            type: "thread.move.advance",
            commandId: CommandId.make(`${move.id}:advance:${attempt}`),
            threadId,
            moveId: move.id,
            sourceOnline,
          })
          .pipe(Effect.result);
        if (advanced._tag === "Success") return;
        const still = yield* current(threadId);
        if (
          Option.isNone(still) ||
          still.value.move.id !== move.id ||
          still.value.move.step !== "waiting-for-turn"
        ) {
          return;
        }
        // Say what it waits on: a turn that asks the User something waits for their answer.
        const { runs } = yield* projections.getThreadRecords(threadId, ["runs"], {
          turnItemTypes: [],
        });
        const waitingOn = runs.some((run) => run.status === "waiting") ? "user" : "turn";
        if (still.value.move.waitingOn !== waitingOn) {
          yield* advance(threadId, move.id, { waitingOn });
        }
        if (move.ifRunning === "stop" && !stopped && !sourceOnline) {
          // The turn is paused on a machine that is away: nothing can reach it to stop it, so
          // its sessions end here and the turn is interrupted; the machine drops them on return.
          stopped = true;
          if (Option.isSome(remote) && move.sourceEnvironmentId !== null) {
            yield* remote.value.abandonSessions(move.sourceEnvironmentId, threadId);
          }
          // Whatever the Hub still knew of them (nothing, after a restart), the turn ends here.
          yield* interruptRunsOnHub(orchestrator, {
            threadId,
            reason: `This turn was paused on ${yield* nameOf(move.sourceEnvironmentId)}, which was offline, and was stopped to move the Thread.`,
            key: `${move.id}:offline-stop`,
          });
        }
        if (move.ifRunning === "stop" && !stopped) {
          stopped = true;
          yield* orchestrator
            .dispatch({
              type: "thread.stop",
              commandId: CommandId.make(`${move.id}:stop`),
              threadId,
              reason: "Stopped to move the Thread to another Environment.",
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not stop the Thread's turn for its move", {
                  threadId,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
        }
        yield* orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
          Stream.filter(({ event }) => RUN_EVENTS.has(event.type)),
          Stream.runHead,
          Effect.timeoutOption(TURN_RECHECK),
        );
      }
    });

    /** The Thread's workspace on `executor`: its worktree there, else the Project's checkout. */
    const workspaceOn = Effect.fn("ThreadMoves.workspaceOn")(function* (
      executor: EnvironmentExecutor.EnvironmentExecutor,
      thread: OrchestrationV2AppThread,
    ) {
      const worktree = yield* EnvironmentExecutor.worktreeOn(registry, checkouts, executor, thread);
      if (worktree !== null) return worktree;
      const checkout = yield* executor.workspace.paths.checkout(thread.projectId);
      if (Option.isNone(checkout)) {
        return yield* new MoveStepFailure({
          message: "The Project has no checkout on the source Environment.",
        });
      }
      return checkout.value;
    });

    /** Captures the workspace on the source, manual changes included, and uploads it. */
    const finalCheckpoint = Effect.fn("ThreadMoves.finalCheckpoint")(function* (
      thread: OrchestrationV2AppThread,
      move: OrchestrationV2ThreadMove,
      restarted: boolean,
    ) {
      if (move.sourceEnvironmentId === null) return yield* new SourceOffline();
      // After a restart the source may just not have said hello yet: it is unknown, not offline.
      const executor = yield* awaitExecutor(
        move.sourceEnvironmentId,
        restarted ? RECONNECT_GRACE : null,
      );
      if (Option.isNone(executor)) return yield* new SourceOffline();
      const ref = finalCheckpointRef(thread.id, move.id);
      const asStep = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((error) =>
            isUnavailable(error) || isSourceOffline(error)
              ? new SourceOffline()
              : isMoveStepFailure(error)
                ? error
                : new MoveStepFailure({ message: messageOf(error) }),
          ),
        );
      const source = executor.value;
      const cwd = yield* asStep(workspaceOn(source, thread));
      const scratch = yield* scratchOf(thread);
      // A folder from before folders got git gets its repository first, so it can move.
      if (scratch !== undefined) yield* asStep(source.workspace.hubRepository.ensureScratch(cwd));
      yield* asStep(source.workspace.checkpoints.captureCheckpoint({ cwd, checkpointRef: ref }));
      // A folder's own branches and HEAD go with it.
      const published =
        scratch === undefined
          ? { refs: [], nested: [] }
          : yield* asStep(
              source.workspace.move.publishScratch({
                cwd,
                prefix: HubRepository.scratchHistoryPrefix(thread.id, move.id),
              }),
            );
      yield* asStep(
        source.workspace.hubRepository.push({
          cwd,
          projectId: thread.projectId,
          ...(scratch === undefined ? {} : { scratchThreadId: scratch.threadId }),
          checkpointRefs: [ref, ...published.refs],
        }),
      );
      return {
        checkpoint: {
          kind: "final",
          ref,
          appRunOrdinal: null,
        } satisfies OrchestrationV2ThreadMoveCheckpoint,
        nested: published.nested,
      };
    });

    /** The newest checkpoint of the Thread the Hub repository has. */
    const lastUploaded = Effect.fn("ThreadMoves.lastUploaded")(function* (threadId: ThreadId) {
      const rows = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM orchestration_v2_projection_checkpoints
        WHERE thread_id = ${threadId} AND status = 'ready' AND uploaded_to_hub = 1
      `;
      let best:
        | { readonly ref: CheckpointRef; readonly appRunOrdinal: number; readonly at: number }
        | undefined;
      for (const row of rows) {
        const checkpoint = yield* decodeCheckpoint(row.payload).pipe(Effect.option);
        if (Option.isNone(checkpoint)) continue;
        const ordinal = checkpoint.value.appRunOrdinal ?? 0;
        const at = DateTime.toEpochMillis(checkpoint.value.capturedAt);
        if (
          best === undefined ||
          ordinal > best.appRunOrdinal ||
          (ordinal === best.appRunOrdinal && at > best.at)
        ) {
          best = { ref: checkpoint.value.ref, appRunOrdinal: ordinal, at };
        }
      }
      return best === undefined
        ? ({ kind: "none", ref: null, appRunOrdinal: null } as const)
        : ({ kind: "uploaded", ref: best.ref, appRunOrdinal: best.appRunOrdinal } as const);
    });

    /** The target's executor; a target that is not connected yet gets the grace to say hello. */
    const targetOf = (move: OrchestrationV2ThreadMove) =>
      awaitExecutor(move.targetEnvironmentId, RECONNECT_GRACE).pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              nameOf(move.targetEnvironmentId).pipe(
                Effect.flatMap((name) =>
                  Effect.fail(new MoveStepFailure({ message: `${name} is offline.` })),
                ),
              ),
          }),
        ),
      );

    /** The Project's setup script as normal setup resolves it, with the User's settings. */
    const setupScriptOf = Effect.fn("ThreadMoves.setupScriptOf")(function* (
      thread: OrchestrationV2AppThread,
    ) {
      const project = Option.flatten(yield* projects.get(thread.projectId).pipe(Effect.option));
      if (Option.isNone(project)) return null;
      const scripts = Option.isSome(settings)
        ? yield* settings.value.getSettings.pipe(
            Effect.map((current) =>
              resolveProjectScripts(current, {
                id: project.value.projectId,
                scripts: project.value.scripts,
              }),
            ),
            Effect.orElseSucceed(() => project.value.scripts),
          )
        : project.value.scripts;
      const script = setupProjectScript(scripts);
      return script === null ? null : { name: script.name, command: script.command };
    });

    /** Puts the Thread on its target in one batch; then the source's sessions let go of it. */
    const switchOver = Effect.fn("ThreadMoves.switchOver")(function* (
      threadId: ThreadId,
      moveId: string,
    ) {
      let switched:
        | {
            readonly thread: OrchestrationV2AppThread;
            readonly move: OrchestrationV2ThreadMove;
            readonly sessionIds: ReadonlyArray<ProviderSessionId>;
          }
        | undefined;
      yield* update(threadId, moveId, ({ thread, move, now }) =>
        Effect.gen(function* () {
          const { runs, providerSessions } = yield* projections
            .getThreadRecords(threadId, ["runs", "providerSessions"], { turnItemTypes: [] })
            .pipe(Effect.orDie);
          const live = providerSessions.filter(
            (session) => session.status !== "stopped" && session.status !== "error",
          );
          const latestRun = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
          const sourceName = yield* nameOf(move.sourceEnvironmentId);
          const targetName = yield* nameOf(move.targetEnvironmentId);
          const actorName = yield* actorNameOf(move.actorUserId);
          const continuesFrom: OrchestrationV2ThreadMoveCheckpoint = move.continuesFrom ?? {
            kind: "none",
            ref: null,
            appRunOrdinal: null,
          };
          const next: OrchestrationV2ThreadMove = {
            ...move,
            step: "switched",
            status: "switched",
            updatedAt: DateTime.formatIso(now),
          };
          const { activeEnvironmentId: _previous, ...rest } = thread;
          const moved: OrchestrationV2AppThread = {
            ...rest,
            // Absent means the Hub machine, as for Threads from before Environments.
            ...(move.targetEnvironmentId === HUB_MACHINE_ENVIRONMENT_ID
              ? {}
              : { activeEnvironmentId: move.targetEnvironmentId }),
            // A moved Thread always works in its own worktree on the target.
            ...(move.targetWorktreePath === undefined
              ? {}
              : { worktreePath: move.targetWorktreePath }),
            // The source's native conversation stays there; the target starts its own.
            activeProviderThreadId: null,
            move: next,
          };
          const extra: Array<OrchestrationV2DomainEvent> = [];
          for (const session of live) {
            extra.push({
              id: yield* ids.allocate.event({ threadId }).pipe(Effect.orDie),
              type: "provider-session.detached",
              threadId,
              driver: session.driver,
              providerInstanceId: session.providerInstanceId,
              occurredAt: now,
              payload: {
                providerSessionId: session.id,
                detachedAt: now,
                reason: "The Thread moved to another Environment.",
              },
            });
          }
          extra.push(
            yield* timelineEvent(thread, now, latestRun?.id ?? null, (base) => ({
              ...base,
              id: TurnItemId.make(`turn-item:environment-move:${moveId}`),
              status: "completed",
              title: `Moved from ${sourceName} to ${targetName}`,
              type: "environment_move",
              moveId,
              sourceEnvironmentId: move.sourceEnvironmentId,
              sourceEnvironmentName: sourceName,
              targetEnvironmentId: move.targetEnvironmentId,
              targetEnvironmentName: targetName,
              ...(move.actorUserId === undefined ? {} : { actorUserId: move.actorUserId }),
              ...(actorName === undefined ? {} : { actorName }),
              continuesFrom,
              sourceOffline: move.sourceOffline === true,
              ...(move.setAsideRefs === undefined || move.setAsideRefs.length === 0
                ? {}
                : { setAsideRefs: move.setAsideRefs }),
            })),
          );
          // What the agent on the target is told, so the User can read it; its first turn
          // there reads it from this item.
          const handoff = yield* storedHandoff(moveId);
          if (Option.isSome(handoff)) {
            const written = handoff.value;
            extra.push(
              yield* timelineEvent(thread, now, latestRun?.id ?? null, (base) => ({
                ...base,
                id: TurnItemId.make(MoveHandoff.moveHandoffItemId(moveId)),
                status: "completed",
                title: `Handoff to ${targetName}: notes ${MoveHandoff.writerLabel({
                  writtenBy: written.writtenBy,
                  writerName: written.writerEnvironmentName,
                  writerProviderInstanceId: written.writerProviderInstanceId,
                })}`,
                type: "environment_handoff",
                moveId,
                writtenBy: written.writtenBy,
                writerEnvironmentName: written.writerEnvironmentName,
                writerProviderInstanceId: written.writerProviderInstanceId,
                sourceEnvironmentName: sourceName,
                targetEnvironmentName: targetName,
                summary: written.summary,
                context: written.context,
                recentMessageCount: written.recentMessages.length,
                recentMessages: written.recentMessages,
                ...(written.fallbackReason === undefined
                  ? {}
                  : { fallbackReason: written.fallbackReason }),
              })),
            );
          }
          switched = { thread: moved, move: next, sessionIds: live.map((session) => session.id) };
          return { thread: moved, extra };
        }),
      );
      if (switched === undefined) return;
      const done = switched;
      // The timeline item has it now.
      yield* dropHandoff(moveId);
      // Calls and events are checked anew: the source's late events are refused from now on.
      if (Option.isSome(remote)) yield* remote.value.threadMoved(threadId);
      yield* recordAudit(done.thread, done.move, "switched");
      yield* resumeQueue;
      // The source's sessions let go of the Thread; an offline source drops them when it returns.
      yield* Effect.forEach(
        done.sessionIds,
        (providerSessionId) =>
          sessions
            .detach({
              providerSessionId,
              threadId,
              detail: "The Thread moved to another Environment.",
            })
            .pipe(
              Effect.timeout(DETACH_TIMEOUT),
              Effect.catchCause((cause) =>
                Effect.logInfo("The moved Thread's source session did not detach", {
                  threadId,
                  providerSessionId,
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
        { discard: true },
      ).pipe(Effect.forkIn(scope));
    });

    /**
     * What a Thread without a Project's folder had on the target, set aside by the move, goes to
     * the Hub too (the target may write the Thread's `recovered` refs while its move runs).
     */
    const uploadSetAside = Effect.fn("ThreadMoves.uploadSetAside")(function* (
      thread: OrchestrationV2AppThread,
      move: OrchestrationV2ThreadMove,
      cwd: string,
      refs: ReadonlyArray<string>,
    ) {
      if (refs.length === 0) return;
      const scratch = yield* scratchOf(thread);
      if (scratch === undefined) return;
      const target = yield* targetOf(move);
      yield* asFailure(
        target.workspace.hubRepository.push({
          cwd,
          projectId: thread.projectId,
          scratchThreadId: scratch.threadId,
          checkpointRefs: refs.map((ref) => CheckpointRef.make(ref)),
        }),
      );
    });

    /** A cancelled move: its timeline entry and audit, then the queue goes on where it runs. */
    const cancelled = Effect.fn("ThreadMoves.cancelled")(function* (
      thread: OrchestrationV2AppThread,
      move: OrchestrationV2ThreadMove,
    ) {
      const now = yield* DateTime.now;
      const latestRun = yield* latestRunOf(thread.id);
      const sourceName = yield* nameOf(move.sourceEnvironmentId);
      const targetName = yield* nameOf(move.targetEnvironmentId);
      const actorName = yield* actorNameOf(move.actorUserId);
      yield* eventSink.write({
        events: [
          yield* timelineEvent(thread, now, latestRun?.id ?? null, (base) => ({
            ...base,
            id: TurnItemId.make(`turn-item:environment-move:${move.id}`),
            status: "completed",
            title: `Move to ${targetName} cancelled`,
            type: "environment_move",
            moveId: move.id,
            sourceEnvironmentId: move.sourceEnvironmentId,
            sourceEnvironmentName: sourceName,
            targetEnvironmentId: move.targetEnvironmentId,
            targetEnvironmentName: targetName,
            ...(move.actorUserId === undefined ? {} : { actorUserId: move.actorUserId }),
            ...(actorName === undefined ? {} : { actorName }),
            continuesFrom: move.continuesFrom ?? { kind: "none", ref: null, appRunOrdinal: null },
            sourceOffline: move.sourceOffline === true,
            outcome: "cancelled",
          })),
        ],
      });
      yield* recordAudit(thread, move, "cancelled");
      yield* dropHandoff(move.id);
      yield* resumeQueue;
    });

    const prepare = Effect.fn("ThreadMoves.prepare")(function* (
      thread: OrchestrationV2AppThread,
      move: OrchestrationV2ThreadMove,
    ) {
      const target = yield* targetOf(move);
      const scratch = yield* scratchWithHistory(thread, move);
      const checkout =
        move.targetCheckout ??
        (yield* asFailure(
          target.workspace.move.fetch({
            projectId: thread.projectId,
            refs: [],
            ...(scratch === undefined ? {} : { scratch }),
          }),
        )).checkout;
      return yield* asFailure(
        target.workspace.move.prepare({
          checkout,
          projectId: thread.projectId,
          threadId: thread.id,
          ref: move.continuesFrom?.ref ?? null,
          branch: thread.branch,
          knownWorktree: move.knownWorktrees?.[move.targetEnvironmentId] ?? null,
          // A move keeps what it sets aside apart from the changes a machine hands back.
          setAsidePrefix: `${HubRepository.threadRefPrefixes(thread.id)[1]}move/`,
          // A scratch workspace is the Thread's own folder: no worktree, no setup script.
          setupScript: scratch === undefined ? yield* setupScriptOf(thread) : null,
          ...(scratch === undefined ? {} : { scratch: true }),
          ...(scratch?.history === undefined ? {} : { scratchHistory: scratch.history }),
        }),
      );
    });

    /** The handoff written for the move, if its step already ran (before a restart, say). */
    const storedHandoff = Effect.fn("ThreadMoves.storedHandoff")(function* (moveId: string) {
      const rows = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM orchestration_v2_move_handoffs WHERE move_id = ${moveId}
      `.pipe(Effect.orElseSucceed(() => []));
      const row = rows[0];
      if (row === undefined) return Option.none<MoveHandoff.StoredHandoff>();
      return yield* MoveHandoff.decodeStoredHandoff(row.payload).pipe(Effect.option);
    });

    const storeHandoff = Effect.fn("ThreadMoves.storeHandoff")(function* (
      threadId: ThreadId,
      moveId: string,
      unmasked: MoveHandoff.StoredHandoff,
    ) {
      const handoff = Option.isNone(secretMasker)
        ? unmasked
        : (yield* secretMasker.value.forThread(threadId)).maskDeep(unmasked);
      const payload = yield* MoveHandoff.encodeStoredHandoff(handoff).pipe(Effect.orDie);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO orchestration_v2_move_handoffs (move_id, thread_id, payload_json, created_at)
        VALUES (${moveId}, ${threadId}, ${payload}, ${now})
        ON CONFLICT (move_id) DO UPDATE SET payload_json = excluded.payload_json
      `;
    });

    /**
     * Whether the Hub machine may write this Thread's summary: its provider sign-ins are the
     * Owner's, so only for the Owner's own Threads (and Threads from before Users).
     */
    const hubMayWriteFor = Effect.fn("ThreadMoves.hubMayWriteFor")(function* (
      thread: OrchestrationV2AppThread,
    ) {
      if (thread.ownerUserId === undefined) return true;
      const rows = yield* sql<{ readonly isOwner: number }>`
        SELECT is_owner AS "isOwner" FROM users WHERE user_id = ${thread.ownerUserId}
      `.pipe(Effect.orElseSucceed(() => []));
      return rows[0]?.isOwner === 1;
    });

    /**
     * The notes the target's new session starts from: one model call on the source, or on the Hub
     * machine for the Owner's Threads, secrets redacted, then the recent messages. Any failure
     * (reads included, or a call past its time, then cancelled) assembles them instead.
     */
    const writeHandoff = Effect.fn("ThreadMoves.writeHandoff")(function* (
      thread: OrchestrationV2AppThread,
      move: OrchestrationV2ThreadMove,
    ) {
      const sourceName = yield* nameOf(move.sourceEnvironmentId);
      const targetName = yield* nameOf(move.targetEnvironmentId);
      const assembled = (
        history: MoveHandoff.MoveHistory,
        recent: ReadonlyArray<OrchestrationV2HistoricalMessage>,
        reason: string,
      ): MoveHandoff.StoredHandoff => {
        const summary = MoveHandoff.redactSecrets(
          MoveHandoff.mechanicalSummary({ threadTitle: thread.title, history }),
        );
        return {
          writtenBy: "fallback",
          writerEnvironmentName: null,
          writerProviderInstanceId: null,
          summary,
          context: MoveHandoff.handoffContext({
            sourceName,
            targetName,
            writtenBy: "fallback",
            writerName: null,
            writerProviderInstanceId: null,
            summary,
            recentCount: recent.length,
            historyCount: history.messages.length,
          }),
          recentMessages: recent,
          fallbackReason: auditMessage(reason),
        };
      };
      const written = Effect.gen(function* () {
        const { runs, attempts, turnItems } = yield* projections.getThreadRecords(
          thread.id,
          ["runs", "attempts", "turnItems"],
          { turnItemTypes: ["checkpoint"] },
        );
        const items = yield* projections.getTurnStartHistory(thread.id);
        const history = MoveHandoff.moveHistory(
          MoveHandoff.inConversationOrder(
            visibleConversationItems({ runs, attempts }, [...items, ...turnItems]),
            runs,
          ),
          runs.filter((run) => run.status === "completed").length,
        );
        const recent = MoveHandoff.recentMessages(history.messages);

        // The source writes it while it is online; otherwise the Hub machine, for the Owner only, or
        // (the Hub running no agents) the target, which takes the Thread's history anyway.
        const source =
          move.sourceOffline === true || move.sourceEnvironmentId === null
            ? Option.none<EnvironmentExecutor.EnvironmentExecutor>()
            : yield* awaitExecutor(move.sourceEnvironmentId, null);
        if (Option.isNone(source) && hubRunsAgents && !(yield* hubMayWriteFor(thread))) {
          return assembled(
            history,
            recent,
            "the Hub doesn't write summaries with another User's history",
          );
        }
        const target =
          Option.isSome(source) || hubRunsAgents
            ? Option.none<EnvironmentExecutor.EnvironmentExecutor>()
            : yield* awaitExecutor(move.targetEnvironmentId, null);
        if (Option.isNone(source) && !hubRunsAgents && Option.isNone(target)) {
          return assembled(history, recent, `${targetName} is not connected.`);
        }
        const writer = Option.isSome(source)
          ? { executor: source.value, writtenBy: "source" as const, name: sourceName }
          : Option.isSome(target)
            ? { executor: target.value, writtenBy: "target" as const, name: targetName }
            : yield* registry
                .get(registry.hubMachineEnvironmentId)
                .pipe(
                  Effect.flatMap((executor) =>
                    nameOf(executor.environmentId).pipe(
                      Effect.map((name) => ({ executor, writtenBy: "hub" as const, name })),
                    ),
                  ),
                );
        const textGeneration = writer.executor.textGeneration;
        if (textGeneration === undefined) {
          return assembled(history, recent, `${writer.name} has no text generation.`);
        }
        // The source runs it in the Thread's workspace; the Hub machine and the target in the checkout.
        const cwd = yield* (
          writer.writtenBy === "source"
            ? workspaceOn(writer.executor, thread)
            : writer.executor.workspace.paths
                .checkout(thread.projectId)
                .pipe(Effect.map(Option.getOrElse(() => process.cwd())))
        ).pipe(Effect.orElseSucceed(() => process.cwd()));
        const timeout = handoffTimeoutMs();
        const generated = yield* textGeneration
          .threadHandoff({
            cwd,
            threadTitle: thread.title,
            transcript: MoveHandoff.renderTranscript(history.messages),
            changedFiles: history.changedFiles,
            sourceEnvironmentName: sourceName,
            targetEnvironmentName: targetName,
            modelSelection: thread.modelSelection,
            generationId: `move:${move.id}`,
          })
          .pipe(
            // One key per move: after a restart the machine answers from the call it already ran.
            EnvironmentExecutor.withEffectAttempt({ effectId: `move:${move.id}:handoff` }),
            Effect.mapError(messageOf),
            // Past its time the call is interrupted, which cancels it on the machine.
            Effect.timeoutOrElse({
              duration: Duration.millis(timeout),
              orElse: () => Effect.fail("Writing the summary took too long."),
            }),
            Effect.result,
          );
        if (generated._tag === "Failure") return assembled(history, recent, generated.failure);
        const summary = MoveHandoff.redactSecrets(generated.success.summary.trim());
        if (summary.length === 0) return assembled(history, recent, "The summary came back empty.");
        const writerProviderInstanceId =
          generated.success.providerInstanceId ?? thread.modelSelection.instanceId;
        return {
          writtenBy: writer.writtenBy,
          writerEnvironmentName: writer.name,
          writerProviderInstanceId,
          summary,
          context: MoveHandoff.handoffContext({
            sourceName,
            targetName,
            writtenBy: writer.writtenBy,
            writerName: writer.name,
            writerProviderInstanceId,
            summary,
            recentCount: recent.length,
            historyCount: history.messages.length,
          }),
          recentMessages: recent,
        } satisfies MoveHandoff.StoredHandoff;
      });
      const handoff = yield* written.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => {
            const reason = Option.getOrElse(Cause.findErrorOption(cause), () =>
              Cause.pretty(cause),
            );
            return Effect.succeed(
              assembled(
                { messages: [], changedFiles: [], completedTurns: 0 },
                [],
                `The history could not be read: ${messageOf(reason)}`,
              ),
            );
          },
        ),
      );
      if (handoff.writtenBy === "fallback") {
        yield* Effect.logWarning("A moved Thread's handoff notes were assembled instead", {
          threadId: thread.id,
          moveId: move.id,
          reason: handoff.fallbackReason,
        });
      }
      return handoff;
    });

    /** A Thread without a Project's folder, with its history when the source published it. */
    const scratchWithHistory = (
      thread: OrchestrationV2AppThread,
      move: OrchestrationV2ThreadMove,
    ) =>
      scratchOf(thread).pipe(
        Effect.map((scratch): MoveFetchInput["scratch"] =>
          scratch === undefined
            ? undefined
            : move.continuesFrom?.kind === "final"
              ? { ...scratch, history: HubRepository.scratchHistoryPrefix(thread.id, move.id) }
              : scratch,
        ),
      );

    /** The workflow from the step the Thread records, to the switch or a failure. */
    const runMove = Effect.fn("ThreadMoves.run")(function* (
      threadId: ThreadId,
      restarted: boolean,
    ) {
      while (true) {
        const found = yield* current(threadId);
        if (Option.isNone(found)) return;
        const { thread, move } = found.value;
        const failed = (error: MoveStepFailure) =>
          fail(threadId, move.id, move.step, error.message);
        switch (move.step) {
          case "waiting-for-turn":
            yield* waitForTurn(threadId, move, restarted);
            break;
          case "final-checkpoint": {
            let outcome = yield* Effect.result(finalCheckpoint(thread, move, restarted));
            // After a restart the source's old socket may still be closing when the move asks:
            // it gets the grace to come back before the move goes on without it.
            if (
              restarted &&
              outcome._tag === "Failure" &&
              isSourceOffline(outcome.failure) &&
              move.sourceEnvironmentId !== null
            ) {
              yield* awaitReconnect(move.sourceEnvironmentId);
              outcome = yield* Effect.result(finalCheckpoint(thread, move, restarted));
            }
            if (outcome._tag === "Success") {
              const { nested } = outcome.success;
              yield* advance(
                threadId,
                move.id,
                { step: "fetching", continuesFrom: outcome.success.checkpoint },
                // Repositories nested in a folder are in no checkpoint: the Thread says so.
                nested.length === 0
                  ? undefined
                  : (now) =>
                      latestRunOf(threadId).pipe(
                        Effect.flatMap((latestRun) =>
                          timelineEvent(thread, now, latestRun?.id ?? null, (base) => ({
                            ...base,
                            id: TurnItemId.make(`turn-item:environment-move-nested:${move.id}`),
                            status: "completed",
                            title: "Nested repositories stay behind",
                            type: "system_notice",
                            message: `These folders are git repositories of their own, so their contents do not move: ${nested.join(", ")}.`,
                          })),
                        ),
                        Effect.map((event) => [event]),
                      ),
              );
            } else if (isSourceOffline(outcome.failure)) {
              yield* advance(threadId, move.id, { step: "fetching", sourceOffline: true });
            } else {
              return yield* failed(outcome.failure);
            }
            break;
          }
          case "fetching": {
            const continuesFrom: OrchestrationV2ThreadMoveCheckpoint =
              move.continuesFrom ??
              (yield* lastUploaded(threadId).pipe(
                Effect.orElseSucceed(
                  () => ({ kind: "none", ref: null, appRunOrdinal: null }) as const,
                ),
              ));
            if (move.continuesFrom === undefined) {
              // Recorded before it is fetched, so the Thread shows what it will continue from.
              yield* advance(threadId, move.id, { continuesFrom });
            }
            const fetched = yield* Effect.result(
              Effect.all([targetOf(move), scratchWithHistory(thread, move)]).pipe(
                Effect.flatMap(([target, scratch]) =>
                  asFailure(
                    target.workspace.move.fetch({
                      projectId: thread.projectId,
                      refs: continuesFrom.ref === null ? [] : [continuesFrom.ref],
                      ...(scratch === undefined ? {} : { scratch }),
                    }),
                  ),
                ),
              ),
            );
            if (fetched._tag === "Failure") return yield* failed(fetched.failure);
            yield* advance(threadId, move.id, {
              step: "preparing",
              targetCheckout: fetched.success.checkout,
            });
            break;
          }
          case "preparing": {
            const prepared = yield* Effect.result(
              prepare(thread, move).pipe(
                Effect.tap((result) =>
                  uploadSetAside(thread, move, result.cwd, result.setAsideRefs),
                ),
              ),
            );
            if (prepared._tag === "Failure") return yield* failed(prepared.failure);
            const { setupScript } = prepared.success;
            yield* advance(
              threadId,
              move.id,
              {
                step: "handoff",
                targetWorktreePath: prepared.success.cwd,
                ...(prepared.success.setAsideRefs.length === 0
                  ? {}
                  : { setAsideRefs: prepared.success.setAsideRefs }),
              },
              // The setup script's output shows in the Thread, as normal setup's does.
              setupScript.status !== "succeeded"
                ? undefined
                : (now) =>
                    latestRunOf(threadId).pipe(
                      Effect.flatMap((latestRun) =>
                        timelineEvent(thread, now, latestRun?.id ?? null, (base) => ({
                          ...base,
                          id: TurnItemId.make(`turn-item:environment-move-setup:${move.id}`),
                          status: "completed",
                          title: `Setup script: ${setupScript.name ?? "setup"}`,
                          type: "command_execution",
                          input: `Setup script: ${setupScript.name ?? "setup"}`,
                          output: setupScript.output ?? "",
                          exitCode: 0,
                        })),
                      ),
                      Effect.map((event) => [event]),
                    ),
            );
            break;
          }
          // What the agent on the target is told; the switch delivers it to its first session.
          case "handoff": {
            // Kept as soon as it is written: a restart after this reuses it, never pays again.
            const stored = yield* storedHandoff(move.id);
            const handoff = Option.isSome(stored)
              ? stored.value
              : yield* writeHandoff(thread, move);
            if (Option.isNone(stored)) yield* storeHandoff(threadId, move.id, handoff);
            // Every client gets the Thread's shell: it carries who wrote it and a preview only.
            yield* advance(threadId, move.id, {
              step: "switched",
              handoff: {
                writtenBy: handoff.writtenBy,
                writerEnvironmentName: handoff.writerEnvironmentName,
                writerProviderInstanceId: handoff.writerProviderInstanceId,
                preview: Array.from(handoff.summary)
                  .slice(0, MoveHandoff.HANDOFF_PREVIEW_CHARS)
                  .join(""),
                ...(handoff.fallbackReason === undefined
                  ? {}
                  : { fallbackReason: handoff.fallbackReason }),
              },
            });
            break;
          }
          case "switched":
            yield* switchOver(threadId, move.id);
            return;
        }
      }
    });

    const resume: ThreadMovesShape["resume"] = (threadId, options) =>
      Effect.suspend(() => {
        if (running.has(threadId)) return Effect.void;
        running.add(threadId);
        return runMove(threadId, options?.restarted === true).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.gen(function* () {
                  // An unexpected failure still ends the move, so the Thread never stays stuck.
                  const found = yield* current(threadId).pipe(
                    Effect.orElseSucceed(() => Option.none()),
                  );
                  if (Option.isNone(found)) return;
                  yield* fail(
                    threadId,
                    found.value.move.id,
                    found.value.move.step,
                    `The move stopped unexpectedly: ${Cause.pretty(cause).slice(0, 500)}`,
                  ).pipe(Effect.ignore);
                }),
          ),
          Effect.ensuring(Effect.sync(() => running.delete(threadId))),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      });

    // A move starts as soon as the Orchestrator records it; a cancelled one is noted.
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event) => {
        if (event.type !== "thread.move-updated") return Effect.void;
        const move = event.payload.move;
        if (move == null) return Effect.void;
        if (move.status === "cancelled") {
          return cancelled(event.payload, move).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not note a cancelled Thread move", {
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }
        if (move.status !== "running" || move.step !== "waiting-for-turn" || move.waitingOn) {
          return Effect.void;
        }
        return recordAudit(event.payload, move, "started").pipe(
          Effect.andThen(resume(event.threadId)),
        );
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Thread moves stopped following the orchestration", {
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.forkIn(scope),
    );

    // Moves a previous run left in progress go on from the step they recorded, once their
    // machines had the chance to say hello again.
    yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.move.status') = 'running'
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => resume(ThreadId.make(row.threadId), { restarted: true }), {
          discard: true,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not list the Thread moves left in progress", { cause }),
      ),
      Effect.forkIn(scope),
    );

    return ThreadMoves.of({ resume });
  }),
);
