/**
 * «Hub con Environments», spec 3 ticket 03: a Thread nobody placed runs in its Space's Sandbox,
 * never on the Hub machine unless `T3CODE_HUB_RUNS_AGENTS` (the testkit's `hubRunsAgents`); with
 * neither it is refused with why; a Thread left on the Hub machine needs an environment and moves.
 */
// @effect-diagnostics nodeBuiltinImport:off -- checks the Hub's own copy of the Project on disk.
import * as NodeFSP from "node:fs/promises";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderReplayTranscript,
  sandboxEnvironmentIdOf,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as CommandActor from "../auth/CommandActor.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ClaudeOrchestratorReplayHarness } from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import * as EnvironmentReturnService from "../orchestration-v2/EnvironmentReturnService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import { materializeFixtureInput } from "../orchestration-v2/testkit/fixtures/shared.ts";
import {
  findReplayFixture,
  readReplayFixtureTranscript,
} from "../orchestration-v2/testkit/ProviderReplayFixtures.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { makeHub, seedProject, type Hub } from "./HubWithEnvironments.testkit.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");

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

/** The provider, with no recorded turns: for tests that run none. */
const idleAdapters: Adapters = ProviderAdapterRegistry.layerFromAdapters([
  {
    instanceId: CLAUDE_INSTANCE,
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

/** A client's command, through the Hub's placement and starts. */
const dispatchAs = (hub: Hub, actor: UserId, command: OrchestrationV2Command) =>
  hub
    .service(ThreadManagementService.ThreadManagementService)
    .dispatch({ ...command, ownerUserId: actor } as never)
    .pipe(CommandActor.actAs(actor));

/** What `GET /api/environments` answers the Owner. */
const listed = Effect.fn(function* (hub: Hub) {
  const response = yield* hub.server.request("/api/environments", { cookie: hub.owner });
  assert.equal(response.status, 200);
  return response.body as {
    readonly environments: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
    readonly sandboxesUnavailable?: string | null;
  };
});

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

/**
 * The Thread once `done` holds for it, read again on each of its events, as the Orchestrator
 * streams them or (`viaSink`) as the event sink that wrote them does.
 */
const awaitThread = (
  hub: Hub,
  threadId: ThreadId,
  done: (thread: OrchestrationV2AppThread) => boolean,
  viaSink = false,
) =>
  Effect.gen(function* () {
    const afterSequence = yield* hub
      .service(EventSink.EventSinkV2)
      .latestSequence({ threadId })
      .pipe(Effect.orDie);
    const current = (yield* projectionOf(hub, threadId)).thread;
    if (done(current)) return current;
    const events: Stream.Stream<unknown> = viaSink
      ? hub.service(EventSink.EventSinkV2).stream({ threadId, afterSequence }).pipe(Stream.orDie)
      : hub
          .service(Orchestrator.OrchestratorV2)
          .streamStoredEventsFrom({ threadId, afterSequence })
          .pipe(Stream.orDie);
    const next = yield* events.pipe(
      Stream.mapEffect(() => projectionOf(hub, threadId)),
      Stream.filterMap((projection) =>
        done(projection.thread) ? Result.succeed(projection.thread) : Result.failVoid,
      ),
      Stream.runHead,
    );
    return Option.getOrThrow(next);
  });

describe("Hub con Environments: the Hub stops running agents", () => {
  it.live("a Hub without agents acts on its own machine for no draft nor Thread-less call", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sandboxes: false, hubRunsAgents: false });
      const owner = { userId: yield* ownerIdOf(hub) };
      const acme = yield* createOrganization(hub, "Acme");
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId: ProjectId.make("project:acme"),
        title: "Acme",
        defaultModelSelection: null,
        spaceId: acme,
      });
      const workspace = yield* ThreadWorkspace.make.pipe(
        Effect.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
        Effect.provideContext(hub.server.services as never),
      ) as Effect.Effect<ThreadWorkspace.ThreadWorkspace["Service"]>;
      // A draft: the composer of a Thread not sent yet, which runs nowhere so far. (Reads still
      // answer from the Hub's copy; this testkit Hub has no workspace services to read with.)
      for (const threadId of [ThreadId.make("thread:draft"), undefined]) {
        const written = yield* workspace
          .writeFile(
            {
              cwd: workspaceRoot,
              relativePath: "notes.md",
              contents: "x\n",
              ...(threadId === undefined ? {} : { threadId }),
            },
            owner,
          )
          .pipe(Effect.flip);
        assert.include(written.message, "The Hub runs no agents", String(threadId));
      }
      const opened = yield* workspace
        .terminalOpen({ threadId: "thread:draft", terminalId: "term-1", cwd: workspaceRoot }, owner)
        .pipe(Effect.flip);
      assert.include(opened.message, "The Hub runs no agents");
      assert.isFalse(
        yield* Effect.promise(() =>
          NodeFSP.access(`${workspaceRoot}/notes.md`).then(
            () => true,
            () => false,
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "a Thread nobody placed runs in its Space's Sandbox, and the Hub machine is not offered",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hub = yield* makeHub({ sandboxAdapters: loaded.adapters, hubRunsAgents: false });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const sandboxId = sandboxEnvironmentIdOf(acme);
        const before = yield* listed(hub);
        assert.isFalse(before.environments.some((environment) => environment.kind === "hub"));
        assert.isTrue(before.environments.some((environment) => environment.id === sandboxId));
        assert.strictEqual(before.sandboxesUnavailable, null);

        const [create, ...rest] = loaded.materialized.commands;
        if (create?.type !== "thread.create") return yield* Effect.die("no thread.create");
        yield* seedProject(hub.server, {
          projectId: create.projectId,
          title: "Acme web",
          defaultModelSelection: loaded.variant.modelSelection,
          spaceId: acme,
        });
        // Created as a client creates it, choosing no machine.
        const { activeEnvironmentId: _none, ...unplaced } = create;
        yield* dispatchAs(hub, owner, unplaced);
        assert.equal(
          (yield* projectionOf(hub, create.threadId)).thread.activeEnvironmentId,
          sandboxId,
        );
        const message = rest.find((command) => command.type === "message.dispatch");
        if (message === undefined) return yield* Effect.die("no message");
        yield* dispatchAs(hub, owner, message);
        assert.equal(yield* awaitRunSettled(hub, create.threadId, 1), "completed");
        const sandbox = yield* hub.sandboxOf(acme);
        const projection = yield* projectionOf(hub, create.threadId);
        assert.isNotEmpty(projection.checkpointScopes);
        for (const scope of projection.checkpointScopes) {
          assert.isTrue(scope.cwd.startsWith(sandbox.workspaceRoot), scope.cwd);
        }

        // Nobody may ask for the Hub machine, and work the Hub places itself (no User) goes to
        // the Sandbox as well.
        const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
        const refused = yield* dispatchAs(hub, owner, {
          ...create,
          commandId: CommandId.make("command:on-the-hub"),
          threadId: ThreadId.make("thread:on-the-hub"),
          activeEnvironmentId: HUB_MACHINE_ENVIRONMENT_ID,
        }).pipe(Effect.flip);
        assert.include(
          EnvironmentRegistry.environmentRefusalMessage(refused) ?? JSON.stringify(refused),
          "The Hub machine does not run Threads",
        );
        assert.equal(
          yield* registry.chooseForThread({
            userId: undefined,
            requested: undefined,
            projectId: create.projectId,
            providerInstanceId: loaded.variant.modelSelection.instanceId,
          }),
          sandboxId,
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "with no Sandboxes and the Hub machine off, a Thread nobody placed is refused with why",
    () =>
      Effect.gen(function* () {
        const why =
          "Podman Sandboxes need the Hub to listen on loopback only (T3CODE_HOST=127.0.0.1).";
        const hub = yield* makeHub({
          sandboxes: false,
          hubRunsAgents: false,
          sandboxesUnavailable: why,
        });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const projectId = ProjectId.make("project:acme");
        yield* seedProject(hub.server, {
          projectId,
          title: "Acme",
          defaultModelSelection: null,
          spaceId: acme,
        });
        const answer = yield* listed(hub);
        assert.deepEqual(answer.environments, []);
        assert.equal(answer.sandboxesUnavailable, why);

        const threadId = ThreadId.make("thread:nowhere");
        const refused = yield* dispatchAs(hub, owner, {
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:nowhere"),
          threadId,
          projectId,
          title: "Nowhere",
          modelSelection: { instanceId: CLAUDE_INSTANCE, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        }).pipe(Effect.flip);
        assert.include(
          EnvironmentRegistry.environmentRefusalMessage(refused) ?? JSON.stringify(refused),
          `No Environment can run this Thread: ${why}`,
        );
        // Nothing was made, on the Hub machine or anywhere.
        assert.isTrue(
          Option.isNone(
            yield* hub
              .service(Orchestrator.OrchestratorV2)
              .getThreadProjection(threadId)
              .pipe(Effect.option),
          ),
        );
        // Their own machine, chosen, still runs it.
        const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters });
        assert.equal(
          yield* hub.service(EnvironmentRegistry.EnvironmentRegistry).chooseForThread({
            userId: owner,
            requested: laptop.environmentId,
            projectId,
            providerInstanceId: CLAUDE_INSTANCE,
          }),
          laptop.environmentId,
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "a Thread on the Hub machine needs an environment once the Hub starts with the setting off, and moves to the Sandbox",
    () =>
      Effect.gen(function* () {
        // Made while the Hub machine ran Threads (the setting on).
        const hub = yield* makeHub({ sandboxAdapters: idleAdapters });
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const projectId = ProjectId.make("project:acme");
        yield* seedProject(hub.server, {
          projectId,
          title: "Acme",
          defaultModelSelection: null,
          spaceId: acme,
        });
        const threadId = ThreadId.make("thread:on-the-hub");
        yield* dispatchAs(hub, owner, {
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:on-the-hub"),
          threadId,
          projectId,
          spaceId: acme,
          title: "On the Hub",
          modelSelection: { instanceId: CLAUDE_INSTANCE, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const [placed] = yield* hub.server.sql<{ readonly environmentId: string | null }>`
          SELECT active_environment_id AS "environmentId"
          FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
        `;
        assert.equal(placed?.environmentId, HUB_MACHINE_ENVIRONMENT_ID);
        // And one in the Acme Sandbox, which the restarted Hub has no runtime for.
        const sandboxThreadId = ThreadId.make("thread:in-the-sandbox");
        yield* dispatchAs(hub, owner, {
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:in-the-sandbox"),
          threadId: sandboxThreadId,
          projectId,
          spaceId: acme,
          title: "In the Sandbox",
          modelSelection: { instanceId: CLAUDE_INSTANCE, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeEnvironmentId: sandboxEnvironmentIdOf(acme),
        });
        const activeOf = (id: ThreadId) =>
          hub.server.sql<{ readonly environmentId: string | null }>`
            SELECT active_environment_id AS "environmentId"
            FROM orchestration_v2_projection_threads WHERE thread_id = ${id}
          `.pipe(Effect.map((rows) => rows[0]?.environmentId));

        // The Hub starts again with the setting off: what it does at startup for its Threads runs
        // again, over the same database, seeing a Hub machine that runs no Threads.
        const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
        // The orchestration's services are in the Hub's context, beside the testkit's own.
        const services = hub.server.services as unknown as Context.Context<
          | EnvironmentExecutor.EnvironmentExecutorRegistry
          | EventSink.EventSinkV2
          | Orchestrator.OrchestratorV2
          | SqlClient.SqlClient
        >;
        const restarted = Context.add(
          services,
          EnvironmentRegistry.EnvironmentRegistry,
          EnvironmentRegistry.EnvironmentRegistry.of({
            ...registry,
            hubRunsAgents: false,
            sandboxesUnavailable: "Sandboxes are turned off on this Hub.",
          }),
        );
        // The Hub's own event sink, so its streams see what is written; fresh Thread locks and
        // stores over the same database, as a restarted Hub has.
        yield* Layer.build(
          EnvironmentReturnService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                IdAllocator.layer,
                ThreadCommandExecutor.layer,
                ProjectionStore.layer,
                TurnItemPositionStore.layer,
              ),
            ),
            Layer.provide(Layer.succeedContext(restarted)),
          ),
        );
        // Released while the Hub starts, before its runs are recovered: nothing waits for it.
        assert.isNull(yield* activeOf(threadId));
        assert.isNull(yield* activeOf(sandboxThreadId));
        const released = yield* awaitThread(
          hub,
          threadId,
          (thread) => thread.activeEnvironmentId === null,
          true,
        );
        assert.isNull(released.activeEnvironmentId);
        // It takes no work until it moves, and says why.
        const refused = yield* dispatchAs(hub, owner, {
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:message"),
          threadId,
          messageId: MessageId.make("message:after-restart"),
          text: "Still there?",
          attachments: [],
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
        } as never).pipe(Effect.flip);
        assert.include(JSON.stringify(refused), "needs an environment");

        // It moves to its Space's Sandbox, which starts for the move.
        const target: EnvironmentId = sandboxEnvironmentIdOf(acme);
        yield* dispatchAs(hub, owner, {
          type: "thread.move",
          commandId: CommandId.make("command:move-to-sandbox"),
          threadId,
          targetEnvironmentId: target,
        });
        const moved = yield* awaitThread(
          hub,
          threadId,
          (thread) => thread.move != null && thread.move.status !== "running",
        );
        assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
        assert.equal(moved.activeEnvironmentId, target);
      }).pipe(Effect.scoped),
  );
});
