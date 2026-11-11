// @effect-diagnostics nodeBuiltinImport:off -- holds a git request open over a raw socket.
/**
 * «Hub con Environments», spec 3 ticket 12: a Project moving to another Space stops its Threads,
 * releases those its machine does not serve, and the old Space's machines lose it at once.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type OrchestrationV2Command,
  ProjectId,
  type ProjectMovePlan,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderReplayTranscript,
  sandboxEnvironmentIdOf,
  type SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import { ClaudeOrchestratorReplayHarness } from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
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
import * as Sandboxes from "../sandboxes/Sandboxes.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { memberWithPasskey } from "./environments.testkit.ts";
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

/** Starts the Space's Sandbox and waits for it, as the Thread's first work does. */
const startSandbox = (hub: Hub, spaceId: SpaceId) =>
  hub
    .service(Sandboxes.Sandboxes)
    .ensureRunning({ spaceId, actorUserId: undefined })
    .pipe(Effect.orDie);

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
  return { threadId: create.threadId, projectId: create.projectId, message };
});

interface Answer<A> {
  readonly status: number;
  readonly body: A & { readonly message?: string; readonly _tag?: string };
}

const movePlan = (hub: Hub, projectId: ProjectId, spaceId: SpaceId, cookie = hub.owner) =>
  hub.server
    .request("/api/projects/move-plan", { cookie, body: { projectId, spaceId } })
    .pipe(Effect.map((response) => response as unknown as Answer<ProjectMovePlan>));

let moves = 0;
const moveProject = (
  hub: Hub,
  projectId: ProjectId,
  spaceId: SpaceId,
  options: { readonly cookie?: string; readonly stopThreads?: boolean } = {},
) =>
  hub.server
    .request("/api/projects/mutate", {
      cookie: options.cookie ?? hub.owner,
      body: {
        type: "project.move",
        commandId: `move:${projectId}:${spaceId}:${(moves += 1)}`,
        projectId,
        spaceId,
        ...(options.stopThreads === undefined ? {} : { stopThreads: options.stopThreads }),
      },
    })
    .pipe(
      Effect.map((response) => response as unknown as Answer<{ readonly spaceId: string | null }>),
    );

/** What a machine's credential gets when it asks for the Project's repository. */
const repositoryStatus = (hub: Hub, projectId: ProjectId, credential: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.execute(
        HttpClientRequest.get(
          `${HubRepository.hubRepositoryUrl(hub.server.url, { projectId })}/info/refs?service=git-upload-pack`,
        ).pipe(HttpClientRequest.bearerToken(credential)),
      ),
    ),
    Effect.map((response) => response.status),
    Effect.provide(FetchHttpClient.layer),
    Effect.orDie,
  );

const threadOf = (hub: Hub, threadId: ThreadId) =>
  hub.service(Orchestrator.OrchestratorV2).getThreadProjection(threadId).pipe(Effect.orDie);

/** The Thread once `done` holds, re-read after each of its events. */
const awaitThread = Effect.fn(function* (
  hub: Hub,
  threadId: ThreadId,
  done: (projection: Effect.Success<ReturnType<typeof threadOf>>) => boolean,
) {
  const afterSequence = yield* hub
    .service(EventSink.EventSinkV2)
    .latestSequence({ threadId })
    .pipe(Effect.orDie);
  const now = yield* threadOf(hub, threadId);
  if (done(now)) return now;
  const reached = yield* hub
    .service(Orchestrator.OrchestratorV2)
    .streamStoredEventsFrom({ threadId, afterSequence })
    .pipe(
      Stream.mapEffect(() => threadOf(hub, threadId)),
      Stream.filter(done),
      Stream.runHead,
      Effect.orDie,
    );
  return Option.getOrThrow(reached);
});

const RUNNING = new Set(["preparing", "starting", "running", "waiting"]);

