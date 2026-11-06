/**
 * One executor per Environment holds everything the Hub needs a machine for. The Hub machine's is
 * in process; the orchestration's adapter registry, runtime policy and checkpoint store forward to
 * the executor of the fiber's `CurrentEnvironment` (`docs/internals/overview.md`).
 */
import {
  ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  ProviderInstanceId,
  type EnvironmentExecutorSnapshot,
  type EnvironmentExecutorTransport,
  type EnvironmentProviderCapabilitySnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";

/** How often the in-process executor republishes its snapshot, like a remote heartbeat. */
export const HUB_MACHINE_HEARTBEAT_INTERVAL = Duration.seconds(10);

export class EnvironmentExecutorUnavailableError extends Schema.TaggedError<EnvironmentExecutorUnavailableError>()(
  "EnvironmentExecutorUnavailableError",
  { environmentId: EnvironmentId },
) {
  override get message(): string {
    return `Environment ${this.environmentId} has no executor.`;
  }
}

export class EnvironmentCapabilitiesUnavailableError extends Schema.TaggedError<EnvironmentCapabilitiesUnavailableError>()(
  "EnvironmentCapabilitiesUnavailableError",
  { environmentId: EnvironmentId, instanceId: ProviderInstanceId },
) {
  override get message(): string {
    return `Environment ${this.environmentId} has not reported provider ${this.instanceId}.`;
  }
}

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
  /** One `ProviderAdapterV2` per provider instance; a session runtime carries turns and events. */
  readonly provider: {
    readonly adapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape;
  };
  readonly workspace: {
    readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
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

/** The Environment whose executor the forwarding services use in this fiber. */
const CurrentEnvironment = Context.Reference<EnvironmentId>(
  "t3/environment/EnvironmentExecutor/CurrentEnvironment",
  { defaultValue: () => HUB_MACHINE_ENVIRONMENT_ID },
);

/** Runs `effect` against the Thread's Active environment. */
export const onActiveEnvironment =
  (threadId: ThreadId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const resolver = yield* ActiveEnvironmentResolver;
      const environmentId = yield* resolver.resolve(threadId);
      return yield* Effect.provideService(effect, CurrentEnvironment, environmentId);
    });

export interface EnvironmentExecutorRegistryShape {
  readonly hubMachineEnvironmentId: EnvironmentId;
  readonly get: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<EnvironmentExecutor, EnvironmentExecutorUnavailableError>;
  readonly list: Effect.Effect<ReadonlyArray<EnvironmentId>>;
  /** The executor of the fiber's `CurrentEnvironment`. */
  readonly current: Effect.Effect<EnvironmentExecutor, EnvironmentExecutorUnavailableError>;
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
  /** Replaces what is known about an Environment; the hello and every heartbeat call it. */
  readonly publish: (snapshot: EnvironmentExecutorSnapshot) => Effect.Effect<void>;
  readonly snapshot: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<Option.Option<EnvironmentExecutorSnapshot>>;
  /** A pure read of the last snapshot: no adapter or network call. */
  readonly provider: (
    environmentId: EnvironmentId,
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<
    EnvironmentProviderCapabilitySnapshot,
    EnvironmentCapabilitiesUnavailableError
  >;
  /** The provider as the Thread's Active environment last reported it. */
  readonly forThread: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }) => Effect.Effect<
    EnvironmentProviderCapabilitySnapshot,
    EnvironmentCapabilitiesUnavailableError
  >;
}

/** Per-Environment provider capabilities. The Orchestrator decides from here, never from an adapter. */
export class EnvironmentCapabilityCache extends Context.Service<
  EnvironmentCapabilityCache,
  EnvironmentCapabilityCacheShape
>()("t3/environment/EnvironmentExecutor/EnvironmentCapabilityCache") {}

