import {
  OrchestrationGetWorkflowScriptError,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { readContainedWorkflowFile } from "./workflowFileRead.ts";

/**
 * A workflow script of one Thread: only a path a workflow of the Thread, or of a Thread below it
 * the caller sees, recorded, so a caller who may read the Thread reads no other session's script
 * under the shared root.
 */
export const readThreadWorkflowScript = Effect.fn("orchestration.readThreadWorkflowScript")(
  function* <E>(input: {
    readonly threadId: ThreadId;
    readonly scriptPath: string;
    readonly threads: {
      /** The Thread's family, as far as the caller may see it. */
      readonly family: Effect.Effect<ReadonlyArray<OrchestrationV2ThreadShell>, E>;
      readonly subagents: (
        threadId: ThreadId,
      ) => Effect.Effect<ReadonlyArray<OrchestrationV2Subagent>, E>;
    };
  }) {
    const unreadable = (cause: unknown) =>
      new OrchestrationGetWorkflowScriptError({
        reason: "read-failed",
        scriptPath: input.scriptPath,
        cause,
      });
    const family = yield* input.threads.family.pipe(Effect.mapError(unreadable));
    // The Thread and every visible Thread below it.
    const below = new Set<ThreadId>([input.threadId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const shell of family) {
        const parent = shell.lineage.parentThreadId;
        if (!below.has(shell.id) && parent !== null && below.has(parent)) {
          below.add(shell.id);
          grew = true;
        }
      }
    }
    // Read at once; a Thread whose records cannot be read is skipped, not the whole answer, though
    // the Thread asked about must itself be readable.
    const records = yield* Effect.forEach(
      [...below],
      (threadId) =>
        input.threads
          .subagents(threadId)
          .pipe(
            threadId === input.threadId
              ? Effect.mapError(unreadable)
              : Effect.orElseSucceed(() => []),
          ),
      { concurrency: 8 },
    );
    const recorded = records.some((subagents) =>
      subagents.some((subagent) => subagent.workflow?.runHandles?.scriptPath === input.scriptPath),
    );
    if (!recorded) {
      return yield* new OrchestrationGetWorkflowScriptError({
        reason: "not-found",
        scriptPath: input.scriptPath,
      });
    }
    return yield* readWorkflowScript({ scriptPath: input.scriptPath });
  },
);

export const readWorkflowScript = Effect.fn("orchestration.readWorkflowScript")(function* (input: {
  readonly scriptPath: string;
}) {
  const file = yield* readContainedWorkflowFile({
    path: input.scriptPath,
    extension: ".js",
    byteCap: 256 * 1024,
  }).pipe(
    Effect.mapError(
      (error) =>
        new OrchestrationGetWorkflowScriptError({
          reason: error.reason === "wrong-extension" ? "not-js" : error.reason,
          scriptPath: error.path,
          cause: error,
        }),
    ),
  );
  return { scriptPath: file.path, contents: file.contents, truncated: file.truncated };
});
