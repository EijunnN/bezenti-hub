/**
 * «Hub con Environments»: a real Hub (HTTP and the Environment socket on a loopback port, an
 * in-memory database, the production orchestration) and real joined Environments that connect to
 * it over the protocol. Each Environment runs its own executor over a replay provider adapter and
 * temporary git repositories, and can drop its socket and reconnect. The seam of spec 2's tests.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ENVIRONMENT_CONNECTION_PROTOCOL_VERSION,
  EnvironmentId,
  EventId,
  type EnvironmentHeartbeatFrame,
  type EnvironmentHelloFrame,
  type ModelSelection,
  OrchestrationV2ProviderCapabilities,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type SpaceId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import type { HubServices, Server } from "../auth/UserAuth.testkit.ts";
import * as EnvironmentAgent from "./EnvironmentAgent.ts";
import { joinMachine, hubWithOwner } from "./environments.testkit.ts";
import { connectOnce } from "./JoinedHub.ts";

const HOST_RESOURCES = {
  sampledAt: 0,
  cpuUtilization: 0.1,
  cpuCount: 8,
  availableMemoryBytes: 8_000_000_000,
  totalMemoryBytes: 16_000_000_000,
};

// Providers run on the Environments: the Hub machine has none of its own.
const layerNoProviders = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: () => Effect.succeed(undefined),
  listInstances: Effect.succeed([]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Effect.never as never,
  subscribeChanges: Effect.never,
} as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]);

const layerCheckpoints = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provide(VcsProcess.layer),
);

/** The production orchestration over the Hub's own database and Environments. */
const layerHubOrchestration = CheckpointDiffQuery.layer.pipe(
  // Diffs read checkpoints as the server reads them, through the same executors.
  Layer.provide(RuntimeLayer.layerCheckpointStoreProvided),
  Layer.provideMerge(RuntimeLayer.layer),
  Layer.provideMerge(ProjectStore.layer),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(layerCheckpoints),
  Layer.provide(layerNoProviders),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.die("worktrees are not made in these tests"),
    }),
  ),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone })),
  Layer.provide(
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("unused title link"),
    }),
  ),
  Layer.provideMerge(HubRepository.layer),
  Layer.provideMerge(VcsProcess.layer),
);

const withOrchestration = (services: Context.Context<HubServices>) =>
  Effect.gen(function* () {
    const orchestration = yield* Layer.build(
      layerHubOrchestration.pipe(Layer.provide(Layer.succeedContext(services))),
    );
    const merged = Context.merge(services, orchestration);
    // The effect worker runs as the server runs it, so effects settle without a test draining them.
    yield* EffectWorker.runDaemon.pipe(Effect.provideContext(merged), Effect.forkScoped);
    return merged as unknown as Context.Context<HubServices>;
  }).pipe(Effect.orDie);

export interface TestEnvironment {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  /** Its Environment credential, as `t3 join` stored it. */
  readonly credential: string;
  /**
   * The per-Thread MCP configs the Hub sent for this machine's agents. Recorded, not handed to the
   * replay adapters, whose transcripts were recorded without T3's MCP server.
   */
  readonly mcpConfigs: ReadonlyArray<McpProviderSessionConfig>;
  /** Where this machine keeps Project checkouts (`<T3 home>/projects`). */
  readonly workspaceRoot: string;
  /** Opens a socket to the Hub; succeeds once the Hub welcomed it. */
  readonly connect: Effect.Effect<void>;
  /** Drops the socket. The machine keeps running: its sessions and unacknowledged events stay. */
  readonly disconnect: Effect.Effect<void>;
}

