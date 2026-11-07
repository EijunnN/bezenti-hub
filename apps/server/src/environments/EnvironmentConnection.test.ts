import {
  ENVIRONMENT_CLOSE_REASONS,
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

import { addMember, type Server } from "../auth/UserAuth.testkit.ts";
import { formatEnvironmentCredential } from "@t3tools/shared/environmentJoin";
import { hubWithOwner, joinMachine, listEnvironments } from "./environments.testkit.ts";
import { connectOnce, mustRestartAsDedicated } from "./JoinedHub.ts";

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
  workspaceRoot: "/home/ada/.t3/projects",
  orchestration: { providers: [], unavailableProviders: [] },
});

/** The machine's side of one connection; `welcomed` completes when the Hub accepts it. */
const connect = Effect.fn(function* (
  server: Server,
  joined: { readonly credential: string; readonly hubEnvironmentId: string },
  options: {
    readonly protocolVersion?: number;
    readonly expectedHubId?: string;
    /** Runs on the machine just before it sends hello, after the Hub checked its credential. */
    readonly beforeHello?: Effect.Effect<unknown>;
  } = {},
) {
  const welcomed = yield* Deferred.make<EnvironmentWelcomeFrame>();
  const fiber = yield* connectOnce({
    hubUrl: server.url,
    credential: joined.credential,
    expectedHubId: EnvironmentId.make(options.expectedHubId ?? joined.hubEnvironmentId),
    hello: (options.beforeHello ?? Effect.void).pipe(Effect.as(hello(options.protocolVersion))),
    heartbeat: Effect.succeed({ type: "heartbeat", hostResources, disk: null }),
    onWelcome: (welcome) => Deferred.succeed(welcomed, welcome).pipe(Effect.asVoid),
  }).pipe(Effect.forkScoped);
  const outcome = Fiber.join(fiber);
  /** Welcomed, or why the connection ended first. */
  const firstResult = Effect.raceFirst(
    Deferred.await(welcomed).pipe(Effect.as("welcomed" as const)),
    outcome.pipe(Effect.map((ended) => ended.reason ?? "closed")),
  );
  return { welcomed, outcome, firstResult };
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

it.effect(
  "a dedicated machine is welcomed with its mode and Space, which a server running work itself stops on",
  () =>
    Effect.gen(function* () {
      const { server, authenticator, owner } = yield* hubWithOwner({ listen: true });
      const acme = (yield* server.request("/api/spaces/organizations", {
        body: { name: "Acme" },
        cookie: owner,
      })).body.id as string;
      const personal = yield* joinMachine(server, authenticator, owner, "Laptop");
      const dedicated = yield* joinMachine(server, authenticator, owner, "Acme VPS", acme);
      const personalWelcome = yield* Deferred.await((yield* connect(server, personal)).welcomed);
      assert.equal(personalWelcome.mode, "personal");
      assert.isUndefined(personalWelcome.spaceId);
      const welcome = yield* Deferred.await((yield* connect(server, dedicated)).welcomed);
      assert.equal(welcome.mode, "dedicated");
      assert.equal(welcome.spaceId, acme);
      // A server joined as personal (or from before modes) serves no work for a dedicated
      // machine; the Sandbox's server and a server already dedicated do.
      assert.isTrue(mustRestartAsDedicated({}, welcome));
      assert.isTrue(mustRestartAsDedicated({ mode: "personal" }, welcome));
      assert.isFalse(mustRestartAsDedicated({ sandboxed: true }, welcome));
      assert.isFalse(mustRestartAsDedicated({ mode: "dedicated" }, welcome));
      assert.isFalse(mustRestartAsDedicated({}, personalWelcome));
    }),
);

it.effect("a credential another Hub issued is refused", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner({ listen: true });
    const joined = yield* joinMachine(server, authenticator, owner);
    const foreign = formatEnvironmentCredential(
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

it.effect("a machine removed while it connects is not welcomed", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner({ listen: true });
    const joined = yield* joinMachine(server, authenticator, owner);
    // Removed after the Hub checked the credential at the upgrade, before the socket is tracked.
    const connection = yield* connect(server, joined, {
      beforeHello: server.request("/api/environments/remove", {
        cookie: owner,
        body: { environmentId: joined.environmentId },
      }),
    });
    assert.include(["environment-removed", "credential-revoked"], yield* connection.firstResult);
  }),
);

it.effect("a machine whose owner is turned off is refused and disconnected", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner({ listen: true });
    const joined = yield* joinMachine(server, authenticator, owner);
    yield* addMember(server);
    yield* server.sql`
      UPDATE environments SET owner_user_id = 'member-1'
      WHERE environment_id = ${joined.environmentId}
    `;
    const live = yield* connect(server, joined);
    yield* Deferred.await(live.welcomed);
    const disabled = yield* server.request("/api/installation/users/member-1/status", {
      cookie: owner,
      body: { status: "disabled" },
    });
    assert.equal(disabled.status, 200);
    assert.equal((yield* live.outcome).reason, "owner-inactive");
    assert.equal(yield* (yield* connect(server, joined)).firstResult, "credential-revoked");
  }),
);

it.effect("a machine whose owner is off is refused even before its row is revoked", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner({ listen: true });
    const joined = yield* joinMachine(server, authenticator, owner);
    yield* addMember(server);
    yield* server.sql`
      UPDATE environments SET owner_user_id = 'member-1'
      WHERE environment_id = ${joined.environmentId}
    `;
    yield* server.sql`UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_id = 'member-1'`;
    assert.equal(yield* (yield* connect(server, joined)).firstResult, "owner-inactive");
  }),
);

it.effect("the newer connection with the same credential wins, and the older one stops", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner({ listen: true });
    const joined = yield* joinMachine(server, authenticator, owner);
    const older = yield* connect(server, joined);
    yield* Deferred.await(older.welcomed);
    const newer = yield* connect(server, joined);
    yield* Deferred.await(newer.welcomed);
    const ended = yield* older.outcome;
    assert.equal(ended.reason, "replaced");
    assert.isTrue(ENVIRONMENT_CLOSE_REASONS.replaced.final);
    assert.match(ended.message, /another process is using this machine's credential/i);
    assert.equal((yield* listEnvironments(server, owner))[1]!.status, "online");
  }),
);
