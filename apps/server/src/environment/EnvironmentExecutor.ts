/**
 * One executor per Environment holds everything the Hub needs a machine for. The Hub machine's is
 * in process. The orchestration's adapter registry, runtime policy and capability reads resolve the
 * Thread's Environment on each call (`docs/internals/overview.md`, «Environment executors»).
 */
import {
  ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  EnvironmentExecutorUnavailableError,
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  ProviderInstanceId,
  type EnvironmentExecutorSnapshot,
  type EnvironmentExecutorTransport,
  type EnvironmentProviderCapabilitySnapshot,
  type EnvironmentUnavailableProvider,
  type OrchestrationV2AppThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as ProjectCheckouts from "./ProjectCheckouts.ts";
import { locateInCheckout } from "./WorkspaceLocation.ts";

export { EnvironmentExecutorUnavailableError } from "@t3tools/contracts";

/** How often the in-process executor republishes its snapshot, like a remote heartbeat. */
export const HUB_MACHINE_HEARTBEAT_INTERVAL = Duration.seconds(10);

export class EnvironmentCapabilitiesUnavailableError extends Schema.TaggedError<EnvironmentCapabilitiesUnavailableError>()(
  "EnvironmentCapabilitiesUnavailableError",
  {
    environmentId: EnvironmentId,
    instanceId: ProviderInstanceId,
    reason: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason === undefined
      ? `Environment ${this.environmentId} has not reported provider ${this.instanceId}.`
      : `Provider ${this.instanceId} is unavailable on Environment ${this.environmentId}: ${this.reason}`;
  }
}

export type EnvironmentCapabilityReadError =
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2Error
  | ProviderAdapter.ProviderAdapterV2Error
  | EnvironmentCapabilitiesUnavailableError
  | EnvironmentExecutorUnavailableError;

/** The machine-side services behind the workspace RPCs (files, search, browse, terminals, previews). */
export interface EnvironmentWorkspaceRpc {
  readonly entries: WorkspaceEntries.WorkspaceEntries["Service"];
  readonly files: WorkspaceFileSystem.WorkspaceFileSystem["Service"];
  readonly terminals: TerminalManager.TerminalManager["Service"];
  readonly previews: PreviewManager.PreviewManager["Service"];
  readonly ports: PortScanner.PortDiscovery["Service"];
}

export interface EnvironmentExecutor {
  readonly environmentId: EnvironmentId;
  readonly transport: EnvironmentExecutorTransport;
  readonly provider: {
    /** One `ProviderAdapterV2` per provider instance; a session runtime carries turns and events. */
    readonly adapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape;
    /** In process: the live adapter. Remote: the last snapshot, so deciding makes no network call. */
    readonly capabilities: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<EnvironmentProviderCapabilitySnapshot, EnvironmentCapabilityReadError>;
  };
  readonly workspace: {
    /** Project checkouts on this machine, and logical workspace paths resolved against them. */
    readonly paths: ProjectCheckouts.EnvironmentWorkspacePaths;
    readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
    /** Takes the Thread with its worktree already resolved onto this machine. */
    readonly runtimePolicy: RuntimePolicy.RuntimePolicyV2Shape;
    /** None where the server runs without the RPC services (orchestration-only tests). */
    readonly rpc: Option.Option<EnvironmentWorkspaceRpc>;
  };
  readonly host: {
    /** Host resources and provider capabilities, as published in a hello or heartbeat. */
    readonly describe: Effect.Effect<EnvironmentExecutorSnapshot>;
  };
}

/** Which Environment a Thread runs on. Until Threads store one, every Thread runs on the Hub machine. */
export const ActiveEnvironmentResolver = Context.Reference<{
  readonly resolve: (threadId: ThreadId) => Effect.Effect<EnvironmentId>;
}>("t3/environment/EnvironmentExecutor/ActiveEnvironmentResolver", {
  defaultValue: () => ({ resolve: () => Effect.succeed(HUB_MACHINE_ENVIRONMENT_ID) }),
});

/**
 * The Environment for calls that carry no Thread: checkpoint operations, which only run inside
 * their own Thread's effect. Everything that has a Thread resolves it instead.
 */
const CheckpointEnvironment = Context.Reference<EnvironmentId>(
  "t3/environment/EnvironmentExecutor/CheckpointEnvironment",
  { defaultValue: () => HUB_MACHINE_ENVIRONMENT_ID },
);

/** Runs a Thread's effect so its checkpoint work goes to the Thread's Active environment. */
export const onActiveEnvironment =
  (threadId: ThreadId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const resolver = yield* ActiveEnvironmentResolver;
      const environmentId = yield* resolver.resolve(threadId);
      return yield* Effect.provideService(effect, CheckpointEnvironment, environmentId);
    });