/** A joined Environment's half: its executor and agent over the given provider adapters. */
const startEnvironment = Effect.fn("HubWithEnvironments.startEnvironment")(function* (input: {
  readonly hubUrl: string;
  readonly credential: string;
  readonly environmentId: EnvironmentId;
  readonly hubEnvironmentId: EnvironmentId;
  readonly name: string;
  readonly adapters: Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    never,
    McpProviderSessions.McpProviderSessions
  >;
  readonly connect: boolean;
}) {
  const scope = yield* Effect.scope;
  const mcpConfigs: Array<McpProviderSessionConfig> = [];
  const layerRecordingMcp = Layer.effect(
    McpProviderSessions.McpProviderSessions,
    Effect.map(McpProviderSessions.McpProviderSessions, (sessions) => ({
      ...sessions,
      set: (config: McpProviderSessionConfig) => Effect.sync(() => void mcpConfigs.push(config)),
    })),
  ).pipe(Layer.provide(McpProviderSessions.layer));
  const layerMachine = Layer.mergeAll(EnvironmentExecutor.layerHubMachine, layerRecordingMcp).pipe(
    Layer.provide(
      Layer.mergeAll(
        input.adapters,
        RuntimePolicy.layer,
        layerCheckpoints,
        layerNoProviders,
        ProjectStore.layer,
      ),
    ),
    Layer.provideMerge(layerRecordingMcp),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: `t3-environment-${input.name}-` }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const machine = yield* Layer.build(layerMachine).pipe(Effect.orDie);
  const agent = yield* EnvironmentAgent.make({
    environmentId: input.environmentId,
    hubUrl: input.hubUrl,
    credential: input.credential,
  }).pipe(Effect.provideContext(machine));
  const report = agent.report;
  const hello: Effect.Effect<EnvironmentHelloFrame> = Effect.map(report, (described) => ({
    type: "hello",
    protocolVersion: ENVIRONMENT_CONNECTION_PROTOCOL_VERSION,
    os: "linux",
    hostname: input.name,
    providers: described.orchestration.providers.map((provider) => ({
      instanceId: provider.instanceId,
      provider: provider.provider,
      displayName: null,
      enabled: provider.enabled,
      installed: true,
      version: "1.0.0",
      capabilities: { runtimeModes: [], conversationRollback: true, textGeneration: false },
    })),
    hostResources: HOST_RESOURCES,
    disk: null,
    sessions: described.sessions,
    workspaceRoot: described.workspaceRoot,
    orchestration: described.orchestration,
  }));
  const heartbeat: Effect.Effect<EnvironmentHeartbeatFrame> = Effect.map(report, (described) => ({
    type: "heartbeat",
    hostResources: HOST_RESOURCES,
    disk: null,
    orchestration: described.orchestration,
  }));

  let connection: Fiber.Fiber<unknown> | undefined;
  const connect = Effect.gen(function* () {
    const welcomed = yield* Deferred.make<void>();
    connection = yield* connectOnce({
      hubUrl: input.hubUrl,
      credential: input.credential,
      expectedHubId: input.hubEnvironmentId,
      hello,
      heartbeat,
      onWelcome: () => Deferred.succeed(welcomed, undefined).pipe(Effect.asVoid),
      serve: agent.attach,
    }).pipe(Effect.forkIn(scope));
    yield* Deferred.await(welcomed);
  });
  const disconnect = Effect.suspend(() => {
    const current = connection;
    connection = undefined;
    return current === undefined ? Effect.void : Fiber.interrupt(current);
  });
  if (input.connect) yield* connect;
  return {
    environmentId: input.environmentId,
    name: input.name,
    credential: input.credential,
    mcpConfigs,
    workspaceRoot: (yield* report).workspaceRoot,
    connect,
    disconnect,
  } satisfies TestEnvironment;
});

/** A Hub with its Owner signed in, running the orchestration, listening on loopback. */
export const makeHub = Effect.fn("HubWithEnvironments.makeHub")(function* () {
  const { server, authenticator, owner } = yield* hubWithOwner({
    listen: true,
    extend: withOrchestration,
  });
  /** Joins a machine as the Owner (`t3 join`, approved with a passkey) and connects it. */
  const join = Effect.fn("HubWithEnvironments.join")(function* (input: {
    readonly name: string;
    readonly adapters: Layer.Layer<
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      never,
      McpProviderSessions.McpProviderSessions
    >;
    /** Off: the machine joined but never connected, so the Hub sees it offline. */
    readonly connect?: boolean;
  }) {
    const joined = yield* joinMachine(server, authenticator, owner, input.name);
    return yield* startEnvironment({
      hubUrl: server.url,
      credential: joined.credential,
      environmentId: EnvironmentId.make(joined.environmentId),
      hubEnvironmentId: EnvironmentId.make(joined.hubEnvironmentId),
      name: input.name,
      adapters: input.adapters,
      connect: input.connect ?? true,
    });
  });
  return { server, authenticator, owner, join, service: serviceOf(server) };
});

/** A Hub service, as the routes and orchestration share it. */
const serviceOf =
  (server: Server) =>
  <I, S>(tag: Context.Key<I, S>): S =>
    Context.get(server.services as unknown as Context.Context<I>, tag);

/**
 * A Project on the Hub whose workspace is a fresh git repository with one commit, published as
 * its own `origin` so an Environment that lacks it clones it.
 */
