import {
  ENVIRONMENT_CONNECTION_PROTOCOL_VERSION,
  type EnvironmentHelloFrame,
  EnvironmentId,
  type EnvironmentWelcomeFrame,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type { Server } from "../auth/UserAuth.testkit.ts";
import { formatCredential } from "./EnvironmentRegistry.ts";
import { hubWithOwner, joinMachine, listEnvironments } from "./environments.testkit.ts";
import { connectOnce } from "./JoinedHub.ts";

const hostResources = {
  sampledAt: 0,
  cpuUtilization: 0.25,
  cpuCount: 8,
  availableMemoryBytes: 8_000_000_000,
  totalMemoryBytes: 16_000_000_000,
};

const hello = (
  protocolVersion = ENVIRONMENT_CONNECTION_PROTOCOL_VERSION,
): EnvironmentHelloFrame => ({
  type: "hello",
  protocolVersion,
  os: "linux",
  hostname: "ada-laptop",
  providers: [
    {
      instanceId: ProviderInstanceId.make("codex"),
      provider: ProviderDriverKind.make("codex"),
      displayName: null,
      enabled: true,
      installed: true,
      version: "1.2.3",
      capabilities: {
        runtimeModes: ["full-access"],
        conversationRollback: true,
        textGeneration: true,
      },
    },
  ],
  hostResources,
  disk: { totalBytes: 500_000_000_000, availableBytes: 100_000_000_000 },
  sessions: [],
});

/** The machine's side of one connection; `welcomed` completes when the Hub accepts it. */
const connect = Effect.fn(function* (
  server: Server,
  joined: { readonly credential: string; readonly hubEnvironmentId: string },
  options: { readonly protocolVersion?: number; readonly expectedHubId?: string } = {},
) {
  const welcomed = yield* Deferred.make<EnvironmentWelcomeFrame>();
  const fiber = yield* connectOnce({
    hubUrl: server.url,
    credential: joined.credential,
    expectedHubId: EnvironmentId.make(options.expectedHubId ?? joined.hubEnvironmentId),
    hello: Effect.succeed(hello(options.protocolVersion)),
    heartbeat: Effect.succeed({ type: "heartbeat", hostResources, disk: null }),
    onWelcome: (welcome) => Deferred.succeed(welcomed, welcome).pipe(Effect.asVoid),
  }).pipe(Effect.forkScoped);
  return { welcomed, outcome: Fiber.join(fiber) };
});

it.effect("a joined machine says hello and shows online, and removing it closes it at once", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner({ listen: true });
    const joined = yield* joinMachine(server, authenticator, owner);
    const connection = yield* connect(server, joined);
    const welcome = yield* Deferred.await(connection.welcomed);
    assert.equal(welcome.environmentId, joined.environmentId);
    assert.equal(welcome.hubEnvironmentId, joined.hubEnvironmentId);

    const [, laptop] = yield* listEnvironments(server, owner);
    assert.equal(laptop!.status, "online");
    assert.equal(laptop!.hostname, "ada-laptop");
    assert.deepEqual(
      laptop!.providers.map((provider) => provider.instanceId),
      ["codex"],
    );

    const removed = yield* server.request("/api/environments/remove", {
      cookie: owner,
      body: { environmentId: joined.environmentId },
    });
    assert.equal(removed.status, 200);
    // The live socket is closed with a reason the machine stops on.
    assert.equal((yield* connection.outcome).reason, "environment-removed");
    // And its credential is refused on the next connect.
    const again = yield* connect(server, joined);
    const outcome = yield* again.outcome;
    assert.equal(outcome.reason, "credential-revoked");
    assert.isFalse(outcome.welcomed);
  }),
);

it.effect("a credential another Hub issued is refused", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner({ listen: true });
    const joined = yield* joinMachine(server, authenticator, owner);
    const foreign = formatCredential(
      EnvironmentId.make("another-hub"),
      joined.credential.split(".")[2]!,
    );
    const outcome = yield* (yield* connect(server, { ...joined, credential: foreign })).outcome;
    assert.equal(outcome.reason, "credential-other-hub");
    assert.isFalse(outcome.welcomed);
  }),
);

it.effect("the machine refuses a Hub that answers as another one", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner({ listen: true });
    const joined = yield* joinMachine(server, authenticator, owner);
    const outcome = yield* (yield* connect(server, joined, { expectedHubId: "another-hub" }))
      .outcome;
    assert.equal(outcome.reason, "credential-other-hub");
    assert.isFalse(outcome.welcomed);
  }),
);

it.effect("an incompatible protocol version is refused with its reason", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner({ listen: true });
    const joined = yield* joinMachine(server, authenticator, owner);
    const outcome = yield* (yield* connect(server, joined, { protocolVersion: 999 })).outcome;
    assert.equal(outcome.reason, "incompatible-version");
    assert.equal((yield* listEnvironments(server, owner))[1]!.status, "offline");
  }),
);
