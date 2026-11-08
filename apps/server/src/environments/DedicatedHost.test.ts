// @effect-diagnostics nodeBuiltinImport:off -- compares with the machine's own size.
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  type SandboxLimits,
  SandboxRuntime,
  type SandboxSpec,
  type SandboxStartOptions,
} from "../sandboxes/SandboxRuntime.ts";
import {
  awaitDedicatedRuntime,
  DEDICATED_IMAGE_RECHECK_MS,
  dedicatedHomesIn,
  dedicatedSandboxIdOf,
  type HubAnswer,
  superviseDedicatedSandbox,
} from "./DedicatedHost.ts";
import type { JoinedConnectionState } from "./JoinedHub.ts";
import type { JoinedHubState } from "./joinedHubState.ts";

const joined: JoinedHubState = {
  hubUrl: "https://hub.example.com",
  hubEnvironmentId: EnvironmentId.make("hub-1"),
  environmentId: EnvironmentId.make("env-vps"),
  name: "Acme VPS",
  joinedAt: "2026-01-01T00:00:00.000Z",
  mode: "dedicated",
  spaceId: "org-acme",
};

const NO_LIMITS: SandboxLimits = { cpus: null, memoryBytes: null, pids: null, diskBytes: null };

let issued = 0;
/** The Hub's answer: dedicated to `spaceId` with a new Sandbox credential, or personal. */
const uses = (spaceId: string | null, limits: SandboxLimits = NO_LIMITS): HubAnswer => ({
  _tag: "uses",
  mode: spaceId === null ? "personal" : "dedicated",
  spaceId,
  limits,
  sandboxCredential: spaceId === null ? undefined : `t3env.sandbox-${(issued += 1)}`,
});

/** Dedicated to a Space the Hub no longer has. */
const orphaned: HubAnswer = {
  _tag: "uses",
  mode: "dedicated",
  spaceId: null,
  limits: NO_LIMITS,
  sandboxCredential: undefined,
};

/**
 * A runtime recording what it was asked. Each start's server ends with the exit code the test
 * puts in `ends` (at once when one is waiting).
 */
const makeRuntime = Effect.fn(function* () {
  const created: Array<SandboxSpec> = [];
  const deleted: Array<string> = [];
  const started: Array<string> = [];
  const startOptions: Array<SandboxStartOptions | undefined> = [];
  const ends = yield* Queue.unbounded<number>();
  const layer = Layer.succeed(
    SandboxRuntime,
    SandboxRuntime.of({
      kind: "process",
      create: (spec) => Effect.sync(() => void created.push(spec)),
      start: (sandboxId, options) =>
        Effect.sync(() => {
          started.push(sandboxId);
          startOptions.push(options);
          return { exited: Queue.take(ends), imageVersion: null };
        }),
      imageVersion: Effect.succeed(null),
      stop: () => Effect.void,
      delete: (sandboxId) => Effect.sync(() => void deleted.push(sandboxId)),
      inspect: () => Effect.succeed({ state: { _tag: "missing" }, homePath: "/nowhere" }),
      limitSupport: Effect.succeed({ cpus: true, memory: true, pids: true, note: null }),
      resourceUse: () => Effect.succeed(null),
      measureHome: () => Effect.succeed({ _tag: "unavailable" }),
      hostSpace: Effect.succeed(null),
      exits: Stream.empty,
    }),
  );
  return { created, deleted, started, startOptions, ends, layer };
});

const supervise = Effect.fn(function* (
  runtime: Effect.Success<ReturnType<typeof makeRuntime>>,
  answers: Ref.Ref<HubAnswer>,
  homes: ReadonlyArray<string> = [],
) {
  const state = yield* Ref.make<JoinedConnectionState>({
    _tag: "connecting",
    attempt: 0,
    lastError: null,
  });
  const persisted: Array<JoinedHubState> = [];
  const personal = yield* Deferred.make<JoinedHubState>();
  const fiber = yield* superviseDedicatedSandbox({
    joined,
    state,
    askHub: Ref.get(answers),
    homesOnDisk: Effect.succeed(homes),
    persist: (next) => Effect.sync(() => void persisted.push(next)),
    becomePersonal: (next) => Deferred.succeed(personal, next).pipe(Effect.asVoid),
  }).pipe(Effect.provide(runtime.layer), Effect.forkChild);
  yield* TestClock.adjust("1 millis");
  return { state, persisted, personal, fiber };
});

