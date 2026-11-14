import {
  type AiAccountId,
  type AiAccountPickerResult,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyAiAccountsToProviders,
  modelFamilyOf,
  nameThreadAiAccount,
  resolveAiAccount,
} from "./aiAccountPicker.ts";

const claude: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.0.0",
  // The Hub machine has no Claude login of its own.
  status: "error",
  auth: { status: "unauthenticated" },
  message: "Claude is not authenticated.",
  setup: { canAuthenticate: true, canInstall: false },
  checkedAt: "2026-11-13T00:00:00.000Z",
  models: [
    {
      slug: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};
const cursor: ServerProvider = {
  ...claude,
  instanceId: ProviderInstanceId.make("cursor"),
  driver: ProviderDriverKind.make("cursor"),
  models: [{ slug: "auto", name: "Auto", isCustom: false, capabilities: null }],
};

const acmeClaude = "acct-acme-claude" as AiAccountId;
const acmeGoogle = "acct-acme-google" as AiAccountId;
const picker: AiAccountPickerResult = {
  applies: true,
  spaceName: "Acme",
  accounts: [
    {
      id: acmeClaude,
      name: "Acme Claude",
      type: "subscription",
      provider: "claude",
      priority: 1,
      models: ["claude-sonnet-5-5"],
    },
    {
      id: acmeGoogle,
      name: "Acme Google",
      type: "subscription",
      provider: "antigravity",
      priority: 2,
      models: ["gemini-3-pro", "claude-sonnet-5-5"],
    },
  ],
};

describe("applyAiAccountsToProviders", () => {
  it("offers a gateway agent with an allowed account, whatever the machine's login says", () => {
    const [shown] = applyAiAccountsToProviders([claude], picker);
    expect(shown?.status).toBe("ready");
    expect(shown?.auth.status).toBe("authenticated");
    expect(shown?.setup).toBeUndefined();
    expect(shown?.message).toBeUndefined();
    // Every allowed account's models; another family with its family named.
    expect(shown?.models.map((model) => [model.slug, model.subProvider])).toEqual([
      ["claude-sonnet-5-5", undefined],
      ["gemini-3-pro", "Gemini"],
    ]);
  });

  it("never offers a provider on the machine's login when no allowed account fits it", () => {
    const loggedIn = {
      ...cursor,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
    };
    const [shown] = applyAiAccountsToProviders([loggedIn], picker);
    expect(shown?.status).toBe("error");
    expect(shown?.message).toBe("No AI account is allowed for you in Acme.");
  });

  it("keeps the agent's own models when the Hub could not read an account's catalog", () => {
    const unknown: AiAccountPickerResult = {
      ...picker,
      accounts: [{ ...picker.accounts[0]!, models: null }],
    };
    const [shown] = applyAiAccountsToProviders([claude], unknown);
    expect(shown?.status).toBe("ready");
    expect(shown?.models.map((model) => model.slug)).toEqual(["claude-sonnet-5-5"]);
    expect(
      resolveAiAccount({
        driver: "claudeAgent",
        model: "claude-sonnet-5-5",
        picker: unknown,
        preferred: undefined,
      })?.id,
    ).toBe(acmeClaude);
  });

  it("leaves the providers as the Hub reports them off AI accounts", () => {
    const off = { ...picker, applies: false };
    expect(applyAiAccountsToProviders([claude], off)).toEqual([claude]);
    expect(applyAiAccountsToProviders([claude], null)).toEqual([claude]);
  });
});

describe("resolveAiAccount", () => {
  it("defaults to the first allowed that serves the model, and keeps a fitting choice", () => {
    const base = { driver: "claudeAgent", picker, preferred: undefined };
    expect(resolveAiAccount({ ...base, model: "claude-sonnet-5-5" })?.id).toBe(acmeClaude);
    expect(resolveAiAccount({ ...base, model: "gemini-3-pro" })?.id).toBe(acmeGoogle);
    expect(
      resolveAiAccount({ ...base, model: "claude-sonnet-5-5", preferred: acmeGoogle })?.id,
    ).toBe(acmeGoogle);
    // An account that is not allowed here is never the answer.
    expect(
      resolveAiAccount({
        ...base,
        model: "claude-sonnet-5-5",
        preferred: "acct-globex" as AiAccountId,
      })?.id,
    ).toBe(acmeClaude);
    expect(resolveAiAccount({ ...base, driver: "cursor", model: "auto" })).toBeUndefined();
  });

  it("names model families", () => {
    expect(modelFamilyOf("gemini-3-pro")).toBe("Gemini");
    expect(modelFamilyOf("gpt-5.5")).toBe("OpenAI");
    expect(modelFamilyOf("mystery")).toBeUndefined();
  });
});

describe("nameThreadAiAccount", () => {
  it("names the account in use only from the viewer's own accounts", () => {
    const session = {
      id: acmeGoogle,
      provider: "antigravity" as const,
      model: "claude-sonnet-5-5",
    };
    expect(nameThreadAiAccount({ session, threadSelection: null, picker })?.name).toBe(
      "Acme Google",
    );
    // A viewer who may not use it sees its provider, never its name.
    expect(nameThreadAiAccount({ session, threadSelection: null, picker: null })?.name).toBe(
      "Antigravity account",
    );
  });

  it("shows the Thread's chosen account before any session runs", () => {
    expect(
      nameThreadAiAccount({
        session: null,
        threadSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-5-5",
          aiAccountId: acmeClaude,
        },
        picker,
      }),
    ).toEqual({
      id: acmeClaude,
      name: "Acme Claude",
      provider: "claude",
      model: "claude-sonnet-5-5",
    });
  });
});
