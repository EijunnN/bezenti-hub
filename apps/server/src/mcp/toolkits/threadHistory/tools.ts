import { NonNegativeInt, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const HistoryEntry = Schema.Struct({
  position: NonNegativeInt,
  itemId: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  kind: Schema.String,
  text: Schema.String,
  truncated: Schema.Boolean,
});

const ThreadHistoryTool = Tool.make("thread_history", {
  description:
    "Search or read THIS thread's full history, also from before it moved machines. search: entries containing `query`, `total` matches. read: entries cut at `maxCharsPerItem`. Both page `limit` at a time with `afterPosition=nextPosition`; `order:'newest'` starts at the end.",
  parameters: Schema.Struct({
    action: Schema.Literals(["search", "read"]),
    order: Schema.optional(Schema.Literals(["oldest", "newest"])),
    query: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
    /** Only this thread; any other is refused. */
    threadId: Schema.optional(ThreadId),
    afterPosition: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
    maxCharsPerItem: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 20_000 })),
    ),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    total: NonNegativeInt,
    entries: Schema.Array(HistoryEntry),
    nextPosition: Schema.NullOr(NonNegativeInt),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Search and read this thread's history")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadHistoryToolkit = Toolkit.make(ThreadHistoryTool);