const resolveThread = Effect.fn("EnvironmentExecutor.resolveThread")(function* (
  threadId: ThreadId,
) {
  const resolver = yield* ActiveEnvironmentResolver;
  return yield* resolver.resolve(threadId);
});

export interface EnvironmentExecutorRegistryShape {
  readonly hubMachineEnvironmentId: EnvironmentId;
  readonly get: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<EnvironmentExecutor, EnvironmentExecutorUnavailableError>;
  readonly list: Effect.Effect<ReadonlyArray<EnvironmentId>>;
  /** The executor of the Thread's Active environment. */
  readonly forThread: (
    threadId: ThreadId,
  ) => Effect.Effect<EnvironmentExecutor, EnvironmentExecutorUnavailableError>;
  /** Adds or replaces an executor; a joined Environment registers on connect. */
  readonly register: (executor: EnvironmentExecutor) => Effect.Effect<void>;
  /** Removes a joined Environment's executor. The Hub machine's stays. */
  readonly unregister: (environmentId: EnvironmentId) => Effect.Effect<void>;
}

export class EnvironmentExecutorRegistry extends Context.Service<
  EnvironmentExecutorRegistry,
  EnvironmentExecutorRegistryShape
>()("t3/environment/EnvironmentExecutor/EnvironmentExecutorRegistry") {}

export interface EnvironmentCapabilityCacheShape {
  /** Keeps the newest snapshot per Environment by `observedAt`; an older one is ignored. */
  readonly publish: (snapshot: EnvironmentExecutorSnapshot) => Effect.Effect<void>;
  readonly snapshot: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<Option.Option<EnvironmentExecutorSnapshot>>;
  /** A pure read of the last snapshot. A remote executor answers `capabilities` with it. */
  readonly snapshotProvider: (
    environmentId: EnvironmentId,
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<
    EnvironmentProviderCapabilitySnapshot,
    EnvironmentCapabilitiesUnavailableError
  >;
  /** The provider as the Thread's Active environment's executor reports it. */
  readonly forThread: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }) => Effect.Effect<EnvironmentProviderCapabilitySnapshot, EnvironmentCapabilityReadError>;
}

/** Per-Environment provider capabilities, as the Orchestrator reads them while deciding. */
export class EnvironmentCapabilityCache extends Context.Service<
  EnvironmentCapabilityCache,
  EnvironmentCapabilityCacheShape
>()("t3/environment/EnvironmentExecutor/EnvironmentCapabilityCache") {}

