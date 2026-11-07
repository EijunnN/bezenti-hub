/**
 * Settles the tasks delegated over Peer Links that had no result when links were removed
 * (migration 102 records them). Nothing would ever report one, so each ends interrupted through
 * the orchestrator, which wakes its parent as for a local child's result. A record whose task
 * cannot be settled is logged and kept for the next start; the table goes once it is empty.
 */
import { CommandId, NodeId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "./Orchestrator.ts";

const RETIRED_REMOTE_TASK_RESULT =
  "Stopped: it ran on a linked machine, and Peer Links were removed. Delegate it again here.";

export const settleRetiredRemoteTasks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const table = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'retired_remote_tasks'
  `;
  if (table.length === 0) return;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const retired = yield* sql<{ readonly task_id: string; readonly thread_id: string }>`
    SELECT task_id, thread_id FROM retired_remote_tasks
  `;
  for (const row of retired) {
    const forget = sql`DELETE FROM retired_remote_tasks WHERE task_id = ${row.task_id}`;
    yield* orchestrator
      .dispatch({
        type: "delegated_task.orphan.settle",
        // Stable, so a retry after a crash replays rather than settling twice.
        commandId: CommandId.make(`peer-links-removed:${row.task_id}`),
        parentThreadId: ThreadId.make(row.thread_id),
        taskId: NodeId.make(row.task_id),
        result: RETIRED_REMOTE_TASK_RESULT,
      })
      .pipe(
        Effect.andThen(forget),
        // A task that is gone or already ended has nothing left to settle.
        Effect.catchTags({
          OrchestratorDispatchError: (error) =>
            Effect.logInfo("Retired task has nothing to settle", {
              taskId: row.task_id,
              cause: error.cause,
            }).pipe(Effect.andThen(forget)),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not settle a retired task", { taskId: row.task_id, cause }),
        ),
      );
  }
  const [left] = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM retired_remote_tasks
  `;
  if (left?.count === 0) yield* sql`DROP TABLE retired_remote_tasks`;
}).pipe(
  Effect.catchCause((cause) => Effect.logWarning("Could not settle retired tasks", { cause })),
  Effect.withSpan("RetiredRemoteTasks.settle"),
);
