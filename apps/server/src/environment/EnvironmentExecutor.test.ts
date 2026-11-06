import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as EnvironmentExecutor from "./EnvironmentExecutor.ts";
import * as ProjectCheckouts from "./ProjectCheckouts.ts";
import type { WorkspaceLocation } from "./WorkspaceLocation.ts";

const LAPTOP = EnvironmentId.make("environment:laptop");
const NOWHERE = EnvironmentId.make("environment:nowhere");
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const THREAD_ON_LAPTOP = ThreadId.make("thread-on-laptop");
const THREAD_ON_HUB = ThreadId.make("thread-on-hub");
const THREAD_NOWHERE = ThreadId.make("thread-nowhere");

const policyAt = (cwd: string): ProviderAdapter.ProviderAdapterV2RuntimePolicy => ({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd,
});

const PROJECT = ProjectId.make("project");
const HUB_CHECKOUT = "/srv/hub/web";

const threadRecord = (id: ThreadId, worktreePath: string | null = null) =>
  ({ id, projectId: PROJECT, worktreePath }) as unknown as OrchestrationV2AppThread;

const projects = {
  get: (projectId: ProjectId) =>
    Effect.succeed(
      projectId === PROJECT
        ? Option.some({ workspaceRoot: HUB_CHECKOUT } as ProjectStore.ProjectRow)
        : Option.none(),
    ),
} as unknown as ProjectStore.ProjectStoreV2["Service"];
const layerProjects = Layer.succeed(ProjectStore.ProjectStoreV2, projects);

interface AdapterProbe {
  readonly reads: { count: number };
  readonly opened: Array<string>;
  readonly readSignals?: Queue.Queue<void>;
}

const makeAdapter = (
  label: string,
  probe: AdapterProbe,
  capabilities = CodexProviderCapabilitiesV2,
): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId,
  driver,
  getCapabilities: () =>
    Effect.sync(() => {
      probe.reads.count += 1;
      return capabilities;
    }).pipe(
      Effect.tap(() =>
        probe.readSignals === undefined ? Effect.void : Queue.offer(probe.readSignals, undefined),
      ),
    ),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () =>
    Effect.sync(() => probe.opened.push(label)).pipe(Effect.andThen(Effect.die("opened"))),
});

const newProbe = (readSignals?: Queue.Queue<void>): AdapterProbe => ({
  reads: { count: 0 },
  opened: [],
  ...(readSignals === undefined ? {} : { readSignals }),
});

// Replays the last change, so a publish before the executor subscribes still reaches it.
class InstanceChanges extends Context.Service<InstanceChanges, PubSub.PubSub<void>>()(
  "t3/environment/EnvironmentExecutor.test/InstanceChanges",
) {}

interface FakeCheckouts {
  readonly chosen: Map<ProjectId, string>;
  readonly stored: Map<ThreadId, { worktreePath: string | null; location: WorkspaceLocation }>;
}

const fakeCheckouts = (state: FakeCheckouts) =>
  ProjectCheckouts.ProjectCheckouts.of({
    chosen: ({ projectId }) => Effect.succeed(Option.fromUndefinedOr(state.chosen.get(projectId))),
    choose: () => Effect.void,
    storedWorktree: (threadId) =>
      Effect.succeed(Option.fromUndefinedOr(state.stored.get(threadId))),
  });

const makeLayer = (
  hubAdapter: ProviderAdapter.ProviderAdapterV2["Service"],
  checkouts: FakeCheckouts = { chosen: new Map(), stored: new Map() },
) => {
  const layerInstances = Layer.unwrap(
    Effect.gen(function* () {
      const changes = yield* InstanceChanges;
      return Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        subscribeChanges: PubSub.subscribe(changes),
      });
    }),
  );
  const layerHubMachine = EnvironmentExecutor.layerHubMachine.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProviderAdapterRegistry.layerFromAdapters([hubAdapter]),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: ({ thread }) => Effect.succeed(policyAt(thread.worktreePath ?? "/hub")),
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(true),
        }),
        layerInstances,
        layerProjects,
      ),
    ),
  );
  return Layer.mergeAll(
    EnvironmentExecutor.layerProviderAdapterRegistry,
    EnvironmentExecutor.layerRuntimePolicy,
    EnvironmentExecutor.layerCheckpointStore,
  ).pipe(
    Layer.provideMerge(layerHubMachine),
    Layer.provideMerge(Layer.succeed(ProjectCheckouts.ProjectCheckouts, fakeCheckouts(checkouts))),
    Layer.provideMerge(Layer.effect(InstanceChanges, PubSub.unbounded<void>({ replay: 1 }))),
  );
};