const makeCapabilityCache = Effect.fn("EnvironmentExecutor.makeCapabilityCache")(function* (
  read: (
    environmentId: EnvironmentId,
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<EnvironmentProviderCapabilitySnapshot, EnvironmentCapabilityReadError>,
) {
  const snapshots = yield* Ref.make<ReadonlyMap<EnvironmentId, EnvironmentExecutorSnapshot>>(
    new Map(),
  );
  return EnvironmentCapabilityCache.of({
    publish: Effect.fn("EnvironmentCapabilityCache.publish")(function* (snapshot) {
      // ISO-8601 instants in UTC order as strings, and the update is atomic.
      yield* Ref.update(snapshots, (current) => {
        const known = current.get(snapshot.environmentId);
        if (known !== undefined && known.observedAt > snapshot.observedAt) return current;
        return new Map(current).set(snapshot.environmentId, snapshot);
      });
    }),
    snapshot: Effect.fn("EnvironmentCapabilityCache.snapshot")(function* (environmentId) {
      return Option.fromUndefinedOr((yield* Ref.get(snapshots)).get(environmentId));
    }),
    snapshotProvider: Effect.fn("EnvironmentCapabilityCache.snapshotProvider")(
      function* (environmentId, instanceId) {
        const known = (yield* Ref.get(snapshots)).get(environmentId);
        const found = known?.providers.find((entry) => entry.instanceId === instanceId);
        if (found !== undefined) return found;
        const unavailable = known?.unavailableProviders.find(
          (entry) => entry.instanceId === instanceId,
        );
        return yield* new EnvironmentCapabilitiesUnavailableError({
          environmentId,
          instanceId,
          ...(unavailable === undefined ? {} : { reason: unavailable.reason }),
        });
      },
    ),
    forThread: Effect.fn("EnvironmentCapabilityCache.forThread")(function* (input) {
      return yield* read(yield* resolveThread(input.threadId), input.providerInstanceId);
    }),
  });
});

/** What the local adapter registry says about one instance, with its own typed errors. */
const readLocalProvider = Effect.fn("EnvironmentExecutor.readLocalProvider")(function* (
  adapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape,
  instanceId: ProviderInstanceId,
) {
  if (adapters.getMetadata !== undefined) {
    const { driver, ...metadata } = yield* adapters.getMetadata(instanceId);
    return { instanceId, provider: driver, ...metadata } as EnvironmentProviderCapabilitySnapshot;
  }
  const adapter = yield* adapters.get(instanceId);
  const capabilities = yield* adapter.getCapabilities();
  return {
    instanceId,
    provider: adapter.driver,
    continuationKey: `${adapter.driver}:instance:${instanceId}`,
    enabled: true,
    capabilities,
  } as EnvironmentProviderCapabilitySnapshot;
});

const failureReason = (cause: Cause.Cause<unknown>): string => {
  const text = Cause.pretty(cause).trim();
  return text.length > 0 ? text.slice(0, 500) : "The provider could not be described.";
};

/** Every instance of a local registry: described ones, and the ones that failed with why. */
const describeLocalProviders = Effect.fn("EnvironmentExecutor.describeLocalProviders")(function* (
  environmentId: EnvironmentId,
  adapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape,
) {
  const instanceIds = yield* adapters.list();
  const described = yield* Effect.forEach(instanceIds, (instanceId) =>
    Effect.exit(readLocalProvider(adapters, instanceId)).pipe(
      Effect.map((exit) => ({ instanceId, exit })),
    ),
  );
  const providers: Array<EnvironmentProviderCapabilitySnapshot> = [];
  const unavailableProviders: Array<EnvironmentUnavailableProvider> = [];
  for (const { instanceId, exit } of described) {
    if (Exit.isSuccess(exit)) {
      providers.push(exit.value);
      continue;
    }
    yield* Effect.logWarning("Provider instance could not be described", {
      environmentId,
      instanceId,
      cause: exit.cause,
    });
    unavailableProviders.push({ instanceId, reason: failureReason(exit.cause) });
  }
  return { providers, unavailableProviders };
});

const optionalWorkspaceRpc: Effect.Effect<Option.Option<EnvironmentWorkspaceRpc>> = Effect.gen(
  function* () {
    const entries = yield* Effect.serviceOption(WorkspaceEntries.WorkspaceEntries);
    const files = yield* Effect.serviceOption(WorkspaceFileSystem.WorkspaceFileSystem);
    const terminals = yield* Effect.serviceOption(TerminalManager.TerminalManager);
    const previews = yield* Effect.serviceOption(PreviewManager.PreviewManager);
    const ports = yield* Effect.serviceOption(PortScanner.PortDiscovery);
    return Option.all({ entries, files, terminals, previews, ports });
  },
);

interface InProcessExecutorInput {
  readonly environmentId: EnvironmentId;
  readonly adapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape;
  readonly paths: ProjectCheckouts.EnvironmentWorkspacePaths;
  readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
  readonly runtimePolicy: RuntimePolicy.RuntimePolicyV2Shape;
  readonly rpc: Option.Option<EnvironmentWorkspaceRpc>;
  readonly hostResources: Option.Option<HostResources.HostResources["Service"]>;
}

/** An executor whose machine is this process. */
const makeInProcessExecutor = (input: InProcessExecutorInput): EnvironmentExecutor => ({
  environmentId: input.environmentId,
  transport: "in-process",
  provider: {
    adapters: input.adapters,
    capabilities: (instanceId) => readLocalProvider(input.adapters, instanceId),
  },
  workspace: {
    paths: input.paths,
    checkpoints: input.checkpoints,
    runtimePolicy: input.runtimePolicy,
    rpc: input.rpc,
  },
  host: {
    describe: Effect.gen(function* () {
      const described = yield* describeLocalProviders(input.environmentId, input.adapters);
      const resources = Option.isSome(input.hostResources)
        ? { hostResources: yield* input.hostResources.value.read, disk: null }
        : undefined;
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      return {
        contractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
        environmentId: input.environmentId,
        transport: "in-process",
        ...described,
        ...(resources === undefined ? {} : { resources }),
        observedAt,
      } satisfies EnvironmentExecutorSnapshot;
    }),
  },
});

const makeRegistry = Effect.fn("EnvironmentExecutor.makeRegistry")(function* (
  hubMachine: EnvironmentExecutor,
) {
  const executors = yield* Ref.make<ReadonlyMap<EnvironmentId, EnvironmentExecutor>>(
    new Map([[hubMachine.environmentId, hubMachine]]),
  );
  const get: EnvironmentExecutorRegistryShape["get"] = (environmentId) =>
    Ref.get(executors).pipe(
      Effect.flatMap((byEnvironment) => {
        const executor = byEnvironment.get(environmentId);
        return executor === undefined
          ? Effect.fail(new EnvironmentExecutorUnavailableError({ environmentId }))
          : Effect.succeed(executor);
      }),
    );
  return EnvironmentExecutorRegistry.of({
    hubMachineEnvironmentId: hubMachine.environmentId,
    get,
    list: Ref.get(executors).pipe(Effect.map((byEnvironment) => [...byEnvironment.keys()])),
    forThread: Effect.fn("EnvironmentExecutorRegistry.forThread")(function* (threadId) {
      return yield* get(yield* resolveThread(threadId));
    }),
    register: Effect.fn("EnvironmentExecutorRegistry.register")(function* (executor) {
      yield* Ref.update(executors, (current) =>
        new Map(current).set(executor.environmentId, executor),
      );
    }),
    unregister: Effect.fn("EnvironmentExecutorRegistry.unregister")(function* (environmentId) {
      if (environmentId === hubMachine.environmentId) return;
      yield* Ref.update(executors, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      });
    }),
  });
});

