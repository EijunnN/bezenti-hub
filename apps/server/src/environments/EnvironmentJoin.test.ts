import { assert, it } from "@effect/vitest";
import { HUB_MACHINE_ENVIRONMENT_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { addMember, passkeyReauth } from "../auth/UserAuth.testkit.ts";
import {
  approveJoin,
  hubWithOwner,
  joinMachine,
  joinStatus,
  listEnvironments,
  loopbackStateOf,
  startJoin,
} from "./environments.testkit.ts";

const OWNER_ONLY = "Only the Owner manages this Hub's Environments.";
const STRONG_FACTOR = "Confirm with your passkey, or with your password and a code from your app.";

it.effect("the Owner registers a machine with a passkey and it joins as their personal one", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner();
    const joined = yield* joinMachine(server, authenticator, owner, "Laptop");
    assert.match(joined.credential, /^t3env\./);

    const environments = yield* listEnvironments(server, owner);
    assert.deepEqual(
      environments.map(({ name, kind, status }) => ({ name, kind, status })),
      [
        { name: "Hub machine", kind: "hub", status: "online" },
        // Never connected yet.
        { name: "Laptop", kind: "external", status: "offline" },
        // The Owner's Personal space's Sandbox, not made until chosen.
        { name: "Personal Sandbox", kind: "sandbox", status: "offline" },
      ],
    );
    assert.equal(environments[0]!.id, HUB_MACHINE_ENVIRONMENT_ID);
    assert.equal(environments[1]!.hostname, "ada-laptop");
    // The list never carries the credential, nor does the Hub keep it.
    assert.notInclude(JSON.stringify(environments), joined.credential);
    const [stored] = yield* server.sql<{ readonly hash: string }>`
      SELECT credential_hash AS hash FROM environments WHERE environment_id = ${joined.environmentId}
    `;
    assert.notEqual(stored!.hash, joined.credential);
    assert.notInclude(stored!.hash, joined.credential.split(".")[2]!);

    const audit = yield* server.request("/api/installation/audit?action=environment.register", {
      cookie: owner,
    });
    const [entry] = audit.body.entries as ReadonlyArray<{
      target: { kind: string; id: string; name: string };
      detail: Record<string, unknown>;
    }>;
    assert.deepEqual(entry!.target, {
      kind: "environment",
      id: joined.environmentId,
      name: "Laptop",
    });
    assert.deepEqual(entry!.detail, { kind: "external", os: "linux" });
  }),
);

