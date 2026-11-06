// @effect-diagnostics nodeBuiltinImport:off -- writes one attachment file for the Hub to serve.
import * as NodeFSP from "node:fs/promises";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderReplayTranscript,
  ProviderTurnId,
  MessageId,
  NodeId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { addMember } from "../auth/UserAuth.testkit.ts";
import * as ServerConfig from "../config.ts";
import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ClaudeOrchestratorReplayHarness } from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import { materializeFixtureInput } from "../orchestration-v2/testkit/fixtures/shared.ts";
import {
  runOrchestratorV2Scenario,
  type OrchestratorV2ScenarioStep,
} from "../orchestration-v2/testkit/OrchestratorScenario.ts";
import {
  findReplayFixture,
  readReplayFixtureTranscript,
} from "../orchestration-v2/testkit/ProviderReplayFixtures.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import {
  connectProtocolEnvironment,
  makeHub,
  seedProject,
  type Hub,
  type TestEnvironment,
} from "./HubWithEnvironments.testkit.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");

/**
 * The recorded fixtures ran under a runtime policy override (approval and sandbox policy). The
 * Hub resolves the policy and sends it with each call, so the replay machine lays the same
 * override over what it receives, as the single-machine harness lays it over its own policy.
 */
const withPolicyOverride = (
  adapters: Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    never,
    McpProviderSessions.McpProviderSessions
  >,
  override: RuntimePolicy.RuntimePolicyV2Override | undefined,
) => {
  if (override === undefined) return adapters;
  const apply = (
    policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  ): ProviderAdapter.ProviderAdapterV2RuntimePolicy => ({
    ...policy,
    ...(override.approvalPolicy === undefined ? {} : { approvalPolicy: override.approvalPolicy }),
    ...(override.sandboxPolicy === undefined ? {} : { sandboxPolicy: override.sandboxPolicy }),
  });
  return Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (instanceId: ProviderInstanceId) =>
        registry.get(instanceId).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
              adapter.openSession({ ...input, runtimePolicy: apply(input.runtimePolicy) }).pipe(
                Effect.map((runtime) => ({
                  ...runtime,
                  ensureThread: (thread: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) =>
                    runtime.ensureThread({ ...thread, runtimePolicy: apply(thread.runtimePolicy) }),
                  startTurn: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                    runtime.startTurn({ ...turn, runtimePolicy: apply(turn.runtimePolicy) }),
                })),
              ),
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));
};

/** A machine with the provider but no recorded turns, for tests that run none. */
const idleAdapters = (instanceId: ProviderInstanceId) =>
  ProviderAdapterRegistry.layerFromAdapters([
    {
      instanceId,
      driver: CLAUDE,
      getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("no turns run here"),
    },
  ]);

/** A recorded fixture's Claude variant, its transcript, and the commands that replay it. */
const loadFixture = Effect.fn(function* (name: string) {
  const fixture = findReplayFixture(name);
  const variant = fixture?.providers.find((provider) => provider.driver === CLAUDE);
  assert.isDefined(fixture);
  assert.isDefined(variant);
  const raw = yield* readReplayFixtureTranscript(variant.transcriptFile);
  const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
    materializeReplayTranscriptRuntimeInstructions(raw as ProviderReplayTranscript, {
      driver: CLAUDE,
      model: variant.modelSelection.model,
    }),
  );
  const materialized = yield* materializeFixtureInput({
    scenario: name,
    fixtureInput: fixture.buildInput(),
    driver: CLAUDE,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer));
  const replayGate = makeProviderReplayGate(
    materialized.steps.flatMap((step) =>
      step.type === "release_replay_gate" || step.type === "release_replay_gate_after_waiting"
        ? [step.label]
        : [],
    ),
  );
  const adapters = withPolicyOverride(
    ClaudeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript, {
      replayGate,
    }).pipe(Layer.orDie),
    variant.runtimePolicyOverride,
  );
  return { fixture, variant, transcript, materialized, replayGate, adapters };
});
type LoadedFixture = Effect.Success<ReturnType<typeof loadFixture>>;

const placeOn =
  (environmentId: EnvironmentId) =>
  (command: OrchestrationV2Command): OrchestrationV2Command =>
    command.type === "thread.create" ? { ...command, activeEnvironmentId: environmentId } : command;

