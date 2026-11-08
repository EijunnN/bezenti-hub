/**
 * «Hub con Environments», spec 3 ticket 06: the Sandboxes' base image. The Owner builds it (the
 * build's output and outcome are followed and audited), each Sandbox records the version it
 * started with, a stopped one runs the newest at its next start, and a running one moves to it
 * only when the Owner asks and never mid-turn. Building it for real is SandboxImage.build.test.ts.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type ProviderReplayTranscript,
  sandboxEnvironmentIdOf,
  type SpaceId,
  type ThreadId,
  UserId,
  type OrchestrationV2Command,
  type SandboxImageStatus,
  type UpdateSandboxImageResult,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as EnvironmentDemand from "../environment/EnvironmentDemand.ts";
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
  findReplayFixture,
  readReplayFixtureTranscript,
} from "../orchestration-v2/testkit/ProviderReplayFixtures.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import type { SandboxImageFound } from "../sandboxes/PodmanSandboxRuntime.ts";
import * as SandboxImage from "../sandboxes/SandboxImage.ts";
import * as Sandboxes from "../sandboxes/Sandboxes.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
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
  return { variant, materialized, adapters, transcript };
});
type LoadedFixture = Effect.Success<ReturnType<typeof loadFixture>>;

/** The machine's agent stops reporting its turn after `afterEvents` events: the turn stays on. */
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

/** The machine's agent refuses to start any turn. */
const refusingTurns = (adapters: Adapters): Adapters =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (instanceId: Parameters<typeof registry.get>[0]) =>
        registry.get(instanceId).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            openSession: (open: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
              adapter.openSession(open).pipe(
                Effect.map((runtime) => ({
                  ...runtime,
                  startTurn: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                    Effect.fail(
                      new ProviderAdapter.ProviderAdapterTurnStartError({
                        driver: runtime.driver,
                        threadId: input.threadId,
                        providerThreadId: input.providerThread.id,
                        runId: input.runId,
                        cause: "refused by the test",
                      }),
                    ),
                })),
              ),
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

const ownerIdOf = Effect.fn(function* (hub: Hub) {
  const [row] = yield* hub.server.sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM users WHERE is_owner = 1
  `;
  assert.isDefined(row);
  return UserId.make(row.userId);
});

const createOrganization = Effect.fn(function* (hub: Hub, name: string) {
  const created = yield* hub
    .service(SpaceDirectory.SpaceDirectory)
    .createOrganization(yield* ownerIdOf(hub), name)
    .pipe(Effect.orDie);
  return created.id;
});

const dispatchAs = (hub: Hub, actor: UserId, command: OrchestrationV2Command) =>
  hub
    .service(ThreadManagementService.ThreadManagementService)
    .dispatch({ ...command, ownerUserId: actor } as never)
    .pipe(CommandActor.actAs(actor));

/** The fixture's Thread on the Space's Sandbox, and its first message sent: the turn runs there. */
const runTurnOnSandbox = Effect.fn(function* (hub: Hub, loaded: LoadedFixture, spaceId: SpaceId) {
  const owner = yield* ownerIdOf(hub);
  const [create, ...messages] = loaded.materialized.commands;
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
  yield* dispatchAs(hub, owner, message);
  return create.threadId;
});

/** The Thread's run `ordinal` once it settled. */
const awaitRunSettled = (hub: Hub, threadId: ThreadId, ordinal: number) =>
  Effect.gen(function* () {
    const settled = ["completed", "failed", "interrupted", "cancelled"];
    const orchestrator = hub.service(Orchestrator.OrchestratorV2);
    const afterSequence = yield* hub
      .service(EventSink.EventSinkV2)
      .latestSequence({ threadId })
      .pipe(Effect.orDie);
    const run = (yield* orchestrator.getThreadProjection(threadId).pipe(Effect.orDie)).runs.find(
      (candidate) => candidate.ordinal === ordinal,
    );
    if (run !== undefined && settled.includes(run.status)) return run.status;
    const next = yield* orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
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

interface Answer<A> {
  readonly status: number;
  readonly body: A & { readonly message?: string };
}
const answered = <A>(response: { readonly status: number; readonly body: unknown }) =>
  response as Answer<A>;

const buildEnded = (response: Answer<SandboxImageStatus>) =>
  response.body.build.state !== "building";

const imageStatus = (hub: Hub, cookie = hub.owner) =>
  hub.server
    .request("/api/sandboxes/image", { cookie })
    .pipe(Effect.map(answered<SandboxImageStatus>));

const requestBuild = (hub: Hub, cookie = hub.owner) =>
  hub.server
    .request("/api/sandboxes/image/build", { cookie, body: {} })
    .pipe(Effect.map(answered<SandboxImageStatus>));

const updateImage = (hub: Hub, spaceId: SpaceId, cookie = hub.owner) =>
  hub.server
    .request("/api/sandboxes/image/update", {
      cookie,
      body: { environmentId: sandboxEnvironmentIdOf(spaceId) },
    })
    .pipe(Effect.map(answered<UpdateSandboxImageResult>));

const sandboxImageRow = (body: SandboxImageStatus, spaceId: SpaceId) =>
  body.sandboxes.find((sandbox) => sandbox.spaceId === spaceId);

const auditedImageUpdates = (hub: Hub) =>
  hub.server.sql<{ readonly actor: string | null; readonly detail: string | null }>`
    SELECT actor_user_id AS actor, detail_json AS detail FROM audit_log
    WHERE action = 'sandbox.image.update' ORDER BY rowid
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({ actor: row.actor, ...JSON.parse(row.detail ?? "{}") })),
    ),
  );

