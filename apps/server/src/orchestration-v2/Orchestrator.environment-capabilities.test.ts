import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

// A remote Environment answers from its snapshot; the adapter must not be asked while deciding.
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () => Effect.die("The Orchestrator asked the adapter while deciding"),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Execution is paused after dispatch"),
};
const capabilityReads: Array<ThreadId> = [];
const snapshotCapabilities = EnvironmentExecutor.EnvironmentCapabilityCache.of({
  publish: () => Effect.void,
  snapshot: () => Effect.succeed(Option.none()),
  snapshotProvider: () => Effect.die("unused"),
  forThread: ({ threadId, providerInstanceId }) =>
    Effect.sync(() => {
      capabilityReads.push(threadId);
      return {
        instanceId: providerInstanceId,
        provider: driver,
        enabled: true,
        continuationKey: "codex:remote",
        capabilities: CodexProviderCapabilitiesV2,
      };
    }),
});

const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "environment-capabilities" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

it.effect("deciding a turn reads provider capabilities from the Environment cache", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("environment-capabilities-thread");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("environment-capabilities-create"),
      threadId,
      projectId: ProjectId.make("environment-capabilities-project"),
      title: "Capabilities",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("environment-capabilities-message"),
      threadId,
      messageId: MessageId.make("environment-capabilities-message"),
      text: "Start a turn",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });

    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.lengthOf(projection.runs, 1);
    assert.isAbove(capabilityReads.length, 0);
    assert.isTrue(capabilityReads.every((read) => read === threadId));
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(EnvironmentExecutor.EnvironmentCapabilityCache, snapshotCapabilities),
  ),
);
