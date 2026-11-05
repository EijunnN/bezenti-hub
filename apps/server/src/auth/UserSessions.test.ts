import { UserId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  addMember,
  bootstrapOwner,
  isSignedIn,
  makeAuthenticator,
  serveAuthHttp,
} from "./UserAuth.testkit.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

it.effect("keeps a User's session for 30 days after its last use", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const cookie = created.cookie ?? "";
    const signedIn = () => server.request("/api/auth/session", { cookie });

    yield* TestClock.adjust("20 days");
    expect((yield* signedIn()).body).toMatchObject({ authenticated: true });
    yield* TestClock.adjust("20 days");
    const renewed = yield* signedIn();
    expect(renewed.body).toMatchObject({ authenticated: true });
    expect(renewed.cookie).toBe(cookie);

    yield* TestClock.adjust("29 days");
    expect((yield* signedIn()).body).toMatchObject({ authenticated: true });
    yield* TestClock.adjust("31 days");
    expect((yield* signedIn()).body).toMatchObject({ authenticated: false });
  }),
);

it.effect("signs a device in as the User who created its pairing link", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    yield* bootstrapOwner(server, yield* makeAuthenticator());
    const memberCookie = yield* addMember(server);

    const link = yield* server.request("/api/auth/pairing-token", {
      body: { label: "Grace's phone" },
      cookie: memberCookie,
    });
    expect(link.status).toBe(200);
    const paired = yield* server.request("/api/auth/browser-session", {
      body: { credential: link.body.credential },
    });
    expect(paired.status).toBe(200);
    const session = yield* server.request("/api/auth/session", { cookie: paired.cookie ?? "" });
    expect(session.body).toMatchObject({ authenticated: true, userId: "member-1" });
  }),
);

it.effect("gives every session without a User of its own to the Owner", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const userOf = (cookie: string | undefined) =>
      server
        .request("/api/auth/session", { cookie: cookie ?? "" })
        .pipe(Effect.map((session) => session.body.userId));
    const pairBrowser = Effect.fn(function* () {
      const link = yield* server.environmentAuth.createPairingLink();
      const paired = yield* server.request("/api/auth/browser-session", {
        body: { credential: link.credential },
      });
      return paired.cookie;
    });

    const pairedBeforeOwner = yield* pairBrowser();
    expect(yield* userOf(pairedBeforeOwner)).toBeUndefined();
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const ownerId = (created.body.user as { id: string }).id;
    expect(yield* userOf(pairedBeforeOwner)).toBe(ownerId);

    // `t3 pair`, the startup link and `t3 auth session issue` run in the Hub's shell.
    expect(yield* userOf(yield* pairBrowser())).toBe(ownerId);
    const startup = yield* server.environmentAuth.issueStartupPairingCredential();
    const startupBrowser = yield* server.request("/api/auth/browser-session", {
      body: { credential: startup.credential },
    });
    expect(yield* userOf(startupBrowser.cookie)).toBe(ownerId);
    const cliToken = yield* server.environmentAuth.issueSession();
    expect((yield* server.sessions.verify(cliToken.token)).userId).toBe(ownerId);
    const mcpClient = yield* server.environmentAuth.issueMcpClientSession({
      label: "Claude Code",
      access: "read-only",
      peerLink: false,
      client: { deviceType: "bot" },
    });
    expect((yield* server.sessions.verify(mcpClient.token)).userId).toBe(ownerId);

    const userless = yield* server.sessions.issue({ subject: "one-time-token" }).pipe(Effect.exit);
    expect(userless._tag).toBe("Failure");
  }),
);

it.effect("lets each User list and revoke their own sessions and the Owner anyone's", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const ownerCookie = created.cookie ?? "";
    const laptop = yield* addMember(server);
    const phone = yield* server.sessions.issue({
      method: "browser-session-cookie",
      subject: EnvironmentAuth.USER_SIGN_IN_SUBJECT,
      userId: UserId.make("member-1"),
    });
    const viewer = (cookie: string) => server.sessions.verify(cookie.split("=")[1] ?? "");
    const listed = (cookie: string) =>
      viewer(cookie).pipe(Effect.flatMap(server.environmentAuth.listClientSessions));
    const revoke = (cookie: string, sessionId: string) =>
      server.request("/api/auth/clients/revoke", { body: { sessionId }, cookie });

    const memberSessions = yield* listed(laptop);
    expect(memberSessions.map((session) => session.userId)).toEqual(["member-1", "member-1"]);
    const ownerSession = (yield* viewer(ownerCookie)).sessionId;
    expect((yield* revoke(laptop, ownerSession)).status).toBe(403);
    expect((yield* revoke(laptop, phone.sessionId)).body).toEqual({ revoked: true });
    expect(yield* listed(laptop)).toHaveLength(1);

    const ownerView = yield* listed(ownerCookie);
    expect(ownerView).toHaveLength(2);
    expect(ownerView.find((session) => session.userId === "member-1")).toMatchObject({
      userDisplayName: "Grace Hopper",
    });
    const laptopSession = (yield* viewer(laptop)).sessionId;
    const socket = yield* server.sessions
      .awaitInvalidation(laptopSession)
      .pipe(Effect.forkScoped({ startImmediately: true }));
    expect((yield* revoke(ownerCookie, laptopSession)).body).toEqual({ revoked: true });
    yield* Fiber.join(socket);
    expect(yield* isSignedIn(server, laptop)).toBe(false);
  }).pipe(Effect.scoped),
);
