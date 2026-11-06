// @effect-diagnostics nodeBuiltinImport:off -- writes one attachment file for the Hub to serve.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EnvironmentId,
  EventId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type OrchestrationV2AppThread,
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
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as ServerConfig from "../config.ts";
import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ClaudeOrchestratorReplayHarness } from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as CheckpointUploadService from "../orchestration-v2/CheckpointUploadService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
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
import * as VcsProcess from "../vcs/VcsProcess.ts";
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

/** Git in a folder of the test, its exit code and output whatever they are. */
const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly env?: Readonly<Record<string, string>> } = {},
) =>
  Effect.flatMap(VcsProcess.VcsProcess, (vcs) =>
    vcs.run({
      operation: "HubRepository.test.git",
      command: "git",
      cwd,
      args,
      allowNonZeroExit: true,
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
    }),
  ).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))), Effect.orDie);

/** Resolves once the Hub marks the turn's checkpoint as in its repository. */
const awaitUploaded = Effect.fn(function* (hub: Hub, threadId: ThreadId, appRunOrdinal: number) {
  const orchestrator = hub.service(Orchestrator.OrchestratorV2);
  // Events after this sequence are streamed, so a mark the projection does not show yet is seen.
  const afterSequence = yield* hub
    .service(EventSink.EventSinkV2)
    .latestSequence({ threadId })
    .pipe(Effect.orDie);
  const projection = yield* orchestrator.getThreadProjection(threadId).pipe(Effect.orDie);
  const uploaded = projection.checkpoints.some(
    (checkpoint) => checkpoint.appRunOrdinal === appRunOrdinal && checkpoint.uploadedToHub === true,
  );
  if (uploaded) return;
  // The orchestration's own event stream: it sees the uploader's writes as clients do.
  yield* orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
    Stream.filter(
      ({ event }) =>
        event.type === "checkpoint.uploaded" &&
        projection.checkpoints.some(
          (checkpoint) =>
            checkpoint.id === event.payload.checkpointId &&
            checkpoint.appRunOrdinal === appRunOrdinal,
        ),
    ),
    Stream.runHead,
    Effect.orDie,
  );
});

