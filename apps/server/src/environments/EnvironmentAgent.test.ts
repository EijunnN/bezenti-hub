import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, HUB_MACHINE_ENVIRONMENT_ID } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import * as ServerConfig from "../config.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as EnvironmentAgent from "./EnvironmentAgent.ts";

/** This machine's executor, answering only whether a folder is a repository, and counting. */
const layerMachine = (calls: { count: number }) =>
  Layer.mergeAll(
    Layer.succeed(EnvironmentExecutor.EnvironmentExecutorRegistry, {
      hubMachineEnvironmentId: HUB_MACHINE_ENVIRONMENT_ID,
      get: () =>
        Effect.succeed({
          environmentId: HUB_MACHINE_ENVIRONMENT_ID,
          transport: "in-process",
          provider: {},
          workspace: {
            checkpoints: {
              isGitRepository: () =>
                Effect.sync(() => {
                  calls.count += 1;
                  return calls.count === 1;
                }),
            },
            rpc: Option.none(),
          },
          host: {},
        }),
    } as unknown as EnvironmentExecutor.EnvironmentExecutorRegistry["Service"]),
    McpProviderSessions.layer,
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-environment-agent-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

it.effect("a request resent with its idempotency key runs once and gets the first answer", () => {
  const calls = { count: 0 };
  return Effect.gen(function* () {
    const agent = yield* EnvironmentAgent.make({
      environmentId: EnvironmentId.make("environment:laptop"),
      hubUrl: "http://127.0.0.1:1",
    });
    const written = yield* Queue.unbounded<unknown>();
    const connection = yield* agent.attach((text) =>
      Queue.offer(written, JSON.parse(text)).pipe(Effect.asVoid),
    );
    const request = {
      type: "request",
      requestId: "request-1",
      method: "checkpoint.isGitRepository",
      idempotencyKey: "effect:1:1:checkpoint.isGitRepository:1",
      payload: { cwd: "/repo" },
    };
    yield* connection.receive(request);
    const first = yield* Queue.take(written);
    // The Hub lost the answer and asks again under the same key.
    yield* connection.receive({ ...request, requestId: "request-2" });
    const second = yield* Queue.take(written);

    assert.equal(calls.count, 1);
    assert.deepEqual(first, {
      type: "response",
      requestId: "request-1",
      result: { _tag: "success", value: true },
    });
    assert.deepEqual(second, {
      type: "response",
      requestId: "request-2",
      result: { _tag: "success", value: true },
    });

    // Another key is another call.
    yield* connection.receive({
      ...request,
      requestId: "request-3",
      idempotencyKey: "effect:1:2:checkpoint.isGitRepository:1",
    });
    const third = yield* Queue.take(written);
    assert.equal(calls.count, 2);
    assert.deepEqual(third, {
      type: "response",
      requestId: "request-3",
      result: { _tag: "success", value: false },
    });
  }).pipe(Effect.provide(layerMachine(calls)), Effect.scoped);
});
