import { OrchestratorMcpFailure } from "@t3tools/contracts";
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

const cut = (text: string, max: number) => {
  const characters = Array.from(text);
  return characters.length <= max
    ? { text, truncated: false }
    : { text: characters.slice(0, max).join(""), truncated: true };
};

/** A window of `text` around the first match of `query`. */
const snippet = (text: string, at: number, length: number) => {
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 2));
  const end = Math.min(text.length, at + length + Math.floor(SNIPPET_CHARS / 2));
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
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
        .getProjectThreadRecords({ projectId: projection.thread.projectId, threadId }, [
          "runs",
          "attempts",
          "turnItems",
        ])
        .pipe(Effect.mapError(unavailable));
      const ordered = inConversationOrder(
        visibleConversationItems(records, records.turnItems),
        records.runs,
      );
      const entries = ordered.flatMap((item) => {
        const message = historicalMessage(item);
        return message === null ? [] : [message];
      });
      const limit = input.limit ?? DEFAULT_LIMIT;
      if (input.action === "search") {
        const query = input.query?.trim().toLowerCase() ?? "";
        if (query.length === 0) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "search needs a `query`.",
          });
        }
        const matches = entries.flatMap((message, position) => {
          const at = message.text.toLowerCase().indexOf(query);
          return at === -1 ? [] : [{ message, position, at }];
        });
        return {
          threadId,
          total: entries.length,
          entries: matches.slice(0, limit).map(({ message, position, at }) => ({
            position,
            itemId: message.itemId,
            role: message.role,
            kind: message.kind,
            text: snippet(message.text, at, query.length),
            truncated: message.text.length > SNIPPET_CHARS,
          })),
          nextPosition: null,
        };
      }
      const from = input.afterPosition === undefined ? 0 : input.afterPosition + 1;
      const page = entries.slice(from, from + limit);
      const maxChars = input.maxCharsPerItem ?? DEFAULT_MAX_CHARS;
      return {
        threadId,
        total: entries.length,
        entries: page.map((message, index) => ({
          position: from + index,
          itemId: message.itemId,
          role: message.role,
          kind: message.kind,
          ...cut(message.text, maxChars),
        })),
        nextPosition: from + page.length < entries.length ? from + page.length - 1 : null,
      };
    }),
  ),
});