/** Replays a fixture through the Hub's orchestrator, its Thread running on `environment`. */
const replayOn = Effect.fn(function* (
  hub: Hub,
  environment: TestEnvironment,
  loaded: LoadedFixture,
) {
  const place = placeOn(environment.environmentId);
  const created = loaded.materialized.commands.find((command) => command.type === "thread.create");
  assert.isDefined(created);
  yield* seedProject(hub.server, {
    projectId: created.projectId,
    title: "Remote project",
    defaultModelSelection: loaded.variant.modelSelection,
  });
  return yield* runOrchestratorV2Scenario(
    {
      name: `${loaded.fixture.name}/remote`,
      commands: loaded.materialized.commands.map(place),
      // Over real sockets time is the wall clock; the recorded clock steps only separate stamps.
      steps: loaded.materialized.steps.flatMap((step): ReadonlyArray<OrchestratorV2ScenarioStep> =>
        step.type === "advance_clock"
          ? []
          : [step.type === "dispatch" ? { ...step, command: place(step.command) } : step],
      ),
      projectionThreadIds: loaded.materialized.projectionThreadIds,
    },
    { replayGate: loaded.replayGate },
  ).pipe(
    Effect.provideService(Orchestrator.OrchestratorV2, hub.service(Orchestrator.OrchestratorV2)),
  );
});

