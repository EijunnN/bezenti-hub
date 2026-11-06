/**
 * «Hub con Environments», ticket 10: a machine that drops in the middle of a turn, comes back with
 * its agent alive or dead, comes back with changes made by hand for a Thread that moved away, or
 * is removed.
 */
// @effect-diagnostics nodeBuiltinImport:off -- edits a machine's files by hand, as a User would.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type EnvironmentId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2TurnItem,
  type ProjectId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderReplayTranscript,
  type ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as CommandActor from "../auth/CommandActor.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  ClaudeOrchestratorReplayHarness,
  makeClaudeRestartReplayHarness,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
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
  makeHub,
  seedProject,
  type Hub,
  type TestEnvironment,
} from "./HubWithEnvironments.testkit.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");

type Adapters = Layer.Layer<
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  never,
  McpProviderSessions.McpProviderSessions
>;

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
  const replayGate = makeProviderReplayGate([]);
  const adapters: Adapters = ClaudeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(
    transcript,
    { replayGate },
  ).pipe(Layer.orDie);
  return { fixture, variant, transcript, materialized, replayGate, adapters };
});
type LoadedFixture = Effect.Success<ReturnType<typeof loadFixture>>;

/** Wraps each session the machine's adapters open. */
const wrappingSessions = (
  adapters: Adapters,
  wrap: (
    runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  ) => ProviderAdapter.ProviderAdapterV2SessionRuntime,
): Adapters =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (instanceId: ProviderInstanceId) =>
        registry.get(instanceId).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            openSession: (open: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
              adapter.openSession(open).pipe(Effect.map(wrap)),
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

/**
 * The machine's agent holds its turn's event stream after `afterEvents` events until the test
 * lets it go: the provider goes on working, only what it reports waits.
 */
const holdingEvents = (adapters: Adapters, afterEvents: number) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    /** The turn's last event went to the machine's agent. */
    const ended = yield* Deferred.make<void>();
    const layer = wrappingSessions(adapters, (runtime) => {
      let seen = 0;
      return {
        ...runtime,
        events: runtime.events.pipe(
          Stream.tap((event) =>
            Effect.suspend(() => {
              seen += 1;
              if (event.type === "turn.terminal") return Deferred.succeed(ended, undefined);
              if (seen !== afterEvents) return Effect.void;
              return Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              );
            }),
          ),
        ),
      };
    });
    return { layer, reached, release, ended };
  });

/** Turns that write `file` in their workspace, so each turn's checkpoint carries it. */
const editingTurns = (adapters: Adapters, file: string, content: string) =>
  wrappingSessions(adapters, (runtime) => ({
    ...runtime,
    startTurn: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      Effect.promise(() =>
        NodeFSP.writeFile(
          `${turn.runtimePolicy.cwd}/${file}`,
          `${content} (turn ${turn.runOrdinal})\n`,
        ),
      ).pipe(Effect.andThen(runtime.startTurn(turn))),
  }));

/** A machine with the provider but no recorded turns, for tests that run none there. */
const idleAdapters = (instanceId: ProviderInstanceId): Adapters =>
  ProviderAdapterRegistry.layerFromAdapters([
    {
      instanceId,
      driver: CLAUDE,
      getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("no turns run here"),
    },
  ]);

const placeOn = (
  environment: TestEnvironment,
  command: LoadedFixture["materialized"]["commands"][number],
) =>
  command.type === "thread.create"
    ? { ...command, activeEnvironmentId: environment.environmentId }
    : command;

