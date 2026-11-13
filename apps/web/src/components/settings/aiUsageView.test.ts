import type { AiUsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { dayBefore, formatTokens, groupUsage, usageNotes } from "./aiUsageView";

const totals = (requests: number, input = 0, output = 0) => ({
  requests,
  failedRequests: 0,
  unknownRequests: 0,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const summary = {
  fromDay: "2026-11-01",
  toDay: "2026-11-02",
  scope: "all",
  rows: [
    {
      day: "2026-11-02",
      userId: "ada",
      spaceId: "acme",
      accountId: "a1",
      model: "m",
      ...totals(2, 20, 10),
    },
    {
      day: "2026-11-01",
      userId: "ada",
      spaceId: "acme",
      accountId: "a1",
      model: "m",
      ...totals(1, 11, 7),
    },
    {
      day: "2026-11-02",
      userId: "gus",
      spaceId: "globex",
      accountId: null,
      model: null,
      ...totals(5),
    },
  ],
  totals: totals(8, 31, 17),
  labels: {
    users: [{ id: "ada", name: "Ada" }],
    spaces: [
      { id: "acme", name: "Acme" },
      { id: "globex", name: "Globex" },
    ],
    accounts: [{ id: "a1", name: null, provider: "claude" }],
  },
  truncated: false,
  retentionDays: 90,
} as unknown as AiUsageSummary;

describe("groupUsage", () => {
  it("adds rows up per day, newest first", () => {
    const days = groupUsage(summary, "day");
    expect(days.map((group) => [group.key, group.totals.requests])).toEqual([
      ["2026-11-02", 7],
      ["2026-11-01", 1],
    ]);
  });

  it("names Users, Spaces and accounts, most requests first, hiding what it may not name", () => {
    expect(
      groupUsage(summary, "user").map((group) => [group.label, group.totals.requests]),
    ).toEqual([
      ["Removed User", 5],
      ["Ada", 3],
    ]);
    expect(groupUsage(summary, "space").map((group) => group.label)).toEqual(["Globex", "Acme"]);
    expect(groupUsage(summary, "account").map((group) => group.label)).toEqual([
      "No account reached",
      "Claude account",
    ]);
  });
});

describe("formatting", () => {
  it("shortens token counts", () => {
    expect(
      [0, 999, 1_000, 1_234, 15_600, 250_000, 3_400_000, 7_000_000_000].map(formatTokens),
    ).toEqual(["0", "999", "1k", "1.2k", "15.6k", "250k", "3.4M", "7B"]);
  });

  it("says what is unknown or failed, and nothing when all is well", () => {
    expect(usageNotes(totals(3))).toEqual([]);
    expect(usageNotes({ ...totals(3), unknownRequests: 1, failedRequests: 2 })).toEqual([
      "1 request without token counts",
      "2 failed",
    ]);
  });

  it("counts days back from today, inclusive", () => {
    expect(dayBefore(new Date("2026-11-13T10:00:00Z"), 7)).toBe("2026-11-07");
    expect(dayBefore(new Date("2026-11-13T10:00:00Z"), 1)).toBe("2026-11-13");
  });
});
