import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2HistoricalMessage,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

import * as MoveHandoff from "./MoveHandoff.ts";

const message = (
  index: number,
  role: "user" | "assistant",
  text: string,
): OrchestrationV2HistoricalMessage => ({
  role,
  text,
  threadId: ThreadId.make("thread:handoff"),
  runId: RunId.make(`run:${index}`),
  itemId: TurnItemId.make(`item:${index}`),
  providerThreadId: null,
  status: "completed",
  kind: role === "user" ? "user_message" : "assistant_message",
});

describe("MoveHandoff", () => {
  it("keeps recent messages when the newest one is too large, with the last request whole", () => {
    const messages = [
      message(1, "user", "First request"),
      message(2, "assistant", "First reply"),
      message(3, "user", "Please refactor the parser"),
      message(4, "assistant", "x".repeat(50_000)),
    ];
    const recent = MoveHandoff.recentMessages(messages);
    assert.isNotEmpty(recent);
    assert.include(
      recent.map((entry) => entry.text),
      "Please refactor the parser",
    );
    const huge = recent.find((entry) => entry.itemId === "item:4");
    assert.isDefined(huge, "the newest message is clipped, not dropped");
    assert.isBelow(huge.text.length, 50_000);
    assert.isAtMost(
      recent.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0),
      12_000,
    );
  });

  it("keeps the newest message of the transcript whole within its budget", () => {
    // Ten replies fill the budget almost exactly; the omission marker must still fit in it.
    const messages = Array.from({ length: 40 }, (_, index) =>
      message(index, "assistant", `${String(index).padStart(2, "0")}${"y".repeat(3_988)}`),
    );
    const transcript = MoveHandoff.renderTranscript(messages);
    assert.isAtMost(transcript.length, 40_000);
    assert.isTrue(transcript.endsWith(`39${"y".repeat(3_988)}`));
    assert.isTrue(transcript.startsWith("[Earlier messages omitted]"));
  });
});
