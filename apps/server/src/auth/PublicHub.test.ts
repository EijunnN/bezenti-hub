import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { OwnerPresence } from "./OwnerPresence.ts";
import {
  addMember,
  bootstrapOwner,
  makeAuthenticator,
  serveAuthHttp,
  serveAuthHttpWith,
  type Server,
} from "./UserAuth.testkit.ts";

const PASSWORD = "correct horse battery";

const withPasswordMember = Effect.fn(function* (server: Server) {
  const cookie = yield* addMember(server);
  const set = yield* server.request("/api/auth/account/password", {
    body: { loginName: "grace", password: PASSWORD },
    cookie,
  });
  expect(set.status).toBe(200);
});

const signIn = (
  server: Server,
  options: { readonly peer?: string; readonly headers?: Record<string, string> },
  password = PASSWORD,
) =>
  server.request("/api/auth/password/sign-in", {
    body: { loginName: "grace", password },
    ...options,
  });

it.effect("refuses a browser session over plain HTTP from off this machine", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    yield* withPasswordMember(server);

    const remote = yield* signIn(server, { peer: "203.0.113.5" });
    expect(remote.status).toBe(400);
    expect(remote.body).toMatchObject({ reason: "insecure_transport" });
    expect(remote.cookie).toBeUndefined();

    const local = yield* signIn(server, { peer: "127.0.0.1" });
    expect(local.status).toBe(200);
    expect(local.setCookie).not.toMatch(/;\s*Secure/i);
  }),
);

it.effect("ignores a spoofed X-Forwarded-Proto from a peer that is not a trusted proxy", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    yield* withPasswordMember(server);

    const spoofed = yield* signIn(server, {
      peer: "203.0.113.5",
      headers: { "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "https" },
    });
    expect(spoofed.status).toBe(400);
  }),
);

it.effect("issues a Secure session cookie to a client a trusted proxy forwards over HTTPS", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    yield* withPasswordMember(server);

    const forwarded = yield* signIn(server, {
      peer: "127.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.7", "x-forwarded-proto": "https" },
    });
    expect(forwarded.status).toBe(200);
    expect(forwarded.setCookie).toMatch(/;\s*Secure/i);
    const sessions = yield* server.sessions.listActive();
    expect(sessions.map((session) => session.client.ipAddress)).toContain("198.51.100.7");

    const plain = yield* signIn(server, {
      peer: "127.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.7", "x-forwarded-proto": "http" },
    });
    expect(plain.status).toBe(400);
  }),
);

it.effect("backs off each forwarded client on its own, not the proxy's address", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const from = (client: string) => ({
      peer: "127.0.0.1",
      headers: { "x-forwarded-for": client, "x-forwarded-proto": "https" },
    });
    const guess = (client: string) =>
      server.request("/api/auth/password/sign-in", {
        body: { loginName: "nobody", password: "wrong horse battery" },
        ...from(client),
      });

    for (let failure = 0; failure < 5; failure += 1) {
      expect((yield* guess("198.51.100.7")).status).toBe(401);
    }
    expect((yield* guess("198.51.100.7")).status).toBe(429);
    expect((yield* guess("198.51.100.8")).status).toBe(401);
  }),
);

it.effect("opens the listener to every peer once the Owner exists", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const presence = Context.get(server.services, OwnerPresence);
    expect(presence.exists()).toBe(false);
    yield* bootstrapOwner(server, yield* makeAuthenticator());
    expect(presence.exists()).toBe(true);
  }),
);

it.effect("binds passkeys to the public URL the Hub is published on", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttpWith({ publicUrl: new URL("https://hub.example.com") });
    const behindProxy = {
      peer: "127.0.0.1",
      headers: {
        // The proxy forwards to the loopback address, so Host no longer names the Hub.
        host: "127.0.0.1:3773",
        origin: "https://hub.example.com",
        "x-forwarded-for": "198.51.100.7",
        "x-forwarded-proto": "https",
      },
    };
    const published = yield* server.request("/api/auth/passkey/challenge", {
      body: {},
      ...behindProxy,
    });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ options: { rpId: "hub.example.com" } });

    // Another name for the same server would strand the passkey there.
    const local = yield* server.request("/api/auth/passkey/challenge", { body: {} });
    expect(local.status).toBe(400);
    expect(local.body).toMatchObject({ reason: "invalid_origin" });
  }),
);
