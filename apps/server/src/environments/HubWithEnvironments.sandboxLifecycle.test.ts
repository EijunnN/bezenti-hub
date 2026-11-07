// @effect-diagnostics nodeBuiltinImport:off -- fills a Sandbox's home past its disk limit.
/**
 * «Hub con Environments», spec 3 ticket 02: a Space's Sandbox starts when work needs it (never
 * while a Thread is placed), shows `starting` and then online or `failed` with why and «Try
 * again», stops after the idle timeout on the test clock, and dies mid-turn like an offline
 * Environment of spec 2.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type EnvironmentId,
  MessageId,
  type OrchestrationV2Command,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderReplayTranscript,
  sandboxEnvironmentIdOf,
  type SpaceId,
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
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CommandActor from "../auth/CommandActor.ts";
import * as EnvironmentDemand from "../environment/EnvironmentDemand.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ClaudeOrchestratorReplayHarness } from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { materializeFixtureInput } from "../orchestration-v2/testkit/fixtures/shared.ts";
import {
  findReplayFixture,
  readReplayFixtureTranscript,
} from "../orchestration-v2/testkit/ProviderReplayFixtures.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessSandboxRuntime from "../sandboxes/ProcessSandboxRuntime.ts";
import * as Sandboxes from "../sandboxes/Sandboxes.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { listEnvironments } from "./environments.testkit.ts";
import { makeHub, seedProject, type Hub } from "./HubWithEnvironments.testkit.ts";

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
  const recorded = (yield* readReplayFixtureTranscript(
    variant.transcriptFile,
  )) as ProviderReplayTranscript;
  const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
    materializeReplayTranscriptRuntimeInstructions(recorded, {
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
  const adapters: Adapters = ClaudeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(
    transcript,
    { replayGate: makeProviderReplayGate([]) },
  ).pipe(Layer.orDie);
  return { variant, materialized, adapters };
});
type LoadedFixture = Effect.Success<ReturnType<typeof loadFixture>>;

/**
 * The machine's agent holds its turn's event stream after `afterEvents` events until the test
 * lets it go: the provider goes on working, only what it reports waits.
 */
const holdingEvents = (adapters: Adapters, afterEvents: number) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const layer: Adapters = Layer.effect(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
        ...registry,
        get: (instanceId: Parameters<typeof registry.get>[0]) =>
          registry.get(instanceId).pipe(
            Effect.map((adapter) => ({
              ...adapter,
              openSession: (open: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
                adapter.openSession(open).pipe(
                  Effect.map((runtime) => {
                    let seen = 0;
                    return {
                      ...runtime,
                      events: runtime.events.pipe(
                        Stream.tap(() =>
                          Effect.suspend(() => {
                            seen += 1;
                            return seen === afterEvents
                              ? Deferred.succeed(reached, undefined).pipe(
                                  Effect.andThen(Effect.never),
                                )
                              : Effect.void;
                          }),
                        ),
                      ),
                    };
                  }),
                ),
            })),
          ),
      })),
    ).pipe(Layer.provide(adapters));
    return { layer, reached };
  });

/**
 * The recorded turn plays on the first session the machine opens; a later one (after the Sandbox
 * started again) only says it opened and then waits, as the recording has no second turn.
 */
const replayingOnce = (adapters: Adapters) =>
  Effect.gen(function* () {
    const reopened = yield* Deferred.make<void>();
    let opened = 0;
    const layer: Adapters = Layer.effect(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
        ...registry,
        get: (instanceId: Parameters<typeof registry.get>[0]) =>
          registry.get(instanceId).pipe(
            Effect.map((adapter) => ({
              ...adapter,
              openSession: (open: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
                Effect.suspend(() => {
                  opened += 1;
                  return opened === 1
                    ? adapter.openSession(open)
                    : Deferred.succeed(reopened, undefined).pipe(Effect.andThen(Effect.never));
                }),
            })),
          ),
      })),
    ).pipe(Layer.provide(adapters));
    return { layer, reopened };
  });

