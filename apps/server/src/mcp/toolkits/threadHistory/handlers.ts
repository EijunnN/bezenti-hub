import { type OrchestrationV2TurnItem, OrchestratorMcpFailure } from "@t3tools/contracts";
import { historicalMessage } from "@t3tools/provider-core/server/handoffBudget";
import * as Effect from "effect/Effect";

import { visibleConversationItems } from "../../../orchestration-v2/ContextHandoffService.ts";
import { inConversationOrder } from "../../../orchestration-v2/MoveHandoff.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread, unavailable } from "../../threadAccess.ts";
import { ThreadHistoryToolkit } from "./tools.ts";

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_CHARS = 2_000;
const SNIPPET_CHARS = 300;
/** The conversation's items, as a handoff reads them; the rest of the timeline is not read. */
const HISTORY_TYPES: ReadonlyArray<OrchestrationV2TurnItem["type"]> = [
  "user_message",
  "assistant_message",
  "command_execution",
  "error",
  "run_interrupt_result",
  "file_change",
  "proposed_plan",
];

const cut = (text: string, max: number) => {
  const characters = Array.from(text);
  return characters.length <= max
    ? { text, truncated: false }
    : { text: characters.slice(0, max).join(""), truncated: true };
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A window of `text` around a match at `at`, in the original text's own offsets. */
const snippet = (text: string, at: number, length: number) => {
  const start = Math.max(0, at - Math.max(0, Math.floor((SNIPPET_CHARS - length) / 2)));
  const end = Math.min(text.length, start + Math.max(SNIPPET_CHARS, length));
  return {
    text: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    truncated: start > 0 || end < text.length,
  };
};

export const layer = McpToolAccess.toLayer(ThreadHistoryToolkit, {
  thread_history: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadId = scope.thread!.threadId;
      // Only the agent's own Thread: another one is never read, whatever the User may see.
      if (input.threadId !== undefined && input.threadId !== threadId) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "thread_history reads only this thread's history.",
        });
      }
      // The caller's own Thread, with its User's permissions: a hidden one reads as missing.
      const { threads, projection } = yield* readThread(threadId);
      const records = yield* threads
        .getProjectThreadRecords(
          { projectId: projection.thread.projectId, threadId },
          ["runs", "attempts", "turnItems"],
          { turnItemTypes: HISTORY_TYPES },
        )
        .pipe(Effect.mapError(unavailable));
      const entries = inConversationOrder(
        visibleConversationItems(records, records.turnItems),
        records.runs,
      ).flatMap((item) => {
        const message = historicalMessage(item);
        return message === null ? [] : [message];
      });
      const limit = input.limit ?? DEFAULT_LIMIT;
      const from = input.afterPosition === undefined ? 0 : input.afterPosition + 1;
      if (input.action === "search") {
        const query = input.query?.trim() ?? "";
        if (query.length === 0) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "search needs a `query`.",
          });
        }
        // Matched on the text itself, so offsets stay the text's own whatever the case.
        const pattern = new RegExp(escapeRegExp(query), "i");
        const matches = entries.flatMap((message, position) => {
          const found = pattern.exec(message.text);
          return found === null
            ? []
            : [{ message, position, at: found.index, length: found[0].length }];
        });
        const ordered = input.order === "newest" ? matches.toReversed() : matches;
        const page = ordered.slice(from, from + limit);
        return {
          threadId,
          total: matches.length,
          entries: page.map(({ message, position, at, length }) => ({
            position,
            itemId: message.itemId,
            role: message.role,
            kind: message.kind,
            ...snippet(message.text, at, length),
          })),
          // A cursor over the matches, in the order asked for.
          nextPosition: from + page.length < ordered.length ? from + page.length - 1 : null,
        };
      }
      const ordered = input.order === "newest" ? entries.toReversed() : entries;
      const page = ordered.slice(from, from + limit);
      const maxChars = input.maxCharsPerItem ?? DEFAULT_MAX_CHARS;
      return {
        threadId,
        total: entries.length,
        entries: page.map((message, index) => ({
          position: input.order === "newest" ? entries.length - 1 - (from + index) : from + index,
          itemId: message.itemId,
          role: message.role,
          kind: message.kind,
          ...cut(message.text, maxChars),
        })),
        nextPosition: from + page.length < ordered.length ? from + page.length - 1 : null,
      };
    }),
  ),
});