it.effect(
  "its Sandbox gets the credential the Hub issued it, restarts with a backoff, and stays failed after too many ends",
  () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime();
      for (let end = 0; end < 4; end += 1) yield* Queue.offer(runtime.ends, 1);
      const answers = yield* Ref.make(uses("org-acme"));
      const first = yield* Ref.get(answers);
      const { state, fiber } = yield* supervise(runtime, answers);
      assert.equal(runtime.created.length, 1);
      assert.equal(runtime.created[0]?.sandboxId, dedicatedSandboxIdOf("org-acme"));
      assert.equal(runtime.created[0]?.spaceId, "org-acme");
      assert.equal(
        Redacted.value(runtime.created[0]!.credential),
        first._tag === "uses" ? first.sandboxCredential : undefined,
      );
      assert.equal(runtime.started.length, 1);
      // Each answer issues another: a start after it has it.
      const second = uses("org-acme");
      yield* Ref.set(answers, second);
      // 1, 2 and 4 seconds apart; the fourth end in ten minutes leaves it failed.
      yield* TestClock.adjust("1 second");
      assert.equal(runtime.started.length, 2);
      yield* TestClock.adjust("2 seconds");
      assert.equal(runtime.started.length, 3);
      assert.equal(
        Redacted.value(runtime.created.at(-1)!.credential),
        second._tag === "uses" ? second.sandboxCredential : undefined,
      );
      yield* TestClock.adjust("4 seconds");
      assert.equal(runtime.started.length, 4);
      yield* Fiber.join(fiber);
      const failed = yield* Ref.get(state);
      assert.equal(failed._tag === "sandbox" && failed.state, "failed");
      assert.include(failed._tag === "sandbox" ? failed.message : "", "exit code 1");
      yield* TestClock.adjust("1 hour");
      assert.equal(runtime.started.length, 4);
    }),
);

it.effect(
  "a new Space gets a home of its own and the old one is deleted; other Spaces' homes never stay",
  () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime();
      const answers = yield* Ref.make(uses("org-acme"));
      const { persisted } = yield* supervise(runtime, answers, [
        dedicatedSandboxIdOf("org-acme"),
        dedicatedSandboxIdOf("org-old"),
        ".state",
      ]);
      // A home left from an earlier dedication goes before anything starts.
      assert.deepEqual(runtime.deleted, [dedicatedSandboxIdOf("org-old")]);
      assert.deepEqual(runtime.started, [dedicatedSandboxIdOf("org-acme")]);
      // Dedicated to Globex on the Hub: its server ends, the host asks and follows.
      yield* Ref.set(answers, uses("org-globex"));
      yield* Queue.offer(runtime.ends, 78);
      yield* TestClock.adjust("1 millis");
      assert.deepEqual(runtime.deleted, [
        dedicatedSandboxIdOf("org-old"),
        dedicatedSandboxIdOf("org-acme"),
      ]);
      assert.deepEqual(
        runtime.created.map((spec) => [spec.sandboxId, spec.spaceId]),
        [
          [dedicatedSandboxIdOf("org-acme"), "org-acme"],
          [dedicatedSandboxIdOf("org-globex"), "org-globex"],
        ],
      );
      assert.equal(runtime.started.at(-1), dedicatedSandboxIdOf("org-globex"));
      assert.equal(persisted.at(-1)?.spaceId, "org-globex");
    }),
);

it.effect("made personal on the Hub, it deletes the Space's home and serves as personal", () =>
  Effect.gen(function* () {
    const runtime = yield* makeRuntime();
    const answers = yield* Ref.make(uses("org-acme"));
    const { persisted, personal, fiber } = yield* supervise(runtime, answers);
    yield* Ref.set(answers, uses(null));
    yield* Queue.offer(runtime.ends, 78);
    yield* TestClock.adjust("1 millis");
    yield* Fiber.join(fiber);
    assert.deepEqual(runtime.deleted, [dedicatedSandboxIdOf("org-acme")]);
    const became = yield* Deferred.await(personal);
    assert.equal(became.mode, "personal");
    assert.isUndefined(became.spaceId);
    assert.equal(persisted.at(-1)?.mode, "personal");
    // Its stale home is never started again.
    assert.equal(runtime.started.length, 1);
  }),
);

it.effect(
  "its Space deleted, it deletes the home and waits, then runs for the Space the Owner names",
  () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime();
      const answers = yield* Ref.make(uses("org-acme"));
      const { state, persisted } = yield* supervise(runtime, answers);
      yield* Ref.set(answers, orphaned);
      yield* Queue.offer(runtime.ends, 78);
      yield* TestClock.adjust("1 millis");
      assert.deepEqual(runtime.deleted, [dedicatedSandboxIdOf("org-acme")]);
      assert.isUndefined(persisted.at(-1)?.spaceId);
      const waiting = yield* Ref.get(state);
      assert.equal(waiting._tag === "sandbox" && waiting.state, "restarting");
      yield* TestClock.adjust("30 seconds");
      assert.equal(runtime.started.length, 1);
      // The Owner dedicates it to Globex: the next ask finds it.
      yield* Ref.set(answers, uses("org-globex"));
      yield* TestClock.adjust("10 seconds");
      assert.equal(runtime.started.at(-1), dedicatedSandboxIdOf("org-globex"));
      assert.equal(persisted.at(-1)?.spaceId, "org-globex");
    }),
);