/** The machine's agent, with turns that edit a file the turn's checkpoint then carries. */
const withEditingTurns = (
  adapters: LoadedFixture["adapters"],
  input: { readonly file: string; readonly content: string },
) =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (instanceId: ProviderInstanceId) =>
        registry.get(instanceId).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            openSession: (open: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
              adapter.openSession(open).pipe(
                Effect.map((runtime) => ({
                  ...runtime,
                  startTurn: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                    Effect.promise(() =>
                      NodeFSP.writeFile(
                        `${turn.runtimePolicy.cwd}/${input.file}`,
                        `${input.content} (turn ${turn.runOrdinal})
`,
                      ),
                    ).pipe(Effect.andThen(runtime.startTurn(turn))),
                })),
              ),
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

/** Ready checkpoints of a Thread (turns 1..count) that the Hub repository does not have yet. */
const seedCheckpoints = Effect.fn(function* (hub: Hub, threadId: ThreadId, count: number) {
  const projection = yield* hub
    .service(Orchestrator.OrchestratorV2)
    .getThreadProjection(threadId)
    .pipe(Effect.orDie);
  const now = projection.thread.createdAt;
  const scopeId = CheckpointScopeId.make("scope:protocol");
  const nodeId = NodeId.make("node:protocol");
  const seeded = Array.from({ length: count }, (_, index) => ({
    ordinal: index + 1,
    ref: CheckpointRef.make(`refs/t3/orchestration-v2/checkpoints/protocol/ordinal/${index + 1}`),
    checkpointId: CheckpointId.make(`checkpoint:protocol:${index + 1}`),
  }));
  yield* hub.server.eventSink
    .write({
      events: [
        {
          id: EventId.make("event:protocol-scope"),
          type: "checkpoint-scope.created",
          threadId,
          occurredAt: now,
          payload: {
            id: scopeId,
            threadId,
            runId: null,
            nodeId,
            parentScopeId: null,
            providerThreadId: null,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: "/remote/projects/protocol",
            createdAt: now,
          },
        },
        ...seeded.map((checkpoint) => ({
          id: EventId.make(`event:protocol-checkpoint:${checkpoint.ordinal}`),
          type: "checkpoint.captured" as const,
          threadId,
          occurredAt: now,
          payload: {
            id: checkpoint.checkpointId,
            threadId,
            scopeId,
            runId: null,
            nodeId,
            parentCheckpointId: null,
            ordinalWithinScope: checkpoint.ordinal,
            appRunOrdinal: checkpoint.ordinal,
            ref: checkpoint.ref,
            status: "ready" as const,
            files: [],
            capturedAt: now,
            uploadedToHub: false,
          },
        })),
      ],
    })
    .pipe(Effect.orDie);
  return seeded as [(typeof seeded)[number], ...typeof seeded];
});

/** The machine answers the Hub's next request, which must be `method` with `payload`. */
const answerNext = Effect.fn(function* (
  machine: {
    readonly nextFrame: Effect.Effect<Record<string, unknown>>;
    readonly connection: RemoteEnvironments.RemoteConnection;
  },
  method: string,
  payload: unknown,
  result:
    | { readonly _tag: "success"; readonly value: unknown }
    | { readonly _tag: "failure"; readonly error: unknown },
) {
  const frame = yield* machine.nextFrame;
  assert.deepEqual({ method: frame.method, payload: frame.payload }, { method, payload });
  yield* machine.connection.receive({ type: "response", requestId: frame.requestId, result });
});

const PUSH_FAILED = {
  _tag: "failure",
  error: {
    _tag: "VcsProcessExitError",
    operation: "HubRepository.push",
    command: "git push",
    cwd: "/remote/projects/protocol",
    exitCode: 1,
    detail: "src refspec does not match any",
  },
} as const;

describe("Hub repository", () => {
  it.live(
    "an Environment reaches the repositories of Projects its owner works in, until removed",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: idleAdapters(ProviderInstanceId.make("claudeAgent")),
        });
        const own = ProjectId.make("project:own");
        const { workspaceRoot } = yield* seedProject(hub.server, {
          projectId: own,
          title: "Own",
          defaultModelSelection: null,
        });
        yield* addMember(hub.server, { id: "member-1", displayName: "Grace Hopper" });
        const others = ProjectId.make("project:graces");
        yield* seedProject(hub.server, {
          projectId: others,
          title: "Grace's",
          defaultModelSelection: null,
          spaceId: SpaceId.make("personal:member-1"),
        });
        const ref = CheckpointRef.make("refs/t3/orchestration-v2/checkpoints/test/ordinal/1");
        yield* git(workspaceRoot, ["update-ref", ref, "HEAD"]);
        const remote = (projectId: ProjectId) =>
          HubRepository.withEnvironmentCredential(
            HubRepository.hubRepositoryUrl(hub.server.url, projectId),
            laptop.credential,
          );
        const push = (projectId: ProjectId) =>
          git(workspaceRoot, ["push", remote(projectId).url, `${ref}:${ref}`], {
            env: remote(projectId).env ?? {},
          });
        const advertised = (projectId: ProjectId, credential = laptop.credential) =>
          HttpClient.HttpClient.pipe(
            Effect.flatMap((client) =>
              client.execute(
                HttpClientRequest.get(
                  `${remote(projectId).url}/info/refs?service=git-upload-pack`,
                ).pipe(HttpClientRequest.bearerToken(credential)),
              ),
            ),
            Effect.map((response) => response.status),
            Effect.provide(FetchHttpClient.layer),
            Effect.orDie,
          );

        // Its own Project: it may fetch (which refs it may see is the next test's).
        const listed = yield* git(workspaceRoot, ["ls-remote", remote(own).url], {
          env: remote(own).env ?? {},
        });
        assert.equal(listed.exitCode, 0);
        assert.equal(yield* advertised(own), 200);

        // Another User's Space: the Owner's machine neither reads nor writes its Project.
        assert.equal(yield* advertised(others), 403);
        assert.notEqual((yield* push(others)).exitCode, 0);
        assert.equal(yield* advertised(own, "not-a-credential"), 401);

        // Removed: push and fetch stop at once.
        const owner = yield* ownerIdOf(hub);
        yield* hub
          .service(EnvironmentRegistry.EnvironmentRegistry)
          .remove({ actorUserId: owner, environmentId: laptop.environmentId });
        assert.equal(yield* advertised(own), 401);
        assert.notEqual(
          (yield* git(workspaceRoot, ["ls-remote", remote(own).url], {
            env: remote(own).env ?? {},
          })).exitCode,
          0,
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "a turn's checkpoint uploads, and its diffs open on the Hub with the machine offline",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hub = yield* makeHub();
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: withEditingTurns(loaded.adapters, {
            file: "notes.md",
            content: "Written on the Laptop",
          }),
        });
        yield* replayOn(hub, laptop, loaded);
        const [threadId] = loaded.materialized.projectionThreadIds;
        assert.isDefined(threadId);
        yield* awaitUploaded(hub, threadId, 1);
        yield* laptop.disconnect;

        const diffs = hub.service(CheckpointDiffQuery.CheckpointDiffQuery);
        const turn = yield* diffs.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 });
        assert.include(turn.diff, "+Written on the Laptop (turn 1)");
        const whole = yield* diffs.getFullThreadDiff({ threadId, toTurnCount: 1 });
        assert.include(whole.diff, "notes.md");

        // Uploaded to the Hub, not to the Project's own remote the Laptop cloned from.
        const projection = yield* hub
          .service(Orchestrator.OrchestratorV2)
          .getThreadProjection(threadId);
        const project = yield* hub
          .service(ProjectStore.ProjectStoreV2)
          .get(projection.thread.projectId);
        assert.isTrue(Option.isSome(project));
        const origin = Option.getOrThrow(project).workspaceRoot;
        assert.equal((yield* git(origin, ["for-each-ref", "refs/t3/"])).stdout, "");
        for (const checkpoint of projection.checkpoints) {
          if (checkpoint.status === "ready") assert.isTrue(checkpoint.uploadedToHub, checkpoint.id);
        }
      }).pipe(Effect.scoped),
  );

  it.live("a machine reads and writes only the refs of Threads it runs, and deletes none", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      const desktop = yield* hub.join({ name: "Desktop", adapters: idleAdapters(instanceId) });
      const projectId = ProjectId.make("project:shared");
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId,
        title: "Shared",
        defaultModelSelection: null,
      });
      const threadId = ThreadId.make("thread:on-laptop");
      yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:thread-on-laptop"),
        threadId,
        projectId,
        title: "On the Laptop",
        modelSelection: { instanceId, model: "claude-sonnet-4-6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeEnvironmentId: laptop.environmentId,
      });
      const scopeId = CheckpointScopeId.make("scope:on-laptop");
      const projection = yield* hub
        .service(Orchestrator.OrchestratorV2)
        .getThreadProjection(threadId);
      yield* hub.server.eventSink.write({
        events: [
          {
            id: EventId.make("event:on-laptop-scope"),
            type: "checkpoint-scope.created",
            threadId,
            occurredAt: projection.thread.createdAt,
            payload: {
              id: scopeId,
              threadId,
              runId: null,
              nodeId: NodeId.make("node:on-laptop"),
              parentScopeId: null,
              providerThreadId: null,
              kind: "root_run",
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
              cwd: workspaceRoot,
              createdAt: projection.thread.createdAt,
            },
          },
        ],
      });
      const checkpointRef = yield* checkpointRefForScopeOrdinal({
        scopeId,
        ordinalWithinScope: 1,
      }).pipe(Effect.provide(NodeCrypto.layer));
      const headRef = `${HubRepository.threadRefPrefixes(threadId)[0]}head`;
      yield* git(workspaceRoot, ["update-ref", checkpointRef, "HEAD"]);
      yield* git(workspaceRoot, ["update-ref", headRef, "HEAD"]);
      const on = (machine: TestEnvironment, ...args: ReadonlyArray<string>) => {
        const remote = HubRepository.withEnvironmentCredential(
          HubRepository.hubRepositoryUrl(hub.server.url, projectId),
          machine.credential,
        );
        return git(workspaceRoot, [args[0]!, remote.url, ...args.slice(1)], {
          env: remote.env ?? {},
        });
      };

      // The Laptop runs the Thread: it uploads the Thread's refs.
      const succeeded = (output: { readonly exitCode: number; readonly stderr: string }) =>
        assert.equal(output.exitCode, 0, output.stderr);
      succeeded(yield* on(laptop, "push", `+${checkpointRef}:${checkpointRef}`));
      succeeded(yield* on(laptop, "push", `+${headRef}:${headRef}`));
      assert.include((yield* on(laptop, "ls-remote")).stdout, checkpointRef);
      // Another machine sees none of them and changes none, nor writes outside a Thread's refs.
      const seen = (yield* on(desktop, "ls-remote")).stdout;
      assert.notInclude(seen, checkpointRef);
      assert.notInclude(seen, headRef);
      assert.notEqual((yield* on(desktop, "push", `+HEAD:${checkpointRef}`)).exitCode, 0);
      assert.notEqual((yield* on(desktop, "push", `+HEAD:${headRef}`)).exitCode, 0);
      assert.notEqual((yield* on(laptop, "push", "+HEAD:refs/heads/main")).exitCode, 0);
      // Nobody deletes on the Hub, the machine that runs the Thread included.
      assert.notEqual((yield* on(laptop, "push", `:${checkpointRef}`)).exitCode, 0);
      assert.include((yield* on(laptop, "ls-remote")).stdout, checkpointRef);
    }).pipe(Effect.scoped),
  );

  it.live("a failed upload shows as not uploaded and retries when the machine comes back", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const opened = yield* openProtocolSession(hub);
      const { threadId } = opened;
      const [{ ref, checkpointId }] = yield* seedCheckpoints(hub, threadId, 1);
      yield* hub.service(CheckpointUploadService.CheckpointUploads).request(threadId);

      const pushed = yield* opened.machine.nextFrame;
      assert.equal(pushed.method, "checkpoint.push");
      assert.deepEqual(pushed.payload, {
        cwd: "/remote/projects/protocol",
        projectId: "project:protocol",
        checkpointRefs: [ref],
      });
      yield* opened.machine.connection.receive({
        type: "response",
        requestId: pushed.requestId,
        result: {
          _tag: "failure",
          error: {
            _tag: "VcsProcessExitError",
            operation: "HubRepository.push",
            command: "git push",
            cwd: "/remote/projects/protocol",
            exitCode: 128,
            detail: "Could not reach the Hub.",
          },
        },
      });
      const stored = yield* hub.server.sql<{ readonly uploaded: number | null }>`
        SELECT uploaded_to_hub AS uploaded FROM orchestration_v2_projection_checkpoints
        WHERE checkpoint_id = ${checkpointId}
      `;
      assert.deepEqual(stored, [{ uploaded: 0 }]);

      // The machine reconnects: the upload runs again at once, and the turn is marked uploaded.
      yield* opened.machine.disconnect;
      const back = yield* connectProtocolEnvironment(hub, {
        environmentId: opened.environmentId,
        instanceId: opened.instanceId,
        driver: CLAUDE,
        capabilities: ClaudeProviderCapabilitiesV2,
      });
      const retried = yield* back.nextFrame;
      assert.equal(retried.method, "checkpoint.push");
      yield* back.connection.receive({
        type: "response",
        requestId: retried.requestId,
        result: { _tag: "success", value: null },
      });
      yield* awaitUploaded(hub, threadId, 1);
    }).pipe(Effect.scoped),
  );

  it.live("a ref its machine lacks is left for its source machine and holds back no other", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const opened = yield* openProtocolSession(hub);
      const [first, second] = yield* seedCheckpoints(hub, opened.threadId, 2);
      assert.isDefined(second);
      const transfer = (refs: ReadonlyArray<CheckpointRef>) => ({
        cwd: "/remote/projects/protocol",
        projectId: "project:protocol",
        checkpointRefs: refs,
      });
      yield* hub.service(CheckpointUploadService.CheckpointUploads).request(opened.threadId);

      // The batch fails, so each ref goes on its own: the one this checkout lacks is set aside.
      yield* answerNext(
        opened.machine,
        "checkpoint.push",
        transfer([first.ref, second.ref]),
        PUSH_FAILED,
      );
      yield* answerNext(opened.machine, "checkpoint.push", transfer([first.ref]), {
        _tag: "success",
        value: null,
      });
      yield* answerNext(opened.machine, "checkpoint.push", transfer([second.ref]), PUSH_FAILED);
      yield* answerNext(
        opened.machine,
        "checkpoint.hasRef",
        { cwd: "/remote/projects/protocol", checkpointRef: second.ref },
        { _tag: "success", value: false },
      );
      yield* awaitUploaded(hub, opened.threadId, 1);
      const stored = yield* hub.server.sql<{ readonly id: string; readonly uploaded: number }>`
        SELECT checkpoint_id AS id, uploaded_to_hub AS uploaded
        FROM orchestration_v2_projection_checkpoints ORDER BY ordinal_within_scope
      `;
      assert.deepEqual(stored, [
        { id: first.checkpointId, uploaded: 1 },
        { id: second.checkpointId, uploaded: 0 },
      ]);
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

describe("Hub con Environments: what a machine is trusted with", () => {
  it.live("the machine refuses a workspace path whose symlinks lead outside the Thread", () =>
    Effect.gen(function* () {
      const { threadId, hubCheckout, laptopCheckout, owner, workspace } = yield* threadOnLaptop();
      const outside = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(`${NodeOS.tmpdir()}/t3-outside-`),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(`${outside}/secret.txt`, "not the Thread's\n");
        await NodeFSP.symlink(outside, `${laptopCheckout}/home-link`);
        await NodeFSP.symlink("/", `${laptopCheckout}/root-link`);
      });
      // Inside the workspace as text, outside it once the machine follows the links.
      const read = yield* workspace
        .readFile({ cwd: hubCheckout, relativePath: "home-link/secret.txt", threadId }, owner)
        .pipe(Effect.flip);
      assert.equal(read.failure, "resolved_path_outside_root");
      const write = yield* workspace
        .writeFile(
          { cwd: hubCheckout, relativePath: "home-link/planted.txt", contents: "x", threadId },
          owner,
        )
        .pipe(Effect.flip);
      assert.equal(write.failure, "resolved_path_outside_root");
      assert.isFalse(
        yield* Effect.promise(() =>
          NodeFSP.access(`${outside}/planted.txt`).then(
            () => true,
            () => false,
          ),
        ),
      );
      const listed = yield* workspace
        .listEntries({ cwd: `${hubCheckout}/root-link`, threadId }, owner)
        .pipe(Effect.flip);
      assert.equal(listed.failure, "outside_thread_workspace");
      const terminal = yield* workspace
        .terminalOpen({ threadId, terminalId: "term-1", cwd: `${hubCheckout}/root-link` }, owner)
        .pipe(Effect.flip);
      assert.equal(
        terminal._tag === "TerminalEnvironmentUnavailableError" ? terminal.reason : terminal._tag,
        "outside_thread_workspace",
      );
      // What the workspace does hold still answers.
      assert.equal(
        (yield* workspace.readFile(
          { cwd: hubCheckout, relativePath: "README.md", threadId },
          owner,
        )).contents,
        "# On the Laptop\n",
      );
    }).pipe(Effect.scoped),
  );

  it.live("a machine's preview events reach clients only for Threads it runs", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const opened = yield* openProtocolSession(hub);
      const workspace = yield* threadWorkspaceOf(hub);
      const received = yield* workspace.previewEvents.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      const closed = (threadId: string) => ({
        type: "closed",
        threadId,
        tabId: "tab-1",
        createdAt: "1970-01-01T00:00:00.000Z",
        serverEpoch: "epoch",
        revision: 1,
      });
      // A Thread on the Hub machine, which this machine has no say over.
      yield* opened.machine.sendPreviewEvent(closed("thread:elsewhere"));
      yield* opened.machine.sendPreviewEvent(closed(opened.threadId));
      const [first] = yield* Fiber.join(received);
      assert.equal(first?.threadId, opened.threadId);
    }).pipe(Effect.scoped),
  );

  it.live("cleaning up a Thread's terminals waits for its machine instead of reporting done", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const opened = yield* openProtocolSession(hub);
      const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
      yield* opened.machine.disconnect;
      const cleanup = yield* ResourceCleanupService.onThreadMachine(
        registry,
        opened.threadId,
        (forward) => forward.call("terminal.close", { threadId: opened.threadId }),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(cleanup));
    }).pipe(Effect.scoped),
  );
});

