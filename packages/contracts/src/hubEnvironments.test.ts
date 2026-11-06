import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { HUB_MACHINE_ENVIRONMENT_ID } from "./environmentExecutor.ts";
import { previewThreadPlacement } from "./hubEnvironments.ts";

const laptop = EnvironmentId.make("laptop");
const claude = ProviderInstanceId.make("claudeAgent");
const provider = {
  instanceId: claude,
  provider: ProviderDriverKind.make("claudeAgent"),
  displayName: null,
  enabled: true,
  installed: true,
  version: null,
  capabilities: {} as never,
};
const preferred = (overrides: object = {}) => ({
  id: laptop,
  kind: "external" as const,
  status: "online" as const,
  providers: [provider],
  usable: true,
  ...overrides,
});

describe("previewThreadPlacement", () => {
  it("starts on the preferred Environment only while it can run the Thread", () => {
    expect(previewThreadPlacement({ preferred: preferred(), providerInstanceId: claude })).toBe(
      laptop,
    );
    for (const unavailable of [
      preferred({ usable: false }),
      preferred({ status: "offline" }),
      preferred({ status: "reconnecting" }),
      preferred({ providers: [{ ...provider, enabled: false }] }),
      preferred({ providers: [] }),
    ]) {
      expect(previewThreadPlacement({ preferred: unavailable, providerInstanceId: claude })).toBe(
        HUB_MACHINE_ENVIRONMENT_ID,
      );
    }
    expect(previewThreadPlacement({ preferred: undefined, providerInstanceId: claude })).toBe(
      HUB_MACHINE_ENVIRONMENT_ID,
    );
  });
});
