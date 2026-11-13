/**
 * Spec 4 ticket 07: on a Hub running on AI accounts, Antigravity (a driver without a base URL)
 * never writes titles, messages or summaries: it would sign in with the machine's Google account.
 * Another model writes them, or the call says why.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AiGatewaySessions from "../ai/AiGatewaySessions.ts";
import * as HubRunsAgents from "../environment/HubRunsAgents.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const instance = (id: string, driver: string, wrote: Array<string>) => ({
  instanceId: ProviderInstanceId.make(id),
  driverKind: ProviderDriverKind.make(driver),
  snapshot: {
    getSnapshot: Effect.succeed({
      instanceId: ProviderInstanceId.make(id),
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
    }),
  },
  textGeneration: {
    generateThreadTitle: () => Effect.sync(() => (wrote.push(id), { title: `title by ${id}` })),
  },
});

const generateTitle = (options: { readonly aiAccounts: boolean; readonly fallback: boolean }) =>
  Effect.gen(function* () {
    const wrote: Array<string> = [];
    const instances = [
      instance("antigravity", "antigravity", wrote),
      ...(options.fallback ? [instance("codex", "codex", wrote)] : []),
    ];
    const service = yield* TextGeneration.make.pipe(
      Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (id: ProviderInstanceId) =>
          Effect.succeed(instances.find((candidate) => candidate.instanceId === id)),
        listInstances: Effect.succeed(instances),
      } as never),
      Effect.provideService(
        SourceControlProviderRegistry.SourceControlProviderRegistry,
        {} as never,
      ),
      Effect.provideService(ServerSettings.ServerSettingsService, {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      } as never),
      Effect.provideService(HubRunsAgents.HubRunsAgents, true),
      Effect.provideService(AiGatewaySessions.AiGatewaySessions, {
        applies: () => Effect.succeed(options.aiAccounts),
      } as never),
    );
    const result = yield* service
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "fix the login",
        linkedContext: [],
        modelSelection: { instanceId: ProviderInstanceId.make("antigravity"), model: "gemini" },
      } as never)
      .pipe(Effect.result);
    return { wrote, result };
  });

describe("TextGeneration on a Hub running on AI accounts (spec 4 ticket 07)", () => {
  it.effect("lets another model write instead of Antigravity on its machine login", () =>
    Effect.gen(function* () {
      const { wrote } = yield* generateTitle({ aiAccounts: true, fallback: true });
      assert.deepEqual(wrote, ["codex"]);
    }),
  );

  it.effect("says why when no other model can, never signing in to Google", () =>
    Effect.gen(function* () {
      const { wrote, result } = yield* generateTitle({ aiAccounts: true, fallback: false });
      assert.deepEqual(wrote, []);
      assert.isTrue(result._tag === "Failure");
      assert.include(JSON.stringify(result), "runs on AI accounts");
    }),
  );

  it.effect("keeps Antigravity where AI accounts do not apply", () =>
    Effect.gen(function* () {
      const { wrote } = yield* generateTitle({ aiAccounts: false, fallback: true });
      assert.deepEqual(wrote, ["antigravity"]);
    }),
  );
});