/** A move as its sender dispatches it, through the Hub's checks. */
const dispatchMove = (
  hub: Hub,
  input: {
    readonly commandId: string;
    readonly threadId: ThreadId;
    readonly target: EnvironmentId;
    readonly actor: UserId;
    readonly ifRunning?: "wait" | "stop";
  },
) =>
  hub
    .service(ThreadManagementService.ThreadManagementService)
    .dispatch({
      type: "thread.move",
      commandId: CommandId.make(input.commandId),
      threadId: input.threadId,
      targetEnvironmentId: input.target,
      ...(input.ifRunning === undefined ? {} : { ifRunning: input.ifRunning }),
      ownerUserId: input.actor,
    })
    .pipe(CommandActor.actAs(input.actor));

/** The Thread once its move switched or failed, as its stream shows it. */
const settledMove = Effect.fn(function* (hub: Hub, threadId: ThreadId) {
  const orchestrator = hub.service(Orchestrator.OrchestratorV2);
  const settled = (thread: OrchestrationV2AppThread) =>
    thread.move != null && thread.move.status !== "running";
  const afterSequence = yield* hub
    .service(EventSink.EventSinkV2)
    .latestSequence({ threadId })
    .pipe(Effect.orDie);
  const { thread } = yield* orchestrator.getThreadProjection(threadId).pipe(Effect.orDie);
  if (settled(thread)) return thread;
  const found = yield* orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
    Stream.filterMap(({ event }) =>
      event.type === "thread.move-updated" && settled(event.payload)
        ? Result.succeed(event.payload)
        : Result.failVoid,
    ),
    Stream.runHead,
    Effect.orDie,
  );
  return Option.getOrThrow(found);
});