/** Each Sandbox start the audit log recorded, by why it happened. */
const auditedStarts = (hub: Hub) =>
  hub.server.sql<{ readonly action: string; readonly detail: string | null }>`
    SELECT action, detail_json AS detail FROM audit_log
    WHERE action IN ('sandbox.start', 'sandbox.stop') ORDER BY rowid
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => `${row.action}:${JSON.parse(row.detail ?? "{}").via as string}`),
    ),
  );

describe("Hub con Environments: the Sandboxes' base image", () => {
  it.live(
    "each Sandbox records the image it started with, and a stopped one runs the newest at its next start",
    () =>
      Effect.gen(function* () {
        let newest = "0.1.7-20261101000000";
        const hub = yield* makeHub({ sandboxImageVersion: () => newest });
        const acme = yield* createOrganization(hub, "Acme");
        const sandboxes = hub.service(Sandboxes.Sandboxes);
        yield* sandboxes
          .ensureRunning({ spaceId: acme, actorUserId: undefined })
          .pipe(Effect.orDie);
        const first = yield* imageStatus(hub);
        assert.equal(first.status, 200);
        assert.equal(sandboxImageRow(first.body, acme)?.imageVersion, "0.1.7-20261101000000");

        yield* sandboxes.stop({ spaceId: acme, actor: { source: "system" } }).pipe(Effect.orDie);
        newest = "0.1.7-20261107000000";
        // Stopped: nothing to restart; its next start takes the new image by itself.
        const asked = yield* updateImage(hub, acme);
        assert.equal(asked.status, 200);
        assert.deepEqual(asked.body, {
          outcome: "next-start",
          imageVersion: "0.1.7-20261107000000",
        });
        assert.equal(
          sandboxImageRow((yield* imageStatus(hub)).body, acme)?.imageVersion,
          "0.1.7-20261101000000",
        );
        yield* sandboxes
          .ensureRunning({ spaceId: acme, actorUserId: undefined })
          .pipe(Effect.orDie);
        assert.equal(
          sandboxImageRow((yield* imageStatus(hub)).body, acme)?.imageVersion,
          "0.1.7-20261107000000",
        );
        // Asking was no update: only moving a running Sandbox is one.
        assert.lengthOf(yield* auditedImageUpdates(hub), 0);
      }).pipe(Effect.scoped),
  );

  it.live("a running Sandbox is never moved to a new image mid-turn: the Owner is told why", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const hold = yield* holdingEvents(loaded.adapters, 2);
      let newest = "0.1.7-20261101000000";
      const hub = yield* makeHub({
        sandboxAdapters: hold.layer,
        sandboxImageVersion: () => newest,
      });
      const acme = yield* createOrganization(hub, "Acme");
      const threadId = yield* runTurnOnSandbox(hub, loaded, acme);
      yield* Deferred.await(hold.reached);
      newest = "0.1.7-20261107000000";

      const refused = yield* updateImage(hub, acme);
      assert.equal(refused.status, 409);
      assert.include(refused.body.message ?? "", "A turn is in progress on it (1 Thread)");
      const status = sandboxImageRow((yield* imageStatus(hub)).body, acme);
      assert.equal(status?.imageVersion, "0.1.7-20261101000000");
      assert.isTrue(status?.busy);
      // Untouched: still on its old image, its turn still running.
      const listed = yield* listEnvironments(hub.server, hub.owner);
      assert.equal(
        listed.find((entry) => entry.id === sandboxEnvironmentIdOf(acme))?.status,
        "online",
      );
      const run = (yield* hub
        .service(Orchestrator.OrchestratorV2)
        .getThreadProjection(threadId)
        .pipe(Effect.orDie)).runs.at(-1);
      assert.equal(run?.status, "running");
      assert.deepEqual(yield* auditedStarts(hub), ["sandbox.start:demand"]);
      assert.lengthOf(yield* auditedImageUpdates(hub), 0);
    }).pipe(Effect.scoped),
  );

  it.live(
    "once its turn ended, the Owner's request starts it again on the newest image, audited",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        let newest = "0.1.7-20261101000000";
        const hub = yield* makeHub({
          sandboxAdapters: loaded.adapters,
          sandboxImageVersion: () => newest,
        });
        const acme = yield* createOrganization(hub, "Acme");
        const threadId = yield* runTurnOnSandbox(hub, loaded, acme);
        assert.equal(yield* awaitRunSettled(hub, threadId, 1), "completed");

        // Still on the newest image: there is nothing to move.
        const current = yield* updateImage(hub, acme);
        assert.equal(current.status, 200);
        assert.equal(current.body.outcome, "up-to-date");

        newest = "0.1.7-20261107000000";
        const updated = yield* updateImage(hub, acme);
        assert.equal(updated.status, 200);
        assert.deepEqual(updated.body, {
          outcome: "updated",
          imageVersion: "0.1.7-20261107000000",
        });
        const status = sandboxImageRow((yield* imageStatus(hub)).body, acme);
        assert.equal(status?.imageVersion, "0.1.7-20261107000000");
        const listed = yield* listEnvironments(hub.server, hub.owner);
        assert.equal(
          listed.find((entry) => entry.id === sandboxEnvironmentIdOf(acme))?.status,
          "online",
        );
        assert.deepEqual(yield* auditedStarts(hub), [
          "sandbox.start:demand",
          "sandbox.stop:update",
          "sandbox.start:update",
        ]);
        assert.deepEqual(yield* auditedImageUpdates(hub), [
          {
            actor: yield* ownerIdOf(hub),
            via: "restart",
            outcome: "updated",
            from: "0.1.7-20261101000000",
            version: "0.1.7-20261107000000",
          },
        ]);
      }).pipe(Effect.scoped),
  );

  it.live("the Owner builds it once at a time, follows its output, and each build is audited", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const printed = yield* Deferred.make<void>();
      const builds = yield* Ref.make(0);
      let built: SandboxImageFound | null = null;
      const hub = yield* makeHub({
        sandboxImageBuilder: SandboxImage.SandboxImageBuilder.of({
          cannotBuildReason: Effect.succeed(null),
          inspect: Effect.fn(function* () {
            yield* Effect.void;
            return built;
          }),
          build: Effect.fn(function* (input) {
            const count = yield* Ref.updateAndGet(builds, (n) => n + 1);
            input.onLine("STEP 1/2: FROM debian");
            yield* Deferred.succeed(printed, undefined);
            yield* Deferred.await(release);
            input.onLine("STEP 2/2: COPY server/");
            if (count === 2) {
              return yield* new SandboxImage.SandboxImageBuildError({
                detail: "podman build exited with code 125.",
              });
            }
            built = { id: "abc", version: "0.1.7-20261107000000", createdAt: null };
            return built;
          }),
        }),
      });
      const started = yield* requestBuild(hub);
      assert.equal(started.status, 200);
      assert.equal(started.body.build.state, "building");
      assert.equal(started.body.image.version, null);
      // One at a time: a second request is refused while it runs.
      const again = yield* requestBuild(hub);
      assert.equal(again.status, 409);
      yield* Deferred.await(printed);
      const following = yield* imageStatus(hub);
      assert.deepEqual(following.body.build.log, ["STEP 1/2: FROM debian"]);
      assert.equal(following.body.build.logLines, 1);

      yield* Deferred.succeed(release, undefined);
      const done = yield* imageStatus(hub).pipe(
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- the build runs in the Hub's own fiber; its status is what clients poll
        Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: buildEnded }),
      );
      assert.equal(done.body.build.state, "succeeded");
      assert.equal(done.body.image.version, "0.1.7-20261107000000");
      assert.deepEqual(done.body.build.log, ["STEP 1/2: FROM debian", "STEP 2/2: COPY server/"]);
      // A client that has the first line asks only for what came after it.
      const since = answered<SandboxImageStatus>(
        yield* hub.server.request("/api/sandboxes/image?after=1", { cookie: hub.owner }),
      );
      assert.deepEqual(since.body.build.log, ["STEP 2/2: COPY server/"]);
      assert.equal(since.body.build.logLines, 2);

      // A failed build says why, and is recorded too.
      yield* requestBuild(hub);
      const failed = yield* imageStatus(hub).pipe(
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- the build runs in the Hub's own fiber; its status is what clients poll
        Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: buildEnded }),
      );
      assert.equal(failed.body.build.state, "failed");
      assert.equal(failed.body.build.error, "podman build exited with code 125.");
      assert.deepEqual(yield* auditedImageUpdates(hub), [
        {
          actor: yield* ownerIdOf(hub),
          via: "settings",
          outcome: "built",
          version: "0.1.7-20261107000000",
        },
        {
          actor: yield* ownerIdOf(hub),
          via: "settings",
          outcome: "failed",
          reason: "podman build exited with code 125.",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "refuses to move a running Sandbox when the newest image is missing, keeping it running",
    () =>
      Effect.gen(function* () {
        let newest: string | null = "0.1.7-20261101000000";
        const hub = yield* makeHub({ sandboxImageVersion: () => newest });
        const acme = yield* createOrganization(hub, "Acme");
        yield* hub
          .service(Sandboxes.Sandboxes)
          .ensureRunning({ spaceId: acme, actorUserId: undefined })
          .pipe(Effect.orDie);
        // The tag was removed (or never built): a restart would only fail to start.
        newest = null;
        const refused = yield* updateImage(hub, acme);
        assert.equal(refused.status, 409);
        assert.include(refused.body.message ?? "", "The newest image is missing");
        const listed = yield* listEnvironments(hub.server, hub.owner);
        assert.equal(
          listed.find((entry) => entry.id === sandboxEnvironmentIdOf(acme))?.status,
          "online",
        );
        assert.deepEqual(yield* auditedStarts(hub), ["sandbox.start:demand"]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "work sent to a Sandbox just before the update makes it refuse, before any run is recorded",
    () =>
      Effect.gen(function* () {
        let newest = "0.1.7-20261101000000";
        const hub = yield* makeHub({ sandboxImageVersion: () => newest });
        const acme = yield* createOrganization(hub, "Acme");
        yield* hub
          .service(Sandboxes.Sandboxes)
          .ensureRunning({ spaceId: acme, actorUserId: undefined })
          .pipe(Effect.orDie);
        newest = "0.1.7-20261107000000";
        // A message's dispatch claims the Sandbox (as `message.dispatch` does) before its run
        // exists, until the dispatch ends: here, the rest of the test.
        yield* hub.service(EnvironmentDemand.EnvironmentDemand).claim(sandboxEnvironmentIdOf(acme));
        // The Owner's view says so before the Owner asks.
        assert.isTrue(sandboxImageRow((yield* imageStatus(hub)).body, acme)?.busy);
        const refused = yield* updateImage(hub, acme);
        assert.equal(refused.status, 409);
        assert.include(refused.body.message ?? "", "Work was just sent to it");
        assert.deepEqual(yield* auditedStarts(hub), ["sandbox.start:demand"]);
      }).pipe(Effect.scoped),
  );

  it.live("a dispatch keeps its own claim: a turn other work started never takes it", () =>
    Effect.gen(function* () {
      let newest = "0.1.7-20261101000000";
      const hub = yield* makeHub({ sandboxImageVersion: () => newest });
      const acme = yield* createOrganization(hub, "Acme");
      yield* hub
        .service(Sandboxes.Sandboxes)
        .ensureRunning({ spaceId: acme, actorUserId: undefined })
        .pipe(Effect.orDie);
      newest = "0.1.7-20261107000000";
      const demand = hub.service(EnvironmentDemand.EnvironmentDemand);
      const environmentId = sandboxEnvironmentIdOf(acme);
      // A User's dispatch under way; meanwhile a turn an effect started reports in and ends.
      const dispatching = yield* Scope.make();
      yield* demand.claim(environmentId).pipe(Scope.provide(dispatching));
      yield* demand.turnStarted(environmentId, "effect-session:1");
      yield* demand.turnEnded(environmentId, "effect-session:1");
      const refused = yield* updateImage(hub, acme);
      assert.equal(refused.status, 409);
      assert.include(refused.body.message ?? "", "Work was just sent to it");
      // Its dispatch ended (its run is recorded): the claim still stands until its turn reports in.
      yield* Scope.close(dispatching, Exit.void);
      assert.equal((yield* updateImage(hub, acme)).status, 409);
      yield* demand.turnStarted(environmentId, "session-b:1");
      yield* demand.turnEnded(environmentId, "session-b:1");
      const updated = yield* updateImage(hub, acme);
      assert.equal(updated.status, 200);
      assert.equal(updated.body.outcome, "updated");
    }).pipe(Effect.scoped),
  );

  it.live("a preview or a terminal reaching a Sandbox claims nothing: it can be updated", () =>
    Effect.gen(function* () {
      let newest = "0.1.7-20261101000000";
      const hub = yield* makeHub({ sandboxImageVersion: () => newest });
      const acme = yield* createOrganization(hub, "Acme");
      yield* hub
        .service(Sandboxes.Sandboxes)
        .ensureRunning({ spaceId: acme, actorUserId: undefined })
        .pipe(Effect.orDie);
      newest = "0.1.7-20261107000000";
      // As HubPreviews and ThreadWorkspace ask: a User's own action, but no work dispatched.
      yield* hub
        .service(EnvironmentDemand.EnvironmentDemand)
        .awaitStarted(sandboxEnvironmentIdOf(acme), {
          actorUserId: yield* ownerIdOf(hub),
          explicit: true,
        })
        .pipe(Effect.orDie);
      assert.isFalse(sandboxImageRow((yield* imageStatus(hub)).body, acme)?.busy);
      const updated = yield* updateImage(hub, acme);
      assert.equal(updated.status, 200);
      assert.equal(updated.body.outcome, "updated");
    }).pipe(Effect.scoped),
  );

  it.live("a turn that failed to start leaves the Sandbox free to update", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      let newest = "0.1.7-20261101000000";
      const hub = yield* makeHub({
        // Its replay is never played (no turn starts), so it is not asserted complete.
        sandboxAdapters: refusingTurns(
          makeClaudeRestartReplayHarness(loaded.transcript)
            .harness.makeProviderAdapterRegistryLayer(loaded.transcript)
            .pipe(Layer.orDie),
        ),
        sandboxImageVersion: () => newest,
      });
      const acme = yield* createOrganization(hub, "Acme");
      const threadId = yield* runTurnOnSandbox(hub, loaded, acme);
      assert.notEqual(yield* awaitRunSettled(hub, threadId, 1), "completed");
      newest = "0.1.7-20261107000000";
      assert.isFalse(sandboxImageRow((yield* imageStatus(hub)).body, acme)?.busy);
      const updated = yield* updateImage(hub, acme);
      assert.equal(updated.status, 200);
      assert.equal(updated.body.outcome, "updated");
    }).pipe(Effect.scoped),
  );

  // Asked again once its answer is a few seconds old: SandboxImage.test.ts.
  it.live("a Hub that cannot build the image says why", () =>
    Effect.gen(function* () {
      const reason = "Rootless Podman is not available on the Hub.";
      const hub = yield* makeHub({
        sandboxImageBuilder: SandboxImage.SandboxImageBuilder.of({
          // `podman info` timed out, or Podman was set up after the Hub started.
          cannotBuildReason: Effect.sync(() => reason),
          inspect: Effect.fn(function* () {
            yield* Effect.void;
            return null;
          }),
          build: Effect.fn(function* () {
            yield* Effect.void;
            return { id: "abc", version: "0.1.7-20261107000000", createdAt: null };
          }),
        }),
      });
      const before = yield* imageStatus(hub);
      assert.isFalse(before.body.canBuild);
      assert.equal(before.body.cannotBuildReason, "Rootless Podman is not available on the Hub.");
    }).pipe(Effect.scoped),
  );

  it.live("two builds asked at once: one runs, the other is refused", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const builds = yield* Ref.make(0);
      const hub = yield* makeHub({
        sandboxImageBuilder: SandboxImage.SandboxImageBuilder.of({
          cannotBuildReason: Effect.succeed(null),
          inspect: Effect.fn(function* () {
            yield* Effect.void;
            return null;
          }),
          build: Effect.fn(function* () {
            yield* Ref.update(builds, (n) => n + 1);
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return { id: "abc", version: "0.1.7-20261107000000", createdAt: null };
          }),
        }),
      });
      const answers = yield* Effect.all([requestBuild(hub), requestBuild(hub)], {
        concurrency: "unbounded",
      });
      assert.sameMembers(
        answers.map((answer) => answer.status),
        [200, 409],
      );
      // The refused one answered 409 before either returned: only the running one ever builds.
      yield* Deferred.await(started);
      assert.equal(yield* Ref.get(builds), 1);
      assert.equal((yield* requestBuild(hub)).status, 409);
      yield* Deferred.succeed(release, undefined);
    }).pipe(Effect.scoped),
  );

  it.live("nobody but the Owner sees, builds or moves it", () =>
    Effect.gen(function* () {
      const builds = yield* Ref.make(0);
      const hub = yield* makeHub({
        sandboxImageVersion: () => "0.1.7-20261101000000",
        sandboxImageBuilder: SandboxImage.SandboxImageBuilder.of({
          cannotBuildReason: Effect.succeed(null),
          inspect: Effect.fn(function* () {
            yield* Effect.void;
            return null;
          }),
          build: Effect.fn(function* () {
            yield* Ref.update(builds, (n) => n + 1);
            return { id: "abc", version: "x", createdAt: null };
          }),
        }),
      });
      const acme = yield* createOrganization(hub, "Acme");
      yield* hub
        .service(Sandboxes.Sandboxes)
        .ensureRunning({ spaceId: acme, actorUserId: undefined })
        .pipe(Effect.orDie);
      const member = yield* addMember(hub.server, { id: "member-1", displayName: "Grace Hopper" });
      // Even an Admin of the Sandbox's own Organization.
      yield* joinOrganization(hub.server, acme, "member-1", "admin");
      for (const response of [
        yield* imageStatus(hub, member),
        yield* requestBuild(hub, member),
        yield* updateImage(hub, acme, member),
      ]) {
        assert.equal(response.status, 403);
        assert.equal(response.body.message, "Only the Owner manages the Sandbox image.");
      }
      assert.equal(yield* Ref.get(builds), 0);
      assert.lengthOf(yield* auditedImageUpdates(hub), 0);
    }).pipe(Effect.scoped),
  );
});