const makeCapabilityCache = Effect.gen(function* () {
  const snapshots = yield* Ref.make<ReadonlyMap<EnvironmentId, EnvironmentExecutorSnapshot>>(
    new Map(),
  );
  const provider: EnvironmentCapabilityCacheShape["provider"] = (environmentId, instanceId) =>
    Ref.get(snapshots).pipe(
      Effect.flatMap((byEnvironment) => {
        const found = byEnvironment
          .get(environmentId)
          ?.providers.find((entry) => entry.instanceId === instanceId);
        return found === undefined
          ? Effect.fail(new EnvironmentCapabilitiesUnavailableError({ environmentId, instanceId }))
          : Effect.succeed(found);
      }),
    );
  return EnvironmentCapabilityCache.of({
    publish: Effect.fn("EnvironmentCapabilityCache.publish")(function* (snapshot) {
      yield* Ref.update(snapshots, (current) =>
        new Map(current).set(snapshot.environmentId, snapshot),
      );
    }),
    snapshot: Effect.fn("EnvironmentCapabilityCache.snapshot")(function* (environmentId) {
      return Option.fromUndefinedOr((yield* Ref.get(snapshots)).get(environmentId));
    }),
    provider,
    forThread: Effect.fn("EnvironmentCapabilityCache.forThread")(function* (input) {
      const resolver = yield* ActiveEnvironmentResolver;
      const environmentId = yield* resolver.resolve(input.threadId);
      return yield* provider(environmentId, input.providerInstanceId);
    }),
  });
});