/** Logs a failed refresh and carries on, so a bad snapshot never stops startup or the heartbeat. */
const logRefreshFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logWarning("Hub machine snapshot refresh failed", { cause }),
    ),
  );

/**
 * The registry with the Hub machine's in-process executor, built over the local adapter registry,
 * runtime policy and checkpoint store. Its snapshot (for Settings and the hello of later tickets)
 * is published at startup, when provider instances change, and on every heartbeat.
 */
export const layerHubMachine: Layer.Layer<
  EnvironmentExecutorRegistry | EnvironmentCapabilityCache,
  never,
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | RuntimePolicy.RuntimePolicyV2
  | CheckpointStore.CheckpointStore
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProjectStore.ProjectStoreV2
> = Layer.effectContext(
  Effect.gen(function* () {
    const hubMachine = makeInProcessExecutor({
      environmentId: HUB_MACHINE_ENVIRONMENT_ID,
      adapters: yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      paths: ProjectCheckouts.hubMachinePaths(yield* ProjectStore.ProjectStoreV2),
      checkpoints: yield* CheckpointStore.CheckpointStore,
      runtimePolicy: yield* RuntimePolicy.RuntimePolicyV2,
      rpc: yield* optionalWorkspaceRpc,
      hostResources: yield* Effect.serviceOption(HostResources.HostResources),
    });
    const registry = yield* makeRegistry(hubMachine);
    const cache = yield* makeCapabilityCache(
      Effect.fn("EnvironmentExecutor.readCapabilities")(function* (environmentId, instanceId) {
        const executor = yield* registry.get(environmentId);
        return yield* executor.provider.capabilities(instanceId);
      }),
    );
    const refreshLock = yield* Semaphore.make(1);
    const refresh = logRefreshFailure(
      refreshLock.withPermits(1)(hubMachine.host.describe.pipe(Effect.flatMap(cache.publish))),
    );

    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    // Startup never waits on the subscription. Refreshing once subscribed covers a change that
    // landed between the first snapshot and the subscription.
    yield* instances.subscribeChanges.pipe(
      Effect.flatMap((instanceChanges) =>
        refresh.pipe(
          Effect.andThen(
            Stream.runForEach(Stream.fromSubscription(instanceChanges), () => refresh),
          ),
        ),
      ),
      Effect.scoped,
      Effect.forkScoped,
    );
    yield* refresh;
    yield* Effect.sleep(HUB_MACHINE_HEARTBEAT_INTERVAL).pipe(
      Effect.andThen(refresh),
      Effect.forever,
      Effect.forkScoped,
    );

    return Context.make(EnvironmentExecutorRegistry, registry).pipe(
      Context.add(EnvironmentCapabilityCache, cache),
    );
  }),
);

