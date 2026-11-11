/**
 * «Hub con Environments»: a delegated task runs where its parent Thread runs. Its child Thread is
 * created and sent its first message in one command, before the child is projected, so its
 * machine comes from its creation (the parent's), not from a projected row.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeHub, seedProject } from "./HubWithEnvironments.testkit.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-sonnet-4-6" };

/** A machine whose provider sessions never finish opening: each Thread's run stays on, and the
 * test sees which Thread each session was opened for. */
const holdingAdapters = (opened: Queue.Queue<ThreadId>) =>
  ProviderAdapterRegistry.layerFromAdapters([
    {
      instanceId,
      driver: CLAUDE,
      getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) =>
        Queue.offer(opened, input.threadId).pipe(Effect.andThen(Effect.never)),
    },
  ]);

describe("Hub con Environments: delegated tasks", () => {
  it.live.each([
    { hubRunsAgents: true, label: "a Hub that runs agents" },
    { hubRunsAgents: false, label: "an agentless Hub (the default)" },
  ])(
    "on $label, a delegated task of a Thread on a joined Environment starts on that machine",
    ({ hubRunsAgents }) =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ hubRunsAgents });
        const opened = yield* Queue.unbounded<ThreadId>();
        const laptop = yield* hub.join({ name: "Laptop", adapters: holdingAdapters(opened) });
        const orchestrator = hub.service(Orchestrator.OrchestratorV2);
        const projectId = ProjectId.make("project:delegated-remote");
        const parentThreadId = ThreadId.make("thread:delegated-remote-parent");
        yield* seedProject(hub.server, {
          projectId,
          title: "Delegated",
          defaultModelSelection: modelSelection,
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:delegated-remote-create"),
          threadId: parentThreadId,
          projectId,
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeEnvironmentId: laptop.environmentId,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:delegated-remote-message"),
          threadId: parentThreadId,
          messageId: MessageId.make("message:delegated-remote-parent"),
          text: "Delegate something",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        // The parent's run is on, on the Laptop.
        assert.equal(yield* Queue.take(opened), parentThreadId);
        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;

        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make("command:delegated-remote-task"),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Do the delegated part",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
        });

        const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (candidate) => candidate.prompt === "Do the delegated part",
        );
        assert.isDefined(task);
        const childThreadId = task.childThreadId!;
        const child = yield* orchestrator.getThreadProjection(childThreadId);
        assert.equal(child.thread.activeEnvironmentId, laptop.environmentId);
        assert.lengthOf(child.runs, 1);
        // Its first message opens its session on the parent's machine, the Laptop.
        assert.equal(yield* Queue.take(opened), childThreadId);
      }).pipe(Effect.scoped),
  );
});