const resolver = {
  resolve: (threadId: ThreadId) =>
    Effect.succeed(
      threadId === THREAD_ON_LAPTOP
        ? LAPTOP
        : threadId === THREAD_NOWHERE
          ? NOWHERE
          : HUB_MACHINE_ENVIRONMENT_ID,
    ),
};
const withResolver = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, EnvironmentExecutor.ActiveEnvironmentResolver, resolver);
const onThread =
  (threadId: ThreadId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withResolver(EnvironmentExecutor.onActiveEnvironment(threadId)(effect));

/** Registers a laptop executor whose adapter, policy and capabilities differ from the Hub's. */
const registerLaptop = (laptopAdapter: ProviderAdapter.ProviderAdapterV2["Service"]) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
    const hubMachine = yield* registry.get(HUB_MACHINE_ENVIRONMENT_ID);
    yield* registry.register({
      ...hubMachine,
      environmentId: LAPTOP,
      transport: "remote",
      provider: {
        adapters: {
          get: () => Effect.succeed(laptopAdapter),
          list: () => Effect.succeed([instanceId]),
        },
        capabilities: (requested) =>
          Effect.succeed({
            instanceId: requested,
            provider: driver,
            enabled: true,
            continuationKey: "laptop",
            capabilities: ClaudeProviderCapabilitiesV2,
          }),
      },
      workspace: {
        ...hubMachine.workspace,
        runtimePolicy: { resolve: () => Effect.succeed(policyAt("/laptop")) },
      },
    });
  });

const openFor = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const adapter = yield* adapters.get(instanceId);
    yield* Effect.exit(
      Effect.scoped(
        adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`session:${threadId}`),
          modelSelection,
          runtimePolicy: policyAt("/unused"),
        }),
      ),
    );
  });

it.effect(
  "the registry holds the Hub machine and opens a session on its Thread's Environment",
  () => {
    const hubProbe = newProbe();
    const laptopProbe = newProbe();
    return Effect.gen(function* () {
      const registry = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
      assert.equal(registry.hubMachineEnvironmentId, HUB_MACHINE_ENVIRONMENT_ID);
      assert.deepEqual(yield* registry.list, [HUB_MACHINE_ENVIRONMENT_ID]);
      const hubMachine = yield* registry.forThread(THREAD_ON_LAPTOP);
      assert.equal(hubMachine.environmentId, HUB_MACHINE_ENVIRONMENT_ID);
      assert.equal(hubMachine.transport, "in-process");
      assert.equal(
        (yield* Effect.flip(registry.get(LAPTOP)))._tag,
        "EnvironmentExecutorUnavailableError",
      );

      yield* registerLaptop(makeAdapter("laptop", laptopProbe));
      yield* withResolver(openFor(THREAD_ON_LAPTOP));
      yield* withResolver(openFor(THREAD_ON_HUB));
      assert.deepEqual(laptopProbe.opened, ["laptop"]);
      assert.deepEqual(hubProbe.opened, ["hub"]);
      assert.equal(
        (yield* withResolver(registry.forThread(THREAD_ON_LAPTOP))).environmentId,
        LAPTOP,
      );

      yield* registry.unregister(LAPTOP);
      yield* registry.unregister(HUB_MACHINE_ENVIRONMENT_ID);
      assert.deepEqual(yield* registry.list, [HUB_MACHINE_ENVIRONMENT_ID]);
    }).pipe(Effect.provide(makeLayer(makeAdapter("hub", hubProbe))));
  },
);

it.effect(
  "work for another Thread inside a Thread's effect uses that other Thread's Environment",
  () => {
    const hubProbe = newProbe();
    const laptopProbe = newProbe();
    return Effect.gen(function* () {
      const policies = yield* RuntimePolicy.RuntimePolicyV2;
      const cache = yield* EnvironmentExecutor.EnvironmentCapabilityCache;
      yield* registerLaptop(makeAdapter("laptop", laptopProbe));

      // An effect for the laptop Thread dispatches to a Thread on the Hub machine.
      yield* onThread(THREAD_ON_LAPTOP)(
        Effect.gen(function* () {
          const policy = yield* policies.resolve({
            thread: threadRecord(THREAD_ON_HUB),
            modelSelection,
          });
          assert.equal(policy.cwd, "/hub");
          yield* openFor(THREAD_ON_HUB);
          const entry = yield* cache.forThread({
            threadId: THREAD_ON_HUB,
            providerInstanceId: instanceId,
          });
          assert.deepEqual(entry.capabilities, CodexProviderCapabilitiesV2);

          const own = yield* policies.resolve({
            thread: threadRecord(THREAD_ON_LAPTOP),
            modelSelection,
          });
          assert.equal(own.cwd, "/laptop");
        }),
      );
      assert.deepEqual(hubProbe.opened, ["hub"]);
      assert.deepEqual(laptopProbe.opened, []);
    }).pipe(Effect.provide(makeLayer(makeAdapter("hub", hubProbe))));
  },
);

