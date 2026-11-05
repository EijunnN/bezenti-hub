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

/** A published Hub: the Owner exists, and Grace signs in with a password alone. */
const withPasswordMember = Effect.fn(function* (server: Server) {
  yield* bootstrapOwner(server, yield* makeAuthenticator());
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
    yield* bootstrapOwner(server, yield* makeAuthenticator());
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
        // A LAN client: before the Owner exists the Hub admits only private ones.
        "x-forwarded-for": "192.168.1.40",
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

const LAN_PEER = "192.168.1.31";
const metadata = (ipAddress: string | undefined) => ({
  deviceType: "desktop" as const,
  ...(ipAddress === undefined ? {} : { ipAddress }),
});

it.effect("keeps a fresh Installation closed to public clients a proxy forwards", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const via = (client: string) => ({ headers: { "x-forwarded-for": client } });

    expect((yield* server.request("/api/auth/session", via("203.0.113.5"))).status).toBe(403);
    // A proxy that cannot name the client does not make it local.
    const unnamed = { headers: { "x-forwarded-proto": "https" } };
    expect((yield* server.request("/api/auth/session", unnamed)).status).toBe(403);
    expect((yield* server.request("/api/auth/session", via(LAN_PEER))).status).toBe(200);
    expect((yield* server.request("/api/auth/session")).status).toBe(200);

    yield* bootstrapOwner(server, yield* makeAuthenticator());
    expect((yield* server.request("/api/auth/session", via("203.0.113.5"))).status).toBe(200);
  }),
);

it.effect("re-reads whether the Owner exists when the startup read missed it", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    yield* server.sql`
      INSERT INTO users (user_id, display_name, is_owner, created_at)
      VALUES ('owner-1', 'Ada Lovelace', 1, '2026-01-01T00:00:00.000Z')
    `;
    const presence = Context.get(server.services, OwnerPresence);
    expect(presence.exists()).toBe(false);
    const response = yield* server.request("/api/auth/session", {
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(response.status).toBe(200);
    expect(presence.exists()).toBe(true);
  }),
);

it.effect("signs LAN and tailnet browsers in over plain HTTP, but not public ones", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    yield* withPasswordMember(server);
    expect((yield* signIn(server, { peer: LAN_PEER })).status).toBe(200);
    expect((yield* signIn(server, { peer: "100.90.1.2" })).status).toBe(200);
    expect((yield* signIn(server, { peer: "203.0.113.5" })).status).toBe(400);
  }),
);

it.effect("signs only this machine in over plain HTTP once the Hub has a public URL", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttpWith({ publicUrl: new URL("https://hub.example.com") });
    const exchange = (ipAddress: string) =>
      Effect.gen(function* () {
        const { credential } = yield* server.environmentAuth.issuePairingCredential();
        return yield* server.environmentAuth
          .exchangeBootstrapCredentialForAccessToken(credential, undefined, metadata(ipAddress))
          .pipe(Effect.result);
      });
    expect((yield* exchange(LAN_PEER))._tag).toBe("Failure");
    expect((yield* exchange("127.0.0.1"))._tag).toBe("Success");
  }),
);

it.effect("exchanges a pairing credential over plain HTTP only off the public internet", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    yield* bootstrapOwner(server, yield* makeAuthenticator());
    const exchange = (ipAddress: string | undefined) =>
      Effect.gen(function* () {
        const { credential } = yield* server.environmentAuth.issuePairingCredential();
        return yield* server.environmentAuth
          .exchangeBootstrapCredentialForAccessToken(credential, undefined, metadata(ipAddress))
          .pipe(Effect.result);
      });
    expect((yield* exchange("203.0.113.5"))._tag).toBe("Failure");
    expect((yield* exchange(undefined))._tag).toBe("Failure");
    expect((yield* exchange(LAN_PEER))._tag).toBe("Success");
    expect((yield* exchange("127.0.0.1"))._tag).toBe("Success");
  }),
);

it.effect("believes X-Forwarded-Host only from a trusted proxy", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    yield* bootstrapOwner(server, yield* makeAuthenticator());
    const headers = {
      host: "127.0.0.1:3773",
      origin: "http://hub.example.com",
      "x-forwarded-host": "hub.example.com",
    };
    const spoofed = yield* server.request("/api/auth/passkey/challenge", {
      body: {},
      peer: LAN_PEER,
      headers,
    });
    expect(spoofed.status).toBe(400);
    const proxied = yield* server.request("/api/auth/passkey/challenge", { body: {}, headers });
    expect(proxied.status).toBe(200);
  }),
);
