// @effect-diagnostics nodeBuiltinImport:off -- the tests read and write files on disk.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderReplayTranscript,
  ProviderTurnId,
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CommandActor from "../auth/CommandActor.ts";
import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ClaudeOrchestratorReplayHarness } from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
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
import * as Sandboxes from "../sandboxes/Sandboxes.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  connectProtocolEnvironment,
  makeHub,
  seedProject,
  type Hub,
  type TestEnvironment,
} from "./HubWithEnvironments.testkit.ts";

export const CLAUDE = ProviderDriverKind.make("claudeAgent");

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
export const idleAdapters = (instanceId: ProviderInstanceId) =>
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
export const loadFixture = Effect.fn(function* (name: string) {
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
  (environmentId: EnvironmentId, worktreePath?: string) =>
  (command: OrchestrationV2Command): OrchestrationV2Command =>
    command.type === "thread.create"
      ? {
          ...command,
          activeEnvironmentId: environmentId,
          ...(worktreePath === undefined ? {} : { worktreePath }),
        }
      : command;

/**
 * Replays a fixture through the Hub's orchestrator, its Thread running on `environment`. With
 * `scratchFolder` the Thread has no Project: it is in the Hub's scratch Project, with its own
 * folder there, as a new Thread without a Project gets one (`ManagedProjectFolders`).
 */
export const replayOn = Effect.fn(function* (
  hub: Hub,
  environment: TestEnvironment,
  loaded: LoadedFixture,
  options: {
    readonly scratchFolder?: string;
    readonly spaceId?: SpaceId;
    /** Runs on the Hub's checkout of the Project once it is made, before the Thread starts. */
    readonly afterSeed?: (workspaceRoot: string) => Effect.Effect<void>;
  } = {},
) {
  const created = loaded.materialized.commands.find((command) => command.type === "thread.create");
  assert.isDefined(created);
  const seeded = yield* seedProject(hub.server, {
    projectId: created.projectId,
    title: options.scratchFolder === undefined ? "Remote project" : "No project",
    defaultModelSelection: loaded.variant.modelSelection,
    ...(options.scratchFolder === undefined ? {} : { scratch: true }),
    ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
  });
  if (options.afterSeed !== undefined) yield* options.afterSeed(seeded.workspaceRoot);
  let worktreePath: string | undefined;
  if (options.scratchFolder !== undefined) {
    worktreePath = `${seeded.workspaceRoot}/${options.scratchFolder}`;
    yield* Effect.promise(() => NodeFSP.mkdir(worktreePath!, { recursive: true }));
    yield* git(worktreePath, ["init", "--quiet"]);
  }
  const place = placeOn(environment.environmentId, worktreePath);
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

export const ownerIdOf = Effect.fn(function* (hub: Hub) {
  const [row] = yield* hub.server.sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM users WHERE is_owner = 1
  `;
  assert.isDefined(row);
  return UserId.make(row.userId);
});

/** The Thread changed Environments, as a move records it. */
export const moveThread = Effect.fn(function* (
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
export const openProtocolSession = Effect.fn(function* (hub: Hub) {
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

/** Git in a folder of the test, its exit code and output whatever they are. */
export const git = (
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
export const awaitUploaded = Effect.fn(function* (
  hub: Hub,
  threadId: ThreadId,
  appRunOrdinal: number,
) {
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
export const withEditingTurns = (
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

/** A move as its sender dispatches it, through the Hub's checks. */
export const dispatchMove = (
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
export const settledMove = Effect.fn(function* (hub: Hub, threadId: ThreadId) {
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

export const readText = (path: string) => Effect.promise(() => NodeFSP.readFile(path, "utf8"));

export const checkoutOn = Effect.fn(function* (
  hub: Hub,
  environment: TestEnvironment,
  projectId: ProjectId,
) {
  const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
  const executor = yield* registry.get(environment.environmentId).pipe(Effect.orDie);
  return Option.getOrThrow(yield* executor.workspace.paths.checkout(projectId).pipe(Effect.orDie));
});

/** A recorded turn on the Laptop that writes `notes.md`, its checkpoint in the Hub repository. */
export const turnOnLaptop = Effect.fn(function* (input: {
  readonly desktop: boolean;
  readonly laptopTextGeneration?: ProviderTextGeneration;
  readonly hubTextGeneration?: ProviderTextGeneration;
  readonly desktopTextGeneration?: ProviderTextGeneration;
  /** Off: the Hub machine runs no agents (`T3CODE_HUB_RUNS_AGENTS`). */
  readonly hubRunsAgents?: boolean;
  /** The Desktop's provider; by default one that runs no turn. */
  readonly desktopAdapters?: (
    instanceId: ProviderInstanceId,
  ) => Layer.Layer<ProviderAdapterRegistry.ProviderAdapterRegistryV2>;
}) {
  const loaded = yield* loadFixture("simple");
  const hub = yield* makeHub({
    ...(input.hubTextGeneration === undefined ? {} : { textGeneration: input.hubTextGeneration }),
    ...(input.hubRunsAgents === undefined ? {} : { hubRunsAgents: input.hubRunsAgents }),
  });
  const laptop = yield* hub.join({
    name: "Laptop",
    adapters: withEditingTurns(loaded.adapters, {
      file: "notes.md",
      content: "Written on the Laptop",
    }),
    ...(input.laptopTextGeneration === undefined
      ? {}
      : { textGeneration: input.laptopTextGeneration }),
  });
  const desktop = input.desktop
    ? // It runs no recorded turn: a session opening there is all the next turn shows.
      yield* hub.join({
        name: "Desktop",
        adapters: (input.desktopAdapters ?? idleAdapters)(loaded.variant.modelSelection.instanceId),
        ...(input.desktopTextGeneration === undefined
          ? {}
          : { textGeneration: input.desktopTextGeneration }),
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

export const exists = (target: string) =>
  Effect.promise(() =>
    NodeFSP.access(target).then(
      () => true,
      () => false,
    ),
  );

/** Starts the Space's Sandbox and waits for it, as the Thread's first work does. */
export const startSandbox = (hub: Hub, spaceId: SpaceId) =>
  hub
    .service(Sandboxes.Sandboxes)
    .ensureRunning({ spaceId, actorUserId: undefined })
    .pipe(Effect.orDie);

/** An Organization of the Owner's, as `/api/spaces` makes one. */
export const createOrganization = Effect.fn(function* (hub: Hub, name: string) {
  const owner = yield* ownerIdOf(hub);
  const created = yield* hub
    .service(SpaceDirectory.SpaceDirectory)
    .createOrganization(owner, name)
    .pipe(Effect.orDie);
  return created.id;
});