/** Reads every provider instance of a local adapter registry; an instance that fails is left out. */
const describeLocalProviders = Effect.fn("EnvironmentExecutor.describeLocalProviders")(function* (
  adapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape,
) {
  const instanceIds = yield* adapters.list();
  const described = yield* Effect.forEach(instanceIds, (instanceId) =>
    Effect.exit(
      adapters.getMetadata !== undefined
        ? adapters.getMetadata(instanceId).pipe(
            Effect.map(({ driver, ...metadata }) => ({
              instanceId,
              provider: driver,
              ...metadata,
            })),
          )
        : adapters.get(instanceId).pipe(
            Effect.flatMap((adapter) =>
              adapter.getCapabilities().pipe(
                Effect.map((capabilities) => ({
                  instanceId,
                  provider: adapter.driver,
                  continuationKey: `${adapter.driver}:instance:${instanceId}`,
                  enabled: true,
                  capabilities,
                })),
              ),
            ),
          ),
    ),
  );
  const providers: ReadonlyArray<EnvironmentProviderCapabilitySnapshot> = described.flatMap(
    (exit) => (Exit.isSuccess(exit) ? [exit.value] : []),
  );
  return providers;
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
  readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
  readonly runtimePolicy: RuntimePolicy.RuntimePolicyV2Shape;
  readonly rpc: Option.Option<EnvironmentWorkspaceRpc>;
  readonly hostResources: Option.Option<HostResources.HostResources["Service"]>;
}

/** An executor whose machine is this process. */
const makeInProcessExecutor = (input: InProcessExecutorInput): EnvironmentExecutor => ({
  environmentId: input.environmentId,
  transport: "in-process",
  provider: { adapters: input.adapters },
  workspace: {
    checkpoints: input.checkpoints,
    runtimePolicy: input.runtimePolicy,
    rpc: input.rpc,
  },
  host: {
    describe: Effect.gen(function* () {
      const providers = yield* describeLocalProviders(input.adapters);
      const resources = Option.isSome(input.hostResources)
        ? { hostResources: yield* input.hostResources.value.read, disk: null }
        : undefined;
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      return {
        contractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
        environmentId: input.environmentId,
        transport: "in-process",
        providers,
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
    current: Effect.gen(function* () {
      return yield* get(yield* CurrentEnvironment);
    }),
    forThread: Effect.fn("EnvironmentExecutorRegistry.forThread")(function* (threadId) {
      const resolver = yield* ActiveEnvironmentResolver;
      return yield* get(yield* resolver.resolve(threadId));
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

/**
 * The registry with the Hub machine's in-process executor, built over the local adapter registry,
 * runtime policy and checkpoint store. Its snapshot is published once before the layer is ready,
 * again whenever provider instances change, and on every heartbeat interval.
 */
export const layerHubMachine: Layer.Layer<
  EnvironmentExecutorRegistry | EnvironmentCapabilityCache,
  never,
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | RuntimePolicy.RuntimePolicyV2
  | CheckpointStore.CheckpointStore
  | ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effectContext(
  Effect.gen(function* () {
    const hubMachine = makeInProcessExecutor({
      environmentId: HUB_MACHINE_ENVIRONMENT_ID,
      adapters: yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      checkpoints: yield* CheckpointStore.CheckpointStore,
      runtimePolicy: yield* RuntimePolicy.RuntimePolicyV2,
      rpc: yield* optionalWorkspaceRpc,
      hostResources: yield* Effect.serviceOption(HostResources.HostResources),
    });
    const registry = yield* makeRegistry(hubMachine);
    const cache = yield* makeCapabilityCache;
    const publish = hubMachine.host.describe.pipe(Effect.flatMap(cache.publish));

    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    // Subscribing must not hold up startup; the heartbeat covers a change it misses meanwhile.
    yield* instances.subscribeChanges.pipe(
      Effect.flatMap((instanceChanges) =>
        Stream.runForEach(Stream.fromSubscription(instanceChanges), () => publish),
      ),
      Effect.scoped,
      Effect.forkScoped,
    );
    yield* publish;
    yield* Effect.sleep(HUB_MACHINE_HEARTBEAT_INTERVAL).pipe(
      Effect.andThen(publish),
      Effect.forever,
      Effect.forkScoped,
    );

    return Context.make(EnvironmentExecutorRegistry, registry).pipe(
      Context.add(EnvironmentCapabilityCache, cache),
    );
  }),
);

/** A capability cache over a fixed adapter registry, read once. For hosts without a registry. */
export const makeStaticCapabilityCache = Effect.fn("EnvironmentExecutor.makeStaticCapabilityCache")(
  function* (adapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape) {
    const cache = yield* makeCapabilityCache;
    const providers = yield* describeLocalProviders(adapters);
    yield* cache.publish({
      contractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
      environmentId: HUB_MACHINE_ENVIRONMENT_ID,
      transport: "in-process",
      providers,
      observedAt: DateTime.formatIso(yield* DateTime.now),
    });
    return cache;
  },
);

/** `ProviderAdapterRegistryV2` forwarded to the current Environment's executor. */
export const layerProviderAdapterRegistry: Layer.Layer<
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  never,
  EnvironmentExecutorRegistry | EnvironmentCapabilityCache
> = Layer.effect(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  Effect.gen(function* () {
    const registry = yield* EnvironmentExecutorRegistry;
    const cache = yield* EnvironmentCapabilityCache;
    const adaptersFor = (instanceId: ProviderInstanceId) =>
      registry.current.pipe(
        Effect.mapError(
          () => new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
        ),
        Effect.map((executor) => executor.provider.adapters),
      );
    return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: Effect.fn("EnvironmentExecutor.adapters.get")(function* (instanceId) {
        return yield* (yield* adaptersFor(instanceId)).get(instanceId);
      }),
      list: Effect.fn("EnvironmentExecutor.adapters.list")(function* () {
        return yield* registry.current.pipe(
          Effect.flatMap((executor) => executor.provider.adapters.list()),
          Effect.orElseSucceed((): ReadonlyArray<ProviderInstanceId> => []),
        );
      }),
      // Read from the snapshot, so planning a provider switch makes no adapter call.
      getMetadata: Effect.fn("EnvironmentExecutor.adapters.getMetadata")(function* (instanceId) {
        const environmentId = yield* CurrentEnvironment;
        const entry = yield* cache.provider(environmentId, instanceId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRegistry.ProviderAdapterRegistryMetadataError({
                instanceId,
                cause,
              }),
          ),
        );
        return {
          driver: entry.provider,
          continuationKey: entry.continuationKey,
          enabled: entry.enabled,
          capabilities: entry.capabilities,
        };
      }),
    });
  }),
);

const currentExecutorOrDie = (registry: EnvironmentExecutorRegistryShape) =>
  registry.current.pipe(Effect.orDie);

/** `RuntimePolicyV2` (cwd and sandbox resolution) forwarded to the current Environment's executor. */
export const layerRuntimePolicy: Layer.Layer<
  RuntimePolicy.RuntimePolicyV2,
  never,
  EnvironmentExecutorRegistry
> = Layer.effect(
  RuntimePolicy.RuntimePolicyV2,
  Effect.gen(function* () {
    const registry = yield* EnvironmentExecutorRegistry;
    return RuntimePolicy.RuntimePolicyV2.of({
      resolve: Effect.fn("EnvironmentExecutor.runtimePolicy.resolve")(function* (input) {
        const executor = yield* currentExecutorOrDie(registry);
        return yield* executor.workspace.runtimePolicy.resolve(input);
      }),
    });
  }),
);

/** `CheckpointStore` forwarded to the current Environment's executor. */
export const layerCheckpointStore: Layer.Layer<
  CheckpointStore.CheckpointStore,
  never,
  EnvironmentExecutorRegistry
> = Layer.effect(
  CheckpointStore.CheckpointStore,
  Effect.gen(function* () {
    const registry = yield* EnvironmentExecutorRegistry;
    const checkpoints = Effect.map(
      currentExecutorOrDie(registry),
      (executor) => executor.workspace.checkpoints,
    );
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