it.effect("a Thread whose Environment has no executor fails with a typed error", () =>
  Effect.gen(function* () {
    const policies = yield* RuntimePolicy.RuntimePolicyV2;
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const policyError = yield* Effect.flip(
      withResolver(policies.resolve({ thread: threadRecord(THREAD_NOWHERE), modelSelection })),
    );
    assert.equal(policyError._tag, "RuntimePolicyResolveError");
    const checkpointError = yield* Effect.flip(
      onThread(THREAD_NOWHERE)(checkpoints.isGitRepository("/repo")),
    );
    assert.equal(checkpointError._tag, "EnvironmentExecutorUnavailableError");
  }).pipe(Effect.provide(makeLayer(makeAdapter("hub", newProbe())))),
);

it.effect("the Hub machine reads capabilities from its live adapters", () => {
  const probe = newProbe();
  return Effect.gen(function* () {
    const cache = yield* EnvironmentExecutor.EnvironmentCapabilityCache;
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const before = probe.reads.count;
    const entry = yield* cache.forThread({
      threadId: THREAD_ON_HUB,
      providerInstanceId: instanceId,
    });
    assert.deepEqual(entry.capabilities, CodexProviderCapabilitiesV2);
    assert.equal(entry.provider, driver);
    assert.equal(probe.reads.count, before + 1);
    const unknown = yield* Effect.flip(
      cache.forThread({
        threadId: THREAD_ON_HUB,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      }),
    );
    // The local registry's own error, not a generic one.
    assert.equal(unknown._tag, "ProviderAdapterRegistryLookupError");
    assert.equal(
      (yield* Effect.flip(adapters.get(ProviderInstanceId.make("claudeAgent"))))._tag,
      "ProviderAdapterRegistryLookupError",
    );
  }).pipe(Effect.provide(makeLayer(makeAdapter("hub", probe))));
});

it.effect(
  "the Hub machine's snapshot refreshes on instance changes and heartbeats, newest wins",
  () =>
    Effect.gen(function* () {
      const readSignals = yield* Queue.unbounded<void>();
      yield* Effect.gen(function* () {
        const cache = yield* EnvironmentExecutor.EnvironmentCapabilityCache;
        const changes = yield* InstanceChanges;
        yield* Queue.take(readSignals);
        const first = yield* cache.snapshot(HUB_MACHINE_ENVIRONMENT_ID);
        assert.equal(first._tag, "Some");
        if (first._tag !== "Some") return;
        assert.deepEqual(
          first.value.providers.map((entry) => entry.instanceId),
          [instanceId],
        );

        yield* PubSub.publish(changes, undefined);
        yield* Queue.take(readSignals);
        yield* TestClock.adjust(EnvironmentExecutor.HUB_MACHINE_HEARTBEAT_INTERVAL);
        yield* Queue.take(readSignals);
        const latest = yield* cache.snapshot(HUB_MACHINE_ENVIRONMENT_ID);
        assert.equal(latest._tag, "Some");
        if (latest._tag !== "Some") return;

        // An older snapshot arriving late never replaces a newer one.
        yield* cache.publish({
          ...latest.value,
          providers: [],
          observedAt: "1970-01-01T00:00:00.000Z",
        });
        const kept = yield* cache.snapshot(HUB_MACHINE_ENVIRONMENT_ID);
        assert.deepEqual(kept, latest);
      }).pipe(Effect.provide(makeLayer(makeAdapter("hub", newProbe(readSignals)))));
    }),
);