const ownerIdOf = Effect.fn(function* (hub: Hub) {
  const [row] = yield* hub.server.sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM users WHERE is_owner = 1
  `;
  assert.isDefined(row);
  return UserId.make(row.userId);
});

/** The Thread changed Environments, as a move records it. */
const moveThread = Effect.fn(function* (
  hub: Hub,
  threadId: ThreadId,
  environmentId: EnvironmentId,
) {
  yield* hub.server.sql`
    UPDATE orchestration_v2_projection_threads
    SET active_environment_id = ${environmentId} WHERE thread_id = ${threadId}
  `;
  yield* hub.service(RemoteEnvironments.RemoteEnvironments).threadMoved(threadId);
});

/** A Thread on a hand-driven machine, with one provider session open on it. */
const openProtocolSession = Effect.fn(function* (hub: Hub) {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const environmentId = EnvironmentId.make("environment:protocol");
  const machine = yield* connectProtocolEnvironment(hub, {
    environmentId,
    instanceId,
    driver: CLAUDE,
    capabilities: ClaudeProviderCapabilitiesV2,
  });
  const threadId = ThreadId.make("thread:protocol");
  const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
  yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:protocol-thread"),
    threadId,
    projectId: ProjectId.make("project:protocol"),
    title: "Protocol",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeEnvironmentId: environmentId,
  });
  const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
  const adapter = yield* (yield* registry.get(environmentId)).provider.adapters.get(instanceId);
  const providerSessionId = ProviderSessionId.make("provider-session:protocol");
  const opening = yield* adapter
    .openSession({
      threadId,
      providerSessionId,
      modelSelection,
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/remote" },
    })
    .pipe(Effect.provideService(Scope.Scope, yield* Effect.scope), Effect.forkScoped);
  const open = yield* machine.nextFrame;
  assert.equal(open.method, "provider.openSession");
  yield* machine.connection.receive({
    type: "response",
    requestId: open.requestId,
    result: {
      _tag: "success",
      value: {
        providerSession: machine.providerSession(providerSessionId, "/remote"),
        features: {
          injectHistory: false,
          compactThread: false,
          stopTask: false,
          unloadThread: false,
          hasPendingBackgroundWork: false,
          backgroundTasksEndWithProcess: false,
        },
      },
    },
  });
  const runtime = yield* Fiber.join(opening);
  const encodeEvent = Schema.encodeEffect(
    Schema.toCodecJson(ProviderAdapter.ProviderAdapterV2Event),
  );
  const send = (seq: number, turn: string) =>
    encodeEvent({
      type: "background_work.updated",
      driver: CLAUDE,
      providerTurnId: ProviderTurnId.make(turn),
      pending: true,
    }).pipe(
      Effect.flatMap((event) =>
        machine.connection.receive({
          type: "event",
          method: "provider.event",
          payload: { providerSessionId, seq, event },
        }),
      ),
    );
  return {
    machine,
    runtime,
    threadId,
    providerSessionId,
    environmentId,
    instanceId,
    modelSelection,
    send,
    moveTo: (target: EnvironmentId) => moveThread(hub, threadId, target),
  };
});

describe("Hub con Environments", () => {
  it.live("a turn on a joined Environment runs there and is visible on the Hub", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: loaded.adapters });
      const result = yield* replayOn(hub, laptop, loaded);

      loaded.variant.assertOutput(result, loaded.transcript);
      const [threadId] = loaded.materialized.projectionThreadIds;
      const projection = result.projections.get(threadId!);
      assert.equal(projection?.thread.activeEnvironmentId, laptop.environmentId);
      // The checkpoints were taken in the Laptop's own checkout, cloned from the Project.
      assert.isNotEmpty(projection?.checkpointScopes);
      for (const scope of projection?.checkpointScopes ?? []) {
        assert.isTrue(scope.cwd.startsWith(laptop.workspaceRoot), scope.cwd);
      }
      // The agent there reaches the Hub's MCP with the credential the Hub issued for the Thread.
      const [mcp] = laptop.mcpConfigs;
      assert.equal(mcp?.endpoint, `${hub.server.url}/mcp`);
      assert.equal(mcp?.threadId, threadId);
      assert.match(mcp?.authorizationHeader ?? "", /^Bearer \S+$/);
    }).pipe(Effect.scoped),
  );

  it.live.each(["turn_interrupt", "message_steering", "tool_call_read_only_on_request"])(
    "%s works on a joined Environment as on the Hub machine",
    (name) =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture(name);
        const hub = yield* makeHub();
        const laptop = yield* hub.join({ name: "Laptop", adapters: loaded.adapters });
        const result = yield* replayOn(hub, laptop, loaded);
        loaded.variant.assertOutput(result, loaded.transcript);
      }).pipe(Effect.scoped),
  );

  it.live(
    "keeps each event once and in order, and refuses one from a machine the Thread is not on",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const environmentId = EnvironmentId.make("environment:protocol");
        const machine = yield* connectProtocolEnvironment(hub, {
          environmentId,
          instanceId,
          driver: CLAUDE,
          capabilities: ClaudeProviderCapabilitiesV2,
        });
        const threadId = ThreadId.make("thread:protocol");
        const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
        yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:protocol-thread"),
          threadId,
          projectId: ProjectId.make("project:protocol"),
          title: "Protocol",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeEnvironmentId: environmentId,
        });
        const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
        const adapter = yield* (yield* registry.get(environmentId)).provider.adapters.get(
          instanceId,
        );
        const providerSessionId = ProviderSessionId.make("provider-session:protocol");
        const opening = yield* adapter
          .openSession({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/remote",
            },
          })
          .pipe(Effect.provideService(Scope.Scope, yield* Effect.scope), Effect.forkScoped);
        const open = yield* machine.nextFrame;
        assert.equal(open.method, "provider.openSession");
        yield* machine.connection.receive({
          type: "response",
          requestId: open.requestId,
          result: {
            _tag: "success",
            value: {
              providerSession: machine.providerSession(providerSessionId, "/remote"),
              features: {
                injectHistory: false,
                compactThread: false,
                stopTask: false,
                unloadThread: false,
                hasPendingBackgroundWork: false,
                backgroundTasksEndWithProcess: false,
              },
            },
          },
        });
        const runtime = yield* Fiber.join(opening);

        const encodeEvent = Schema.encodeEffect(
          Schema.toCodecJson(ProviderAdapter.ProviderAdapterV2Event),
        );
        const send = (seq: number, turn: string) =>
          encodeEvent({
            type: "background_work.updated",
            driver: CLAUDE,
            providerTurnId: ProviderTurnId.make(turn),
            pending: true,
          }).pipe(
            Effect.flatMap((event) =>
              machine.connection.receive({
                type: "event",
                method: "provider.event",
                payload: { providerSessionId, seq, event },
              }),
            ),
          );
        yield* send(1, "turn-1");
        // A reconnect resends what the Hub had not acknowledged yet.
        yield* send(1, "turn-1");
        yield* send(2, "turn-2");
        yield* machine.connection.flushAcks;
        assert.deepEqual(yield* machine.nextFrame, {
          type: "event",
          method: "provider.ack",
          payload: { acks: [{ providerSessionId, seq: 2 }] },
        });

        // The Thread runs elsewhere now: what this machine still sends must not reach it.
        yield* moveThread(hub, threadId, HUB_MACHINE_ENVIRONMENT_ID);
        yield* send(3, "turn-from-the-old-machine");
        yield* moveThread(hub, threadId, environmentId);
        yield* send(4, "turn-4");

        const received = yield* runtime.events.pipe(Stream.take(3), Stream.runCollect);
        assert.deepEqual(
          [...received].map((event) =>
            event.type === "background_work.updated" ? event.providerTurnId : event.type,
          ),
          ["turn-1", "turn-2", "turn-4"],
        );
      }).pipe(Effect.scoped),
  );

  it.live("a new Thread runs only where its User may, on a machine online with its provider", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      const desktop = yield* hub.join({
        name: "Desktop",
        adapters: idleAdapters(instanceId),
        connect: false,
      });
      const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
      const owner = yield* ownerIdOf(hub);
      const member = UserId.make("member-1");
      yield* addMember(hub.server, { id: member, displayName: "Grace Hopper" });
      const projectId = ProjectId.make("project:choice");
      const choose = (
        userId: UserId,
        requested: EnvironmentId | undefined,
        providerInstanceId = instanceId,
      ) => registry.chooseForThread({ userId, requested, projectId, providerInstanceId });
      const refusal = (userId: UserId, requested: EnvironmentId, providerInstanceId = instanceId) =>
        choose(userId, requested, providerInstanceId).pipe(
          Effect.flip,
          Effect.map((error) =>
            error._tag === "ThreadEnvironmentUnavailableError" ? error.reason : error._tag,
          ),
        );

      assert.equal(yield* choose(owner, laptop.environmentId), laptop.environmentId);
      assert.equal(yield* choose(owner, undefined), HUB_MACHINE_ENVIRONMENT_ID);
      assert.equal(yield* choose(member, undefined), HUB_MACHINE_ENVIRONMENT_ID);
      // The Owner's personal machine is theirs alone, even for a Member who names it.
      assert.equal(yield* refusal(member, laptop.environmentId), "not-usable");
      assert.equal(yield* refusal(owner, desktop.environmentId), "offline");
      assert.equal(
        yield* refusal(owner, laptop.environmentId, ProviderInstanceId.make("codex")),
        "provider-missing",
      );
    }).pipe(Effect.scoped),
  );
  it.live("an effect's call resends on the next socket with the same key, and once only", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const environmentId = EnvironmentId.make("environment:protocol");
      const fake = () =>
        connectProtocolEnvironment(hub, {
          environmentId,
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: CLAUDE,
          capabilities: ClaudeProviderCapabilitiesV2,
        });
      const first = yield* fake();
      const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
      const checkpoints = (yield* registry.get(environmentId)).workspace.checkpoints;
      const call = (attempt: number) => {
        const effect = { effectId: "effect:protocol", attempt };
        return checkpoints
          .isGitRepository("/remote/projects/web")
          .pipe(EnvironmentExecutor.withEffectAttempt(effect), Effect.forkScoped);
      };

      // The socket drops after the request left: the call waits and resends on the next one.
      const dropped = yield* call(1);
      const sent = yield* first.nextFrame;
      yield* first.disconnect;
      const second = yield* fake();
      const resent = yield* second.nextFrame;
      assert.equal(resent.idempotencyKey, sent.idempotencyKey);
      yield* second.connection.receive({
        type: "response",
        requestId: resent.requestId,
        result: { _tag: "success", value: true },
      });
      assert.isTrue(yield* Fiber.join(dropped));

      // A newer socket replaces this one while a call waits: it resends there at once.
      const replaced = yield* call(2);
      const before = yield* second.nextFrame;
      const third = yield* fake();
      const after = yield* third.nextFrame;
      // The effect's next attempt asks under the same key, so the machine does not run it again.
      assert.equal(after.idempotencyKey, sent.idempotencyKey);
      assert.equal(before.idempotencyKey, sent.idempotencyKey);
      yield* third.connection.receive({
        type: "response",
        requestId: after.requestId,
        result: { _tag: "success", value: true },
      });
      assert.isTrue(yield* Fiber.join(replaced));
    }).pipe(Effect.scoped),
  );

  it.live("acknowledgements never move back, and a reconnect ends sessions the machine lost", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const opened = yield* openProtocolSession(hub);
      yield* opened.send(5, "turn-5");
      yield* opened.send(3, "turn-3");
      yield* opened.machine.connection.flushAcks;
      assert.deepEqual(yield* opened.machine.nextFrame, {
        type: "event",
        method: "provider.ack",
        payload: { acks: [{ providerSessionId: opened.providerSessionId, seq: 5 }] },
      });
      // The machine comes back without the session: the Hub's side of it ends.
      yield* opened.machine.disconnect;
      yield* connectProtocolEnvironment(hub, {
        environmentId: opened.environmentId,
        instanceId: opened.instanceId,
        driver: CLAUDE,
        capabilities: ClaudeProviderCapabilitiesV2,
      });
      const ended = yield* opened.runtime.events.pipe(Stream.runCollect, Effect.flip);
      assert.equal(ended._tag, "ProviderAdapterEventStreamError");
    }).pipe(Effect.scoped),
  );

  it.live(
    "a machine reads a turn's attachment only while its session lives and the Thread is there",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const opened = yield* openProtocolSession(hub);
        const attachment = {
          type: "image" as const,
          id: "protocol-attachment-1",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 4,
        };
        const config = hub.service(ServerConfig.ServerConfig);
        const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
        assert.isNotNull(path);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(config.attachmentsDir, { recursive: true });
          await NodeFSP.writeFile(path!, Buffer.from([1, 2, 3, 4]));
        });
        const projection = yield* hub
          .service(Orchestrator.OrchestratorV2)
          .getThreadProjection(opened.threadId);
        const starting = yield* opened.runtime
          .startTurn({
            appThread: projection.thread,
            threadId: opened.threadId,
            runId: RunId.make("run:protocol"),
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: RunAttemptId.make("attempt:protocol"),
            rootNodeId: NodeId.make("node:protocol"),
            providerThread: {
              id: ProviderThreadId.make("provider-thread:protocol"),
              driver: CLAUDE,
              providerInstanceId: opened.instanceId,
              providerSessionId: opened.providerSessionId,
              appThreadId: opened.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              contextUsage: null,
              nativeMetadata: null,
              goal: null,
              createdAt: projection.thread.createdAt,
              updatedAt: projection.thread.createdAt,
            },
            message: {
              messageId: MessageId.make("message:protocol"),
              text: "Look at this",
              attachments: [attachment],
              createdBy: "user",
              creationSource: "web",
            },
            modelSelection: opened.modelSelection,
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/remote",
            },
          })
          .pipe(Effect.forkScoped);
        const start = yield* opened.machine.nextFrame;
        const [ref] = (
          start.payload as { attachments: ReadonlyArray<{ id: string; sha256: string }> }
        ).attachments;
        assert.isDefined(ref);
        let reads = 0;
        const read = Effect.gen(function* () {
          reads += 1;
          yield* opened.machine.connection.receive({
            type: "request",
            requestId: `read-${reads}`,
            method: "attachment.read",
            payload: { threadId: opened.threadId, attachmentId: ref.id, sha256: ref.sha256 },
          });
          const answer = (yield* opened.machine.nextFrame) as { result: { _tag: string } };
          return answer.result._tag;
        });
        assert.equal(yield* read, "success");
        yield* opened.machine.connection.receive({
          type: "response",
          requestId: start.requestId,
          result: { _tag: "success", value: null },
        });
        yield* Fiber.join(starting);

        // The Thread left this machine: its attachments did too.
        yield* opened.moveTo(HUB_MACHINE_ENVIRONMENT_ID);
        assert.equal(yield* read, "failure");
        yield* opened.moveTo(opened.environmentId);
        assert.equal(yield* read, "success");
        // The session ended: nothing it carried is readable any more.
        yield* opened.machine.connection.receive({
          type: "event",
          method: "provider.sessionEnded",
          payload: { providerSessionId: opened.providerSessionId },
        });
        assert.equal(yield* read, "failure");
      }).pipe(Effect.scoped),
  );
});

/** The Hub's workspace RPCs (what `ws.ts` calls), over the Hub's own projection and Environments. */
const threadWorkspaceOf = (hub: Hub) =>
  ThreadWorkspace.make.pipe(
    Effect.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
    Effect.provideContext(hub.server.services as never),
  ) as Effect.Effect<ThreadWorkspace.ThreadWorkspace["Service"]>;

/** A Thread of the Owner's on the Laptop, with the Project checked out there. */
const threadOnLaptop = Effect.fn(function* () {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const hub = yield* makeHub();
  const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
  const projectId = ProjectId.make("project:workspace");
  const { workspaceRoot: hubCheckout } = yield* seedProject(hub.server, {
    projectId,
    title: "Workspace project",
    defaultModelSelection: null,
  });
  const threadId = ThreadId.make("thread:workspace");
  yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:workspace-thread"),
    threadId,
    projectId,
    title: "Workspace",
    modelSelection: { instanceId, model: "claude-sonnet-4-6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeEnvironmentId: laptop.environmentId,
  });
  const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
  const laptopCheckout = Option.getOrThrow(
    yield* (yield* registry.get(laptop.environmentId)).workspace.paths.checkout(projectId),
  );
  // The Laptop's own copy differs from the Hub's, so a test sees which machine answered.
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(laptopCheckout, { recursive: true });
    await NodeFSP.writeFile(`${laptopCheckout}/README.md`, "# On the Laptop\n");
  });
  const owner = { userId: yield* ownerIdOf(hub) };
  return {
    hub,
    laptop,
    threadId,
    projectId,
    hubCheckout,
    laptopCheckout,
    owner,
    workspace: yield* threadWorkspaceOf(hub),
  };
});

describe("Hub con Environments: a Thread's files and terminals", () => {
  it.live("act on the Thread's Active environment, live, and say «environment offline»", () =>
    Effect.gen(function* () {
      const { laptop, threadId, hubCheckout, laptopCheckout, owner, workspace } =
        yield* threadOnLaptop();

      // The client sends the workspace as the Hub records it; the Laptop answers from its own.
      const read = yield* workspace.readFile(
        { cwd: hubCheckout, relativePath: "README.md", threadId },
        owner,
      );
      assert.equal(read.contents, "# On the Laptop\n");
      yield* workspace.writeFile(
        { cwd: hubCheckout, relativePath: "notes.md", contents: "laptop notes\n", threadId },
        owner,
      );
      assert.equal(
        yield* Effect.promise(() => NodeFSP.readFile(`${laptopCheckout}/notes.md`, "utf8")),
        "laptop notes\n",
      );
      const listed = yield* workspace.listEntries({ cwd: hubCheckout, threadId }, owner);
      assert.includeMembers(
        listed.entries.map((entry) => entry.path),
        ["README.md", "notes.md"],
      );

      // A terminal opens in the Laptop's checkout and streams its output live.
      const opened = yield* workspace.terminalOpen(
        { threadId, terminalId: "term-1", cwd: hubCheckout, cols: 80, rows: 24 },
        owner,
      );
      assert.equal(opened.cwd, laptopCheckout);
      const attached = yield* Deferred.make<void>();
      const output = yield* workspace
        .terminalAttach({ threadId, terminalId: "term-1" }, "viewer-1", owner)
        .pipe(
          Stream.tap((event) =>
            event.type === "snapshot" ? Deferred.succeed(attached, undefined) : Effect.void,
          ),
          Stream.filter((event) => event.type === "output"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
      yield* Deferred.await(attached);
      yield* workspace.terminalWrite({ threadId, terminalId: "term-1", data: "pwd\r" }, owner);
      const [echoed] = yield* Fiber.join(output);
      assert.equal(echoed?.type === "output" ? echoed.data : undefined, `${laptopCheckout}\r\n`);

      // A preview opens on the Laptop, and what changes there reaches the Hub as it happens.
      const preview = yield* workspace.previewOpen({ threadId }, owner);
      assert.deepEqual(
        (yield* workspace.previewList({ threadId }, owner)).sessions.map(
          (session) => session.tabId,
        ),
        [preview.tabId],
      );
      const previewChanged = yield* workspace.previewEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "resized"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* workspace.previewAdjust({ threadId, tabId: preview.tabId, zoomFactor: 1.5 }, owner);
      const [changed] = yield* Fiber.join(previewChanged);
      assert.equal(changed?.tabId, preview.tabId);

      // Off: every surface says so, and nothing typed or saved waits to run later.
      const watching = yield* workspace
        .terminalAttach({ threadId, terminalId: "term-1" }, "viewer-2", owner)
        .pipe(Stream.runDrain, Effect.flip, Effect.forkScoped);
      yield* laptop.disconnect;
      const streamEnded = yield* Fiber.join(watching);
      assert.equal(streamEnded._tag, "TerminalEnvironmentUnavailableError");
      const offlineRead = yield* workspace
        .readFile({ cwd: hubCheckout, relativePath: "README.md", threadId }, owner)
        .pipe(Effect.flip);
      assert.equal(offlineRead.failure, "environment_offline");
      assert.match(offlineRead.message, /^Environment offline: Laptop is not connected/);
      const offlineWrite = yield* workspace
        .writeFile(
          { cwd: hubCheckout, relativePath: "notes.md", contents: "while away\n", threadId },
          owner,
        )
        .pipe(Effect.flip);
      assert.equal(offlineWrite.failure, "environment_offline");
      const offlineTyping = yield* workspace
        .terminalWrite({ threadId, terminalId: "term-1", data: "ls\r" }, owner)
        .pipe(Effect.flip);
      assert.equal(offlineTyping.message, "Environment offline: Laptop is not connected.");
      const offlinePreview = yield* workspace.previewOpen({ threadId }, owner).pipe(Effect.flip);
      assert.equal(offlinePreview._tag, "PreviewEnvironmentUnavailableError");
      const offlineSearch = yield* workspace
        .searchEntries({ cwd: hubCheckout, query: "READ", limit: 10, threadId }, owner)
        .pipe(Effect.flip);
      assert.equal(offlineSearch.failure, "environment_offline");

      yield* laptop.connect;
      assert.equal(
        yield* Effect.promise(() => NodeFSP.readFile(`${laptopCheckout}/notes.md`, "utf8")),
        "laptop notes\n",
      );
      assert.equal(
        (yield* workspace.readFile({ cwd: hubCheckout, relativePath: "notes.md", threadId }, owner))
          .contents,
        "laptop notes\n",
      );
    }).pipe(Effect.scoped),
  );

  it.live("never take a User to another machine, another Project or outside the Thread", () =>
    Effect.gen(function* () {
      const { hub, laptop, threadId, hubCheckout, laptopCheckout, owner, workspace } =
        yield* threadOnLaptop();
      const member = UserId.make("member-1");
      yield* addMember(hub.server, { id: member, displayName: "Grace Hopper" });
      const { workspaceRoot: otherProject } = yield* seedProject(hub.server, {
        projectId: ProjectId.make("project:other"),
        title: "Other project",
        defaultModelSelection: null,
      });
      const refusedRead = (
        input: { readonly cwd: string; readonly relativePath: string },
        caller = owner,
      ) =>
        workspace.readFile({ ...input, threadId }, caller).pipe(
          Effect.flip,
          Effect.map((error) => error.failure),
        );
      const asked = laptop.requests.length;

      // The Owner's Laptop is theirs alone: naming its Thread does not reach it for anyone else.
      assert.equal(
        yield* refusedRead({ cwd: hubCheckout, relativePath: "README.md" }, { userId: member }),
        "workspace_path_outside_root",
      );
      assert.equal(
        (yield* workspace
          .terminalOpen({ threadId, terminalId: "term-1", cwd: hubCheckout }, { userId: member })
          .pipe(Effect.flip))._tag,
        "TerminalEnvironmentUnavailableError",
      );
      // The Thread names the machine; a folder of another Project or outside it is refused.
      assert.equal(
        yield* refusedRead({ cwd: otherProject, relativePath: "README.md" }),
        "workspace_path_outside_root",
      );
      assert.equal(
        yield* refusedRead({ cwd: hubCheckout, relativePath: "../other/README.md" }),
        "workspace_path_outside_root",
      );
      assert.equal(
        yield* refusedRead({ cwd: hubCheckout, relativePath: "/etc/hostname" }),
        "workspace_path_outside_root",
      );
      assert.equal(
        (yield* workspace
          .browse({ partialPath: "/", cwd: hubCheckout, threadId }, owner)
          .pipe(Effect.flip)).failure,
        "outside_thread_workspace",
      );
      assert.equal(
        (yield* workspace
          .terminalOpen({ threadId, terminalId: "term-1", cwd: otherProject }, owner)
          .pipe(Effect.flip))._tag,
        "TerminalEnvironmentUnavailableError",
      );
      // Without a Thread a call stays on the Hub machine, even one naming the Laptop's folder.
      yield* workspace
        .readFile({ cwd: laptopCheckout, relativePath: "README.md" }, owner)
        .pipe(Effect.exit);
      assert.deepEqual(laptop.requests.slice(asked), []);
    }).pipe(Effect.scoped),
  );
});