export const seedProject = Effect.fn("HubWithEnvironments.seedProject")(function* (
  server: Server,
  input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly defaultModelSelection: ModelSelection | null;
    /** Its Space; none is a Project from before Spaces, in the Owner's Personal space. */
    readonly spaceId?: SpaceId;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hub-project-" });
  const git = (...args: ReadonlyArray<string>) =>
    Effect.flatMap(VcsProcess.VcsProcess, (vcs) =>
      vcs.run({ operation: "HubWithEnvironments.git", command: "git", args, cwd: workspaceRoot }),
    ).pipe(Effect.provide(VcsProcess.layer), Effect.orDie);
  yield* git("init", "--initial-branch=main");
  yield* git("config", "user.email", "hub@example.com");
  yield* git("config", "user.name", "Hub");
  yield* fs.writeFileString(path.join(workspaceRoot, "README.md"), "# Remote project\n");
  yield* git("add", "README.md");
  yield* git("commit", "-m", "Initial commit");
  yield* git("remote", "add", "origin", workspaceRoot);
  const projects = Context.get(
    server.services as unknown as Context.Context<ProjectStore.ProjectStoreV2>,
    ProjectStore.ProjectStoreV2,
  );
  const now = "1970-01-01T00:00:00.000Z";
  yield* projects
    .apply({
      sequence: 0,
      eventId: EventId.make(`seed:${input.projectId}`),
      aggregateKind: "project",
      aggregateId: input.projectId,
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: input.projectId,
        title: input.title,
        workspaceRoot,
        defaultModelSelection: input.defaultModelSelection,
        ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    })
    .pipe(Effect.orDie);
  return { workspaceRoot };
}, Effect.provide(NodeServices.layer));

export type Hub = Effect.Success<ReturnType<typeof makeHub>>;

const encodeCapabilities = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2ProviderCapabilities),
);

/**
 * A machine that speaks the protocol by hand, attached to the Hub's side of it in process: tests
 * see each frame the Hub sends and choose each one it receives. It answers `provider.detach`.
 */
export const connectProtocolEnvironment = Effect.fn("HubWithEnvironments.connectProtocol")(
  function* (
    hub: Hub,
    input: {
      readonly environmentId: EnvironmentId;
      readonly instanceId: ProviderInstanceId;
      readonly driver: ProviderDriverKind;
      readonly capabilities: OrchestrationV2ProviderCapabilities;
      /** The sessions the machine says it still runs. */
      readonly sessions?: EnvironmentHelloFrame["sessions"];
    },
  ) {
    const remote = hub.service(RemoteEnvironments.RemoteEnvironments);
    const frames = yield* Queue.unbounded<Record<string, unknown>>();
    let receive: (frame: unknown) => Effect.Effect<boolean> = () => Effect.succeed(false);
    // Its own scope, so a test can drop the socket while the test goes on.
    const socket = yield* Scope.fork(yield* Effect.scope);
    const connection = yield* remote
      .connect({
        environmentId: input.environmentId,
        hello: {
          type: "hello",
          protocolVersion: ENVIRONMENT_CONNECTION_PROTOCOL_VERSION,
          os: "linux",
          hostname: "protocol",
          providers: [
            {
              instanceId: input.instanceId,
              provider: input.driver,
              displayName: null,
              enabled: true,
              installed: true,
              version: "1.0.0",
              capabilities: { runtimeModes: [], conversationRollback: true, textGeneration: false },
            },
          ],
          hostResources: HOST_RESOURCES,
          disk: null,
          sessions: input.sessions ?? [],
          workspaceRoot: "/remote/projects",
          orchestration: {
            providers: [
              {
                instanceId: input.instanceId,
                provider: input.driver,
                enabled: true,
                continuationKey: `${input.driver}:instance:${input.instanceId}`,
                capabilities: input.capabilities,
              },
            ],
            unavailableProviders: [],
          },
        },
        write: (text) => {
          const frame = JSON.parse(text) as Record<string, unknown>;
          if (frame.type === "request" && frame.method === "provider.detach") {
            return receive({
              type: "response",
              requestId: frame.requestId,
              result: { _tag: "success", value: null },
            }).pipe(Effect.forkDetach, Effect.asVoid);
          }
          return Queue.offer(frames, frame).pipe(Effect.asVoid);
        },
      })
      .pipe(Effect.provideService(Scope.Scope, socket));
    receive = connection.receive;
    return {
      connection,
      /** The socket drops; the Hub's side of it closes. */
      disconnect: Scope.close(socket, Exit.void),
      /** The next frame the Hub sent, other than `provider.detach`. */
      nextFrame: Queue.take(frames),
      providerSession: (providerSessionId: string, cwd: string) => ({
        id: providerSessionId,
        driver: input.driver,
        providerInstanceId: input.instanceId,
        status: "ready",
        cwd,
        model: null,
        capabilities: encodeCapabilities(input.capabilities),
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        lastError: null,
      }),
    };
  },
);
