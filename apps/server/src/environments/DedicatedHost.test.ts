import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { SandboxRuntime, type SandboxSpec } from "../sandboxes/SandboxRuntime.ts";
import { superviseDedicatedSandbox } from "./DedicatedHost.ts";
import type { JoinedConnectionState } from "./JoinedHub.ts";

const joined = {
  hubUrl: "https://hub.example.com",
  hubEnvironmentId: EnvironmentId.make("hub-1"),
  environmentId: EnvironmentId.make("env-vps"),
  name: "Acme VPS",
  joinedAt: "2026-01-01T00:00:00.000Z",
  mode: "dedicated" as const,
  spaceId: "org-acme",
};

/** A runtime whose server ends at once with exit code 1, recording what it was asked. */
const crashingRuntime = (created: Array<SandboxSpec>, starts: Ref.Ref<number>) =>
  Layer.succeed(
    SandboxRuntime,
    SandboxRuntime.of({
      kind: "process",
      create: (spec) => Effect.sync(() => void created.push(spec)),
      start: () => Ref.update(starts, (n) => n + 1).pipe(Effect.as({ exited: Effect.succeed(1) })),
      stop: () => Effect.void,
      delete: () => Effect.void,
      inspect: () => Effect.succeed({ state: { _tag: "missing" }, homePath: "/nowhere" }),
      exits: Stream.empty,
    }),
  );

it.effect(
  "a dedicated machine's Sandbox gets the machine's credential, restarts with a backoff, and stays failed after too many ends",
  () =>
    Effect.gen(function* () {
      const created: Array<SandboxSpec> = [];
      const starts = yield* Ref.make(0);
      const state = yield* Ref.make<JoinedConnectionState>({
        _tag: "connecting",
        attempt: 0,
        lastError: null,
      });
      const fiber = yield* superviseDedicatedSandbox({
        joined,
        credential: "t3env.secret",
        state,
      }).pipe(Effect.provide(crashingRuntime(created, starts)), Effect.forkChild);
      yield* TestClock.adjust("1 millis");
      assert.equal(created.length, 1);
      assert.equal(created[0]?.environmentId, "env-vps");
      assert.equal(created[0]?.spaceId, "org-acme");
      assert.equal(Redacted.value(created[0]!.credential), "t3env.secret");
      assert.equal(yield* Ref.get(starts), 1);
      const restarting = yield* Ref.get(state);
      assert.equal(restarting._tag === "sandbox" && restarting.state, "restarting");
      // 1, 2 and 4 seconds apart; the fourth end in ten minutes leaves it failed.
      yield* TestClock.adjust("1 second");
      assert.equal(yield* Ref.get(starts), 2);
      yield* TestClock.adjust("2 seconds");
      assert.equal(yield* Ref.get(starts), 3);
      yield* TestClock.adjust("4 seconds");
      assert.equal(yield* Ref.get(starts), 4);
      yield* Fiber.join(fiber);
      const failed = yield* Ref.get(state);
      assert.equal(failed._tag === "sandbox" && failed.state, "failed");
      assert.include(failed._tag === "sandbox" ? failed.message : "", "exit code 1");
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Ref.get(starts), 4);
    }),
);
