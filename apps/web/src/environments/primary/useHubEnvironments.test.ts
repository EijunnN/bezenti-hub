import {
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type HubEnvironmentSummary,
  ProviderDriverKind,
  ProviderInstanceId,
  UserId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { previewDefaultEnvironment } from "./useHubEnvironments";

const claude = ProviderInstanceId.make("claudeAgent");
const ada = UserId.make("ada");
const machine = (
  id: string,
  overrides: Partial<HubEnvironmentSummary> = {},
): HubEnvironmentSummary => ({
  id: EnvironmentId.make(id),
  name: id,
  kind: "external",
  mode: "personal",
  ownerUserId: ada,
  status: "online",
  registeredAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: null,
  os: null,
  hostname: null,
  providers: [
    {
      instanceId: claude,
      provider: ProviderDriverKind.make("claudeAgent"),
      displayName: null,
      enabled: true,
      installed: true,
      version: null,
      capabilities: {} as never,
    },
  ],
  resources: null,
  runningThreadCount: 0,
  ...overrides,
});
const hubMachine = machine(HUB_MACHINE_ENVIRONMENT_ID, { kind: "hub", ownerUserId: null });

describe("previewDefaultEnvironment", () => {
  const preview = (laptop: HubEnvironmentSummary, userId = ada) =>
    previewDefaultEnvironment({
      environments: [hubMachine, laptop],
      preferredEnvironmentId: laptop.id,
      providerInstanceId: claude,
      userId,
    });

  it("shows where the Hub will start the Thread, never an unavailable preference", () => {
    expect(preview(machine("laptop"))).toBe("laptop");
    // The Owner sees others' machines but runs nothing on them.
    expect(preview(machine("laptop"), UserId.make("grace"))).toBe(HUB_MACHINE_ENVIRONMENT_ID);
    expect(preview(machine("laptop", { status: "offline" }))).toBe(HUB_MACHINE_ENVIRONMENT_ID);
    expect(preview(machine("laptop", { status: "reconnecting" }))).toBe(HUB_MACHINE_ENVIRONMENT_ID);
    expect(preview(machine("laptop", { providers: [] }))).toBe(HUB_MACHINE_ENVIRONMENT_ID);
    expect(
      previewDefaultEnvironment({
        environments: [hubMachine],
        preferredEnvironmentId: EnvironmentId.make("hidden"),
        providerInstanceId: claude,
        userId: ada,
      }),
    ).toBe(HUB_MACHINE_ENVIRONMENT_ID);
  });
});
