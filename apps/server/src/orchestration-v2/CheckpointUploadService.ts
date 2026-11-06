/**
 * Uploads each Thread's checkpoints to the Hub's repository of its Project after capture: its
 * Active environment pushes the refs, and the projection marks each checkpoint `uploadedToHub`.
 * A failed upload retries with backoff, and at once when an Environment connects; until then the
 * turn shows its checkpoint as not uploaded yet. See docs/internals/overview.md, «Hub repository».
 */
import {
  type CheckpointRef,
  type OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointJson,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const RETRY_BASE = Duration.seconds(1);
const RETRY_CAP = Duration.minutes(5);

const decodeCheckpoint = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointJson),
);

export interface CheckpointUploadsShape {
  /** Uploads the Thread's checkpoints the Hub's repository lacks, in the background. */
  readonly request: (threadId: ThreadId) => Effect.Effect<void>;
}

export class CheckpointUploads extends Context.Service<CheckpointUploads, CheckpointUploadsShape>()(
  "t3/orchestration-v2/CheckpointUploadService/CheckpointUploads",
) {}

interface PendingCheckpoint {
  readonly checkpoint: OrchestrationV2Checkpoint;
  readonly cwd: string;
}

const sameCapture = (a: OrchestrationV2Checkpoint, b: OrchestrationV2Checkpoint) =>
  a.ref === b.ref && DateTime.toEpochMillis(a.capturedAt) === DateTime.toEpochMillis(b.capturedAt);

export const layer: Layer.Layer<
  CheckpointUploads,
  never,
  | EnvironmentExecutor.EnvironmentExecutorRegistry
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ThreadCommandExecutor.ThreadCommandExecutor
  | SqlClient.SqlClient
