import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { SecretProviderId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { AI_GATEWAY_ENV_NAMES, AI_GATEWAY_KEY_VARIABLE } from "@t3tools/contracts";
import {
  AMBIENT_AI_VARIABLES,
  type AiGatewayProcess,
  aiGatewayModelSlug,
  aiGatewayVariables,
  applyAiGatewayEnv,
  applySecretEnv,
  codexGatewayConfigArgs,
  piGatewayModelsJson,
} from "./instanceEnvironment.ts";
import { mergeProviderInstanceEnvironment } from "./instanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join("/home/ada", tail),
        CLAUDE_CONFIG_DIR: path.join("/home/ada", tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("leaves inherited provider homes unchanged", () =>
    Effect.gen(function* () {
      const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
          baseEnv,
        ),
      ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
    }),
  );

  it.effect("overrides inherited environment values and preserves empty strings", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
            { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
            {
              name: "OPENAI_API_KEY",
              value: {
                provider: SecretProviderId.make("personal"),
                reference: "op://Private/OpenAI/credential",
              },
              sensitive: true,
            },
          ],
          { ANTHROPIC_API_KEY: "inherited", OPENAI_API_KEY: "inherited", PATH: "/bin" },
        ),
      ).toMatchObject({
        OPENROUTER_API_KEY: "sk-or-test",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "inherited",
        PATH: "/bin",
      });
    }),
  );

  it.effect("replaces every inherited spelling of a name on Windows, and only there", () =>
    Effect.gen(function* () {
      const merge = (platform: NodeJS.Platform) =>
        mergeProviderInstanceEnvironment(
          [{ name: "Https_Proxy", value: "http://gateway", sensitive: false }],
          { HTTPS_PROXY: "http://mine", PATH: "/bin" },
        ).pipe(Effect.provideService(HostProcess.Platform, platform));
      // A home variable in another spelling is still expanded.
      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "Codex_Home", value: "~/corp", sensitive: false }],
          {},
        ).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
        ),
      ).toEqual({ CODEX_HOME: "/home/ada/corp" });
      // Upper case sorts first, so it also wins where a spawn merges the parent environment back.
      expect(yield* merge("win32")).toEqual({ HTTPS_PROXY: "http://gateway", PATH: "/bin" });
      expect(yield* merge("linux")).toEqual({
        HTTPS_PROXY: "http://mine",
        Https_Proxy: "http://gateway",
        PATH: "/bin",
      });
    }),
  );
});

const KEY = "t3gk_secret-thread-key-0123456789";
const gateway: AiGatewayProcess = {
  key: KEY,
  aiAccountId: "acct-1" as AiGatewayProcess["aiAccountId"],
  aiAccountName: "Acme DeepSeek",
  provider: "openai-compatible",
  model: "deepseek-chat",
  baseUrl: "http://127.0.0.1:41000",
  home: "/state/provider-homes/abc/claudeAgent",
};

