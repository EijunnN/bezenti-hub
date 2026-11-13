import { describe, expect, it } from "vite-plus/test";

import { gatewayOrigin, LOCAL_CLI_KEY_PLACEHOLDER, localCliSetup } from "./aiGatewayLocalCli.ts";

const KEY = "t3gk_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

describe("localCliSetup", () => {
  it("points Claude Code at the Hub's Anthropic shape with the key as its auth token", () => {
    const setup = localCliSetup("https://hub.example.com", KEY);
    expect(JSON.parse(setup.claudeCode)).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "https://hub.example.com/api/ai/anthropic",
        ANTHROPIC_AUTH_TOKEN: KEY,
      },
    });
  });

  it("gives Codex a model provider on the Hub's OpenAI shape that reads the key from the environment", () => {
    const setup = localCliSetup("https://hub.example.com", KEY);
    expect(setup.codex).toContain('model_provider = "t3"');
    expect(setup.codex).toContain("[model_providers.t3]");
    expect(setup.codex).toContain('base_url = "https://hub.example.com/api/ai/openai/v1"');
    expect(setup.codex).toContain('env_key = "T3_AI_GATEWAY_KEY"');
    expect(setup.codex).toContain('wire_api = "responses"');
    expect(setup.codexShell).toContain(`export T3_AI_GATEWAY_KEY='${KEY}'`);
  });

  it("uses a placeholder once the key is no longer shown", () => {
    const setup = localCliSetup("http://127.0.0.1:4310", null);
    expect(setup.claudeCode).toContain(LOCAL_CLI_KEY_PLACEHOLDER);
    expect(setup.codexShell).toContain(LOCAL_CLI_KEY_PLACEHOLDER);
    expect(setup.claudeCode).not.toContain("t3gk_");
  });

  it("keeps only the origin of the Hub's address", () => {
    expect(gatewayOrigin("https://hub.example.com/some/page?x=1")).toBe("https://hub.example.com");
    expect(gatewayOrigin("http://127.0.0.1:4310/")).toBe("http://127.0.0.1:4310");
    expect(gatewayOrigin("file:///etc/passwd")).toBeNull();
    expect(gatewayOrigin("not a url")).toBeNull();
  });
});

describe("localCliSetup keeps the key out of Codex's config file", () => {
  it("puts the key only in the shell line, never in config.toml", () => {
    const setup = localCliSetup("https://hub.example.com", KEY);
    expect(setup.codex).not.toContain(KEY);
    expect(setup.codexShell).toBe(`export T3_AI_GATEWAY_KEY='${KEY}'`);
  });
});