> = Layer.effect(
  CheckpointUploads,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const registry = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
    const eventSink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const scope = yield* Effect.scope;

    /** Ready checkpoints of the Thread not yet in the Hub's repository, with their workspace. */
    const pendingOf = Effect.fn("CheckpointUploads.pendingOf")(function* (threadId: ThreadId) {
      const rows = yield* sql<{ readonly payload: string; readonly cwd: string | null }>`
        SELECT checkpoint.payload_json AS payload,
          json_extract(scope.payload_json, '$.cwd') AS cwd
        FROM orchestration_v2_projection_checkpoints checkpoint
        JOIN orchestration_v2_projection_checkpoint_scopes scope
          ON scope.scope_id = checkpoint.scope_id
        WHERE checkpoint.thread_id = ${threadId}
          AND checkpoint.status = 'ready' AND checkpoint.uploaded_to_hub = 0
        ORDER BY checkpoint.scope_id, checkpoint.ordinal_within_scope
      `;
      const pending: Array<PendingCheckpoint> = [];
      for (const row of rows) {
        if (row.cwd === null) continue;
        pending.push({ checkpoint: yield* decodeCheckpoint(row.payload), cwd: row.cwd });
      }
      return pending;
    });

    /** One upload of what is pending; "more" when it marked some, as more may have come since. */
    const uploadOnce = Effect.fn("CheckpointUploads.uploadOnce")(function* (threadId: ThreadId) {
      const pending = yield* pendingOf(threadId);
      if (pending.length === 0) return "done" as const;
      const [thread] = yield* sql<{ readonly projectId: string }>`
        SELECT project_id AS "projectId" FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId}
      `;
      if (thread === undefined) return "done" as const;
      const projectId = ProjectId.make(thread.projectId);
      const executor = yield* registry.forThread(threadId);
      const byWorkspace = new Map<string, Array<CheckpointRef>>();
      for (const { checkpoint, cwd } of pending) {
        byWorkspace.set(cwd, [...(byWorkspace.get(cwd) ?? []), checkpoint.ref]);
      }
      for (const [cwd, checkpointRefs] of byWorkspace) {
        yield* executor.workspace.hubRepository.push({ cwd, projectId, checkpointRefs });
      }
      // A rollback and a new capture can reuse an ordinal's ref while the push ran: only the
      // capture that was pushed is marked.
      return yield* threadLocks.withLock(
        threadId,
        Effect.gen(function* () {
          const current = yield* pendingOf(threadId);
          const now = yield* DateTime.now;
          const events: Array<OrchestrationV2DomainEvent> = [];
          for (const { checkpoint } of current) {
            const pushed = pending.find((entry) => entry.checkpoint.id === checkpoint.id);
            if (pushed === undefined || !sameCapture(pushed.checkpoint, checkpoint)) continue;
            events.push({
              id: yield* ids.allocate.event({ threadId }),
              type: "checkpoint.captured",
              threadId,
              ...(checkpoint.runId === null ? {} : { runId: checkpoint.runId }),
              nodeId: checkpoint.nodeId,
              occurredAt: now,
              payload: { ...checkpoint, uploadedToHub: true },
            });
          }
          if (events.length === 0) return "done" as const;
          yield* eventSink.write({ events });
          return "more" as const;
        }),
      );
    });

    const running = new Set<ThreadId>();
    const again = new Set<ThreadId>();
    /** Threads whose last upload failed, with their failures so far and the retry waiting. */
    const retrying = new Map<
      ThreadId,
      { readonly failures: number; readonly fiber: Fiber.Fiber<void> }
    >();

    const start = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (running.has(threadId)) {
          again.add(threadId);
          return Effect.void;
        }
        running.add(threadId);
        const waiting = retrying.get(threadId);
        retrying.delete(threadId);
        return (waiting === undefined ? Effect.void : Fiber.interrupt(waiting.fiber)).pipe(
          Effect.andThen(run(threadId, waiting?.failures ?? 0)),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      });

    const run: (threadId: ThreadId, failures: number) => Effect.Effect<void> = Effect.fn(
      "CheckpointUploads.run",
    )(function* (threadId: ThreadId, failures: number) {
      let outcome: "done" | "more" | "failed";
      do {
        again.delete(threadId);
        outcome = yield* uploadOnce(threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Checkpoint upload to the Hub repository failed", {
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as("failed" as const)),
          ),
        );
      } while (outcome === "more" || (outcome === "done" && again.has(threadId)));
      running.delete(threadId);
      if (outcome === "done") return;
      const delay = Duration.min(
        Duration.times(RETRY_BASE, 2 ** Math.min(failures, 16)),
        RETRY_CAP,
      );
      const fiber = yield* Effect.sleep(delay).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const current = retrying.get(threadId);
            if (current?.fiber !== fiber) return Effect.void;
            retrying.delete(threadId);
            running.add(threadId);
            return run(threadId, failures + 1);
          }),
        ),
        Effect.forkIn(scope),
      );
      retrying.set(threadId, { failures: failures + 1, fiber });
    });

    // A connecting Environment may be where a failed upload has to run: try those now.
    const changes = yield* registry.changes;
    yield* PubSub.take(changes).pipe(
      Effect.andThen(
        Effect.suspend(() => Effect.forEach([...retrying.keys()], start, { discard: true })),
      ),
      Effect.forever,
      Effect.forkIn(scope),
    );

    // What a previous run left pending, such as uploads that failed until the Hub stopped.
    yield* sql<{ readonly threadId: string }>`
      SELECT DISTINCT thread_id AS "threadId" FROM orchestration_v2_projection_checkpoints
      WHERE status = 'ready' AND uploaded_to_hub = 0
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => start(ThreadId.make(row.threadId)), { discard: true }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not list the checkpoints left to upload", { cause }),
      ),
      Effect.forkIn(scope),
    );

    // Requests come from inside effects; uploads start from here so they carry none of their
    // context (the effect's Environment, its idempotency keys).
    const requests = yield* Queue.unbounded<ThreadId>();
    yield* Queue.take(requests).pipe(Effect.flatMap(start), Effect.forever, Effect.forkIn(scope));

    return CheckpointUploads.of({
      request: Effect.fn("CheckpointUploads.request")(function* (threadId) {
        yield* Queue.offer(requests, threadId);
      }),
    });
  }),
);
