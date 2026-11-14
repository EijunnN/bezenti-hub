import { EnvironmentId, type AiAccountSummary, type AiGatewayUserKey } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Redacted from "effect/Redacted";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    may: true,
    commands: {} as Record<string, ReturnType<typeof vi.fn>>,
    usage: null as unknown,
    copied: [] as string[],
  },
}));

vi.mock("react-native", async () => (await import("../vaults/testkit")).nativeMocks.reactNative());
vi.mock("../../components/ui/AppText", async () =>
  (await import("../vaults/testkit")).nativeMocks.appText(),
);
vi.mock("../../components/ui/Button", async () =>
  (await import("../vaults/testkit")).nativeMocks.button(),
);
vi.mock("../../components/ui/ListSection", async () =>
  (await import("../vaults/testkit")).nativeMocks.listSection(),
);
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.may }));
vi.mock("../../state/aiGateway", () => ({
  aiGatewayEnvironment: {
    listAccounts: { id: "listAccounts" },
    usageSummary: () => ({}),
    listKeys: { id: "listKeys" },
    createKey: { id: "createKey", permissionAtom: () => ({}) },
    revokeKey: { id: "revokeKey", permissionAtom: () => ({}) },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: mocks.usage, error: null, isPending: false }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { id: string }) => mocks.commands[command.id],
}));
vi.mock("../../state/spaces", () => ({
  useSpaceSelections: () => new Map([["hub", { view: { userId: "u1" } }]]),
}));
vi.mock("../../state/hubLinks", () => ({ readHubLinkOrigin: () => "https://hub.example.com" }));
vi.mock("../../lib/copyTextWithHaptic", () => ({
  tryCopyTextWithHaptic: (text: string) => {
    mocks.copied.push(text);
    return Promise.resolve(true);
  },
}));

import { AiAccountsList } from "./AiAccountsList";
import { LocalCliKeys } from "./LocalCliKeys";

const hub = EnvironmentId.make("hub");
const ok = (value: unknown) => Promise.resolve({ _tag: "Success", value });
const account = (over: Record<string, unknown>) =>
  ({
    id: "a1",
    name: "Work Claude",
    type: "subscription",
    provider: "claude",
    priority: 1,
    status: "needs-sign-in",
    statusMessage: "The session expired.",
    disabled: false,
    usableIn: [],
    details: null,
    ...over,
  }) as unknown as AiAccountSummary;
const userKey = {
  keyId: "k1",
  name: "Laptop",
  userId: "u1",
  userName: null,
  spaceId: "s1",
  spaceName: "Personal",
  createdAt: "2026-01-01T00:00:00Z",
  lastUsedAt: null,
} as unknown as AiGatewayUserKey;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const text = () => container?.textContent ?? "";
const byLabel = (label: string) =>
  container?.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const click = (label: string) => act(async () => byLabel(label)?.click());
const render = async (node: React.ReactNode) => {
  await act(async () => root?.render(node));
  await act(async () => {});
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.may = true;
  mocks.copied = [];
  mocks.usage = null;
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("Settings → AI accounts on mobile", () => {
  it("shows status, message and quota read-only, with no Owner control", async () => {
    mocks.commands.listAccounts = vi.fn(() =>
      ok({
        canManage: true,
        accounts: [
          account({
            details: {
              keyHint: "wxyz",
              baseUrl: null,
              models: [],
              allowances: { spaceIds: [], userIds: [] },
              usageLimits: {
                checkedAt: "2026-01-01T00:00:00Z",
                windows: [{ id: "w", kind: "weekly", label: "Weekly", usedPercent: 80 }],
              },
              createdAt: "",
              updatedAt: "",
            },
          }),
        ],
      }),
    );
    await render(<AiAccountsList environmentId={hub} />);
    expect(text()).toContain("Work Claude");
    expect(text()).toContain("Needs sign-in again");
    expect(text()).toContain("The session expired.");
    expect(text()).toContain("Quota: Weekly 80% used.");
    expect(text()).not.toContain("wxyz");
    expect(text()).not.toMatch(/Sign in again|Replace credential|Add subscription|Update/);
    expect(mocks.commands.listAccounts).toHaveBeenCalledTimes(1);
  });

  it("shows a Member the Hub's narrowed list as it is", async () => {
    mocks.commands.listAccounts = vi.fn(() =>
      ok({ canManage: false, accounts: [account({ status: "working", statusMessage: null })] }),
    );
    await render(<AiAccountsList environmentId={hub} />);
    expect(text()).toContain("Working");
    expect(text()).toContain("managed on web or desktop");
  });

  it("shows the Hub's refusal", async () => {
    mocks.commands.listAccounts = vi.fn(() =>
      Promise.resolve({ _tag: "Failure", cause: Cause.fail(new Error("Not allowed here.")) }),
    );
    await render(<AiAccountsList environmentId={hub} />);
    expect(text()).toContain("Not allowed here.");
  });
});

describe("Local CLI keys on mobile", () => {
  const setup = async () => {
    mocks.commands.listKeys = vi.fn(() => ok({ keys: [userKey], everyone: false }));
    mocks.commands.createKey = vi.fn(() =>
      ok({
        created: { ...userKey, keyId: "k2", name: "Desk" },
        key: Redacted.make("t3gw-secret-1"),
      }),
    );
    mocks.commands.revokeKey = vi.fn(() => ok({ keys: [], everyone: false }));
    await render(<LocalCliKeys environmentId={hub} />);
  };

  it("lists keys without any key and hides create/revoke without the grant", async () => {
    mocks.may = false;
    await setup();
    expect(text()).toContain("Laptop");
    expect(byLabel("Make a key")).toBeNull();
    expect(byLabel("Revoke Laptop")).toBeNull();
  });

  it("makes a key, copies it once, and never lists it again", async () => {
    await setup();
    await click("Make a key");
    expect(mocks.commands.createKey).toHaveBeenCalledTimes(1);
    expect(text()).toContain("not shown again");
    await click("Copy key");
    expect(mocks.copied).toEqual(["t3gw-secret-1"]);
    await click("Done");
    expect(text()).not.toContain("t3gw-secret-1");
  });

  it("shows the Owner only their own keys, never Revoke on someone else's", async () => {
    await setup();
    mocks.commands.listKeys = vi.fn(() =>
      ok({
        everyone: true,
        keys: [userKey, { ...userKey, keyId: "k9", name: "Grace desktop", userId: "u2" }],
      }),
    );
    await render(null);
    await render(<LocalCliKeys environmentId={hub} />);
    expect(text()).toContain("Laptop");
    expect(text()).not.toContain("Grace desktop");
    expect(byLabel("Revoke Grace desktop")).toBeNull();
  });

  it("revokes a key", async () => {
    await setup();
    await click("Revoke Laptop");
    expect(mocks.commands.revokeKey).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain("Laptop");
  });
});
