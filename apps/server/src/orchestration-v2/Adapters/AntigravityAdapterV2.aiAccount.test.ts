/**
 * Spec 4 ticket 07: an Antigravity session on a direct AI account runs in its Thread's own
 * profile, so its turn outcome is read there, never in the instance's profile.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { expect, vi } from "vite-plus/test";

import { antigravityAiAccountProfile } from "../../provider/antigravityAuthSupport.ts";
import { makeAntigravityAcpAdapterFlavor } from "./AntigravityAdapterV2.ts";

const watched: Array<string> = [];
vi.mock("../../provider/acp/AntigravityTurnOutcome.ts", () => ({
  watchAntigravityPromptOutcome: (profileDirectory: string) => {
    watched.push(profileDirectory);
    return Effect.succeed(() => Effect.succeed(undefined));
  },
}));

const PROFILE = "/state/providers/antigravity/abc";

it.effect("reads an AI-account session's turn outcome in its Thread's profile", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const flavor = makeAntigravityAcpAdapterFlavor({
      instanceId: ProviderInstanceId.make("antigravity-ai-account"),
      random: undefined as never,
      fileSystem: undefined as never,
      path,
      host: { paths: { attachmentsDir: "/attachments" } } as never,
      selfInvocation: undefined as never,
      profileDirectory: PROFILE,
      makeRuntime: () =>
        Effect.succeed({
          start: () => Effect.succeed({ sessionId: "session-direct" }),
        } as never),
      withProcess: (_stop, task) => task,
      defaultModel: Effect.undefined,
    });
    const open = (aiCredential: string | undefined) =>
      Effect.gen(function* () {
        const runtime = yield* flavor.makeRuntime({
          cwd: "/work",
          threadId: "thread:acme",
          ...(aiCredential === undefined ? {} : { aiCredential }),
          processEnvironment: aiCredential === undefined ? {} : { [aiCredential]: "key-0123" },
        } as never);
        yield* runtime.start();
      });
    yield* open("GEMINI_API_KEY");
    yield* flavor.watchPromptOutcome!("session-direct");
    yield* flavor.watchPromptOutcome!("session-of-another-runtime");
    expect(watched).toEqual([antigravityAiAccountProfile(path, PROFILE, "thread:acme"), PROFILE]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
