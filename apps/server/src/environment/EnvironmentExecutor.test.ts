import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as EnvironmentExecutor from "./EnvironmentExecutor.ts";

const LAPTOP = EnvironmentId.make("environment:laptop");
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");

const makeAdapter = (
  reads: { count: number },
  readSignals?: Queue.Queue<void>,
): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId,
  driver,
  getCapabilities: () =>
    Effect.sync(() => {
      reads.count += 1;
      return CodexProviderCapabilitiesV2;
    }).pipe(
      Effect.tap(() =>
        readSignals === undefined ? Effect.void : Queue.offer(readSignals, undefined),
      ),
    ),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("not opened in these tests"),
});

// Replays the last change, so a publish before the executor subscribes still reaches it.
class InstanceChanges extends Context.Service<InstanceChanges, PubSub.PubSub<void>>()(
  "t3/environment/EnvironmentExecutor.test/InstanceChanges",
) {}

const makeLayer = (hubAdapter: ProviderAdapter.ProviderAdapterV2["Service"]) => {
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
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
        Layer.mock(CheckpointStore.CheckpointStore)({}),
        layerInstances,
      ),
    ),
  );
  return EnvironmentExecutor.layerProviderAdapterRegistry.pipe(
    Layer.provideMerge(layerHubMachine),
    Layer.provideMerge(Layer.effect(InstanceChanges, PubSub.unbounded<void>({ replay: 1 }))),
  );
};

it.effect(
  "the registry holds the Hub machine and routes a Thread to its Active environment",
  () => {
    const hubAdapter = makeAdapter({ count: 0 });
    const laptopAdapter = makeAdapter({ count: 0 });
    return Effect.gen(function* () {
      const registry = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
      const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const threadOnLaptop = ThreadId.make("thread-on-laptop");

      assert.equal(registry.hubMachineEnvironmentId, HUB_MACHINE_ENVIRONMENT_ID);
      assert.deepEqual(yield* registry.list, [HUB_MACHINE_ENVIRONMENT_ID]);
      const hubMachine = yield* registry.forThread(threadOnLaptop);
      assert.equal(hubMachine.environmentId, HUB_MACHINE_ENVIRONMENT_ID);
      assert.equal(hubMachine.transport, "in-process");
      const missing = yield* Effect.flip(registry.get(LAPTOP));
      assert.equal(missing._tag, "EnvironmentExecutorUnavailableError");

      yield* registry.register({
        ...hubMachine,
        environmentId: LAPTOP,
        provider: {
          adapters: {
            get: () => Effect.succeed(laptopAdapter),
            list: () => Effect.succeed([instanceId]),
          },
        },
      });
      const resolver = {
        resolve: (threadId: ThreadId) =>
          Effect.succeed(threadId === threadOnLaptop ? LAPTOP : HUB_MACHINE_ENVIRONMENT_ID),
      };
      const routed = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
        EnvironmentExecutor.onActiveEnvironment(threadId)(effect).pipe(
          Effect.provideService(EnvironmentExecutor.ActiveEnvironmentResolver, resolver),
        );

      assert.strictEqual(yield* adapters.get(instanceId), hubAdapter);
      assert.strictEqual(yield* routed(threadOnLaptop, adapters.get(instanceId)), laptopAdapter);
      assert.strictEqual(
        yield* routed(ThreadId.make("thread-on-hub"), adapters.get(instanceId)),
        hubAdapter,
      );
      const laptop = yield* registry
        .forThread(threadOnLaptop)
        .pipe(Effect.provideService(EnvironmentExecutor.ActiveEnvironmentResolver, resolver));
      assert.equal(laptop.environmentId, LAPTOP);

      yield* registry.unregister(LAPTOP);
      yield* registry.unregister(HUB_MACHINE_ENVIRONMENT_ID);
      assert.deepEqual(yield* registry.list, [HUB_MACHINE_ENVIRONMENT_ID]);
    }).pipe(Effect.provide(makeLayer(hubAdapter)));
  },
);

it.effect("capabilities come from the snapshot, refreshed on instance changes and heartbeats", () =>
  Effect.gen(function* () {
    const reads = { count: 0 };
    const readSignals = yield* Queue.unbounded<void>();
    yield* Effect.gen(function* () {
      const cache = yield* EnvironmentExecutor.EnvironmentCapabilityCache;
      const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const changes = yield* InstanceChanges;
      const threadId = ThreadId.make("capabilities-thread");
      yield* Queue.take(readSignals);
      assert.equal(reads.count, 1);

      const entry = yield* cache.forThread({ threadId, providerInstanceId: instanceId });
      assert.deepEqual(entry.capabilities, CodexProviderCapabilitiesV2);
      assert.equal(entry.driver, driver);
      const metadata = yield* adapters.getMetadata!(instanceId);
      assert.deepEqual(metadata.capabilities, CodexProviderCapabilitiesV2);
      assert.equal(reads.count, 1);

      const unknown = yield* Effect.flip(
        cache.forThread({ threadId, providerInstanceId: ProviderInstanceId.make("claudeAgent") }),
      );
      assert.equal(unknown._tag, "EnvironmentCapabilitiesUnavailableError");

      yield* PubSub.publish(changes, undefined);
      yield* Queue.take(readSignals);
      assert.equal(reads.count, 2);

      yield* TestClock.adjust(EnvironmentExecutor.HUB_MACHINE_HEARTBEAT_INTERVAL);
      yield* Queue.take(readSignals);
      assert.equal(reads.count, 3);
    }).pipe(Effect.provide(makeLayer(makeAdapter(reads, readSignals))));
  }),
);