const readText = (path: string) => Effect.promise(() => NodeFSP.readFile(path, "utf8"));

const checkoutOn = Effect.fn(function* (
  hub: Hub,
  environment: TestEnvironment,
  projectId: ProjectId,
) {
  const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
  const executor = yield* registry.get(environment.environmentId).pipe(Effect.orDie);
  return Option.getOrThrow(yield* executor.workspace.paths.checkout(projectId).pipe(Effect.orDie));
});

/** A recorded turn on the Laptop that writes `notes.md`, its checkpoint in the Hub repository. */
const turnOnLaptop = Effect.fn(function* (input: { readonly desktop: boolean }) {
  const loaded = yield* loadFixture("simple");
  const hub = yield* makeHub();
  const laptop = yield* hub.join({
    name: "Laptop",
    adapters: withEditingTurns(loaded.adapters, {
      file: "notes.md",
      content: "Written on the Laptop",
    }),
  });
  const desktop = input.desktop
    ? // It runs no recorded turn: a session opening there is all the next turn shows.
      yield* hub.join({
        name: "Desktop",
        adapters: idleAdapters(loaded.variant.modelSelection.instanceId),
      })
    : undefined;
  yield* replayOn(hub, laptop, loaded);
  const [threadId] = loaded.materialized.projectionThreadIds;
  assert.isDefined(threadId);
  yield* awaitUploaded(hub, threadId, 1);
  const { thread } = yield* hub
    .service(Orchestrator.OrchestratorV2)
    .getThreadProjection(threadId)
    .pipe(Effect.orDie);
  return {
    hub,
    laptop,
    desktop,
    threadId,
    projectId: thread.projectId,
    owner: yield* ownerIdOf(hub),
    laptopCheckout: yield* checkoutOn(hub, laptop, thread.projectId),
  };
});

