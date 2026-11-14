import { ProviderDriverKind, SecretProviderId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { aiCredentialAdded, aiCredentialLeftovers } from "./aiCredentialSettings.logic";

const stored = { name: "OPENAI_API_KEY", value: "", sensitive: true, valueRedacted: true };

describe("AI credentials in the provider form (spec 4 ticket 09)", () => {
  it("refuses an AI credential added or changed, not one kept, cleared or removed", () => {
    expect(
      aiCredentialAdded([], [{ name: "OPENAI_API_KEY", value: "sk-1", sensitive: true }]),
    ).toBe("OPENAI_API_KEY");
    expect(
      aiCredentialAdded([], [{ name: "ANTHROPIC_API_KEY", value: "sk-2", sensitive: false }]),
    ).toBe("ANTHROPIC_API_KEY");
    expect(aiCredentialAdded([stored], [stored])).toBeUndefined();
    expect(
      aiCredentialAdded([stored], [{ name: "OPENAI_API_KEY", value: "sk-new", sensitive: true }]),
    ).toBe("OPENAI_API_KEY");
    expect(
      aiCredentialAdded([stored], [{ name: "OPENAI_API_KEY", value: "", sensitive: true }]),
    ).toBeUndefined();
    expect(aiCredentialAdded([stored], [])).toBeUndefined();
    // A new one is refused even before its value, and whatever its case.
    expect(aiCredentialAdded([], [{ name: "OPENAI_API_KEY", value: "", sensitive: true }])).toBe(
      "OPENAI_API_KEY",
    );
    expect(
      aiCredentialAdded([], [{ name: "openai_api_key", value: "sk-3", sensitive: true }]),
    ).toBe("openai_api_key");
    expect(
      aiCredentialAdded([], [{ name: "HTTPS_PROXY_TOKEN", value: "x", sensitive: true }]),
    ).toBeUndefined();
  });

  it("lists what an instance still holds", () => {
    expect(
      aiCredentialLeftovers({
        driver: ProviderDriverKind.make("opencode"),
        environment: [
          {
            name: "GEMINI_API_KEY",
            value: { provider: SecretProviderId.make("onepassword"), reference: "op://x/y" },
            sensitive: true,
          },
          { name: "HTTPS_PROXY_TOKEN", value: "", sensitive: true, valueRedacted: true },
        ],
      }),
    ).toEqual(["GEMINI_API_KEY"]);
    expect(
      aiCredentialLeftovers({
        driver: ProviderDriverKind.make("antigravity"),
        config: { apiKey: "••••••" },
      }),
    ).toEqual(["API key"]);
    expect(
      aiCredentialLeftovers({ driver: ProviderDriverKind.make("antigravity"), config: {} }),
    ).toEqual([]);
  });
});