describe("the AI gateway in a provider process (spec 4 ticket 06)", () => {
  it("sets only names a Vault cannot hold (the list both specs share)", () => {
    for (const driver of ["claudeAgent", "codex", "opencode", "pi"] as const) {
      for (const name of Object.keys(aiGatewayVariables(driver, gateway))) {
        const reserved =
          AI_GATEWAY_ENV_NAMES.has(name) ||
          name === AI_GATEWAY_KEY_VARIABLE ||
          name.startsWith("T3_");
        expect(reserved, `${driver}: ${name}`).toBe(true);
      }
    }
  });

  it("drops every ambient AI variable, from the machine or a Vault, and sets the gateway's last", () => {
    const machine = {
      PATH: "/bin",
      HOME: "/home/owner",
      ANTHROPIC_API_KEY: "sk-ant-owner",
      CLAUDE_CODE_OAUTH_TOKEN: "owner-oauth",
      OPENAI_API_KEY: "sk-owner",
      CLAUDE_CONFIG_DIR: "/home/owner/.claude",
    };
    const withVault = applySecretEnv(
      machine,
      {
        fingerprint: "f",
        variables: [
          { name: "ANTHROPIC_BASE_URL", value: "https://evil.example" },
          { name: "APP_TOKEN", value: "app" },
        ],
      },
      "linux",
    );
    const env = applyAiGatewayEnv(withVault, aiGatewayVariables("claudeAgent", gateway), "linux");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:41000/api/ai/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    expect(env.CLAUDE_CONFIG_DIR).toBe(gateway.home);
    expect(env.ANTHROPIC_MODEL).toBe("deepseek-chat");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.APP_TOKEN).toBe("app");
    expect(env.HOME).toBe("/home/owner");
    for (const name of AMBIENT_AI_VARIABLES) {
      if (!(name in aiGatewayVariables("claudeAgent", gateway))) expect(env[name]).toBeUndefined();
    }
    // Off the gateway nothing changes.
    expect(applyAiGatewayEnv(machine, undefined, "linux")).toBe(machine);
  });

  it("names the key, never writes it, in Codex's arguments, Pi's models.json and OpenCode's config", () => {
    const args = codexGatewayConfigArgs(gateway).join(" ");
    expect(args).not.toContain(KEY);
    expect(args).toContain('model_providers.t3.env_key="T3_AI_GATEWAY_KEY"');
    expect(args).toContain('model_providers.t3.base_url="http://127.0.0.1:41000/api/ai/openai/v1"');
    expect(args).toContain('model_providers.t3.wire_api="responses"');
    expect(aiGatewayVariables("codex", gateway)).toEqual({
      T3_AI_GATEWAY_KEY: KEY,
      CODEX_HOME: gateway.home,
    });
    const models = piGatewayModelsJson(gateway);
    expect(models).not.toContain(KEY);
    expect(JSON.parse(models).providers.t3).toMatchObject({
      baseUrl: "http://127.0.0.1:41000/api/ai/openai/v1",
      apiKey: "$T3_AI_GATEWAY_KEY",
      models: [{ id: "deepseek-chat" }],
    });
    const opencode = aiGatewayVariables("opencode", gateway);
    expect(opencode.OPENCODE_CONFIG_CONTENT).not.toContain(KEY);
    expect(JSON.parse(opencode.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      enabled_providers: ["t3"],
      model: "t3/deepseek-chat",
      provider: { t3: { options: { apiKey: "{env:T3_AI_GATEWAY_KEY}" } } },
    });
    expect(opencode.XDG_CONFIG_HOME).toBe(`${gateway.home}/config`);
    expect(aiGatewayVariables("pi", gateway).PI_CODING_AGENT_DIR).toBe(gateway.home);
    expect(aiGatewayModelSlug("t3/gpt-5")).toBe("t3/gpt-5");
    expect(aiGatewayModelSlug("deepseek-chat")).toBe("t3/deepseek-chat");
    // A gateway model with a slash keeps it (OpenRouter's names, for one).
    expect(aiGatewayModelSlug("t3/deepseek/deepseek-chat")).toBe("t3/deepseek/deepseek-chat");
    const routed = { ...gateway, model: "t3/deepseek/deepseek-chat" };
    expect(JSON.parse(piGatewayModelsJson(routed)).providers.t3.models[0].id).toBe(
      "deepseek/deepseek-chat",
    );
  });
});

describe("a direct AI account credential in a provider process (spec 4 ticket 07)", () => {
  it("keeps a Vault's Google credentials in a gateway process (gcloud, terraform)", () => {
    const env = applyAiGatewayEnv(
      { PATH: "/bin", GOOGLE_APPLICATION_CREDENTIALS: "/vault/sa.json", CURSOR_API_KEY: "c" },
      { ANTHROPIC_BASE_URL: "http://127.0.0.1:1/api/ai/anthropic" },
      "linux",
    );
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/vault/sa.json");
    expect(env.CURSOR_API_KEY).toBe("c");
  });

  it("unsets the machine's AI credentials, then sets the Thread's set back, a Vault's included", () => {
    const env = applySecretEnv(
      {
        PATH: "/bin",
        GOOGLE_APPLICATION_CREDENTIALS: "/machine/sa.json",
        CURSOR_API_KEY: "machine-key",
        GEMINI_API_KEY: "machine-gemini",
      },
      {
        fingerprint: "f",
        variables: [
          { name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/vault/sa.json" },
          { name: "CURSOR_API_KEY", value: "account-key" },
        ],
        aiCredential: "CURSOR_API_KEY",
      },
      "linux",
    );
    expect(env.CURSOR_API_KEY).toBe("account-key");
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/vault/sa.json");
    expect("GEMINI_API_KEY" in env && env.GEMINI_API_KEY === undefined).toBe(true);
    expect(env.PATH).toBe("/bin");
  });
});
