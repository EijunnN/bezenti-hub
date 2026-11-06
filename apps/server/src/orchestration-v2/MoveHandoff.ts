/**
 * What the agent on a moved Thread's new Environment is told: a summary of the work so far, then
 * the Thread's most recent messages, within a size budget. See docs/internals/overview.md,
 * «Moving a Thread» (`handoff`).
 */
import {
  ContextHandoffId,
  type OrchestrationV2HistoricalMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadHandoffWriter,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { historicalMessage } from "@t3tools/provider-core/server/handoffBudget";
import { THREAD_HANDOFF_SUMMARY_MAX_CHARS } from "@t3tools/provider-core/server/textGenerationPrompts";

/** The conversation the model reads to write the summary, newest kept when it is cut. */
const TRANSCRIPT_MAX_CHARS = 40_000;
const TRANSCRIPT_ITEM_MAX_CHARS = 4_000;
/** The recent messages the new session starts with, word for word. */
const RECENT_MAX_MESSAGES = 12;
const RECENT_MAX_BYTES = 12_000;
const CHANGED_FILES_MAX = 50;

/** The context handoff record a move's handoff is delivered as: one per move, so it goes once. */
export const moveContextHandoffId = (moveId: string) =>
  ContextHandoffId.make(`context-handoff:move:${moveId}`);

export interface MoveHistory {
  readonly messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
  readonly changedFiles: ReadonlyArray<string>;
  readonly completedTurns: number;
}

/** Items in the order of the conversation: by turn (imported history first), then within it. */
export const inConversationOrder = <
  A extends Pick<OrchestrationV2TurnItem, "runId" | "ordinal" | "id">,
>(
  items: ReadonlyArray<A>,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal">>,
): ReadonlyArray<A> => {
  const turnOf = new Map(runs.map((run) => [run.id, run.ordinal]));
  const turn = (item: A) => (item.runId === null ? 0 : (turnOf.get(item.runId) ?? 0));
  return items.toSorted(
    (left, right) =>
      turn(left) - turn(right) || left.ordinal - right.ordinal || left.id.localeCompare(right.id),
  );
};

/**
 * The Thread's visible history as handoff messages, with the files its turns changed (as their
 * file changes and checkpoints recorded them, oldest first).
 */
export const moveHistory = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  completedTurns: number,
): MoveHistory => {
  const messages: Array<OrchestrationV2HistoricalMessage> = [];
  const files: Array<string> = [];
  const touched = (path: string) => {
    const at = files.indexOf(path);
    if (at !== -1) files.splice(at, 1);
    files.push(path);
  };
  for (const item of items) {
    const message = historicalMessage(item);
    if (message !== null) messages.push(message);
    if (item.type === "file_change") {
      for (const path of item.changes?.map((change) => change.path) ?? [item.fileName]) {
        touched(path);
      }
    }
    if (item.type === "checkpoint") {
      for (const file of item.files) touched(file.path);
    }
  }
  return { messages, changedFiles: files.slice(-CHANGED_FILES_MAX), completedTurns };
};

const clip = (text: string, max: number) => {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)}…`;
};

const roleLabel = (message: OrchestrationV2HistoricalMessage) =>
  message.role === "user" ? "User" : message.kind === "assistant_message" ? "Agent" : "Activity";

/** The conversation for the model, oldest first, the oldest dropped when it is too long. */
export const renderTranscript = (messages: ReadonlyArray<OrchestrationV2HistoricalMessage>) => {
  const lines: Array<string> = [];
  let remaining = TRANSCRIPT_MAX_CHARS;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const line = `${roleLabel(message)}: ${clip(message.text.trim(), TRANSCRIPT_ITEM_MAX_CHARS)}`;
    if (line.length + 2 > remaining) {
      lines.unshift("[Earlier messages omitted]");
      break;
    }
    lines.unshift(line);
    remaining -= line.length + 2;
  }
  return lines.join("\n\n");
};

/** The most recent messages, newest kept, within the handoff's own budget. */
export const recentMessages = (messages: ReadonlyArray<OrchestrationV2HistoricalMessage>) => {
  const kept: Array<OrchestrationV2HistoricalMessage> = [];
  let bytes = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const size = Buffer.byteLength(message.text);
    if (kept.length >= RECENT_MAX_MESSAGES || bytes + size > RECENT_MAX_BYTES) break;
    kept.unshift(message);
    bytes += size;
  }
  return kept;
};

const firstLine = (text: string, max: number) =>
  clip((text.trim().split("\n")[0] ?? "").trim(), max);

/**
 * The summary when no model wrote one: the Thread's title, its last requests and reply, and the
 * files it changed. Nothing is invented; it only points at what the history holds.
 */
export const mechanicalSummary = (input: {
  readonly threadTitle: string;
  readonly history: MoveHistory;
}) => {
  const requests = input.history.messages
    .filter((message) => message.kind === "user_message")
    .slice(-5)
    .map((message) => `- ${firstLine(message.text, 200)}`);
  const lastReply = input.history.messages.findLast(
    (message) => message.kind === "assistant_message",
  );
  const files = input.history.changedFiles.slice(-30);
  return clip(
    [
      `Thread: ${input.threadTitle}`,
      `Turns so far: ${input.history.completedTurns}`,
      ...(requests.length === 0 ? [] : ["The User's latest requests (newest last):", ...requests]),
      ...(lastReply === undefined
        ? []
        : ["The agent's last reply:", clip(lastReply.text.trim(), 600)]),
      files.length === 0 ? "Files changed: none recorded." : `Files changed: ${files.join(", ")}`,
    ].join("\n"),
    THREAD_HANDOFF_SUMMARY_MAX_CHARS,
  );
};

/** The text the agent receives ahead of the recent messages. */
export const handoffContext = (input: {
  readonly sourceName: string;
  readonly targetName: string;
  readonly writtenBy: OrchestrationV2ThreadHandoffWriter;
  readonly writerName: string | null;
  readonly summary: string;
  readonly recentCount: number;
}) =>
  [
    `This Thread moved from ${input.sourceName} to ${input.targetName}. You continue it in a new session on ${input.targetName}; the previous session stayed on ${input.sourceName}.`,
    "",
    input.writtenBy === "fallback"
      ? "Summary of the work so far (assembled from the Thread's history, because no summary could be written):"
      : `Summary of the work so far, written by the Thread's provider on ${input.writerName ?? input.sourceName}:`,
    clip(input.summary.trim(), THREAD_HANDOFF_SUMMARY_MAX_CHARS),
    "",
    input.recentCount === 0
      ? "The Thread has no earlier messages."
      : `The Thread's ${input.recentCount} most recent messages follow.`,
    "To look up anything older (decisions, commands, earlier requests), use the `thread_history` tool: it searches and reads this Thread's full history.",
  ].join("\n");
