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
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { addMember } from "../auth/UserAuth.testkit.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
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
        yield* hub.server.sql`
          UPDATE orchestration_v2_projection_threads
          SET active_environment_id = ${HUB_MACHINE_ENVIRONMENT_ID} WHERE thread_id = ${threadId}
        `;
        yield* send(3, "turn-from-the-old-machine");
        yield* hub.server.sql`
          UPDATE orchestration_v2_projection_threads
          SET active_environment_id = ${environmentId} WHERE thread_id = ${threadId}
        `;
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
});