/** Replays a fixture through the Hub's orchestrator, its Thread running on `environment`. */
const replayOn = Effect.fn(function* (
  hub: Hub,
  environment: TestEnvironment,
  loaded: LoadedFixture,
) {
  const place = (command: LoadedFixture["materialized"]["commands"][number]) =>
    placeOn(environment, command);
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

const projectionOf = (hub: Hub, threadId: ThreadId) =>
  hub.service(Orchestrator.OrchestratorV2).getThreadProjection(threadId).pipe(Effect.orDie);

/** Resolves with the first stored event of the Thread that `pick` takes, from now on or before. */
const awaitThreadEvent = <A>(
  hub: Hub,
  threadId: ThreadId,
  pick: (event: { readonly type: string; readonly payload: unknown }) => A | undefined,
  already: Effect.Effect<A | undefined>,
) =>
  Effect.gen(function* () {
    const orchestrator = hub.service(Orchestrator.OrchestratorV2);
    const afterSequence = yield* hub
      .service(EventSink.EventSinkV2)
      .latestSequence({ threadId })
      .pipe(Effect.orDie);
    const found = yield* already;
    if (found !== undefined) return found;
    const next = yield* orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
      Stream.filterMap(({ event }) => {
        const picked = pick(event as { readonly type: string; readonly payload: unknown });
        return picked === undefined ? Result.failVoid : Result.succeed(picked);
      }),
      Stream.runHead,
      Effect.orDie,
    );
    return Option.getOrThrow(next);
  });

/** The Thread's latest run once it settled (not running, not queued). */
const awaitRunSettled = (hub: Hub, threadId: ThreadId, ordinal: number) =>
  awaitThreadEvent(
    hub,
    threadId,
    (event) => {
      const run = event.payload as { readonly ordinal?: number; readonly status?: string };
      return event.type === "run.updated" &&
        run.ordinal === ordinal &&
        ["completed", "failed", "interrupted", "cancelled"].includes(run.status ?? "")
        ? run.status
        : undefined;
    },
    projectionOf(hub, threadId).pipe(
      Effect.map((projection) => {
        const run = projection.runs.find((candidate) => candidate.ordinal === ordinal);
        return run !== undefined &&
          ["completed", "failed", "interrupted", "cancelled"].includes(run.status)
          ? run.status
          : undefined;
      }),
    ),
  );

const awaitRecovered = (hub: Hub, threadId: ThreadId) =>
  awaitThreadEvent(
    hub,
    threadId,
    (event) => {
      const item = event.payload as OrchestrationV2TurnItem;
      return event.type === "turn-item.updated" && item.type === "recovered_changes"
        ? item
        : undefined;
    },
    projectionOf(hub, threadId).pipe(
      Effect.map((projection) =>
        projection.turnItems.find((item) => item.type === "recovered_changes"),
      ),
    ),
  );

/** A message from the Thread's User, as a client sends it (a plain send while a turn runs). */
const sendMessage = (hub: Hub, threadId: ThreadId, actor: UserId, n: number) =>
  hub
    .service(ThreadManagementService.ThreadManagementService)
    .dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:message-${n}`),
      threadId,
      messageId: MessageId.make(`message:while-away-${n}`),
      text: `Message ${n}`,
      attachments: [],
      deliveryIntent: "auto",
      dispatchMode: { type: "start_immediately" },
      ownerUserId: actor,
    } as never)
    .pipe(CommandActor.actAs(actor));

const dispatchMove = (
  hub: Hub,
  input: { readonly threadId: ThreadId; readonly target: EnvironmentId; readonly actor: UserId },
) =>
  hub
    .service(ThreadManagementService.ThreadManagementService)
    .dispatch({
      type: "thread.move",
      commandId: CommandId.make(`command:move:${input.target}`),
      threadId: input.threadId,
      targetEnvironmentId: input.target,
      ownerUserId: input.actor,
    })
    .pipe(CommandActor.actAs(input.actor));

/** The Thread once its move switched or failed. */
const settledMove = (hub: Hub, threadId: ThreadId) =>
  awaitThreadEvent(
    hub,
    threadId,
    (event) => {
      const thread = event.payload as OrchestrationV2AppThread;
      return event.type === "thread.move-updated" &&
        thread.move != null &&
        thread.move.status !== "running"
        ? thread
        : undefined;
    },
    projectionOf(hub, threadId).pipe(
      Effect.map(({ thread }) =>
        thread.move != null && thread.move.status !== "running" ? thread : undefined,
      ),
    ),
  );

const git = (cwd: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.flatMap(VcsProcess.VcsProcess, (vcs) =>
    vcs.run({
      operation: "Disconnections.test.git",
      command: "git",
      cwd,
      args,
      allowNonZeroExit: true,
      env,
    }),
  ).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))), Effect.orDie);

const checkoutOn = Effect.fn(function* (
  hub: Hub,
  environment: TestEnvironment,
  projectId: ProjectId,
) {
  const executor = yield* hub
    .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
    .get(environment.environmentId)
    .pipe(Effect.orDie);
  return Option.getOrThrow(yield* executor.workspace.paths.checkout(projectId).pipe(Effect.orDie));
});

const readText = (path: string) => Effect.promise(() => NodeFSP.readFile(path, "utf8"));

/** Runs `drop` and resolves once the Hub sees the machine away (its executor is gone). */
const goesAway = (hub: Hub, environment: TestEnvironment, drop: Effect.Effect<void>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
      const changes = yield* registry.changes;
      yield* drop;
      while (Option.isSome(yield* registry.get(environment.environmentId).pipe(Effect.option))) {
        yield* PubSub.take(changes);
      }
    }),
  );

describe("Hub con Environments: disconnections", () => {
  it.live("a network cut mid-turn pauses it; nothing is lost or duplicated when it resumes", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const hold = yield* holdingEvents(loaded.adapters, 2);
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: hold.layer });
      const replay = yield* replayOn(hub, laptop, loaded).pipe(Effect.forkScoped);
      yield* Deferred.await(hold.reached);
      // The network drops while the agent keeps working: what it reports waits on the machine.
      yield* goesAway(hub, laptop, laptop.disconnect);
      yield* Deferred.succeed(hold.release, undefined);
      // The agent finished its turn while offline: all of it waits in the machine's spool.
      yield* Deferred.await(hold.ended);
      const [threadId] = loaded.materialized.projectionThreadIds;
      assert.isDefined(threadId);
      // Paused, not ended: the turn is still under way on the Hub while its machine is away.
      const paused = yield* projectionOf(hub, threadId);
      assert.equal(paused.runs.at(-1)?.status, "running");
      // The machine comes back with its agent alive: the turn goes on and ends exactly as recorded.
      yield* laptop.connect;
      const result = yield* Fiber.join(replay);
      loaded.variant.assertOutput(result, loaded.transcript);
    }).pipe(Effect.scoped),
  );

  it.live(
    "back without its agent, the turn ends interrupted; a message sent meanwhile was queued and starts there",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hold = yield* holdingEvents(loaded.adapters, 2);
        const hub = yield* makeHub();
        const owner = yield* ownerIdOf(hub);
        const laptop = yield* hub.join({ name: "Laptop", adapters: hold.layer });
        yield* replayOn(hub, laptop, loaded).pipe(Effect.forkScoped);
        yield* Deferred.await(hold.reached);
        const [threadId] = loaded.materialized.projectionThreadIds;
        assert.isDefined(threadId);
        // The machine's server dies with the turn under way.
        yield* goesAway(hub, laptop, laptop.restart);
        // A plain send to the paused Thread waits in the queue instead of steering a turn that
        // cannot hear it.
        yield* sendMessage(hub, threadId, owner, 1);
        const queued = yield* projectionOf(hub, threadId);
        assert.deepEqual(
          queued.runs.map((run) => run.status),
          ["running", "queued"],
        );
        const asked = laptop.requests.length;
        yield* laptop.connect;
        assert.equal(yield* awaitRunSettled(hub, threadId, 1), "interrupted");
        const { turnItems, thread } = yield* projectionOf(hub, threadId);
        const interrupted = turnItems.find((item) => item.type === "run_interrupt_result");
        assert.isDefined(interrupted);
        if (interrupted?.type === "run_interrupt_result") {
          assert.include(
            interrupted.message,
            "The agent on Laptop stopped while Laptop was offline",
          );
        }
        // It goes on where it was: the queued message starts on the Laptop.
        assert.equal(thread.activeEnvironmentId, laptop.environmentId);
        yield* laptop.awaitRequest("provider.openSession", asked);
      }).pipe(Effect.scoped),
  );

  it.live("a machine that dies while its turn starts ends that turn interrupted too", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const starting = yield* Deferred.make<void>();
      // Its transcript is never played to the end: the machine dies before the turn starts.
      const unfinished: Adapters = makeClaudeRestartReplayHarness(loaded.transcript)
        .harness.makeProviderAdapterRegistryLayer(loaded.transcript)
        .pipe(Layer.orDie);
      const adapters = wrappingSessions(unfinished, (runtime) => ({
        ...runtime,
        // The agent never answers the start: the machine dies first.
        startTurn: () => Deferred.succeed(starting, undefined).pipe(Effect.andThen(Effect.never)),
      }));
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters });
      yield* replayOn(hub, laptop, loaded).pipe(Effect.forkScoped);
      yield* Deferred.await(starting);
      const [threadId] = loaded.materialized.projectionThreadIds;
      assert.isDefined(threadId);
      yield* goesAway(hub, laptop, laptop.restart);
      yield* laptop.connect;
      assert.equal(yield* awaitRunSettled(hub, threadId, 1), "interrupted");
    }).pipe(Effect.scoped),
  );

  it.live("a removed Environment's Thread keeps its history, needs an environment, and moves", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const hold = yield* holdingEvents(loaded.adapters, 2);
      const hub = yield* makeHub();
      const owner = yield* ownerIdOf(hub);
      const laptop = yield* hub.join({ name: "Laptop", adapters: hold.layer });
      const desktop = yield* hub.join({
        name: "Desktop",
        adapters: idleAdapters(loaded.variant.modelSelection.instanceId),
      });
      yield* replayOn(hub, laptop, loaded).pipe(Effect.forkScoped);
      yield* Deferred.await(hold.reached);
      const [threadId] = loaded.materialized.projectionThreadIds;
      assert.isDefined(threadId);
      // Lost while offline: it never comes back to report its turn.
      yield* goesAway(hub, laptop, laptop.disconnect);
      const before = yield* projectionOf(hub, threadId);
      yield* hub
        .service(EnvironmentRegistry.EnvironmentRegistry)
        .remove({ actorUserId: owner, environmentId: laptop.environmentId });
      assert.equal(yield* awaitRunSettled(hub, threadId, 1), "interrupted");
      const released = yield* awaitThreadEvent(
        hub,
        threadId,
        (event) =>
          event.type === "thread.metadata-updated" &&
          (event.payload as OrchestrationV2AppThread).activeEnvironmentId === null
            ? true
            : undefined,
        projectionOf(hub, threadId).pipe(
          Effect.map(({ thread }) => (thread.activeEnvironmentId === null ? true : undefined)),
        ),
      );
      assert.isTrue(released);
      const after = yield* projectionOf(hub, threadId);
      assert.isNull(after.thread.activeEnvironmentId);
      // Its history stays: every message and item it had is still there.
      for (const message of before.messages) {
        assert.isDefined(after.messages.find((candidate) => candidate.id === message.id));
      }
      // It takes no new work until it moves, and says why.
      const refused = yield* sendMessage(hub, threadId, owner, 2).pipe(Effect.flip);
      assert.include(JSON.stringify(refused), "needs an environment");
      // It moves from no Environment to another one.
      yield* dispatchMove(hub, { threadId, target: desktop.environmentId, actor: owner });
      const moved = yield* settledMove(hub, threadId);
      assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
      assert.isNull(moved.move?.sourceEnvironmentId);
      assert.equal(moved.activeEnvironmentId, desktop.environmentId);
    }).pipe(Effect.scoped),
  );

  it.live(
    "a paused Thread moves now when its turn is stopped; a queued message starts on the target",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hold = yield* holdingEvents(loaded.adapters, 2);
        const hub = yield* makeHub();
        const owner = yield* ownerIdOf(hub);
        const laptop = yield* hub.join({ name: "Laptop", adapters: hold.layer });
        const desktop = yield* hub.join({
          name: "Desktop",
          adapters: idleAdapters(loaded.variant.modelSelection.instanceId),
        });
        yield* replayOn(hub, laptop, loaded).pipe(Effect.forkScoped);
        yield* Deferred.await(hold.reached);
        const [threadId] = loaded.materialized.projectionThreadIds;
        assert.isDefined(threadId);
        yield* goesAway(hub, laptop, laptop.disconnect);
        yield* sendMessage(hub, threadId, owner, 3);
        yield* hub
          .service(ThreadManagementService.ThreadManagementService)
          .dispatch({
            type: "thread.move",
            commandId: CommandId.make("command:move-paused"),
            threadId,
            targetEnvironmentId: desktop.environmentId,
            ifRunning: "stop",
            ownerUserId: owner,
          })
          .pipe(CommandActor.actAs(owner));
        assert.equal(yield* awaitRunSettled(hub, threadId, 1), "interrupted");
        const moved = yield* settledMove(hub, threadId);
        assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
        assert.equal(moved.activeEnvironmentId, desktop.environmentId);
        const { turnItems } = yield* projectionOf(hub, threadId);
        const stopped = turnItems.find((item) => item.type === "run_interrupt_result");
        assert.isTrue(
          stopped?.type === "run_interrupt_result" &&
            stopped.message.includes("paused on Laptop, which was offline"),
        );
        // The message sent while it was paused starts where the Thread runs now.
        yield* desktop.awaitRequest("provider.openSession", 0);
      }).pipe(Effect.scoped),
  );

  it.live(
    "changes left on a machine for a Thread that moved go to a recovered branch, once, and stay there",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hub = yield* makeHub();
        const owner = yield* ownerIdOf(hub);
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: editingTurns(loaded.adapters, "notes.md", "Written on the Laptop"),
        });
        const desktop = yield* hub.join({
          name: "Desktop",
          adapters: idleAdapters(loaded.variant.modelSelection.instanceId),
        });
        yield* replayOn(hub, laptop, loaded);
        const [threadId] = loaded.materialized.projectionThreadIds;
        assert.isDefined(threadId);
        const { thread } = yield* projectionOf(hub, threadId);
        // The turn's checkpoint reached the Hub before the machine went away.
        yield* awaitThreadEvent(
          hub,
          threadId,
          (event) => (event.type === "checkpoint.uploaded" ? true : undefined),
          projectionOf(hub, threadId).pipe(
            Effect.map((projection) =>
              projection.checkpoints.some((checkpoint) => checkpoint.uploadedToHub === true)
                ? true
                : undefined,
            ),
          ),
        );
        const laptopCheckout = yield* checkoutOn(hub, laptop, thread.projectId);
        const headBefore = (yield* git(laptopCheckout, ["rev-parse", "HEAD"])).stdout.trim();
        yield* laptop.disconnect;
        // Typed by hand on the Laptop while it was away from the Hub: never uploaded.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(`${laptopCheckout}/by-hand.txt`, "typed on the Laptop\n"),
        );
        yield* dispatchMove(hub, { threadId, target: desktop.environmentId, actor: owner });
        const moved = yield* settledMove(hub, threadId);
        assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
        assert.isTrue(moved.move?.sourceOffline);

        // The Laptop comes back: what it kept goes to a branch of the Hub, with a notice.
        yield* laptop.connect;
        const notice = yield* awaitRecovered(hub, threadId);
        assert.isDefined(notice);
        if (notice?.type !== "recovered_changes") return assert.fail("no notice");
        assert.equal(notice.environmentName, "Laptop");
        assert.equal(notice.title, "Recovered changes from Laptop");
        const prefix = HubRepository.threadRefPrefixes(threadId)[1];
        assert.isTrue(notice.ref.startsWith(prefix), notice.ref);
        assert.match(notice.ref.slice(prefix.length), /^[A-Za-z0-9-]+$/);
        const repositories = hub.service(HubRepository.HubRepositories);
        const hubRepository = `${repositories.root}/${repositories.directoryOf(thread.projectId)}`;
        const listed = yield* git(repositories.root, [
          `--git-dir=${hubRepository}`,
          "show",
          `${notice.ref}:by-hand.txt`,
        ]);
        assert.equal(listed.stdout, "typed on the Laptop\n", listed.stderr);
        // The Laptop's workspace is left as it was: the file is there, nothing merged or reset.
        assert.equal(yield* readText(`${laptopCheckout}/by-hand.txt`), "typed on the Laptop\n");
        assert.equal((yield* git(laptopCheckout, ["rev-parse", "HEAD"])).stdout.trim(), headBefore);
        // Nor did it reach the Thread's workspace on the Desktop.
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.access(`${moved.worktreePath}/by-hand.txt`).then(
              () => true,
              () => false,
            ),
          ),
        );

        // Coming back again with nothing new hands over nothing more.
        const asked = laptop.requests.length;
        yield* laptop.disconnect;
        yield* laptop.connect;
        // The Hub asks again, the machine finds nothing it has not handed over, and no notice
        // follows.
        yield* laptop.awaitRequest("move.recover", asked);
        const another = yield* awaitThreadEvent(
          hub,
          threadId,
          (event) => {
            const item = event.payload as OrchestrationV2TurnItem;
            return event.type === "turn-item.updated" &&
              item.type === "recovered_changes" &&
              item.id !== notice.id
              ? item
              : undefined;
          },
          Effect.succeed(undefined),
        ).pipe(Effect.timeoutOption("2 seconds"));
        assert.isTrue(Option.isNone(another));
        const notices = (yield* projectionOf(hub, threadId)).turnItems.filter(
          (item) => item.type === "recovered_changes",
        );
        assert.equal(notices.length, 1);
      }).pipe(Effect.scoped),
  );

  it.live("a machine a Thread left may create its recovered ref and write nothing else", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const hub = yield* makeHub();
      const owner = yield* ownerIdOf(hub);
      const laptop = yield* hub.join({ name: "Laptop", adapters: loaded.adapters });
      const desktop = yield* hub.join({
        name: "Desktop",
        adapters: idleAdapters(loaded.variant.modelSelection.instanceId),
      });
      const stranger = yield* hub.join({
        name: "Stranger",
        adapters: idleAdapters(loaded.variant.modelSelection.instanceId),
      });
      yield* replayOn(hub, laptop, loaded);
      const [threadId] = loaded.materialized.projectionThreadIds;
      assert.isDefined(threadId);
      const { thread, checkpoints } = yield* projectionOf(hub, threadId);
      const laptopCheckout = yield* checkoutOn(hub, laptop, thread.projectId);
      yield* dispatchMove(hub, { threadId, target: desktop.environmentId, actor: owner });
      assert.equal((yield* settledMove(hub, threadId)).move?.status, "switched");

      const push = (machine: TestEnvironment, refspec: string) => {
        const remote = HubRepository.withEnvironmentCredential(
          HubRepository.hubRepositoryUrl(hub.server.url, thread.projectId),
          machine.credential,
        );
        return git(laptopCheckout, ["push", remote.url, refspec], { ...remote.env });
      };
      const [threads, recovered] = HubRepository.threadRefPrefixes(threadId);
      const ok = (output: { readonly exitCode: number; readonly stderr: string }) =>
        assert.equal(output.exitCode, 0, output.stderr);
      const refused = (output: { readonly exitCode: number }) =>
        assert.notEqual(output.exitCode, 0);

      // The machine it left creates one recovered ref, once.
      ok(yield* push(laptop, `HEAD:${recovered}2026-01-01T00-00-00-000Z`));
      const other = (yield* git(laptopCheckout, [
        "-c",
        "user.name=Laptop",
        "-c",
        "user.email=laptop@example.com",
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        "HEAD",
        "-m",
        "another",
      ])).stdout.trim();
      refused(yield* push(laptop, `+${other}:${recovered}2026-01-01T00-00-00-000Z`));
      // Nothing deeper, nothing of the Thread's own, no checkpoint, nothing of another Thread.
      refused(yield* push(laptop, `HEAD:${recovered}2026-01-02/branch/main`));
      refused(yield* push(laptop, `HEAD:${threads}head`));
      const checkpoint = checkpoints.find((candidate) => candidate.status === "ready");
      assert.isDefined(checkpoint);
      refused(yield* push(laptop, `+HEAD:${checkpoint.ref}`));
      refused(
        yield* push(laptop, `HEAD:${HubRepository.threadRefPrefixes("thread:other")[1]}2026-01-03`),
      );
      // A machine the Thread never ran on has no recovered ref to create.
      refused(yield* push(stranger, `HEAD:${recovered}2026-01-04`));
    }).pipe(Effect.scoped),
  );
});