/** Capabilities read through to a fixed local adapter registry. For hosts without a registry. */
export const makeLocalCapabilityCache = (
  adapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape,
) =>
  makeCapabilityCache(
    Effect.fn("EnvironmentExecutor.readLocalCapabilities")(function* (environmentId, instanceId) {
      if (environmentId !== HUB_MACHINE_ENVIRONMENT_ID) {
        return yield* new EnvironmentExecutorUnavailableError({ environmentId });
      }
      return yield* readLocalProvider(adapters, instanceId);
    }),
  );

/**
 * `ProviderAdapterRegistryV2` over the executors. Lookups answer from the Hub machine, and a
 * session opens on its Thread's Active environment.
 */
export const layerProviderAdapterRegistry: Layer.Layer<
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  never,
  EnvironmentExecutorRegistry
> = Layer.effect(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  Effect.gen(function* () {
    const registry = yield* EnvironmentExecutorRegistry;
    const hubMachine = yield* registry.get(registry.hubMachineEnvironmentId).pipe(Effect.orDie);
    const local = hubMachine.provider.adapters;
    const routed = (
      adapter: ProviderAdapter.ProviderAdapterV2["Service"],
    ): ProviderAdapter.ProviderAdapterV2["Service"] => ({
      ...adapter,
      openSession: (input) =>
        registry.forThread(input.threadId).pipe(
          Effect.flatMap((executor) =>
            executor.environmentId === hubMachine.environmentId
              ? Effect.succeed(adapter)
              : executor.provider.adapters.get(adapter.instanceId),
          ),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: adapter.driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
          Effect.flatMap((target) => target.openSession(input)),
        ),
    });
    return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: Effect.fn("EnvironmentExecutor.adapters.get")(function* (instanceId) {
        return routed(yield* local.get(instanceId));
      }),
      list: Effect.fn("EnvironmentExecutor.adapters.list")(function* () {
        return yield* local.list();
      }),
      ...(local.getMetadata === undefined ? {} : { getMetadata: local.getMetadata }),
    });
  }),
);

/**
 * A Thread's worktree as the executor's machine sees it. The projection records it as the Hub
 * machine resolves it, so the Hub machine takes it as is; another machine resolves its logical
 * form, the stored one when it matches the recorded path, else one computed against the Hub
 * machine's checkout. Null keeps the executor's own checkout of the Project.
 */
const worktreeOn = Effect.fn("EnvironmentExecutor.worktreeOn")(function* (
  registry: EnvironmentExecutorRegistryShape,
  checkouts: ProjectCheckouts.ProjectCheckouts["Service"],
  executor: EnvironmentExecutor,
  thread: OrchestrationV2AppThread,
) {
  const recorded = thread.worktreePath;
  if (recorded === null || executor.environmentId === registry.hubMachineEnvironmentId) {
    return recorded;
  }
  const stored = yield* checkouts.storedWorktree(thread.id);
  const location =
    Option.isSome(stored) &&
    stored.value.worktreePath === recorded &&
    stored.value.location !== null
      ? stored.value.location
      : locateInCheckout({
          environmentId: registry.hubMachineEnvironmentId,
          checkout: Option.getOrNull(
            yield* (yield* registry.get(registry.hubMachineEnvironmentId)).workspace.paths.checkout(
              thread.projectId,
            ),
          ),
          absolute: recorded,
        });
  return yield* executor.workspace.paths.resolve({ projectId: thread.projectId, location });
});

/** `RuntimePolicyV2` (cwd and sandbox resolution) on the Thread's Active environment. */
export const layerRuntimePolicy: Layer.Layer<
  RuntimePolicy.RuntimePolicyV2,
  never,
  EnvironmentExecutorRegistry | ProjectCheckouts.ProjectCheckouts
