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
  type OrchestrationV2ThreadMove,
  type OrchestrationV2ThreadMoveCheckpoint,
  type OrchestrationV2ThreadMoveStep,
  type OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
  type UserId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AuditLog from "../audit/AuditLog.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

/** How often a move waiting for the turn looks again. */
const TURN_POLL = Duration.millis(500);
const DETACH_TIMEOUT = Duration.seconds(30);
const UNFINISHED_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

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
  /** Runs (or resumes) the Thread's move, if one is running, in the background. */
  readonly resume: (threadId: ThreadId) => Effect.Effect<void>;
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

/** The last folder name of a path from any machine. */
const baseName = (path: string) => path.split(/[\\/]/).findLast((part) => part.length > 0) ?? path;

const asFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      isMoveStepFailure(error) ? error : new MoveStepFailure({ message: messageOf(error) }),
    ),
  );

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

    /** The Thread and its move as the projection has them now; none once no move runs. */
    const current = Effect.fn("ThreadMoves.current")(function* (threadId: ThreadId) {
      const thread = yield* projections.getThread(threadId);
      const move = thread.move;
      if (move == null || move.status !== "running") return Option.none();
      return Option.some({ thread, move });
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
      changes: Partial<OrchestrationV2ThreadMove> & {
        readonly step: OrchestrationV2ThreadMoveStep;
      },
    ) =>
      update(threadId, moveId, ({ thread, move, now }) =>
        Effect.succeed({
          thread: { ...thread, move: { ...move, ...changes, updatedAt: DateTime.formatIso(now) } },
        }),
      );

    const recordAudit = (
      thread: OrchestrationV2AppThread,
      move: OrchestrationV2ThreadMove,
      outcome: "switched" | "failed",
      failedStep?: OrchestrationV2ThreadMoveStep,
    ) =>
      Option.match(audit, {
        onNone: () => Effect.void,
        onSome: (log) =>
          log
            .record({
              actor:
                move.actorUserId === undefined
                  ? { source: "system" }
                  : AuditLog.userActor(move.actorUserId),
              action: "thread.move",
              target: { kind: "thread", id: thread.id, name: thread.title },
              ...(thread.spaceId === undefined ? {} : { spaceId: thread.spaceId }),
              detail: {
                from: move.sourceEnvironmentId,
                to: move.targetEnvironmentId,
                outcome,
                ...(failedStep === undefined ? {} : { failedStep }),
                ...(move.continuesFrom === undefined
                  ? {}
                  : { continuesFrom: move.continuesFrom.kind }),
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
          failure: { step, message: message.slice(0, 2_000) },
        };
        failed = { thread, move: next };
        return Effect.succeed({ thread: { ...thread, move: next } });
      });
      if (failed !== undefined) yield* recordAudit(failed.thread, failed.move, "failed", step);
    });

    /** Waits until the Thread has no unfinished run; with `stop`, stops its work once. */
    const waitForTurn = Effect.fn("ThreadMoves.waitForTurn")(function* (
      threadId: ThreadId,
      move: OrchestrationV2ThreadMove,
    ) {
      let stopped = false;
      while (true) {
        const { runs } = yield* projections.getThreadRecords(threadId, ["runs"], {
          turnItemTypes: [],
        });
        if (!runs.some((run) => UNFINISHED_RUN_STATUSES.has(run.status))) return;
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
        yield* Effect.sleep(TURN_POLL);
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
    ) {
      if (move.sourceEnvironmentId === null) return yield* new SourceOffline();
      const executor = yield* registry
        .get(move.sourceEnvironmentId)
        .pipe(Effect.mapError(() => new SourceOffline()));
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
      const cwd = yield* asStep(workspaceOn(executor, thread));
      yield* asStep(executor.workspace.checkpoints.captureCheckpoint({ cwd, checkpointRef: ref }));
      yield* asStep(
        executor.workspace.hubRepository.push({
          cwd,
          projectId: thread.projectId,
          checkpointRefs: [ref],
        }),
      );
      return {
        kind: "final",
        ref,
        appRunOrdinal: null,
      } satisfies OrchestrationV2ThreadMoveCheckpoint;
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

    const targetOf = (move: OrchestrationV2ThreadMove) =>
      registry
        .get(move.targetEnvironmentId)
        .pipe(
          Effect.catch(() =>
            nameOf(move.targetEnvironmentId).pipe(
              Effect.flatMap((name) =>
                Effect.fail(new MoveStepFailure({ message: `${name} went offline.` })),
              ),
            ),
          ),
        );

    /** Puts the Thread on its target in one batch; then the source's sessions let go of it. */
    const switchOver = Effect.fn("ThreadMoves.switchOver")(function* (
      threadId: ThreadId,
      moveId: string,
    ) {
      let switched:
        | {
            readonly thread: OrchestrationV2AppThread;
            readonly move: OrchestrationV2ThreadMove;
            readonly sessionIds: ReadonlyArray<OrchestrationV2DomainEvent["threadId"] | string>;
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
            ...(thread.worktreePath !== null && move.targetWorktreePath !== undefined
              ? { worktreePath: move.targetWorktreePath }
              : {}),
            // The source's native conversation stays there; the target starts its own.
            activeProviderThreadId: null,
            move: next,
          };
          const item: OrchestrationV2TurnItem = {
            id: TurnItemId.make(`turn-item:environment-move:${moveId}`),
            threadId,
            runId: latestRun?.id ?? null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: `Moved from ${sourceName} to ${targetName}`,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
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
          extra.push({
            id: yield* ids.allocate.event({ threadId }).pipe(Effect.orDie),
            type: "turn-item.updated",
            threadId,
            ...(latestRun === undefined ? {} : { runId: latestRun.id }),
            providerInstanceId: thread.providerInstanceId,
            occurredAt: now,
            payload: item,
          });
          switched = { thread: moved, move: next, sessionIds: live.map((session) => session.id) };
          return { thread: moved, extra };
        }),
      );
      if (switched === undefined) return;
      const done = switched;
      // Calls and events are checked anew: the source's late events are refused from now on.
      if (Option.isSome(remote)) yield* remote.value.threadMoved(threadId);
      yield* recordAudit(done.thread, done.move, "switched");
      // The source's sessions let go of the Thread; an offline source drops them when it returns.
      yield* Effect.forEach(
        done.sessionIds,
        (providerSessionId) =>
          sessions
            .detach({
              providerSessionId: providerSessionId as never,
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

    const prepare = Effect.fn("ThreadMoves.prepare")(function* (
      thread: OrchestrationV2AppThread,
      move: OrchestrationV2ThreadMove,
    ) {
      const target = yield* targetOf(move);
      const { checkout } = yield* asFailure(
        target.workspace.move.fetch({ projectId: thread.projectId, refs: [] }),
      );
      const project = yield* projects.get(thread.projectId).pipe(Effect.option);
      const script = Option.match(Option.flatten(project), {
        onNone: () => null,
        onSome: (found) => setupProjectScript(found.scripts),
      });
      return yield* asFailure(
        target.workspace.move.prepare({
          checkout,
          ref: move.continuesFrom?.ref ?? null,
          branch: thread.branch,
          worktree:
            thread.worktreePath === null
              ? null
              : { name: baseName(thread.worktreePath), path: null },
          setAsidePrefix: HubRepository.threadRefPrefixes(thread.id)[1],
          setupScript: script === null ? null : { name: script.name, command: script.command },
        }),
      );
    });

    /** The workflow from the step the Thread records, to the switch or a failure. */
    const runMove = Effect.fn("ThreadMoves.run")(function* (threadId: ThreadId) {
      while (true) {
        const found = yield* current(threadId);
        if (Option.isNone(found)) return;
        const { thread, move } = found.value;
        const failed = (error: MoveStepFailure) =>
          fail(threadId, move.id, move.step, error.message);
        switch (move.step) {
          case "waiting-for-turn": {
            yield* waitForTurn(threadId, move);
            const online =
              move.sourceEnvironmentId !== null &&
              Option.isSome(yield* Effect.option(registry.get(move.sourceEnvironmentId)));
            yield* advance(
              threadId,
              move.id,
              online ? { step: "final-checkpoint" } : { step: "fetching", sourceOffline: true },
            );
            break;
          }
          case "final-checkpoint": {
            const outcome = yield* Effect.result(finalCheckpoint(thread, move));
            if (outcome._tag === "Success") {
              yield* advance(threadId, move.id, {
                step: "fetching",
                continuesFrom: outcome.success,
              });
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
              yield* advance(threadId, move.id, { step: "fetching", continuesFrom });
            }
            const fetched = yield* Effect.result(
              targetOf(move).pipe(
                Effect.flatMap((target) =>
                  asFailure(
                    target.workspace.move.fetch({
                      projectId: thread.projectId,
                      refs: continuesFrom.ref === null ? [] : [continuesFrom.ref],
                    }),
                  ),
                ),
              ),
            );
            if (fetched._tag === "Failure") return yield* failed(fetched.failure);
            yield* advance(threadId, move.id, { step: "preparing" });
            break;
          }
          case "preparing": {
            const prepared = yield* Effect.result(prepare(thread, move));
            if (prepared._tag === "Failure") return yield* failed(prepared.failure);
            yield* advance(threadId, move.id, {
              step: "handoff",
              ...(prepared.success.setAsideRefs.length === 0
                ? {}
                : { setAsideRefs: prepared.success.setAsideRefs }),
              ...(thread.worktreePath === null ? {} : { targetWorktreePath: prepared.success.cwd }),
            });
            break;
          }
          // Ticket 09 hands the agent on the target the conversation here.
          case "handoff":
            yield* advance(threadId, move.id, { step: "switched" });
            break;
          case "switched":
            yield* switchOver(threadId, move.id);
            return;
        }
      }
    });

    const resume: ThreadMovesShape["resume"] = (threadId) =>
      Effect.suspend(() => {
        if (running.has(threadId)) return Effect.void;
        running.add(threadId);
        return runMove(threadId).pipe(
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

    // A move starts as soon as the Orchestrator records it.
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "thread.move-updated" &&
          event.payload.move?.status === "running" &&
          event.payload.move.step === "waiting-for-turn",
      ),
      Stream.runForEach((event) => resume(event.threadId)),
      Effect.catchCause((cause) =>
        Effect.logWarning("Thread moves stopped following the orchestration", {
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.forkIn(scope),
    );

    // Moves a previous run left in progress go on from the step they recorded.
    yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.move.status') = 'running'
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => resume(ThreadId.make(row.threadId)), { discard: true }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not list the Thread moves left in progress", { cause }),
      ),
      Effect.forkIn(scope),
    );

    return ThreadMoves.of({ resume });
  }),
);
