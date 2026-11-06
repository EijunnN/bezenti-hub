import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { addMember, passkeyReauth } from "../auth/UserAuth.testkit.ts";
import {
  approveJoin,
  codeOf,
  hubWithOwner,
  joinMachine,
  listEnvironments,
  REDIRECT,
  VERIFIER,
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
      ],
    );
    assert.equal(environments[0]!.id, "environment:hub-machine");
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
    const refused = yield* approveJoin(server, member, {
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
    // A stolen browser session alone, or a password without a code, adds no machine.
    for (const reauth of [undefined, { method: "password", password: "guess" }]) {
      const refused = yield* approveJoin(server, owner, reauth === undefined ? {} : { reauth });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.message, STRONG_FACTOR);
    }
    // An app's bearer token, not the browser's own cookie, does not approve.
    const signedOut = yield* approveJoin(server, "");
    assert.equal(signedOut.status, 401);
    assert.deepEqual(
      (yield* listEnvironments(server, owner)).map((environment) => environment.kind),
      ["hub"],
    );
  }),
);

it.effect("a code is spent on first use and needs its verifier and redirect", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner();
    const approved = yield* approveJoin(server, owner, {
      reauth: yield* passkeyReauth(server, authenticator),
    });
    const code = codeOf(approved.body.redirectTo);
    const wrongVerifier = yield* server.request("/api/environments/join/token", {
      body: { code, codeVerifier: `${VERIFIER}-other`, redirectUri: REDIRECT },
    });
    assert.equal(wrongVerifier.status, 401);
    // Spent by the failed attempt, so the right verifier no longer works either.
    const replay = yield* server.request("/api/environments/join/token", {
      body: { code, codeVerifier: VERIFIER, redirectUri: REDIRECT },
    });
    assert.equal(replay.status, 401);
  }),
);

it.effect("the credential is handed out only over HTTPS or on this machine", () =>
  Effect.gen(function* () {
    const { server, authenticator, owner } = yield* hubWithOwner();
    const approved = yield* approveJoin(server, owner, {
      reauth: yield* passkeyReauth(server, authenticator),
    });
    const overPlainHttp = yield* server.request("/api/environments/join/token", {
      peer: "203.0.113.7",
      body: {
        code: codeOf(approved.body.redirectTo),
        codeVerifier: VERIFIER,
        redirectUri: REDIRECT,
      },
    });
    assert.equal(overPlainHttp.status, 400);
    assert.equal(overPlainHttp.body.reason, "insecure_transport");
    assert.notProperty(overPlainHttp.body, "credential");
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
      body: { environmentId: "environment:hub-machine" },
    });
    assert.equal(hubRemoval.status, 403);

    const removed = yield* server.request("/api/environments/remove", {
      cookie: owner,
      body: { environmentId: joined.environmentId },
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(
      (removed.body.environments as ReadonlyArray<{ kind: string }>).map((entry) => entry.kind),
      ["hub"],
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
    const left = yield* server.request("/api/environments/leave", {
      authorization: `Bearer ${joined.credential}`,
      body: {},
    });
    assert.equal(left.status, 200);
    assert.deepEqual(
      (yield* listEnvironments(server, owner)).map((environment) => environment.kind),
      ["hub"],
    );
  }),
);