> = Layer.effect(
  RuntimePolicy.RuntimePolicyV2,
  Effect.gen(function* () {
    const registry = yield* EnvironmentExecutorRegistry;
    const checkouts = yield* ProjectCheckouts.ProjectCheckouts;
    return RuntimePolicy.RuntimePolicyV2.of({
      resolve: Effect.fn("EnvironmentExecutor.runtimePolicy.resolve")(function* (input) {
        const resolveError = (cause: unknown) =>
          new RuntimePolicy.RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause,
          });
        const executor = yield* registry
          .forThread(input.thread.id)
          .pipe(Effect.mapError(resolveError));
        const worktreePath = yield* worktreeOn(registry, checkouts, executor, input.thread).pipe(
          Effect.mapError(resolveError),
        );
        return yield* executor.workspace.runtimePolicy.resolve({
          ...input,
          thread: { ...input.thread, worktreePath },
        });
      }),
    });
  }),
);

/** `CheckpointStore` on the Environment of the Thread whose effect is running. */
export const layerCheckpointStore: Layer.Layer<
  CheckpointStore.CheckpointStore,
  never,
  EnvironmentExecutorRegistry
> = Layer.effect(
  CheckpointStore.CheckpointStore,
  Effect.gen(function* () {
    const registry = yield* EnvironmentExecutorRegistry;
    const checkpoints = Effect.gen(function* () {
      const executor = yield* registry.get(yield* CheckpointEnvironment);
      return executor.workspace.checkpoints;
    });
    return CheckpointStore.CheckpointStore.of({
      isGitRepository: Effect.fn("EnvironmentExecutor.checkpoints.isGitRepository")(
        function* (input) {
          return yield* (yield* checkpoints).isGitRepository(input);
        },
      ),
      captureCheckpoint: Effect.fn("EnvironmentExecutor.checkpoints.captureCheckpoint")(
        function* (input) {
          return yield* (yield* checkpoints).captureCheckpoint(input);
        },
      ),
      hasCheckpointRef: Effect.fn("EnvironmentExecutor.checkpoints.hasCheckpointRef")(
        function* (input) {
          return yield* (yield* checkpoints).hasCheckpointRef(input);
        },
      ),
      restoreCheckpoint: Effect.fn("EnvironmentExecutor.checkpoints.restoreCheckpoint")(
        function* (input) {
          return yield* (yield* checkpoints).restoreCheckpoint(input);
        },
      ),
      diffCheckpoints: Effect.fn("EnvironmentExecutor.checkpoints.diffCheckpoints")(
        function* (input) {
          return yield* (yield* checkpoints).diffCheckpoints(input);
        },
      ),
      listAuthoredPaths: Effect.fn("EnvironmentExecutor.checkpoints.listAuthoredPaths")(
        function* (input) {
          return yield* (yield* checkpoints).listAuthoredPaths(input);
        },
      ),
      deleteCheckpointRefs: Effect.fn("EnvironmentExecutor.checkpoints.deleteCheckpointRefs")(
        function* (input) {
          return yield* (yield* checkpoints).deleteCheckpointRefs(input);
        },
      ),
    });
  }),
);

/**
 * The workspace RPC services of the Hub machine's executor. A host built without the registry
 * (some ws tests) uses the local services, which are the same in-process implementations.
 */
export const hubMachineWorkspaceRpc: Effect.Effect<
  EnvironmentWorkspaceRpc,
  never,
  | WorkspaceEntries.WorkspaceEntries
  | WorkspaceFileSystem.WorkspaceFileSystem
  | TerminalManager.TerminalManager
  | PreviewManager.PreviewManager
  | PortScanner.PortDiscovery
> = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(EnvironmentExecutorRegistry);
  if (Option.isSome(registry)) {
    const hubMachine = yield* Effect.option(
      registry.value.get(registry.value.hubMachineEnvironmentId),
    );
    if (Option.isSome(hubMachine) && Option.isSome(hubMachine.value.workspace.rpc)) {
      return hubMachine.value.workspace.rpc.value;
    }
  }
  return {
    entries: yield* WorkspaceEntries.WorkspaceEntries,
    files: yield* WorkspaceFileSystem.WorkspaceFileSystem,
    terminals: yield* TerminalManager.TerminalManager,
    previews: yield* PreviewManager.PreviewManager,
    ports: yield* PortScanner.PortDiscovery,
  };
});
