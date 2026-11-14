import type { AiAccountSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  accountRows,
  aiAccountSelection,
  MOBILE_FORBIDDEN_AI_METHODS,
  ownKeys,
  quotaText,
  withAiAccount,
} from "./aiAccountsView.ts";

const account = (over: Record<string, unknown>): AiAccountSummary =>
  ({
    name: "Work Claude",
    type: "subscription",
    provider: "claude",
    priority: 1,
    status: "working",
    statusMessage: null,
    disabled: false,
    usableIn: [],
    details: null,
    ...over,
  }) as unknown as AiAccountSummary;

describe("accountRows", () => {
  it("orders by priority and words the status", () => {
    const rows = accountRows([
      account({ id: "b", priority: 2, status: "needs-sign-in", name: "B" }),
      account({ id: "a", priority: 1, name: "A" }),
    ]);
    expect(rows.map((row) => row.name)).toEqual(["A", "B"]);
    expect(rows[1]?.statusLabel).toBe("Needs sign-in again");
  });

  it("shows quota windows and the signed-in account for the Owner, nothing for a Member", () => {
    const owner = accountRows([
      account({
        id: "a",
        details: {
          keyHint: "wxyz",
          baseUrl: null,
          models: [],
          allowances: { spaceIds: [], userIds: [] },
          signedInAs: "o@example.com",
          usageLimits: {
            checkedAt: "2026-01-01T00:00:00Z",
            windows: [{ id: "s", kind: "session", label: "5h", usedPercent: 41.6 }],
          },
          createdAt: "",
          updatedAt: "",
        },
      }),
    ]);
    expect(owner[0]?.quota).toBe("Quota: 5h 42% used.");
    expect(owner[0]?.signedInAs).toBe("o@example.com");
    expect(accountRows([account({ id: "m" })])[0]?.quota).toBeNull();
  });

  it("never carries a key hint or credential into a row", () => {
    const rows = accountRows([
      account({
        id: "a",
        details: {
          keyHint: "wxyz",
          baseUrl: null,
          models: [],
          allowances: { spaceIds: [], userIds: [] },
          createdAt: "",
          updatedAt: "",
        },
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("wxyz");
  });
});

describe("quotaText", () => {
  it("is null without windows", () => {
    expect(quotaText(null)).toBeNull();
  });
});

describe("MOBILE_FORBIDDEN_AI_METHODS", () => {
  it("covers sign-in, accounts management and the gateway update", () => {
    expect(MOBILE_FORBIDDEN_AI_METHODS).toContain("aiAccounts.login.start");
    expect(MOBILE_FORBIDDEN_AI_METHODS).toContain("aiAccounts.login.complete");
    expect(MOBILE_FORBIDDEN_AI_METHODS).toContain("aiGateway.update");
    expect(MOBILE_FORBIDDEN_AI_METHODS).toContain("aiAccounts.create");
  });
});

describe("ownKeys", () => {
  const keys = [
    { keyId: "k1", userId: "ada" },
    { keyId: "k2", userId: "olivia" },
  ];
  it("keeps only the viewer's keys, even in the Owner's list of everyone's", () => {
    expect(ownKeys(keys, "olivia").map((key) => key.keyId)).toEqual(["k2"]);
    expect(ownKeys(keys, null)).toEqual([]);
  });
});

describe("aiAccountSelection", () => {
  const thread = { instanceId: "claudeAgent", model: "m", aiAccountId: "a2" } as never;
  it("mid-Thread, the account is the Thread's whatever the composer's draft selection says", () => {
    const draft = { instanceId: "claudeAgent", model: "m2" } as never;
    expect(aiAccountSelection({ isDraft: false, thread, draft })).toMatchObject({
      model: "m2",
      aiAccountId: "a2",
    });
  });
  it("on a new-task draft, the draft's own selection stands", () => {
    expect(aiAccountSelection({ isDraft: true, thread, draft: null })).toBe(thread);
  });
});

describe("withAiAccount", () => {
  it("puts the chosen account into the selection", () => {
    expect(withAiAccount({ instanceId: "x", model: "m" } as never, "a1" as never)).toMatchObject({
      aiAccountId: "a1",
    });
  });
});