it.effect("its homes on disk are the Sandbox directories, never their logs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dedicated-homes-" });
    yield* fs.makeDirectory(`${root}/${dedicatedSandboxIdOf("org-acme")}`);
    yield* fs.makeDirectory(`${root}/.state`);
    yield* fs.writeFileString(`${root}/${dedicatedSandboxIdOf("org-acme")}.log`, "log\n");
    assert.deepEqual(yield* dedicatedHomesIn(root), [dedicatedSandboxIdOf("org-acme")]);
    assert.deepEqual(yield* dedicatedHomesIn(`${root}/missing`), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a machine the Hub no longer accepts runs nothing", () =>
  Effect.gen(function* () {
    const runtime = yield* makeRuntime();
    const { state, fiber } = yield* supervise(
      runtime,
      yield* Ref.make<HubAnswer>({ _tag: "removed" }),
    );
    yield* Fiber.join(fiber);
    assert.deepEqual(runtime.started, []);
    const failed = yield* Ref.get(state);
    assert.equal(failed._tag === "sandbox" && failed.state, "failed");
  }),
);

it.effect(
  "its Sandbox starts with the Space's limits the Hub answers, and a change applies on its next start",
  () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime();
      const limits = { cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 4096, diskBytes: 20 * 1024 ** 3 };
      const answers = yield* Ref.make(uses("org-acme", limits));
      yield* supervise(runtime, answers);
      assert.deepEqual(runtime.startOptions, [{ limits }]);
      // The Owner gives Acme 1 GiB: the next start (after its server ends) has it.
      const lower = { ...limits, memoryBytes: 1024 ** 3 };
      yield* Ref.set(answers, uses("org-acme", lower));
      yield* Queue.offer(runtime.ends, 1);
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual(runtime.startOptions.at(-1), { limits: lower });
    }),
);

it.effect(
  "limits above what the machine has start at its own size, not refused by its runtime",
  () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime();
      const limits = { cpus: 100_000, memoryBytes: 1024 ** 5, pids: 4096, diskBytes: null };
      yield* supervise(runtime, yield* Ref.make(uses("org-acme", limits)));
      assert.deepEqual(runtime.startOptions, [
        {
          limits: {
            cpus: NodeOS.availableParallelism(),
            memoryBytes: NodeOS.totalmem(),
            pids: 4096,
            diskBytes: null,
          },
        },
      ]);
    }),
);

it.effect("a machine waiting for its image starts once it is built, without a restart", () =>
  Effect.gen(function* () {
    const rechecks: Array<boolean> = [];
    const waiting: Array<string> = [];
    let built = false;
    const fiber = yield* awaitDedicatedRuntime({
      check: (recheck) =>
        Effect.sync(() => {
          rechecks.push(recheck);
          return built
            ? Result.succeed("the runtime")
            : Result.fail({ message: "the image is not built.", waits: true });
        }),
      onWaiting: (message) => Effect.sync(() => void waiting.push(message)),
    }).pipe(Effect.forkChild);
    yield* TestClock.adjust("1 millis");
    assert.deepEqual(rechecks, [false]);
    assert.include(waiting[0] ?? "", "the image is not built.");
    assert.include(waiting[0] ?? "", "starts by itself once it is built");
    yield* TestClock.adjust(DEDICATED_IMAGE_RECHECK_MS);
    // Each later look asks Podman again: what it said at startup is not kept.
    assert.deepEqual(rechecks, [false, true]);
    built = true;
    yield* TestClock.adjust(DEDICATED_IMAGE_RECHECK_MS);
    assert.deepEqual(yield* Fiber.join(fiber), Result.succeed("the runtime"));
    yield* TestClock.adjust("1 hour");
    assert.lengthOf(rechecks, 3);
  }),
);

it.effect("any other reason it cannot run is final", () =>
  Effect.gen(function* () {
    const checks = yield* Ref.make(0);
    const result = yield* awaitDedicatedRuntime({
      check: () =>
        Ref.update(checks, (n) => n + 1).pipe(
          Effect.as(Result.fail({ message: "rootless Podman is not available.", waits: false })),
        ),
      onWaiting: () => Effect.void,
    });
    assert.deepEqual(result, Result.fail("rootless Podman is not available."));
    assert.equal(yield* Ref.get(checks), 1);
  }),
);
