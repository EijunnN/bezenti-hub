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
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
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
  return { variant, materialized, adapters };
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