/** The provider, with no recorded turns: for tests that run none in the Sandbox. */
const idleAdapters: Adapters = ProviderAdapterRegistry.layerFromAdapters([
  {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: CLAUDE,
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("no turns run here"),
  },
]);

const ownerIdOf = Effect.fn(function* (hub: Hub) {
  const [row] = yield* hub.server.sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM users WHERE is_owner = 1
  `;
  assert.isDefined(row);
  return UserId.make(row.userId);
});

const createOrganization = Effect.fn(function* (hub: Hub, name: string) {
  const owner = yield* ownerIdOf(hub);
  const created = yield* hub
    .service(SpaceDirectory.SpaceDirectory)
    .createOrganization(owner, name)
    .pipe(Effect.orDie);
  return created.id;
});

/** A client's command, through the Hub's placement and starts, as the Owner. */
const dispatchAs = (hub: Hub, actor: UserId, command: OrchestrationV2Command) =>
  hub
    .service(ThreadManagementService.ThreadManagementService)
    .dispatch({ ...command, ownerUserId: actor } as never)
    .pipe(CommandActor.actAs(actor));

/**
 * The fixture's Project in `spaceId`, and its Thread placed on the Space's Sandbox through the
 * Hub: the Thread exists before its Sandbox ever started.
 */
const placeOnSandbox = Effect.fn(function* (
  hub: Hub,
  loaded: LoadedFixture,
  spaceId: SpaceId,
  owner: UserId,
) {
  const [create, ...messages] = loaded.materialized.commands;
  assert.equal(create?.type, "thread.create");
  if (create?.type !== "thread.create") return yield* Effect.die("no thread.create");
  yield* seedProject(hub.server, {
    projectId: create.projectId,
    title: "Acme web",
    defaultModelSelection: loaded.variant.modelSelection,
    spaceId,
  });
  yield* dispatchAs(hub, owner, {
    ...create,
    activeEnvironmentId: sandboxEnvironmentIdOf(spaceId),
  });
  const message = messages.find((command) => command.type === "message.dispatch");
  if (message === undefined) return yield* Effect.die("no message");
  return { threadId: create.threadId, message };
});

const sandboxRow = (hub: Hub, spaceId: SpaceId) =>
  listEnvironments(hub.server, hub.owner).pipe(
    Effect.map((listed) => listed.find((entry) => entry.id === sandboxEnvironmentIdOf(spaceId))),
  );

const projectionOf = (hub: Hub, threadId: ThreadId) =>
  hub.service(Orchestrator.OrchestratorV2).getThreadProjection(threadId).pipe(Effect.orDie);

/** The Thread's run `ordinal` once it settled, from the event stream or the projection. */
const awaitRunSettled = (hub: Hub, threadId: ThreadId, ordinal: number) =>
  Effect.gen(function* () {
    const settled = ["completed", "failed", "interrupted", "cancelled"];
    const afterSequence = yield* hub
      .service(EventSink.EventSinkV2)
      .latestSequence({ threadId })
      .pipe(Effect.orDie);
    const run = (yield* projectionOf(hub, threadId)).runs.find(
      (candidate) => candidate.ordinal === ordinal,
    );
    if (run !== undefined && settled.includes(run.status)) return run.status;
    const next = yield* hub
      .service(Orchestrator.OrchestratorV2)
      .streamStoredEventsFrom({ threadId, afterSequence })
      .pipe(
        Stream.filterMap(({ event }) => {
          const payload = (event as { readonly payload: unknown }).payload as {
            readonly ordinal?: number;
            readonly status?: string;
          };
          return event.type === "run.updated" &&
            payload.ordinal === ordinal &&
            settled.includes(payload.status ?? "")
            ? Result.succeed(payload.status!)
            : Result.failVoid;
        }),
        Stream.runHead,
        Effect.orDie,
      );
    return Option.getOrThrow(next);
  });

const auditedStarts = (hub: Hub) =>
  hub.server.sql<{ readonly action: string; readonly detail: string | null }>`
    SELECT action, detail_json AS detail FROM audit_log
    WHERE action IN ('sandbox.start', 'sandbox.stop') ORDER BY rowid
  `;

describe("Hub con Environments: a Sandbox starts for work and stops when idle", () => {
  it.live(
    "placing a Thread does not wait for its Sandbox; its first message starts it, shown starting, and the turn runs",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const launching = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const hub = yield* makeHub({
          sandboxAdapters: loaded.adapters,
          // The server waits to boot until the test has seen it starting.
          beforeSandboxLaunch: () =>
            Deferred.succeed(launching, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as(Option.none()),
            ),
        });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const { threadId, message } = yield* placeOnSandbox(hub, loaded, acme, owner);
        // Placed and made, never started.
        assert.equal(
          (yield* projectionOf(hub, threadId)).thread.activeEnvironmentId,
          sandboxEnvironmentIdOf(acme),
        );
        assert.equal((yield* sandboxRow(hub, acme))?.status, "stopped");

        const sent = yield* dispatchAs(hub, owner, message).pipe(Effect.forkScoped);
        yield* Deferred.await(launching);
        assert.equal((yield* sandboxRow(hub, acme))?.status, "starting");
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(sent);
        assert.equal((yield* sandboxRow(hub, acme))?.status, "online");
        assert.equal(yield* awaitRunSettled(hub, threadId, 1), "completed");
        assert.deepEqual(
          (yield* auditedStarts(hub)).map((entry) => entry.action),
          ["sandbox.start"],
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "a start that fails refuses the message with why, shows failed, and «Try again» starts it",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const launches = yield* Ref.make(0);
        const retrying = yield* Deferred.make<void>();
        const hub = yield* makeHub({
          sandboxAdapters: loaded.adapters,
          // Its first server ends before it connects, as one killed while it boots.
          beforeSandboxLaunch: () =>
            Ref.getAndUpdate(launches, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 0
                  ? Effect.succeedSome(137)
                  : Deferred.succeed(retrying, undefined).pipe(Effect.as(Option.none())),
              ),
            ),
        });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const { threadId, message } = yield* placeOnSandbox(hub, loaded, acme, owner);

        const refused = yield* dispatchAs(hub, owner, {
          ...message,
          commandId: CommandId.make(`${message.commandId}:first`),
        }).pipe(Effect.flip);
        const why = EnvironmentRegistry.environmentRefusalMessage(refused);
        assert.include(why ?? "", "could not start");
        assert.include(why ?? "", "exit code 137");
        const failed = yield* sandboxRow(hub, acme);
        assert.equal(failed?.status, "failed");
        assert.include(failed?.startError ?? "", "exit code 137");
        // Work waiting for it does not start it again by itself: a User tries again.
        assert.equal(yield* Ref.get(launches), 1);

        const retried = yield* hub.server.request("/api/environments/start", {
          cookie: hub.owner,
          body: { environmentId: sandboxEnvironmentIdOf(acme) },
        });
        assert.equal(retried.status, 200);
        yield* Deferred.await(retrying);
        // Once the start it began ends, the Sandbox runs.
        yield* hub
          .service(Sandboxes.Sandboxes)
          .ensureRunning({ spaceId: acme, actorUserId: undefined })
          .pipe(Effect.orDie);
        assert.equal((yield* sandboxRow(hub, acme))?.status, "online");
        yield* dispatchAs(hub, owner, message);
        assert.equal(yield* awaitRunSettled(hub, threadId, 1), "completed");
        const starts = yield* auditedStarts(hub);
        // Both starts are recorded, the failed one with its reason.
        const details = starts.map((entry) => JSON.parse(entry.detail ?? "{}"));
        assert.deepEqual(
          details.map((detail) => [detail.via, detail.outcome]),
          [
            ["demand", "failed"],
            ["retry", "started"],
          ],
        );
        assert.include(details[0]?.reason ?? "", "exit code 137");
        const actors = yield* hub.server.sql<{ readonly actor: string | null }>`
          SELECT actor_user_id AS actor FROM audit_log WHERE action = 'sandbox.start'
        `;
        // The User whose message or «Try again» started it is the one named.
        assert.deepEqual(
          actors.map((row) => row.actor),
          [owner, owner],
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "stops after the idle timeout with nothing running or held, on the test clock, and starts again for the next message",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const once = yield* replayingOnce(loaded.adapters);
        const clock = yield* TestClock.make();
        const hub = yield* makeHub({
          sandboxAdapters: once.layer,
          sandboxLifecycle: { clock },
        });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const sandboxId = sandboxEnvironmentIdOf(acme);
        const { threadId, message } = yield* placeOnSandbox(hub, loaded, acme, owner);
        yield* dispatchAs(hub, owner, message);
        assert.equal(yield* awaitRunSettled(hub, threadId, 1), "completed");
        const sandboxes = hub.service(Sandboxes.Sandboxes);
        const demand = hub.service(EnvironmentDemand.EnvironmentDemand);

        // 30 minutes by default: not yet.
        yield* clock.adjust("29 minutes");
        yield* sandboxes.stopIdle;
        assert.equal((yield* sandboxRow(hub, acme))?.status, "online");
        // An open terminal or a preview served through the Hub holds it however long it lasts.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* demand.hold(sandboxId);
            yield* clock.adjust("2 hours");
            yield* sandboxes.stopIdle;
            assert.equal((yield* sandboxRow(hub, acme))?.status, "online");
          }),
        );
        // A touch (a file read, a preview request) counts as use too.
        yield* clock.adjust("20 minutes");
        yield* demand.touch(sandboxId);
        yield* clock.adjust("20 minutes");
        yield* sandboxes.stopIdle;
        assert.equal((yield* sandboxRow(hub, acme))?.status, "online");
        yield* clock.adjust("11 minutes");
        yield* sandboxes.stopIdle;
        assert.equal((yield* sandboxRow(hub, acme))?.status, "stopped");
        const audited = yield* auditedStarts(hub);
        assert.deepEqual(
          audited.map((entry) => [entry.action, JSON.parse(entry.detail ?? "{}").via]),
          [
            ["sandbox.start", "demand"],
            ["sandbox.stop", "idle"],
          ],
        );

        // The next message starts it again and its turn runs there.
        yield* dispatchAs(hub, owner, {
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:after-idle"),
          threadId,
          messageId: MessageId.make("message:after-idle"),
          text: "Again",
          attachments: [],
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
        } as never);
        assert.equal((yield* sandboxRow(hub, acme))?.status, "online");
        yield* Deferred.await(once.reopened);
      }).pipe(Effect.scoped),
  );

  it.live(
    "a Sandbox that dies mid-turn pauses it like an offline machine, starts again, and the turn ends interrupted",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hold = yield* holdingEvents(loaded.adapters, 2);
        const launches = yield* Ref.make(0);
        const relaunching = yield* Deferred.make<void>();
        const relaunch = yield* Deferred.make<void>();
        const hub = yield* makeHub({
          sandboxAdapters: hold.layer,
          // Its second boot waits, so the test sees the turn paused while it is away.
          beforeSandboxLaunch: () =>
            Ref.getAndUpdate(launches, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 0
                  ? Effect.void
                  : Deferred.succeed(relaunching, undefined).pipe(
                      Effect.andThen(Deferred.await(relaunch)),
                    ),
              ),
              Effect.as(Option.none()),
            ),
        });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const { threadId, message } = yield* placeOnSandbox(hub, loaded, acme, owner);
        yield* dispatchAs(hub, owner, message);
        yield* Deferred.await(hold.reached);

        // Its container dies with the turn under way: the Hub starts it again by itself.
        yield* hub.crashSandbox(acme);
        yield* Deferred.await(relaunching);
        assert.equal((yield* sandboxRow(hub, acme))?.status, "starting");
        assert.equal((yield* projectionOf(hub, threadId)).runs.at(-1)?.status, "running");
        yield* Deferred.succeed(relaunch, undefined);
        // Back without its agent: the turn ends interrupted, its history kept.
        assert.equal(yield* awaitRunSettled(hub, threadId, 1), "interrupted");
        assert.equal((yield* sandboxRow(hub, acme))?.status, "online");
        assert.equal(
          (yield* projectionOf(hub, threadId)).thread.activeEnvironmentId,
          sandboxEnvironmentIdOf(acme) as EnvironmentId,
        );
        assert.equal(yield* Ref.get(launches), 2);
      }).pipe(Effect.scoped),
  );
});

/** The Sandbox's row once its server's exit was handled, which the Hub does in its own fiber. */
const awaitStatus = (hub: Hub, spaceId: SpaceId, status: string) =>
  sandboxRow(hub, spaceId).pipe(
    Effect.filterOrFail((row) => row?.status === status),
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- the Hub records a crash in its own fiber, with no event to await
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }),
    Effect.orDie,
  );

describe("Hub con Environments: a Sandbox's start belongs to the Hub, not to whoever asked", () => {
  it.live("a caller that gives up mid-start leaves it starting to the end, never stuck", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const launching = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const hub = yield* makeHub({
        sandboxAdapters: idleAdapters,
        beforeSandboxLaunch: () =>
          Deferred.succeed(launching, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as(Option.none()),
          ),
      });
      const owner = yield* ownerIdOf(hub);
      const acme = yield* createOrganization(hub, "Acme");
      yield* placeOnSandbox(hub, loaded, acme, owner);
      const demand = hub.service(EnvironmentDemand.EnvironmentDemand);
      const caller = yield* demand
        .awaitStarted(sandboxEnvironmentIdOf(acme), { actorUserId: owner, explicit: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(launching);
      // The User closes the tab: their request ends, the Sandbox's start does not.
      yield* Fiber.interrupt(caller);
      yield* Deferred.succeed(gate, undefined);
      // Joining the Hub's start returns once it ended; it ended running.
      yield* hub
        .service(Sandboxes.Sandboxes)
        .ensureRunning({ spaceId: acme, actorUserId: owner })
        .pipe(Effect.orDie);
      assert.equal((yield* sandboxRow(hub, acme))?.status, "online");
      const launched = yield* hub.server.sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM audit_log WHERE action = 'sandbox.start'
      `;
      assert.equal(launched[0]?.count, 1);
    }).pipe(Effect.scoped),
  );

  it.live("a start that times out stops the server it launched before it counts as failed", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const launchedPid = yield* Deferred.make<number>();
      // A server that runs and never connects.
      const silent = ProcessSandboxRuntime.childProcessLauncher({
        command: "bash",
        args: ["-c", "exec sleep 600", "silent-sandbox"],
      });
      const hub = yield* makeHub({
        sandboxLauncher: (launch) =>
          silent(launch).pipe(
            Effect.tap((launched) =>
              launched.pid === null ? Effect.void : Deferred.succeed(launchedPid, launched.pid),
            ),
          ),
        sandboxLifecycle: { startTimeout: "2 seconds" },
      });
      const owner = yield* ownerIdOf(hub);
      const acme = yield* createOrganization(hub, "Acme");
      yield* placeOnSandbox(hub, loaded, acme, owner);
      const failed = yield* hub
        .service(Sandboxes.Sandboxes)
        .ensureRunning({ spaceId: acme, actorUserId: owner })
        .pipe(Effect.flip);
      assert.include(failed.message, "in time");
      const pid = yield* Deferred.await(launchedPid);
      const alive = (() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
      assert.isFalse(alive, `the server ${pid} still runs`);
      assert.equal((yield* sandboxRow(hub, acme))?.status, "failed");
    }).pipe(Effect.scoped),
  );

  it.live(
    "every exit counts toward the crash limit, and a failed Sandbox waits for a User to start it",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hub = yield* makeHub({ sandboxAdapters: loaded.adapters });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        yield* placeOnSandbox(hub, loaded, acme, owner);
        const sandboxes = hub.service(Sandboxes.Sandboxes);
        // Nothing runs on it, and it keeps exiting each time someone starts it.
        for (let round = 1; round <= 3; round += 1) {
          yield* sandboxes.ensureRunning({ spaceId: acme, actorUserId: owner, via: "retry" });
          yield* hub.crashSandbox(acme);
          yield* awaitStatus(hub, acme, "stopped");
        }
        yield* sandboxes.ensureRunning({ spaceId: acme, actorUserId: owner, via: "retry" });
        yield* hub.crashSandbox(acme);
        const failed = yield* awaitStatus(hub, acme, "failed");
        assert.include(failed?.startError ?? "", "kept exiting");
        // Work waiting on it does not start it again: only a User does.
        yield* hub
          .service(EnvironmentDemand.EnvironmentDemand)
          .request([sandboxEnvironmentIdOf(acme)]);
        assert.equal((yield* sandboxRow(hub, acme))?.status, "failed");
      }).pipe(Effect.scoped),
  );

  it.live("reading its files does not start a stopped Sandbox nor count as use; writing does", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const launches = yield* Ref.make(0);
      const hub = yield* makeHub({
        sandboxAdapters: idleAdapters,
        beforeSandboxLaunch: () =>
          Ref.update(launches, (count) => count + 1).pipe(Effect.as(Option.none())),
      });
      const owner = yield* ownerIdOf(hub);
      const acme = yield* createOrganization(hub, "Acme");
      const { threadId } = yield* placeOnSandbox(hub, loaded, acme, owner);
      const workspace = yield* ThreadWorkspace.make.pipe(
        Effect.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
        Effect.provideContext(hub.server.services as never),
      ) as Effect.Effect<ThreadWorkspace.ThreadWorkspace["Service"]>;
      const listed = yield* workspace
        .listEntries({ cwd: "/anywhere", threadId }, { userId: owner })
        .pipe(Effect.flip);
      assert.include(listed.message, "Sandbox stopped");
      assert.equal(yield* Ref.get(launches), 0);
      // Writing a file is the User acting: it starts the Sandbox and waits for it.
      yield* workspace
        .writeFile({ cwd: "/anywhere", relativePath: "x.txt", contents: "x", threadId }, {
          userId: owner,
        } as never)
        .pipe(Effect.ignore);
      assert.equal(yield* Ref.get(launches), 1);
      assert.equal((yield* sandboxRow(hub, acme))?.status, "online");
    }).pipe(Effect.scoped),
  );

  it.live("a guest's message does not start the Sandbox", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const launches = yield* Ref.make(0);
      const hub = yield* makeHub({
        sandboxAdapters: idleAdapters,
        beforeSandboxLaunch: () =>
          Ref.update(launches, (count) => count + 1).pipe(Effect.as(Option.none())),
      });
      const owner = yield* ownerIdOf(hub);
      const acme = yield* createOrganization(hub, "Acme");
      const { threadId } = yield* placeOnSandbox(hub, loaded, acme, owner);
      yield* dispatchAs(hub, owner, {
        type: "thread.guest-message.submit",
        commandId: CommandId.make("command:guest-message"),
        threadId,
        shareId: "guest-share:none",
        guestMessageId: "guest-message:1",
        text: "Hello from a guest",
      } as never).pipe(Effect.ignore);
      assert.equal(yield* Ref.get(launches), 0);
      assert.equal((yield* sandboxRow(hub, acme))?.status, "stopped");
    }).pipe(Effect.scoped),
  );

  it.live("work that arrives while an idle stop is under way starts it again after the stop", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const clock = yield* TestClock.make();
      const stopping = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const hub = yield* makeHub({
        sandboxAdapters: idleAdapters,
        sandboxLifecycle: { clock },
        beforeSandboxStop: () =>
          Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Deferred.await(release))),
      });
      const owner = yield* ownerIdOf(hub);
      const acme = yield* createOrganization(hub, "Acme");
      yield* placeOnSandbox(hub, loaded, acme, owner);
      const sandboxes = hub.service(Sandboxes.Sandboxes);
      yield* sandboxes.ensureRunning({ spaceId: acme, actorUserId: owner });
      yield* clock.adjust("31 minutes");
      const stop = yield* sandboxes.stopIdle.pipe(Effect.forkScoped);
      yield* Deferred.await(stopping);
      // A message lands half-way through the stop.
      const work = yield* hub
        .service(EnvironmentDemand.EnvironmentDemand)
        .awaitStarted(sandboxEnvironmentIdOf(acme), { actorUserId: owner, explicit: true })
        .pipe(Effect.forkScoped);
      // It either waits for the stop (as it must) or, wrongly, is done before the stop ends.
      yield* Fiber.await(work).pipe(Effect.timeoutOption("500 millis"));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stop);
      yield* Fiber.join(work);
      // The work found it running: it was started again once the stop ended.
      assert.equal((yield* sandboxRow(hub, acme))?.status, "online");
    }).pipe(Effect.scoped),
  );
});

