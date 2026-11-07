import { UserId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  addMember,
  bootstrapOwner,
  isSignedIn,
  makeAuthenticator,
  serveAuthHttp,
} from "./UserAuth.testkit.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

it.effect("keeps a browser sign-in for 30 days after its last use, and tokens for 30 days", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const cookie = created.cookie ?? "";
    const signedIn = () => server.request("/api/auth/session", { cookie });
    // Agents and scripts hold their tokens unattended, so use does not extend them.
    const cliToken = yield* server.environmentAuth.issueSession();
    const mcpClient = yield* server.environmentAuth.issueMcpClientSession({
      label: "Claude Code",
      access: "read-only",
      client: { deviceType: "bot", ipAddress: "127.0.0.1" },
    });
    const tokenWorks = (token: string) =>
      server.sessions.verify(token).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

    yield* TestClock.adjust("20 days");
    expect((yield* signedIn()).body).toMatchObject({ authenticated: true });
    expect(yield* tokenWorks(cliToken.token)).toBe(true);
    expect(yield* tokenWorks(mcpClient.token)).toBe(true);
    yield* TestClock.adjust("20 days");
    const renewed = yield* signedIn();
    expect(renewed.body).toMatchObject({ authenticated: true });
    expect(renewed.cookie).toBe(cookie);
    expect(yield* tokenWorks(cliToken.token)).toBe(false);
    expect(yield* tokenWorks(mcpClient.token)).toBe(false);

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
      client: { deviceType: "bot", ipAddress: "127.0.0.1" },
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

it.effect("lets a User revoke only their own pairing links, and the Owner anyone's", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const ownerCookie = created.cookie ?? "";
    const memberCookie = yield* addMember(server);
    const createLink = (cookie: string) =>
      server
        .request("/api/auth/pairing-token", { body: {}, cookie })
        .pipe(Effect.map((link) => link.body.id as string));
    const revoke = (cookie: string, id: string) =>
      server.request("/api/auth/pairing-links/revoke", { body: { id }, cookie });

    const ownerLink = yield* createLink(ownerCookie);
    expect((yield* revoke(memberCookie, ownerLink)).status).toBe(403);
    const memberLink = yield* createLink(memberCookie);
    expect((yield* revoke(memberCookie, memberLink)).body).toEqual({ revoked: true });
    const secondMemberLink = yield* createLink(memberCookie);
    expect((yield* revoke(ownerCookie, secondMemberLink)).body).toEqual({ revoked: true });
    expect((yield* revoke(ownerCookie, ownerLink)).body).toEqual({ revoked: true });
  }),
);

it.effect("refuses a pairing link once its User changed credentials or was disabled", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    yield* bootstrapOwner(server, yield* makeAuthenticator());
    const memberCookie = yield* addMember(server);
    const createLink = server
      .request("/api/auth/pairing-token", { body: {}, cookie: memberCookie })
      .pipe(Effect.map((link) => link.body.credential as string));
    const redeem = (credential: string) =>
      server.request("/api/auth/browser-session", { body: { credential } });

    // A link minted with a stolen session must not outlive the password change that ends it.
    const beforePassword = yield* createLink;
    yield* server.request("/api/auth/account/password", {
      body: { loginName: "grace", password: "correct horse battery" },
      cookie: memberCookie,
    });
    expect((yield* redeem(beforePassword)).status).toBe(401);

    const beforeDisable = yield* createLink;
    yield* server.sql`UPDATE users SET disabled_at = '2026-01-02T00:00:00.000Z' WHERE user_id = 'member-1'`;
    expect((yield* redeem(beforeDisable)).status).toBe(401);
  }),
);

it.effect("streams a User only the changes to their own sessions", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const ownerId = UserId.make((created.body.user as { id: string }).id);
    const memberCookie = yield* addMember(server);
    const issueFor = (userId: UserId) =>
      server.sessions.issue({
        method: "browser-session-cookie",
        subject: EnvironmentAuth.USER_SIGN_IN_SUBJECT,
        userId,
      });
    const ownerTablet = yield* issueFor(ownerId);
    const memberPhone = yield* issueFor(UserId.make("member-1"));
    const member = yield* server.sessions.verify(memberCookie.split("=")[1] ?? "");

    const access = yield* server.environmentAuth.streamAccess(member);
    expect(access.snapshot.clientSessions.map((session) => session.sessionId)).not.toContain(
      ownerTablet.sessionId,
    );
    const firstChange = yield* access.changes.pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* server.sessions.revoke(ownerTablet.sessionId);
    yield* server.sessions.revoke(memberPhone.sessionId);
    expect(yield* Fiber.join(firstChange)).toEqual([
      { type: "clientRemoved", sessionId: memberPhone.sessionId },
    ]);
  }).pipe(Effect.scoped),
);
