import {
  OrchestrationGetWorkflowScriptError,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { readContainedWorkflowFile } from "./workflowFileRead.ts";

/**
 * A workflow script of one Thread: only a path one of its own workflows recorded, so a caller
 * who may read the Thread reads no other session's script under the shared root.
 */
export const readThreadWorkflowScript = Effect.fn("orchestration.readThreadWorkflowScript")(
  function* <E>(input: {
    readonly scriptPath: string;
    readonly subagents: Effect.Effect<ReadonlyArray<OrchestrationV2Subagent>, E>;
  }) {
    const subagents = yield* input.subagents.pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationGetWorkflowScriptError({
            reason: "read-failed",
            scriptPath: input.scriptPath,
            cause,
          }),
      ),
    );
    if (
      !subagents.some((subagent) => subagent.workflow?.runHandles?.scriptPath === input.scriptPath)
    ) {
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