it.effect("a remote Environment's capabilities come from its last snapshot", () =>
  Effect.gen(function* () {
    const cache = yield* EnvironmentExecutor.EnvironmentCapabilityCache;
    const missing = yield* Effect.flip(cache.snapshotProvider(LAPTOP, instanceId));
    assert.equal(missing._tag, "EnvironmentCapabilitiesUnavailableError");
    const base = {
      contractVersion: 1,
      environmentId: LAPTOP,
      transport: "remote" as const,
      unavailableProviders: [],
    };
    yield* cache.publish({
      ...base,
      providers: [
        {
          instanceId,
          provider: driver,
          enabled: true,
          continuationKey: "laptop",
          capabilities: ClaudeProviderCapabilitiesV2,
        },
      ],
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    const entry = yield* cache.snapshotProvider(LAPTOP, instanceId);
    assert.deepEqual(entry.capabilities, ClaudeProviderCapabilitiesV2);
    yield* cache.publish({
      ...base,
      providers: [],
      unavailableProviders: [{ instanceId, reason: "codex is not installed" }],
      observedAt: "2026-01-01T00:00:10.000Z",
    });
    const gone = yield* Effect.flip(cache.snapshotProvider(LAPTOP, instanceId));
    assert.equal(gone._tag, "EnvironmentCapabilitiesUnavailableError");
    assert.equal(gone.reason, "codex is not installed");
  }).pipe(Effect.provide(makeLayer(makeAdapter("hub", newProbe())))),
);

it.effect("the same Thread resolves to each Environment's own checkout", () => {
  const state: FakeCheckouts = { chosen: new Map(), stored: new Map() };
  return Effect.gen(function* () {
    const registry = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
    const policies = yield* RuntimePolicy.RuntimePolicyV2;
    const hubMachine = yield* registry.get(HUB_MACHINE_ENVIRONMENT_ID);
    const paths = ProjectCheckouts.environmentPaths({
      environmentId: LAPTOP,
      workspaceRoot: "/home/ana/work",
      checkouts: fakeCheckouts(state),
      projects,
    });
    yield* registry.register({
      ...hubMachine,
      environmentId: LAPTOP,
      transport: "remote",
      workspace: {
        ...hubMachine.workspace,
        paths,
        runtimePolicy: {
          resolve: ({ thread }) =>
            (thread.worktreePath === null
              ? paths.checkout(thread.projectId).pipe(Effect.map(Option.getOrThrow))
              : Effect.succeed(thread.worktreePath)
            ).pipe(Effect.map(policyAt), Effect.orDie),
        },
      },
    });

    const cwdOn = (threadId: ThreadId, worktreePath: string | null) =>
      withResolver(
        policies.resolve({ thread: threadRecord(threadId, worktreePath), modelSelection }),
      ).pipe(Effect.map((policy) => policy.cwd));
    const inCheckout = `${HUB_CHECKOUT}/packages/app`;
    assert.equal(yield* cwdOn(THREAD_ON_HUB, inCheckout), inCheckout);
    assert.equal(yield* cwdOn(THREAD_ON_LAPTOP, inCheckout), "/home/ana/work/web/packages/app");
    assert.equal(yield* cwdOn(THREAD_ON_HUB, null), "/hub");
    assert.equal(yield* cwdOn(THREAD_ON_LAPTOP, null), "/home/ana/work/web");

    state.chosen.set(PROJECT, "/home/ana/src/web-checkout");
    assert.equal(
      yield* cwdOn(THREAD_ON_LAPTOP, inCheckout),
      "/home/ana/src/web-checkout/packages/app",
    );

    // A managed worktree lives outside the checkout: only the machine that made it has it.
    const worktree = "/srv/hub/.t3/worktrees/web/feature";
    assert.equal(yield* cwdOn(THREAD_ON_HUB, worktree), worktree);
    const elsewhere = yield* Effect.flip(cwdOn(THREAD_ON_LAPTOP, worktree));
    assert.equal(elsewhere._tag, "RuntimePolicyResolveError");

    // The stored logical form wins while it matches the recorded path, so a Project root that
    // moved since does not make the worktree host-bound.
    const moved = "/srv/old/web/packages/app";
    state.chosen.clear();
    state.stored.set(THREAD_ON_LAPTOP, {
      worktreePath: moved,
      location: { base: "checkout", path: "packages/app" },
    });
    assert.equal(yield* cwdOn(THREAD_ON_LAPTOP, moved), "/home/ana/work/web/packages/app");
    assert.equal(yield* cwdOn(THREAD_ON_HUB, moved), moved);
    // A recorded path newer than the stored row is located afresh.
    assert.equal(yield* cwdOn(THREAD_ON_LAPTOP, `${HUB_CHECKOUT}/docs`), "/home/ana/work/web/docs");
  }).pipe(Effect.provide(makeLayer(makeAdapter("hub", newProbe()), state)));
});
