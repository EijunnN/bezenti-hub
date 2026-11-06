import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as JoinedWorkspaceRoots from "../workspace/JoinedWorkspaceRoots.ts";
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
  }).pipe(
    Effect.provide(layerMachine(calls)),
    Effect.provide(JoinedWorkspaceRoots.layer.pipe(Layer.provide(NodeServices.layer))),
    Effect.scoped,
  );
});

/** A machine whose provider sessions end when the test says, each telling when its process went. */
const layerSessions = (
  sessions: Map<string, { end: Effect.Effect<void>; closed: Deferred.Deferred<void> }>,
) =>
  Layer.mergeAll(
    Layer.succeed(EnvironmentExecutor.EnvironmentExecutorRegistry, {
      hubMachineEnvironmentId: HUB_MACHINE_ENVIRONMENT_ID,
      get: () =>
        Effect.succeed({
          environmentId: HUB_MACHINE_ENVIRONMENT_ID,
          transport: "in-process",
          provider: {
            adapters: {
              get: () =>
                Effect.succeed({
                  instanceId: INSTANCE,
                  driver: DRIVER,
                  openSession: (input: { readonly providerSessionId: string }) =>
                    Effect.gen(function* () {
                      const events = yield* Queue.unbounded<never, Cause.Done>();
                      const closed = yield* Deferred.make<void>();
                      yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
                      sessions.set(input.providerSessionId, {
                        end: Queue.end(events).pipe(Effect.asVoid),
                        closed,
                      });
                      return {
                        instanceId: INSTANCE,
                        driver: DRIVER,
                        providerSessionId: input.providerSessionId,
                        providerSession: {
                          id: input.providerSessionId,
                          driver: DRIVER,
                          providerInstanceId: INSTANCE,
                          status: "ready",
                          cwd: "/repo",
                          model: null,
                          capabilities: ClaudeProviderCapabilitiesV2,
                          createdAt: DateTime.makeUnsafe(0),
                          updatedAt: DateTime.makeUnsafe(0),
                          lastError: null,
                        },
                        events: Stream.fromQueue(events),
                      };
                    }),
                }),
            },
          },
          workspace: { rpc: Option.none() },
          host: { describe: Effect.succeed({ providers: [], unavailableProviders: [] }) },
        }),
    } as unknown as EnvironmentExecutor.EnvironmentExecutorRegistry["Service"]),
    McpProviderSessions.layer,
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-environment-agent-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const INSTANCE = ProviderInstanceId.make("claudeAgent");
const DRIVER = ProviderDriverKind.make("claudeAgent");
const THREAD = ThreadId.make("thread:agent");

const openRequest = (providerSessionId: string, credentialId: string) => ({
  type: "request",
  requestId: `open:${providerSessionId}`,
  method: "provider.openSession",
  payload: {
    threadId: THREAD,
    providerSessionId,
    instanceId: INSTANCE,
    modelSelection: { instanceId: INSTANCE, model: "claude-sonnet-4-6" },
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/repo" },
    mcp: {
      credentialId,
      authorizationHeader: `Bearer ${credentialId}`,
      browserToolsAvailable: false,
      capabilities: ["orchestration"],
    },
  },
});

/** A socket to the Hub in its own scope, and the frames the machine wrote on it. */
const connect = Effect.fn(function* (agent: EnvironmentAgent.EnvironmentAgent["Service"]) {
  const socket = yield* Scope.fork(yield* Effect.scope);
  const written = yield* Queue.unbounded<Record<string, unknown>>();
  const connection = yield* agent
    .attach((text) => Queue.offer(written, JSON.parse(text)).pipe(Effect.asVoid))
    .pipe(Effect.provideService(Scope.Scope, socket));
  return { ...connection, next: Queue.take(written), close: Scope.close(socket, Exit.void) };
});

it.effect("a session that ends while the Hub is away is reported when the socket returns", () => {
  const sessions = new Map<string, { end: Effect.Effect<void>; closed: Deferred.Deferred<void> }>();
  return Effect.gen(function* () {
    const agent = yield* EnvironmentAgent.make({
      environmentId: EnvironmentId.make("environment:laptop"),
      hubUrl: "http://127.0.0.1:1",
    });
    const first = yield* connect(agent);
    yield* first.receive(openRequest("session-1", "credential-1"));
    assert.deepInclude(yield* first.next, { type: "response", requestId: "open:session-1" });
    yield* first.close;
    const session = sessions.get("session-1")!;
    yield* session.end;
    yield* Deferred.await(session.closed);

    const second = yield* connect(agent);
    assert.deepEqual(yield* second.next, {
      type: "event",
      method: "provider.sessionEnded",
      payload: { providerSessionId: "session-1", seq: 1 },
    });
  }).pipe(
    Effect.provide(layerSessions(sessions)),
    Effect.provide(JoinedWorkspaceRoots.layer.pipe(Layer.provide(NodeServices.layer))),
    Effect.scoped,
  );
});

it.effect(
  "a session the Hub retired goes, and an older session never takes a newer credential",
  () => {
    const sessions = new Map<
      string,
      { end: Effect.Effect<void>; closed: Deferred.Deferred<void> }
    >();
    return Effect.gen(function* () {
      const agent = yield* EnvironmentAgent.make({
        environmentId: EnvironmentId.make("environment:laptop"),
        hubUrl: "http://127.0.0.1:1",
      });
      const mcp = yield* McpProviderSessions.McpProviderSessions;
      const socket = yield* connect(agent);
      yield* socket.receive(openRequest("session-old", "credential-old"));
      yield* socket.next;
      yield* socket.receive(openRequest("session-new", "credential-new"));
      yield* socket.next;
      yield* socket.receive({
        type: "request",
        requestId: "detach:session-old",
        method: "provider.detach",
        payload: { providerSessionId: "session-old", input: {} },
      });
      yield* socket.next;
      assert.equal((yield* mcp.read(THREAD))?.providerSessionId, "credential-new");

      // The Hub came back without this session: the machine lets its process go.
      yield* socket.receive({
        type: "event",
        method: "provider.retired",
        payload: { providerSessionIds: ["session-new"] },
      });
      yield* Deferred.await(sessions.get("session-new")!.closed);
      assert.deepEqual((yield* agent.report).sessions, []);
    }).pipe(
      Effect.provide(layerSessions(sessions)),
      Effect.provide(JoinedWorkspaceRoots.layer.pipe(Layer.provide(NodeServices.layer))),
      Effect.scoped,
    );
  },
);