describe("Hub con Environments: a Sandbox that fills its disk", () => {
  it.live(
    "stops with its turn interrupted for that reason, failed in one write, and waiting work does not start it again",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hold = yield* holdingEvents(loaded.adapters, 2);
        const launches = yield* Ref.make(0);
        const hub = yield* makeHub({
          sandboxAdapters: hold.layer,
          sandboxLifecycle: { diskCheckEvery: "1 hour" },
          beforeSandboxLaunch: () =>
            Ref.update(launches, (count) => count + 1).pipe(Effect.as(Option.none())),
        });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const { threadId, message } = yield* placeOnSandbox(hub, loaded, acme, owner);
        yield* dispatchAs(hub, owner, message);
        yield* Deferred.await(hold.reached);

        // Its agent writes past the limit while the turn runs.
        NodeFS.writeFileSync(
          NodePath.join(hub.sandboxRoot, `sandbox-${acme}`, "big.bin"),
          Buffer.alloc(2 * 1024 * 1024),
        );
        yield* hub.server.sql`
          UPDATE sandboxes SET disk_limit_bytes = ${1024 * 1024} WHERE space_id = ${acme}
        `;
        // Every status the row passes through while the check stops it.
        const statuses: Array<string> = [];
        const watch = yield* hub.server.sql<{ readonly status: string }>`
          SELECT status FROM sandboxes WHERE space_id = ${acme}
        `.pipe(
          Effect.tap((rows) => Effect.sync(() => statuses.push(rows[0]?.status ?? ""))),
          Effect.andThen(Effect.yieldNow),
          Effect.forever,
          Effect.forkScoped,
        );
        yield* hub.service(Sandboxes.Sandboxes).checkDisk;
        yield* Fiber.interrupt(watch);
        // Never `stopped` on the way: waiting work would take that as free to start.
        assert.notInclude(statuses, "stopped");
        assert.equal((yield* sandboxRow(hub, acme))?.status, "failed");

        assert.equal(yield* awaitRunSettled(hub, threadId, 1), "interrupted");
        const interrupted = (yield* projectionOf(hub, threadId)).turnItems.find(
          (item) => item.type === "run_interrupt_result",
        );
        assert.include(
          interrupted?.type === "run_interrupt_result" ? interrupted.message : "",
          "disk",
        );
        // Work waiting for it does not start it: a User does, once there is room.
        yield* hub
          .service(EnvironmentDemand.EnvironmentDemand)
          .request([sandboxEnvironmentIdOf(acme)]);
        assert.equal((yield* sandboxRow(hub, acme))?.status, "failed");
        assert.equal(yield* Ref.get(launches), 1);
      }).pipe(Effect.scoped),
  );
});