describe("Hub con Environments: a Project moves to another Space", () => {
  it.live(
    "its running Thread stops and needs an environment, the old Sandbox loses the Project, and one move puts it on the new Sandbox",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const held = yield* holdingEvents(loaded.adapters, 2);
        const hub = yield* makeHub({ sandboxAdapters: held.layer });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const { threadId, projectId, message } = yield* runTurnOnSandbox(hub, loaded, acme);
        yield* Deferred.await(held.reached);
        const acmeSandbox = yield* hub.sandboxOf(acme);
        assert.equal(yield* repositoryStatus(hub, projectId, acmeSandbox.credential), 200);
        // The agent there reaches the Hub's MCP with a credential issued for the Thread.
        assert.isTrue(acmeSandbox.mcpConfigs.some((config) => config.threadId === threadId));
        const requestsBefore = acmeSandbox.requests.length;

        // Before confirming, the mover sees what the move does to its Threads.
        const plan = yield* movePlan(hub, projectId, globex);
        assert.equal(plan.status, 200, JSON.stringify(plan.body));
        const entry = {
          threadId,
          title: plan.body.running[0]?.title ?? "",
          environmentId: sandboxEnvironmentIdOf(acme),
        };
        assert.deepEqual(plan.body.running, [entry]);
        assert.deepEqual(plan.body.needsEnvironment, [entry]);
        // Not confirmed: a running Thread refuses it, and nothing moved.
        const refused = yield* moveProject(hub, projectId, globex);
        assert.equal(refused.status, 409, JSON.stringify(refused.body));
        assert.equal(
          (yield* threadOf(hub, threadId)).thread.activeEnvironmentId,
          sandboxEnvironmentIdOf(acme),
        );

        const moved = yield* moveProject(hub, projectId, globex, { stopThreads: true });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        assert.equal(moved.body.spaceId, globex);
        const after = yield* threadOf(hub, threadId);
        assert.equal(after.thread.spaceId, globex);
        // «Needs an environment»: its machine does not serve Globex.
        assert.isNull(after.thread.activeEnvironmentId);
        assert.isFalse(after.runs.some((run) => RUNNING.has(run.status)));
        // Acme's Sandbox reaches nothing of it any more: its repository, its MCP credential.
        assert.equal(yield* repositoryStatus(hub, projectId, acmeSandbox.credential), 403);
        // Its session there is let go (with its MCP credential), on the machine itself.
        yield* acmeSandbox
          .awaitRequest("provider.detach", requestsBefore)
          .pipe(Effect.timeout(Duration.seconds(30)), Effect.orDie);
        // Nor does it take new work there.
        const refusedMessage = yield* dispatchAs(hub, owner, {
          ...message,
          commandId: CommandId.make("message:after-move"),
        }).pipe(Effect.flip);
        assert.include(JSON.stringify(refusedMessage), "needs an environment");

        // One move puts it on Globex's Sandbox (spec 2's move), which gets the repository.
        yield* dispatchAs(hub, owner, {
          type: "thread.move",
          commandId: CommandId.make("move:to-globex"),
          threadId,
          targetEnvironmentId: sandboxEnvironmentIdOf(globex),
          ifRunning: "stop",
        });
        const landed = yield* awaitThread(
          hub,
          threadId,
          (projection) =>
            projection.thread.move?.status !== "running" &&
            projection.thread.activeEnvironmentId === sandboxEnvironmentIdOf(globex),
        );
        assert.equal(landed.thread.move?.status, "switched");
        const globexSandbox = yield* hub.sandboxOf(globex);
        assert.equal(yield* repositoryStatus(hub, projectId, globexSandbox.credential), 200);
        assert.equal(yield* repositoryStatus(hub, projectId, acmeSandbox.credential), 403);
      }).pipe(Effect.scoped),
  );

  it.live(
    "only the Threads whose machine does not serve the new Space need one; moving back and an empty Project work",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const grace = UserId.make("member-grace");
        const linus = UserId.make("member-linus");
        yield* addMember(hub.server, { id: grace, displayName: "Grace" });
        yield* addMember(hub.server, { id: linus, displayName: "Linus" });
        yield* joinOrganization(hub.server, acme, grace, "member");
        yield* joinOrganization(hub.server, globex, grace, "member");
        yield* joinOrganization(hub.server, acme, linus, "member");
        // Linus is only a Guest of Globex: he starts no work there.
        yield* joinOrganization(hub.server, globex, linus, "guest");
        yield* hub.service(SpaceDirectory.SpaceDirectory).changed;
        const at = "2026-01-01T00:00:00.000Z";
        const machine = (
          id: string,
          mode: string,
          ownerUserId: string | null,
          spaceId: string | null,
        ) =>
          hub.server.sql`
            INSERT INTO environments (
              environment_id, name, kind, mode, owner_user_id, space_id, credential_hash,
              credential_issued_at, registered_at
            ) VALUES (${id}, ${id}, 'external', ${mode}, ${ownerUserId}, ${spaceId},
              ${`hash-${id}`}, ${at}, ${at})
          `;
        yield* machine("env-grace", "personal", grace, null);
        yield* machine("env-linus", "personal", linus, null);
        yield* machine("env-acme-vps", "dedicated", null, acme);
        const projectId = ProjectId.make("project:acme-web");
        yield* seedProject(hub.server, {
          projectId,
          title: "Acme web",
          defaultModelSelection: null,
          spaceId: acme,
        });
        yield* hub.server.sql`
          UPDATE projection_projects SET preferred_environment_id = ${sandboxEnvironmentIdOf(acme)}
          WHERE project_id = ${projectId}
        `;
        const threads: Record<string, EnvironmentId | undefined> = {
          hub: undefined,
          sandbox: sandboxEnvironmentIdOf(acme),
          grace: "env-grace" as EnvironmentId,
          linus: "env-linus" as EnvironmentId,
          dedicated: "env-acme-vps" as EnvironmentId,
        };
        const orchestrator = hub.service(Orchestrator.OrchestratorV2);
        for (const [name, environmentId] of Object.entries(threads)) {
          yield* orchestrator
            .dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`create:${name}`),
              threadId: ThreadId.make(`thread:${name}`),
              projectId,
              spaceId: acme,
              title: name,
              modelSelection: { instanceId, model: "claude-sonnet-4-6" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              ...(environmentId === undefined ? {} : { activeEnvironmentId: environmentId }),
            })
            .pipe(Effect.orDie);
        }
        const plan = yield* movePlan(hub, projectId, globex);
        assert.equal(plan.status, 200, JSON.stringify(plan.body));
        assert.deepEqual(plan.body.running, []);
        assert.deepEqual(
          plan.body.needsEnvironment.map((thread) => [thread.title, thread.environmentId]),
          [
            ["sandbox", sandboxEnvironmentIdOf(acme)],
            ["linus", "env-linus"],
            ["dedicated", "env-acme-vps"],
          ],
        );
        const moved = yield* moveProject(hub, projectId, globex);
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        const where = Effect.forEach(Object.keys(threads), (name) =>
          threadOf(hub, ThreadId.make(`thread:${name}`)).pipe(
            Effect.map(({ thread }): ReadonlyArray<unknown> => [
              name,
              thread.spaceId,
              thread.activeEnvironmentId,
            ]),
          ),
        );
        assert.deepEqual(yield* where, [
          ["hub", globex, undefined],
          ["sandbox", globex, null],
          ["grace", globex, "env-grace"],
          ["linus", globex, null],
          ["dedicated", globex, null],
        ]);
        // Acme's Sandbox is no preference in Globex.
        const [project] = yield* hub.server.sql<{ readonly preferred: string | null }>`
          SELECT preferred_environment_id AS preferred FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        assert.isNull(project?.preferred ?? null);

        // Moving back: nothing it left gets a machine back by itself; the rest stay.
        const back = yield* moveProject(hub, projectId, acme);
        assert.equal(back.status, 200, JSON.stringify(back.body));
        assert.deepEqual(yield* where, [
          ["hub", acme, undefined],
          ["sandbox", acme, null],
          ["grace", acme, "env-grace"],
          ["linus", acme, null],
          ["dedicated", acme, null],
        ]);
        // A Project with no Threads moves too.
        const empty = ProjectId.make("project:empty");
        yield* seedProject(hub.server, {
          projectId: empty,
          title: "Empty",
          defaultModelSelection: null,
          spaceId: acme,
        });
        const emptyPlan = yield* movePlan(hub, empty, globex);
        assert.deepEqual(
          [emptyPlan.status, emptyPlan.body.running, emptyPlan.body.needsEnvironment],
          [200, [], []],
        );
        assert.equal((yield* moveProject(hub, empty, globex)).status, 200);
        assert.isDefined(owner);
      }).pipe(Effect.scoped),
  );

  it.live(
    "the plan is the move's to see: Owner and Admins of both Spaces, never a Member or a Guest",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        // An Admin acts as one only with a strong factor (a passkey).
        const ada = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Ada",
          spaceId: acme,
          role: "admin",
        });
        const al = yield* memberWithPasskey(hub.server, hub.owner, {
          displayName: "Al",
          spaceId: acme,
          role: "admin",
        });
        const people = {
          admin: ada.cookie,
          adminOfOne: al.cookie,
          member: yield* addMember(hub.server, { id: "user-member", displayName: "Grace" }),
          guest: yield* addMember(hub.server, { id: "user-guest", displayName: "Linus" }),
        };
        yield* joinOrganization(hub.server, globex, ada.userId, "admin");
        yield* joinOrganization(hub.server, globex, al.userId, "member");
        for (const space of [acme, globex]) {
          yield* joinOrganization(hub.server, space, "user-member", "member");
          yield* joinOrganization(hub.server, space, "user-guest", "guest");
        }
        yield* hub.service(SpaceDirectory.SpaceDirectory).changed;
        const projectId = ProjectId.make("project:acme-web");
        yield* seedProject(hub.server, {
          projectId,
          title: "Acme web",
          defaultModelSelection: null,
          spaceId: acme,
        });
        for (const cookie of [hub.owner, people.admin]) {
          const answer = yield* movePlan(hub, projectId, globex, cookie);
          assert.equal(answer.status, 200, JSON.stringify(answer.body));
        }
        // As the move answers them: refused, or a Project they cannot see.
        for (const cookie of [people.adminOfOne, people.member, people.guest]) {
          const answer = yield* movePlan(hub, projectId, globex, cookie);
          assert.include([400, 403], answer.status, JSON.stringify(answer.body));
          const move = yield* moveProject(hub, projectId, globex, { cookie });
          assert.equal(move.status, answer.status, JSON.stringify(move.body));
        }
      }).pipe(Effect.scoped),
  );

  it.live("a request in flight on the Project's repository ends when the Project moves", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
      const acme = yield* createOrganization(hub, "Acme");
      const globex = yield* createOrganization(hub, "Globex");
      const projectId = ProjectId.make("project:acme-web");
      yield* seedProject(hub.server, {
        projectId,
        title: "Acme web",
        defaultModelSelection: null,
        spaceId: acme,
      });
      yield* startSandbox(hub, acme);
      const sandbox = yield* hub.sandboxOf(acme);
      // A push whose ref updates have not all arrived: the Hub waits for the rest.
      const url = new URL(
        `${HubRepository.hubRepositoryUrl(hub.server.url, { projectId })}/git-receive-pack`,
      );
      const answered = yield* Deferred.make<number | string>();
      const request = NodeHttp.request(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sandbox.credential}`,
          "content-type": "application/x-git-receive-pack-request",
          "transfer-encoding": "chunked",
        },
      });
      request.on("response", (response) => {
        response.resume();
        response.on("end", () =>
          Deferred.doneUnsafe(answered, Effect.succeed(response.statusCode ?? 0)),
        );
        response.on("error", (error) =>
          Deferred.doneUnsafe(answered, Effect.succeed(String(error))),
        );
      });
      request.on("error", (error) => Deferred.doneUnsafe(answered, Effect.succeed(String(error))));
      request.write("00");
      yield* Effect.addFinalizer(() => Effect.sync(() => request.destroy()));
      // It is in flight: no answer yet.
      // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- Nothing marks that the Hub's route began reading a body; a move before that answers 503, also not 200.
      yield* Effect.sleep(Duration.millis(500));
      assert.isTrue(Option.isNone(yield* Deferred.poll(answered)));

      assert.equal((yield* moveProject(hub, projectId, globex)).status, 200);
      const outcome = yield* Deferred.await(answered).pipe(
        Effect.timeout(Duration.seconds(10)),
        Effect.option,
      );
      assert.isTrue(Option.isSome(outcome), "the request still runs after the move");
      assert.notEqual(Option.getOrUndefined(outcome), 200);
      assert.equal(yield* repositoryStatus(hub, projectId, sandbox.credential), 403);
      assert.isDefined(HUB_MACHINE_ENVIRONMENT_ID);
    }).pipe(Effect.scoped),
  );

  it.live("a terminal open on the old Space's Sandbox ends when the Project moves", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
      const acme = yield* createOrganization(hub, "Acme");
      const globex = yield* createOrganization(hub, "Globex");
      const projectId = ProjectId.make("project:acme-web");
      const { workspaceRoot: hubCheckout } = yield* seedProject(hub.server, {
        projectId,
        title: "Acme web",
        defaultModelSelection: null,
        spaceId: acme,
      });
      yield* startSandbox(hub, acme);
      const threadId = ThreadId.make("thread:acme-terminal");
      yield* hub
        .service(Orchestrator.OrchestratorV2)
        .dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:acme-terminal"),
          threadId,
          projectId,
          spaceId: acme,
          title: "Terminal",
          modelSelection: { instanceId, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeEnvironmentId: sandboxEnvironmentIdOf(acme),
        })
        .pipe(Effect.orDie);
      const executor = yield* hub
        .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
        .get(sandboxEnvironmentIdOf(acme))
        .pipe(Effect.orDie);
      const checkout = Option.getOrThrow(yield* executor.workspace.paths.checkout(projectId));
      yield* Effect.promise(() => NodeFSP.mkdir(checkout, { recursive: true }));
      const workspace = (yield* ThreadWorkspace.make.pipe(
        Effect.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
        Effect.provideContext(hub.server.services as never),
      )) as ThreadWorkspace.ThreadWorkspace["Service"];
      const owner = { userId: yield* ownerIdOf(hub) };
      yield* workspace
        .terminalOpen(
          { threadId, terminalId: "term-1", cwd: hubCheckout, cols: 80, rows: 24 },
          owner,
        )
        .pipe(Effect.orDie);
      const attached = yield* Deferred.make<void>();
      const ended = yield* workspace
        .terminalAttach({ threadId, terminalId: "term-1" }, "viewer-1", owner)
        .pipe(
          Stream.tap((event) =>
            event.type === "snapshot" ? Deferred.succeed(attached, undefined) : Effect.void,
          ),
          Stream.runDrain,
          Effect.exit,
          Effect.forkScoped,
        );
      yield* Deferred.await(attached);
      assert.equal((yield* moveProject(hub, projectId, globex)).status, 200);
      // Its stream there ends at once, and nothing can be typed into it any more.
      const exit = yield* Fiber.join(ended).pipe(
        Effect.timeout(Duration.seconds(10)),
        Effect.orDie,
      );
      assert.isTrue(exit._tag === "Failure" || exit._tag === "Success");
      const typed = yield* workspace
        .terminalWrite({ threadId, terminalId: "term-1", data: "pwd\r" }, owner)
        .pipe(Effect.flip);
      assert.isDefined(typed);
    }).pipe(Effect.scoped),
  );
});