describe("Hub con Environments: moving a Thread", () => {
  it.live(
    "its files, manual changes and next turn go to the target, and the timeline says so",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, desktop, threadId, projectId, owner, laptopCheckout } =
          yield* turnOnLaptop({ desktop: true });
        assert.isDefined(desktop);
        const orchestrator = hub.service(Orchestrator.OrchestratorV2);
        const before = yield* orchestrator.getThreadProjection(threadId);
        const laptopSessions = before.providerSessions.map((session) => session.id);
        assert.isNotEmpty(laptopSessions);
        // Typed by hand after the turn: no checkpoint has it yet.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(`${laptopCheckout}/manual.txt`, "typed by hand\n"),
        );

        yield* dispatchMove(hub, {
          commandId: "command:move-to-desktop",
          threadId,
          target: desktop.environmentId,
          actor: owner,
        });
        const moved = yield* settledMove(hub, threadId);
        assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
        assert.equal(moved.activeEnvironmentId, desktop.environmentId);
        assert.equal(moved.move?.continuesFrom?.kind, "final");
        assert.isNotTrue(moved.move?.sourceOffline);

        // The Desktop's checkout has the turn's file and the change made by hand.
        const desktopCheckout = yield* checkoutOn(hub, desktop, projectId);
        assert.notEqual(desktopCheckout, laptopCheckout);
        assert.equal(
          yield* readText(`${desktopCheckout}/notes.md`),
          "Written on the Laptop (turn 1)\n",
        );
        assert.equal(yield* readText(`${desktopCheckout}/manual.txt`), "typed by hand\n");

        // The timeline names both machines, who moved it and what it continues from.
        const after = yield* orchestrator.getThreadProjection(threadId);
        const entry = after.turnItems.find((item) => item.type === "environment_move");
        assert.isDefined(entry);
        assert.equal(entry.title, "Moved from Laptop to Desktop");
        if (entry.type === "environment_move") {
          assert.equal(entry.actorUserId, owner);
          assert.equal(entry.continuesFrom.kind, "final");
          assert.isFalse(entry.sourceOffline);
        }
        // The Laptop's sessions are retired; the audit log records the move.
        for (const session of after.providerSessions) {
          assert.notInclude(laptopSessions, session.id);
        }
        const audited = yield* hub.server.sql<{ readonly detail: string }>`
          SELECT detail_json AS detail FROM audit_log WHERE action = 'thread.move'
        `;
        assert.deepEqual(
          audited.map((row) => JSON.parse(row.detail)),
          [
            {
              from: laptop.environmentId,
              to: desktop.environmentId,
              outcome: "switched",
              continuesFrom: "final",
            },
          ],
        );

        // The next turn opens its session on the Desktop.
        const asked = desktop.requests.length;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:after-move"),
          threadId,
          messageId: MessageId.make("message:after-move"),
          text: "Go on from here",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        yield* desktop.awaitRequest("provider.openSession", asked);
        assert.notInclude(
          laptop.requests.slice(laptop.requests.lastIndexOf("checkpoint.push") + 1),
          "provider.openSession",
        );
      }).pipe(Effect.scoped),
  );

  it.live("with its source offline, it continues from the last checkpoint uploaded", () =>
    Effect.gen(function* () {
      const { hub, laptop, desktop, threadId, projectId, owner } = yield* turnOnLaptop({
        desktop: true,
      });
      assert.isDefined(desktop);
      yield* laptop.disconnect;

      yield* dispatchMove(hub, {
        commandId: "command:move-offline",
        threadId,
        target: desktop.environmentId,
        actor: owner,
      });
      const moved = yield* settledMove(hub, threadId);
      assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
      assert.isTrue(moved.move?.sourceOffline);
      assert.equal(moved.move?.continuesFrom?.kind, "uploaded");
      assert.equal(moved.move?.continuesFrom?.appRunOrdinal, 1);
      const desktopCheckout = yield* checkoutOn(hub, desktop, projectId);
      assert.equal(
        yield* readText(`${desktopCheckout}/notes.md`),
        "Written on the Laptop (turn 1)\n",
      );
      const { turnItems } = yield* hub
        .service(Orchestrator.OrchestratorV2)
        .getThreadProjection(threadId);
      const entry = turnItems.find((item) => item.type === "environment_move");
      assert.isTrue(entry?.type === "environment_move" && entry.sourceOffline);
    }).pipe(Effect.scoped),
  );

  it.live("a failed step leaves the Thread on its source, saying which step failed", () =>
    Effect.gen(function* () {
      const { hub, laptop, desktop, threadId, projectId, owner } = yield* turnOnLaptop({
        desktop: true,
      });
      assert.isDefined(desktop);
      // The Desktop has no checkout and the Project no remote to clone it from.
      const project = Option.getOrThrow(
        yield* hub.service(ProjectStore.ProjectStoreV2).get(projectId),
      );
      yield* git(project.workspaceRoot, ["remote", "remove", "origin"]);

      yield* dispatchMove(hub, {
        commandId: "command:move-fails",
        threadId,
        target: desktop.environmentId,
        actor: owner,
      });
      const failed = yield* settledMove(hub, threadId);
      assert.equal(failed.move?.status, "failed");
      assert.equal(failed.move?.failure?.step, "fetching");
      assert.include(failed.move?.failure?.message ?? "", "no remote to clone");
      assert.equal(failed.activeEnvironmentId, laptop.environmentId);
      const audited = yield* hub.server.sql<{ readonly detail: string }>`
        SELECT detail_json AS detail FROM audit_log WHERE action = 'thread.move'
      `;
      assert.equal(JSON.parse(audited[0]?.detail ?? "{}").failedStep, "fetching");
      // It can be moved again once the cause is gone; a running move is not stuck.
      assert.equal(
        (yield* hub.service(ProjectionStore.ProjectionStoreV2).getThread(threadId)).move?.status,
        "failed",
      );
    }).pipe(Effect.scoped),
  );

  it.live("only one move of a Thread runs at a time", () =>
    Effect.gen(function* () {
      const { hub, desktop, threadId, owner } = yield* turnOnLaptop({ desktop: true });
      assert.isDefined(desktop);
      const results = yield* Effect.forEach(
        [1, 2],
        (n) =>
          dispatchMove(hub, {
            commandId: `command:move-race-${n}`,
            threadId,
            target: desktop.environmentId,
            actor: owner,
          }).pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      const refused = results.filter((result) => result._tag === "Failure");
      assert.equal(refused.length, 1);
      assert.include(JSON.stringify(refused[0]), "already moving to another Environment");
      const moved = yield* settledMove(hub, threadId);
      assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
    }).pipe(Effect.scoped),
  );

  it.live("only its own User moves a Thread, to a machine they may use and that is online", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const owner = yield* ownerIdOf(hub);
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      const away = yield* hub.join({
        name: "Away",
        adapters: idleAdapters(instanceId),
        connect: false,
      });
      const member = UserId.make("member-1");
      yield* addMember(hub.server, { id: member, displayName: "Grace Hopper" });
      const graceSpace = SpaceId.make("personal:member-1");
      const projectId = ProjectId.make("project:graces");
      yield* seedProject(hub.server, {
        projectId,
        title: "Grace's",
        defaultModelSelection: null,
        spaceId: graceSpace,
      });
      const orchestrator = hub.service(Orchestrator.OrchestratorV2);
      const threadOf = (threadId: ThreadId, ownerUserId: UserId, spaceId?: SpaceId) =>
        orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:create:${threadId}`),
          threadId,
          projectId: spaceId === undefined ? ProjectId.make("project:owners") : projectId,
          title: "A Thread",
          modelSelection: { instanceId, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          ...(spaceId === undefined ? {} : { spaceId }),
          ownerUserId,
        });
      yield* seedProject(hub.server, {
        projectId: ProjectId.make("project:owners"),
        title: "Owner's",
        defaultModelSelection: null,
      });
      const graces = ThreadId.make("thread:graces");
      const owners = ThreadId.make("thread:owners");
      yield* threadOf(graces, member, graceSpace);
      yield* threadOf(owners, owner);
      const refusal = <A, E>(result: Effect.Effect<A, E>): Effect.Effect<string> =>
        result.pipe(
          Effect.flip,
          Effect.map((error) => JSON.stringify(error)),
          Effect.orElseSucceed(() => "accepted"),
        );

      // The Owner cannot move another User's Thread, not even to the Owner's own machine.
      const ownerMovesGraces = yield* refusal(
        dispatchMove(hub, {
          commandId: "command:owner-moves-graces",
          threadId: graces,
          target: laptop.environmentId,
          actor: owner,
        }),
      );
      assert.notEqual(ownerMovesGraces, "accepted");
      // Grace cannot move hers onto the Owner's personal machine.
      const graceToLaptop = yield* refusal(
        dispatchMove(hub, {
          commandId: "command:grace-to-laptop",
          threadId: graces,
          target: laptop.environmentId,
          actor: member,
        }),
      );
      assert.include(graceToLaptop, "not-usable");
      // A Guest of the Owner's Space has no move either.
      const guest = UserId.make("guest-1");
      yield* addMember(hub.server, { id: guest, displayName: "Guest" });
      const ownersSpace = (yield* hub.server.sql<{ readonly spaceId: string }>`
        SELECT space_id AS "spaceId" FROM orchestration_v2_projection_threads
        WHERE thread_id = ${owners}
      `)[0]?.spaceId;
      if (ownersSpace !== undefined && ownersSpace !== null) {
        yield* joinOrganization(hub.server, ownersSpace, guest, "guest");
      }
      const guestMoves = yield* refusal(
        dispatchMove(hub, {
          commandId: "command:guest-moves",
          threadId: owners,
          target: laptop.environmentId,
          actor: guest,
        }),
      );
      assert.notEqual(guestMoves, "accepted");
      // The Owner's own Thread does not go to a machine that is offline.
      const toAway = yield* refusal(
        dispatchMove(hub, {
          commandId: "command:to-away",
          threadId: owners,
          target: away.environmentId,
          actor: owner,
        }),
      );
      assert.include(toAway, "offline");
      // Nothing was recorded on either Thread.
      for (const threadId of [graces, owners]) {
        assert.isUndefined(
          (yield* hub.service(ProjectionStore.ProjectionStoreV2).getThread(threadId)).move ??
            undefined,
        );
      }
    }).pipe(Effect.scoped),
  );
});
