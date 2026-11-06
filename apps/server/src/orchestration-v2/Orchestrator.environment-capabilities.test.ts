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

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

// The Hub machine reads capabilities once, for its snapshot. Asking again while deciding fails.
let capabilityReads = 0;
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () =>
    Effect.suspend(() => {
      capabilityReads += 1;
      return capabilityReads === 1
        ? Effect.succeed(CodexProviderCapabilitiesV2)
        : Effect.die("The Orchestrator asked the adapter for capabilities while deciding");
    }),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Execution is paused after dispatch"),
};

const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "environment-capabilities" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

it.effect("deciding a turn reads provider capabilities from the Environment snapshot", () =>
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
    assert.equal(capabilityReads, 1);
  }).pipe(Effect.provide(layer)),
);
