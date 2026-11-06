/**
 * What the Hub does when a machine goes for good or comes back (docs/internals/overview.md,
 * «Disconnections»): a removed Environment's Threads keep their history and need an environment;
 * a machine that returns hands over the changes it still had for Threads that moved away, on a
 * branch of the Hub, and each Thread gets a notice. The machine's workspace is never touched.
 */
import {
  CheckpointRef,
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  OrchestrationV2TurnItemJson,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import * as EnvironmentRegistry from "../environments/EnvironmentRegistry.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const decodeItem = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestrationV2TurnItemJson));

/** A file- and ref-safe instant: one path segment of `refs/t3/recovered/<threadId>/`. */
const stampOf = (now: DateTime.Utc) => DateTime.formatIso(now).replace(/[:.]/g, "-");

export const layer: Layer.Layer<
  never,
  never,
  | EnvironmentExecutor.EnvironmentExecutorRegistry
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ThreadCommandExecutor.ThreadCommandExecutor
  | ProjectionStore.ProjectionStoreV2
  | SqlClient.SqlClient
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const executors = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
    const eventSink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    // The server provides these; orchestration-only hosts join no machines.
    const environments = yield* Effect.serviceOption(EnvironmentRegistry.EnvironmentRegistry);
    const remote = yield* Effect.serviceOption(RemoteEnvironments.RemoteEnvironments);
    const scope = yield* Effect.scope;

    const logged =
      (message: string, detail: Record<string, unknown>) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) => Effect.logWarning(message, { ...detail, cause: Cause.pretty(cause) }),
          ),
          Effect.asVoid,
        );

    /**
     * Every Thread on a removed Environment (or only `environmentId`'s) has none from now on:
     * «needs an environment», its history intact, until it moves.
     */
    const releaseRemoved = Effect.fn("EnvironmentReturns.releaseRemoved")(function* (
      environmentId?: EnvironmentId,
    ) {
      const rows = yield* sql<{ readonly threadId: string; readonly environmentId: string }>`
        SELECT thread.thread_id AS "threadId", thread.active_environment_id AS "environmentId"
        FROM orchestration_v2_projection_threads thread
        JOIN environments ON environments.environment_id = thread.active_environment_id
        WHERE environments.revoked_at IS NOT NULL AND thread.deleted_at IS NULL
          AND (${environmentId ?? null} IS NULL OR environments.environment_id = ${environmentId ?? null})
      `;
      for (const row of rows) {
        const threadId = ThreadId.make(row.threadId);
        yield* threadLocks.withLock(
          threadId,
          Effect.gen(function* () {
            const thread = yield* projections.getThread(threadId);
            if (thread.activeEnvironmentId !== row.environmentId) return;
            const now = yield* DateTime.now;
            yield* eventSink.write({
              events: [
                {
                  id: yield* ids.allocate.event({ threadId }),
                  type: "thread.metadata-updated",
                  threadId,
                  providerInstanceId: thread.providerInstanceId,
                  occurredAt: now,
                  payload: { ...thread, activeEnvironmentId: null },
                },
              ],
            });
          }),
        );
      }
    });

    const nameOf = (environmentId: EnvironmentId) =>
      sql<{ readonly name: string }>`
        SELECT name FROM environments WHERE environment_id = ${environmentId}
      `.pipe(
        Effect.map((rows) => rows[0]?.name ?? environmentId),
        Effect.orElseSucceed(() => environmentId as string),
      );

    /**
     * The Threads that moved away from the machine and run elsewhere now, with what each was
     * last known to hold there: the checkpoint it continued from, or what was recovered since.
     */
    const formerThreads = Effect.fn("EnvironmentReturns.formerThreads")(function* (
      environmentId: EnvironmentId,
    ) {
      const rows = yield* sql<{ readonly threadId: string; readonly payload: string }>`
        SELECT item.thread_id AS "threadId", item.payload_json AS payload
        FROM orchestration_v2_projection_turn_items item
        JOIN orchestration_v2_projection_threads thread ON thread.thread_id = item.thread_id
        WHERE thread.deleted_at IS NULL
          AND (thread.active_environment_id IS NULL OR thread.active_environment_id != ${environmentId})
          AND (
            (item.type = 'environment_move'
              AND json_extract(item.payload_json, '$.sourceEnvironmentId') = ${environmentId}
              AND json_extract(item.payload_json, '$.outcome') IS NOT 'cancelled')
            OR (item.type = 'recovered_changes'
              AND json_extract(item.payload_json, '$.environmentId') = ${environmentId})
          )
        ORDER BY item.updated_at, item.turn_item_id
      `;
      const latest = new Map<ThreadId, { baseRef: string | null; moved: boolean }>();
      for (const row of rows) {
        const item = decodeItem(row.payload);
        if (Option.isNone(item)) continue;
        const threadId = ThreadId.make(row.threadId);
        if (item.value.type === "environment_move") {
          latest.set(threadId, { baseRef: item.value.continuesFrom.ref, moved: true });
        } else if (item.value.type === "recovered_changes") {
          const known = latest.get(threadId);
          latest.set(threadId, { baseRef: item.value.ref, moved: known?.moved ?? false });
        }
      }
      return [...latest.entries()].filter(([, known]) => known.moved);
    });

    /** Asks a machine that came back for the changes it kept of each Thread that left it. */
    const recoverOn = Effect.fn("EnvironmentReturns.recoverOn")(function* (
      executor: EnvironmentExecutor.EnvironmentExecutor,
    ) {
      const environmentId = executor.environmentId;
      for (const [threadId, known] of yield* formerThreads(environmentId)) {
        yield* Effect.gen(function* () {
          const thread = yield* projections.getThread(threadId);
          // Its worktree there, else the Project's checkout, unless another Thread works in it.
          const worktree = thread.move?.knownWorktrees?.[environmentId];
          let cwd = worktree;
          if (cwd === undefined) {
            const checkout = yield* executor.workspace.paths.checkout(thread.projectId);
            if (Option.isNone(checkout)) return;
            const sharing = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads
              WHERE project_id = ${thread.projectId} AND thread_id != ${threadId}
                AND deleted_at IS NULL AND active_environment_id = ${environmentId}
                AND json_extract(payload_json, '$.worktreePath') IS NULL
            `;
            if ((sharing[0]?.count ?? 0) > 0) return;
            cwd = checkout.value;
          }
          const now = yield* DateTime.now;
          const recoveredRef = CheckpointRef.make(
            `${HubRepository.threadRefPrefixes(threadId)[1]}${stampOf(now)}`,
          );
          const result = yield* executor.workspace.move.recover({
            cwd,
            projectId: thread.projectId,
            threadId,
            baseRef: known.baseRef === null ? null : CheckpointRef.make(known.baseRef),
            recoveredRef,
          });
          if (result.status !== "recovered") return;
          const environmentName = yield* nameOf(environmentId);
          yield* threadLocks.withLock(
            threadId,
            Effect.gen(function* () {
              const { runs } = yield* projections.getThreadRecords(threadId, ["runs"], {
                turnItemTypes: [],
              });
              const latestRun = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
              const current = yield* projections.getThread(threadId);
              yield* eventSink.write({
                events: [
                  {
                    id: yield* ids.allocate.event({ threadId }),
                    type: "turn-item.updated",
                    threadId,
                    ...(latestRun === undefined ? {} : { runId: latestRun.id }),
                    providerInstanceId: current.providerInstanceId,
                    occurredAt: now,
                    payload: {
                      id: TurnItemId.make(`turn-item:recovered-changes:${recoveredRef}`),
                      threadId,
                      runId: latestRun?.id ?? null,
                      nodeId: null,
                      providerThreadId: null,
                      providerTurnId: null,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: 0,
                      status: "completed",
                      title: `Recovered changes from ${environmentName}`,
                      startedAt: now,
                      completedAt: now,
                      updatedAt: now,
                      type: "recovered_changes",
                      environmentId,
                      environmentName,
                      ref: recoveredRef,
                      baseRef: known.baseRef,
                    },
                  },
                ],
              });
            }),
          );
        }).pipe(
          logged("Could not look for a moved Thread's changes on its former machine", {
            environmentId,
            threadId,
          }),
        );
      }
    });

    // A machine that connects (again) hands over what it kept of the Threads that left it.
    const known = new Map<EnvironmentId, EnvironmentExecutor.EnvironmentExecutor>();
    const lookAtConnected = Effect.gen(function* () {
      const connected = new Set(yield* executors.list);
      for (const environmentId of known.keys()) {
        if (!connected.has(environmentId)) known.delete(environmentId);
      }
      for (const environmentId of connected) {
        if (environmentId === HUB_MACHINE_ENVIRONMENT_ID) continue;
        const executor = yield* executors.get(environmentId).pipe(Effect.option);
        if (Option.isNone(executor) || known.get(environmentId) === executor.value) continue;
        known.set(environmentId, executor.value);
        yield* recoverOn(executor.value).pipe(
          logged("Could not look for recovered changes", { environmentId }),
          Effect.forkIn(scope),
        );
      }
    });
    const changes = yield* executors.changes;
    yield* lookAtConnected;
    yield* PubSub.take(changes).pipe(
      Effect.andThen(lookAtConnected),
      Effect.forever,
      Effect.forkIn(scope),
    );

    // A removed machine's sessions end and its Threads need an environment, at once and after a
    // restart for removals the Hub did not get to.
    if (Option.isSome(environments)) {
      yield* environments.value.removed.pipe(
        Stream.runForEach((environmentId) =>
          (Option.isSome(remote)
            ? remote.value.environmentRemoved(environmentId)
            : Effect.void
          ).pipe(
            Effect.andThen(releaseRemoved(environmentId)),
            logged("Could not release a removed Environment's Threads", { environmentId }),
          ),
        ),
        Effect.forkIn(scope),
      );
    }
    yield* releaseRemoved().pipe(
      logged("Could not release the Threads of removed Environments", {}),
      Effect.forkIn(scope),
    );
  }),
);
