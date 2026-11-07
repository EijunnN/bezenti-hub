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

  it("counts a Sandbox that is not running as available: the Hub starts it for the work", () => {
    for (const status of ["stopped", "starting"] as const) {
      expect(
        previewThreadPlacement({
          preferred: preferred({ kind: "sandbox", status, providers: [] }),
          providerInstanceId: claude,
        }),
      ).toBe(laptop);
    }
    // Not once its start failed, nor stopped without the provider it reported.
    expect(
      previewThreadPlacement({
        preferred: preferred({ kind: "sandbox", status: "failed", providers: [] }),
        providerInstanceId: claude,
      }),
    ).toBe(HUB_MACHINE_ENVIRONMENT_ID);
    expect(
      previewThreadPlacement({
        preferred: preferred({
          kind: "sandbox",
          status: "stopped",
          providers: [{ ...provider, enabled: false }],
        }),
        providerInstanceId: claude,
      }),
    ).toBe(HUB_MACHINE_ENVIRONMENT_ID);
    expect(
      previewThreadPlacement({
        preferred: preferred({ kind: "sandbox", status: "stopped" }),
        providerInstanceId: claude,
      }),
    ).toBe(laptop);
    // Running, it is held to its providers like any machine; nobody may use it, nothing.
    expect(
      previewThreadPlacement({
        preferred: preferred({ kind: "sandbox", providers: [] }),
        providerInstanceId: claude,
      }),
    ).toBe(HUB_MACHINE_ENVIRONMENT_ID);
    expect(
      previewThreadPlacement({
        preferred: preferred({ kind: "sandbox", status: "stopped", usable: false }),
        providerInstanceId: claude,
      }),
    ).toBe(HUB_MACHINE_ENVIRONMENT_ID);
  });
});
