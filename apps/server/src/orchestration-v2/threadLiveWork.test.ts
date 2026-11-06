import { describe, expect, it } from "@effect/vitest";

import { threadHasLiveWork } from "./threadLiveWork.ts";

const done = { runs: [{ status: "completed" }], runtimeRequests: [] };

describe("threadHasLiveWork", () => {
  it.each([
    ["an idle Thread", { ...done, turnItems: [], subagents: [] }, false],
    [
      "a running turn",
      { ...done, runs: [{ status: "running" }], turnItems: [], subagents: [] },
      true,
    ],
    [
      "a background command after its turn completed",
      { ...done, turnItems: [{ type: "command_execution", status: "running" }], subagents: [] },
      true,
    ],
    [
      "a delegated task after its turn completed",
      { ...done, turnItems: [], subagents: [{ status: "running" }] },
      true,
    ],
    [
      "finished delegated tasks",
      { ...done, turnItems: [], subagents: [{ status: "completed" }, { status: "idle" }] },
      false,
    ],
  ] as const)("%s", (_name, records, expected) => {
    expect(threadHasLiveWork(records as never)).toBe(expected);
  });
});
