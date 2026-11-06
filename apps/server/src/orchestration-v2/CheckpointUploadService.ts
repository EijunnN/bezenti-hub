/**
 * Uploads each Thread's checkpoints to the Hub's repository of its Project after capture: its
 * Active environment pushes the refs and each one pushed is marked (`checkpoint.uploaded`). A
 * failure retries with backoff, and at once when an Environment connects; until then the turn
 * shows its checkpoint as not uploaded yet. See docs/internals/overview.md, «Hub repository».
 */
import {
  type CheckpointId,
  type EnvironmentId,
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const RETRY_BASE = Duration.seconds(1);
const RETRY_CAP = Duration.minutes(5);
/** Refs per push: bounds the command line and what one failure holds back. */
const MAX_REFS_PER_PUSH = 64;

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

/**
 * One Thread's uploads; no entry is idle. Only the running upload leaves `running`, and every
 * transition happens without yielding, so a Thread never has two uploads at once.
 */
type ThreadUpload =
  | { readonly _tag: "running"; again: boolean; readonly failures: number }
  | { readonly _tag: "retryScheduled"; readonly failures: number; readonly token: object };

const sameCapture = (a: OrchestrationV2Checkpoint, b: OrchestrationV2Checkpoint) =>
  a.ref === b.ref && DateTime.toEpochMillis(a.capturedAt) === DateTime.toEpochMillis(b.capturedAt);

const chunks = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

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
    // Which repository each Thread uploads to; absent off the Hub (orchestration-only tests).
    const repositories = yield* Effect.serviceOption(HubRepository.HubRepositories);
    const scope = yield* Effect.scope;
    const uploads = new Map<ThreadId, ThreadUpload>();
    /**
     * Checkpoints whose ref the Thread's machine lacks (captured on the machine it left), with
     * that machine: they wait for the Thread to run where the ref is, and hold back nothing.
     */
    const needsSource = new Map<CheckpointId, EnvironmentId>();

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

    /** Marks what was pushed, unless a rollback and a new capture reused its ref meanwhile. */
    const markUploaded = Effect.fn("CheckpointUploads.markUploaded")(function* (
      threadId: ThreadId,
      pushed: ReadonlyArray<PendingCheckpoint>,
    ) {
      return yield* threadLocks.withLock(
        threadId,
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const events: Array<OrchestrationV2DomainEvent> = [];
          for (const { checkpoint } of yield* pendingOf(threadId)) {
            const entry = pushed.find((candidate) => candidate.checkpoint.id === checkpoint.id);
            if (entry === undefined || !sameCapture(entry.checkpoint, checkpoint)) continue;
            needsSource.delete(checkpoint.id);
            events.push({
              id: yield* ids.allocate.event({ threadId }),
              type: "checkpoint.uploaded",
              threadId,
              ...(checkpoint.runId === null ? {} : { runId: checkpoint.runId }),
              nodeId: checkpoint.nodeId,
              occurredAt: now,
              payload: { checkpointId: checkpoint.id },
            });
          }
          if (events.length > 0) yield* eventSink.write({ events });
          return events.length;
        }),
      );
    });

    /**
     * One upload of what is pending: "more" when it marked some (more may have come since),
     * "failed" when any ref the machine has could not be pushed.
     */
    const uploadOnce = Effect.fn("CheckpointUploads.uploadOnce")(function* (threadId: ThreadId) {
      const [thread] = yield* sql<{ readonly projectId: string }>`
        SELECT project_id AS "projectId" FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId}
      `;
      if (thread === undefined) return "done" as const;
      const executor = yield* registry.forThread(threadId);
      const pending = (yield* pendingOf(threadId)).filter(
        ({ checkpoint }) => needsSource.get(checkpoint.id) !== executor.environmentId,
      );
      if (pending.length === 0) return "done" as const;
      // A Thread without a Project uploads to its own repository.
      const key = Option.isSome(repositories)
        ? Option.getOrElse(yield* repositories.value.keyOfThread(threadId), () => ({
            projectId: ProjectId.make(thread.projectId),
          }))
        : { projectId: ProjectId.make(thread.projectId) };
      const { hubRepository, checkpoints } = executor.workspace;
      const push = (cwd: string, batch: ReadonlyArray<PendingCheckpoint>) =>
        hubRepository
          .push({
            cwd,
            ...HubRepository.keyOf(key),
            checkpointRefs: batch.map(({ checkpoint }) => checkpoint.ref),
          })
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
      const byWorkspace = new Map<string, Array<PendingCheckpoint>>();
      for (const entry of pending) {
        byWorkspace.set(entry.cwd, [...(byWorkspace.get(entry.cwd) ?? []), entry]);
      }
      const pushed: Array<PendingCheckpoint> = [];
      let failed = false;
      for (const [cwd, entries] of byWorkspace) {
        for (const batch of chunks(entries, MAX_REFS_PER_PUSH)) {
          if (yield* push(cwd, batch)) {
            pushed.push(...batch);
            continue;
          }
          // One ref the checkout lacks fails the whole push: try each, and set those aside.
          for (const entry of batch) {
            if (batch.length > 1 && (yield* push(cwd, [entry]))) {
              pushed.push(entry);
              continue;
            }
            const present = yield* checkpoints
              .hasCheckpointRef({ cwd, checkpointRef: entry.checkpoint.ref })
              .pipe(Effect.orElseSucceed(() => true));
            if (present) failed = true;
            else needsSource.set(entry.checkpoint.id, executor.environmentId);
          }
        }
      }
      const marked = pushed.length === 0 ? 0 : yield* markUploaded(threadId, pushed);
      if (failed) return "failed" as const;
      return marked > 0 ? ("more" as const) : ("done" as const);
    });

    const start = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.suspend(() => {
        const current = uploads.get(threadId);
        if (current?._tag === "running") {
          current.again = true;
          return Effect.void;
        }
        // A retry waiting is superseded: its token no longer matches, so it does nothing.
        uploads.set(threadId, { _tag: "running", again: false, failures: current?.failures ?? 0 });
        return run(threadId).pipe(Effect.forkIn(scope), Effect.asVoid);
      });

    const run: (threadId: ThreadId) => Effect.Effect<void> = Effect.fn("CheckpointUploads.run")(
      function* (threadId: ThreadId) {
        while (true) {
          const state = uploads.get(threadId);
          if (state?._tag !== "running") return;
          state.again = false;
          const outcome = yield* uploadOnce(threadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Checkpoint upload to the Hub repository failed", {
                threadId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as("failed" as const)),
            ),
          );
          if (outcome === "more" || (outcome === "done" && state.again)) continue;
          if (outcome === "done") {
            uploads.delete(threadId);
            return;
          }
          const token = {};
          uploads.set(threadId, { _tag: "retryScheduled", failures: state.failures + 1, token });
          const delay = Duration.min(
            Duration.times(RETRY_BASE, 2 ** Math.min(state.failures, 16)),
            RETRY_CAP,
          );
          yield* Effect.sleep(delay).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                const waiting = uploads.get(threadId);
                if (waiting?._tag !== "retryScheduled" || waiting.token !== token) {
                  return Effect.void;
                }
                uploads.set(threadId, {
                  _tag: "running",
                  again: false,
                  failures: waiting.failures,
                });
                return run(threadId);
              }),
            ),
            Effect.forkIn(scope),
          );
          return;
        }
      },
    );

    // A connecting Environment may be where a failed upload has to run: try those now.
    const changes = yield* registry.changes;
    yield* PubSub.take(changes).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          Effect.forEach(
            [...uploads].flatMap(([threadId, state]) =>
              state._tag === "retryScheduled" ? [threadId] : [],
            ),
            start,
            { discard: true },
          ),
        ),
      ),
      Effect.forever,
      Effect.forkIn(scope),
    );

    // Requests come from inside effects; uploads start from here so they carry none of their
    // context (the effect's Environment, its idempotency keys).
    const requests = yield* Queue.unbounded<ThreadId>();
    yield* Queue.take(requests).pipe(Effect.flatMap(start), Effect.forever, Effect.forkIn(scope));

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

    return CheckpointUploads.of({
      request: Effect.fn("CheckpointUploads.request")(function* (threadId) {
        yield* Queue.offer(requests, threadId);
      }),
    });
  }),
);
