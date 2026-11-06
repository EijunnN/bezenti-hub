import { expect, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  addMember,
  bootstrapOwner,
  makeAuthenticator,
  type Server,
  serveAuthHttp,
} from "./UserAuth.testkit.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

// Desktop and mobile apps sign in through the system browser: the Hub's page approves with the
// browser's session, and the app exchanges the one-time code with its PKCE verifier.

const LOOPBACK = "http://127.0.0.1:53111/callback";
const MOBILE = "t3code://auth/callback";
const VERIFIER = "a".repeat(43) + "-verifier-for-tests";
const CHALLENGE = "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c";
const STATE = "state-from-the-app-0123";

const approve = (
  server: Server,
  cookie: string | undefined,
  overrides: { readonly redirectUri?: string; readonly authorization?: string } = {},
) =>
  server.request("/api/auth/app-sign-in/approve", {
    body: {
      redirectUri: overrides.redirectUri ?? LOOPBACK,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
      state: STATE,
      clientLabel: "T3 Code desktop",
    },
    ...(cookie === undefined ? {} : { cookie }),
    ...(overrides.authorization === undefined ? {} : { authorization: overrides.authorization }),
  });

/** The code the approval sends back, read the way the app reads its callback. */
const codeFrom = (redirectTo: unknown) => {
  const url = new URL(String(redirectTo));
  expect(url.searchParams.get("state")).toBe(STATE);
  return url.searchParams.get("code") ?? "";
};

const exchange = (
  server: Server,
  code: string,
  overrides: { readonly verifier?: string; readonly redirectUri?: string } = {},
) =>
  server.request("/api/auth/app-sign-in/token", {
    form: {
      grant_type: "authorization_code",
      code,
      code_verifier: overrides.verifier ?? VERIFIER,
      redirect_uri: overrides.redirectUri ?? LOOPBACK,
      client_label: "T3 Code desktop",
    },
  });

const signedInMember = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  yield* bootstrapOwner(server, yield* makeAuthenticator());
  const cookie = yield* addMember(server);
  return { server, cookie };
});

it.effect("gives the app a session of the User who signed in in the browser", () =>
  Effect.gen(function* () {
    const { server, cookie } = yield* signedInMember;
    for (const redirectUri of [LOOPBACK, MOBILE]) {
      const approved = yield* approve(server, cookie, { redirectUri });
      expect(approved.status).toBe(200);
      expect(String(approved.body.redirectTo).startsWith(`${redirectUri}?code=`)).toBe(true);
      const issued = yield* exchange(server, codeFrom(approved.body.redirectTo), { redirectUri });
      expect(issued.status).toBe(200);
      expect(issued.body.token_type).toBe("Bearer");
      const session = yield* server.request("/api/auth/session", {
        authorization: `Bearer ${String(issued.body.access_token)}`,
      });
      expect(session.body).toMatchObject({
        authenticated: true,
        sessionMethod: "bearer-access-token",
        userId: "member-1",
      });
    }
  }),
);

it.effect("spends a code on its first exchange", () =>
  Effect.gen(function* () {
    const { server, cookie } = yield* signedInMember;
    const code = codeFrom((yield* approve(server, cookie)).body.redirectTo);
    expect((yield* exchange(server, code)).status).toBe(200);
    expect((yield* exchange(server, code)).status).toBe(401);
  }),
);

it.effect("refuses a code after a minute", () =>
  Effect.gen(function* () {
    const { server, cookie } = yield* signedInMember;
    const code = codeFrom((yield* approve(server, cookie)).body.redirectTo);
    yield* TestClock.adjust("61 seconds");
    expect((yield* exchange(server, code)).status).toBe(401);
  }),
);

it.effect("refuses a code presented with another verifier, and spends it", () =>
  Effect.gen(function* () {
    const { server, cookie } = yield* signedInMember;
    const code = codeFrom((yield* approve(server, cookie)).body.redirectTo);
    expect((yield* exchange(server, code, { verifier: "b".repeat(43) })).status).toBe(401);
    // Whoever intercepted the code without the verifier also burned it for the app.
    expect((yield* exchange(server, code)).status).toBe(401);
  }),
);

it.effect("refuses a code presented for another redirect", () =>
  Effect.gen(function* () {
    const { server, cookie } = yield* signedInMember;
    const code = codeFrom((yield* approve(server, cookie)).body.redirectTo);
    expect(
      (yield* exchange(server, code, { redirectUri: "http://127.0.0.1:60000/callback" })).status,
    ).toBe(401);
  }),
);

it.effect("approves only redirects back to this computer or the mobile app", () =>
  Effect.gen(function* () {
    const { server, cookie } = yield* signedInMember;
    for (const redirectUri of [
      "https://attacker.example/callback",
      "http://192.168.1.20:5000/callback",
      "http://127.0.0.1:53111/elsewhere",
      // RFC 8252 §8.3: `localhost` may resolve off this machine.
      "http://localhost:53111/callback",
      "http://127.0.0.1:53111/callback?next=https://attacker.example",
      "t3code://auth/callback/../steal",
      "other-app://auth/callback",
    ]) {
      const refused = yield* approve(server, cookie, { redirectUri });
      expect(refused.status, redirectUri).toBe(400);
      expect(refused.body.reason).toBe("invalid_redirect_uri");
    }
  }),
);

it.effect("approves only with a browser session, not a token an app holds", () =>
  Effect.gen(function* () {
    const { server, cookie } = yield* signedInMember;
    expect((yield* approve(server, undefined)).status).toBe(401);
    const code = codeFrom((yield* approve(server, cookie)).body.redirectTo);
    const token = String((yield* exchange(server, code)).body.access_token);
    expect((yield* approve(server, undefined, { authorization: `Bearer ${token}` })).status).toBe(
      401,
    );
  }),
);

it.effect("signing out of the app revokes its session on the Hub", () =>
  Effect.gen(function* () {
    const { server, cookie } = yield* signedInMember;
    const code = codeFrom((yield* approve(server, cookie)).body.redirectTo);
    const authorization = `Bearer ${String((yield* exchange(server, code)).body.access_token)}`;
    const signedOut = yield* server.request("/api/auth/sign-out", { body: {}, authorization });
    expect(signedOut.body).toEqual({ signedOut: true });
    const session = yield* server.request("/api/auth/session", { authorization });
    expect(session.body.authenticated).toBe(false);
    // The browser that approved stays signed in.
    expect((yield* server.request("/api/auth/session", { cookie })).body.authenticated).toBe(true);
  }),
);

it.effect("gives the app no more access than the browser session that approved it", () =>
  Effect.gen(function* () {
    const { server } = yield* signedInMember;
    const narrowed = yield* server.sessions.issue({
      method: "browser-session-cookie",
      subject: EnvironmentAuth.USER_SIGN_IN_SUBJECT,
      userId: UserId.make("member-1"),
      scopes: [AuthOrchestrationReadScope],
    });
    const cookie = `${server.sessions.cookieName}=${narrowed.token}`;
    const code = codeFrom((yield* approve(server, cookie)).body.redirectTo);
    const issued = yield* exchange(server, code);
    expect(issued.status).toBe(200);
    expect(issued.body.scope).toBe(AuthOrchestrationReadScope);
  }),
);