it.effect("a Member cannot approve a machine, whatever proof they bring", () =>
  Effect.gen(function* () {
    const { server } = yield* hubWithOwner();
    const member = yield* addMember(server);
    const { requestId } = yield* startJoin(server);
    const refused = yield* approveJoin(server, member, requestId, {
      reauth: { method: "password", password: "anything", totpCode: "123456" },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.message, OWNER_ONLY);
    assert.notProperty(refused.body, "redirectTo");
  }),
);

it.effect("the Owner's approval needs a strong factor in the same request", () =>
  Effect.gen(function* () {
    const { server, owner } = yield* hubWithOwner();
    const { requestId } = yield* startJoin(server);
    // A stolen browser session alone, or a password without a code, adds no machine.
    for (const reauth of [undefined, { method: "password", password: "guess" }]) {
      const refused = yield* approveJoin(
        server,
        owner,
        requestId,
        reauth === undefined ? {} : { reauth },
      );
      assert.equal(refused.status, 403);
      assert.equal(refused.body.message, STRONG_FACTOR);
    }
    // Without the browser's own cookie nothing is approved.
    assert.equal((yield* approveJoin(server, "", requestId)).status, 401);
    assert.equal((yield* joinStatus(server, requestId)).body.status, "pending");
    assert.deepEqual(
      (yield* listEnvironments(server, owner)).map((environment) => environment.kind),
      ["hub", "sandbox"],
    );
  }),
);

it.effect("only the `t3 join` that started a request learns its outcome, as often as it asks", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner();
    const joined = yield* joinMachine(server, authenticator, owner);
    // Another verifier learns nothing.
    const stranger = yield* joinStatus(
      server,
      joined.requestId,
      "another-code-verifier-that-is-long-enough-for-pkce-0123",
    );
    assert.equal(stranger.status, 401);
    // A lost answer is asked for again: the same machine, no second row or audit entry.
    const again = yield* joinStatus(server, joined.requestId);
    assert.deepEqual(again.body, {
      status: "approved",
      environmentId: joined.environmentId,
      hubEnvironmentId: joined.hubEnvironmentId,
      name: "Laptop",
    });
    const reapproved = yield* approveJoin(server, owner, joined.requestId, {
      reauth: yield* passkeyReauth(server, authenticator),
    });
    assert.equal(reapproved.status, 200);
    const [rows] = yield* server.sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM environments WHERE kind = 'external'
    `;
    assert.equal(rows!.count, 1);
    const audit = yield* server.request("/api/installation/audit?action=environment.register", {
      cookie: owner,
    });
    assert.lengthOf(audit.body.entries as ReadonlyArray<unknown>, 1);
    // The credential never crossed the wire from the Hub.
    assert.notInclude(JSON.stringify(again.body), joined.credential);
  }),
);

it.effect("a browser on the machine returns to `t3 join`, and a refusal tells it so", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner();
    const approved = yield* startJoin(server, { loopback: true });
    const decided = yield* approveJoin(server, owner, approved.requestId, {
      reauth: yield* passkeyReauth(server, authenticator),
    });
    assert.equal(loopbackStateOf(decided.body.redirectTo), "state-0123456789abcdef");

    const denied = yield* startJoin(server);
    const refused = yield* server.request("/api/environments/join/deny", {
      cookie: owner,
      body: { requestId: denied.requestId },
    });
    assert.deepEqual(refused.body, { redirectTo: null });
    assert.equal((yield* joinStatus(server, denied.requestId)).body.status, "denied");
    assert.equal((yield* joinStatus(server, "no-such-request-0123")).body.status, "expired");
  }),
);

it.effect("a join request asks only for a loopback return and a well-formed hash", () =>
  Effect.gen(function* () {
    const { server } = yield* hubWithOwner();
    const started = yield* server.request("/api/environments/join/start", {
      body: {
        codeChallenge: "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c",
        codeChallengeMethod: "S256",
        credentialHash: "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c",
        name: "x",
        os: "linux",
        hostname: "x",
        redirectUri: "https://evil.example.com/callback",
        state: "state-0123456789abcdef",
      },
    });
    assert.equal(started.status, 400);
  }),
);

it.effect("a Member sees the Hub machine but not the Owner's personal machines", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner();
    const joined = yield* joinMachine(server, authenticator, owner);
    const member = yield* addMember(server);
    assert.deepEqual(
      (yield* listEnvironments(server, member)).map((environment) => environment.kind),
      ["hub"],
    );
    // Naming it answers like a machine that does not exist.
    for (const path of ["rename", "remove"]) {
      const refused = yield* server.request(`/api/environments/${path}`, {
        cookie: member,
        body: { environmentId: joined.environmentId, name: "Mine now" },
      });
      assert.equal(refused.status, 404);
    }
  }),
);

it.effect("renaming and removing are audited, and the Hub machine stays", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner();
    const joined = yield* joinMachine(server, authenticator, owner);
    const renamed = yield* server.request("/api/environments/rename", {
      cookie: owner,
      body: { environmentId: joined.environmentId, name: "Work laptop" },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, "Work laptop");

    const hubRemoval = yield* server.request("/api/environments/remove", {
      cookie: owner,
      body: { environmentId: HUB_MACHINE_ENVIRONMENT_ID },
    });
    assert.equal(hubRemoval.status, 403);

    const removed = yield* server.request("/api/environments/remove", {
      cookie: owner,
      body: { environmentId: joined.environmentId },
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(
      (removed.body.environments as ReadonlyArray<{ kind: string }>).map((entry) => entry.kind),
      ["hub", "sandbox"],
    );
    // A removed machine's credential no longer even unregisters it.
    const left = yield* server.request("/api/environments/leave", {
      authorization: `Bearer ${joined.credential}`,
      body: {},
    });
    assert.equal(left.status, 401);

    const audit = yield* server.request("/api/installation/audit", { cookie: owner });
    const entries = (
      audit.body.entries as ReadonlyArray<{ action: string; detail: Record<string, unknown> }>
    ).filter((entry) => entry.action.startsWith("environment."));
    assert.deepEqual(
      entries.map(({ action, detail }) => ({ action, detail })),
      [
        { action: "environment.remove", detail: { via: "settings" } },
        { action: "environment.rename", detail: { from: "Laptop", to: "Work laptop" } },
        { action: "environment.register", detail: { kind: "external", os: "linux" } },
      ],
    );
  }),
);

it.effect("`t3 leave` unregisters the machine with its own credential", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner();
    const joined = yield* joinMachine(server, authenticator, owner);
    const overPlainHttp = yield* server.request("/api/environments/leave", {
      authorization: `Bearer ${joined.credential}`,
      peer: "203.0.113.7",
      body: {},
    });
    assert.equal(overPlainHttp.status, 400);
    // The scheme is case-insensitive, as for every other bearer the Hub takes.
    const left = yield* server.request("/api/environments/leave", {
      authorization: `bearer ${joined.credential}`,
      body: {},
    });
    assert.equal(left.status, 200);
    assert.deepEqual(
      (yield* listEnvironments(server, owner)).map((environment) => environment.kind),
      ["hub", "sandbox"],
    );
  }),
);
