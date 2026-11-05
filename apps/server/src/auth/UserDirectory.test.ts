import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  addMember,
  type Authenticator,
  bootstrapOwner,
  type CreationOptions,
  finishOwnerRegistration,
  isSignedIn,
  joinOrganization,
  makeAuthenticator,
  passkeyReauth,
  type RequestOptions,
  serveAuthHttp,
  startOwnerRegistration,
  totpCode,
} from "./UserAuth.testkit.ts";

it.effect("bootstraps exactly one Owner whose session carries its user id", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const authenticator = yield* makeAuthenticator();

    const { credential, created } = yield* bootstrapOwner(server, authenticator);
    expect(created.status).toBe(200);
    // Reopening the spent startup URL says so instead of calling it an invalid token.
    const reopened = yield* server.request("/api/auth/owner/status", { body: { credential } });
    expect(reopened.body).toEqual({ status: "spent" });
    // Only the setup link reports itself; any other credential says nothing about whether it existed.
    const pairing = yield* server.environmentAuth.createPairingLink();
    yield* server.request("/api/auth/browser-session", {
      body: { credential: pairing.credential },
    });
    const spentPairing = yield* server.request("/api/auth/owner/status", {
      body: { credential: pairing.credential },
    });
    expect(spentPairing.body).toEqual({ status: "not-applicable" });
    const user = created.body.user as { id: string; displayName: string; isOwner: boolean };
    expect(user).toMatchObject({ displayName: "Ada Lovelace", isOwner: true });
    expect(created.body.recoveryCodes).toHaveLength(10);
    const session = yield* server.request("/api/auth/session", { cookie: created.cookie ?? "" });
    expect(session.body).toMatchObject({ authenticated: true, userId: user.id });

    const { credential: nextCredential } =
      yield* server.environmentAuth.issueStartupPairingCredential();
    const status = yield* server.request("/api/auth/owner/status", {
      body: { credential: nextCredential },
    });
    expect(status.body).toEqual({ status: "claimed" });
    const refused = yield* server.request("/api/auth/owner/registration", {
      body: { credential: nextCredential, displayName: "Mallory" },
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ message: "This Installation already has an Owner." });
  }),
);

it.effect("signs the Owner out and back in with the passkey from another browser", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const authenticator = yield* makeAuthenticator();
    const { created } = yield* bootstrapOwner(server, authenticator);
    const firstBrowser = created.cookie ?? "";

    const signedOut = yield* server.request("/api/auth/sign-out", {
      body: {},
      cookie: firstBrowser,
    });
    expect(signedOut.body).toEqual({ signedOut: true });
    const afterSignOut = yield* server.request("/api/auth/session", { cookie: firstBrowser });
    expect(afterSignOut.body).toMatchObject({ authenticated: false });

    const challenge = yield* server.request("/api/auth/passkey/challenge", { body: {} });
    const assertion = yield* Effect.promise(() =>
      authenticator.get(challenge.body.options as RequestOptions),
    );
    const signedIn = yield* server.request("/api/auth/passkey/sign-in", {
      body: { ceremonyId: challenge.body.ceremonyId, response: assertion },
    });
    expect(signedIn.status).toBe(200);
    const secondBrowser = yield* server.request("/api/auth/session", {
      cookie: signedIn.cookie ?? "",
    });
    expect(secondBrowser.body).toMatchObject({
      authenticated: true,
      userId: (created.body.user as { id: string }).id,
    });

    const replayed = yield* server.request("/api/auth/passkey/sign-in", {
      body: { ceremonyId: challenge.body.ceremonyId, response: assertion },
    });
    expect(replayed.status).toBe(401);
  }),
);

it.effect("lets a recovery code sign the Owner in exactly once", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const [code] = created.body.recoveryCodes as ReadonlyArray<string>;

    const signedIn = yield* server.request("/api/auth/recovery-code/sign-in", {
      body: { code: code?.toLowerCase().replace("-", " ") },
    });
    expect(signedIn.status).toBe(200);
    const session = yield* server.request("/api/auth/session", { cookie: signedIn.cookie ?? "" });
    expect(session.body).toMatchObject({
      authenticated: true,
      userId: (created.body.user as { id: string }).id,
    });

    const reused = yield* server.request("/api/auth/recovery-code/sign-in", { body: { code } });
    expect(reused.status).toBe(401);
  }),
);

it.effect("keeps the bootstrap link and no Owner when the Owner's session cannot be issued", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const authenticator = yield* makeAuthenticator();
    const { credential } = yield* server.environmentAuth.issueStartupPairingCredential();
    yield* server.sql`
      CREATE TRIGGER refuse_sessions BEFORE INSERT ON auth_sessions
      BEGIN SELECT RAISE(ABORT, 'refused'); END
    `;

    const failed = yield* finishOwnerRegistration(
      server,
      authenticator,
      credential,
      yield* startOwnerRegistration(server, credential),
    );
    expect(failed.status).toBe(500);

    yield* server.sql`DROP TRIGGER refuse_sessions`;
    const created = yield* finishOwnerRegistration(
      server,
      authenticator,
      credential,
      yield* startOwnerRegistration(server, credential),
    );
    expect(created.status).toBe(200);
  }),
);

it.effect("keeps a pending Owner registration while sign-in challenges flood in", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const { credential } = yield* server.environmentAuth.issueStartupPairingCredential();
    const ceremony = yield* startOwnerRegistration(server, credential);

    yield* Effect.forEach(
      Array.from({ length: 1_000 }),
      () => server.request("/api/auth/passkey/challenge", { body: {} }),
      { discard: true },
    );

    const created = yield* finishOwnerRegistration(
      server,
      yield* makeAuthenticator(),
      credential,
      ceremony,
    );
    expect(created.status).toBe(200);
  }),
);

const passwordReauth = (password: string, totpCode?: string) => ({
  method: "password",
  password,
  ...(totpCode === undefined ? {} : { totpCode }),
});

it.effect("lets a Member sign in with a password alone", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const cookie = yield* addMember(server);

    const tooLong = yield* server.request("/api/auth/password/sign-in", {
      body: { loginName: "g".repeat(65), password: "correct horse battery" },
    });
    expect(tooLong.status).toBe(400);

    // An account with no credential yet has nothing to step up with.
    const set = yield* server.request("/api/auth/account/password", {
      body: { loginName: "Grace", password: "correct horse battery" },
      cookie,
    });
    expect(set.body).toMatchObject({ loginName: "grace", hasPassword: true, totpEnrolled: false });

    const wrong = yield* server.request("/api/auth/password/sign-in", {
      body: { loginName: "grace", password: "wrong horse battery" },
    });
    expect(wrong.status).toBe(401);
    const signedIn = yield* server.request("/api/auth/password/sign-in", {
      body: { loginName: "GRACE", password: "correct horse battery" },
    });
    expect(signedIn.body).toMatchObject({ authenticated: true });
    const session = yield* server.request("/api/auth/session", { cookie: signedIn.cookie ?? "" });
    expect(session.body).toMatchObject({ authenticated: true, userId: "member-1" });

    const withoutStepUp = yield* server.request("/api/auth/account/password", {
      body: { loginName: "grace", password: "another horse battery" },
      cookie,
    });
    expect(withoutStepUp.status).toBe(403);
    const changed = yield* server.request("/api/auth/account/password", {
      body: {
        loginName: "grace",
        password: "another horse battery",
        reauth: passwordReauth("correct horse battery"),
      },
      cookie,
    });
    expect(changed.status).toBe(200);
    expect(yield* isSignedIn(server, cookie)).toBe(true);
    expect(yield* isSignedIn(server, signedIn.cookie)).toBe(false);

    // Without a passkey, the password is this account's only way in.
    const removal = yield* server.request("/api/auth/account/password/remove", {
      body: { reauth: passwordReauth("another horse battery") },
      cookie,
    });
    expect(removal.status).toBe(403);
  }),
);

it.effect("refuses a password alone for an Admin, as for the Owner", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const cookie = yield* addMember(server);
    yield* server.request("/api/auth/account/password", {
      body: { loginName: "grace", password: "correct horse battery" },
      cookie,
    });
    yield* server.sql`INSERT INTO spaces (space_id, kind, name, created_at)
      VALUES ('org-acme', 'organization', 'Acme', '2026-01-01T00:00:00.000Z')`;
    yield* joinOrganization(server, "org-acme", "member-1", "admin");

    // The right password gets told why, and is not counted as a guess.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const signIn = yield* server.request("/api/auth/password/sign-in", {
        body: { loginName: "grace", password: "correct horse battery" },
      });
      expect(signIn.status).toBe(403);
      expect(signIn.body.message).toContain("authenticator app");
    }
    const wrong = yield* server.request("/api/auth/password/sign-in", {
      body: { loginName: "grace", password: "wrong horse battery" },
    });
    expect(wrong.status).toBe(401);
    const account = yield* server.request("/api/auth/account", { cookie });
    expect(account.body).toMatchObject({ passwordRequiresTotp: true });
  }),
);

it.effect("backs off password sign-in after repeated failures", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const cookie = yield* addMember(server);
    yield* server.request("/api/auth/account/password", {
      body: { loginName: "grace", password: "correct horse battery" },
      cookie,
    });
    const attempt = (password: string) =>
      server.request("/api/auth/password/sign-in", { body: { loginName: "grace", password } });

    for (let failure = 0; failure < 5; failure += 1) {
      expect((yield* attempt("wrong horse battery")).status).toBe(401);
    }
    expect((yield* attempt("correct horse battery")).status).toBe(429);
    yield* TestClock.adjust("31 seconds");
    expect((yield* attempt("correct horse battery")).status).toBe(200);
  }),
);

it.effect("requires the Owner's password to come with a TOTP code", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const authenticator = yield* makeAuthenticator();
    const { created } = yield* bootstrapOwner(server, authenticator);
    const cookie = created.cookie ?? "";
    const ownerId = (created.body.user as { id: string }).id;
    const password = { loginName: "ada", password: "analytical engine" };

    const refused = yield* server.request("/api/auth/account/password", {
      body: { ...password, reauth: yield* passkeyReauth(server, authenticator) },
      cookie,
    });
    expect(refused.status).toBe(403);

    // Two tabs start an enrollment; the first one confirms with the code it showed.
    const enrollment = yield* server.request("/api/auth/account/totp/enrollment", {
      body: {},
      cookie,
    });
    yield* server.request("/api/auth/account/totp/enrollment", { body: {}, cookie });
    const { enrollmentId } = enrollment.body as { enrollmentId: string };
    const secret = enrollment.body.secret as string;
    expect(enrollment.body.otpauthUri).toContain(`secret=${secret}`);
    const now = yield* Clock.currentTimeMillis;
    const nextStepCode = yield* totpCode(secret, now + 30_000);

    const withoutStepUp = yield* server.request("/api/auth/account/totp", {
      body: { enrollmentId, code: nextStepCode },
      cookie,
    });
    expect(withoutStepUp.status).toBe(403);
    const wrongEnrollmentCode = yield* server.request("/api/auth/account/totp", {
      body: {
        enrollmentId,
        code: yield* totpCode(secret, now + 5 * 60_000),
        reauth: yield* passkeyReauth(server, authenticator),
      },
      cookie,
    });
    expect(wrongEnrollmentCode.status).toBe(403);
    const unenrolled = yield* server.request("/api/auth/account", { cookie });
    expect(unenrolled.body).toMatchObject({ totpEnrolled: false, passwordRequiresTotp: true });
    // A code from the next step, which clock drift allows.
    const confirmed = yield* server.request("/api/auth/account/totp", {
      body: {
        enrollmentId,
        code: nextStepCode,
        reauth: yield* passkeyReauth(server, authenticator),
      },
      cookie,
    });
    expect(confirmed.body).toMatchObject({ totpEnrolled: true });

    const set = yield* server.request("/api/auth/account/password", {
      body: { ...password, reauth: yield* passkeyReauth(server, authenticator) },
      cookie,
    });
    expect(set.body).toMatchObject({ hasPassword: true, totpEnrolled: true });

    // A wrong password still gets a code step, so the answer does not confirm the password.
    const wrongPassword = yield* server.request("/api/auth/password/sign-in", {
      body: { ...password, password: "difference engine" },
    });
    expect(wrongPassword.body).toMatchObject({ authenticated: false, secondFactor: "totp" });
    const decoy = yield* server.request("/api/auth/password/totp", {
      body: {
        challengeId: wrongPassword.body.challengeId,
        code: yield* totpCode(secret, yield* Clock.currentTimeMillis),
      },
    });
    expect(decoy.status).toBe(401);

    // Right after enrollment, a code from the current step signs in.
    const firstStep = yield* server.request("/api/auth/password/sign-in", { body: password });
    expect(firstStep.body).toMatchObject({ authenticated: false, secondFactor: "totp" });
    expect(firstStep.cookie).toBeUndefined();
    const challengeId = firstStep.body.challengeId;
    const wrongCode = yield* server.request("/api/auth/password/totp", {
      body: { challengeId, code: yield* totpCode(secret, now + 10 * 60_000) },
    });
    expect(wrongCode.status).toBe(401);
    const code = yield* totpCode(secret, yield* Clock.currentTimeMillis);
    const signedIn = yield* server.request("/api/auth/password/totp", {
      body: { challengeId, code },
    });
    const session = yield* server.request("/api/auth/session", { cookie: signedIn.cookie ?? "" });
    expect(session.body).toMatchObject({ authenticated: true, userId: ownerId });

    const again = yield* server.request("/api/auth/password/sign-in", { body: password });
    const replayed = yield* server.request("/api/auth/password/totp", {
      body: { challengeId: again.body.challengeId, code },
    });
    expect(replayed.status).toBe(401);

    // Removing TOTP first would leave the Owner a password it may not use alone.
    const removeTotpFirst = yield* server.request("/api/auth/account/totp/remove", {
      body: { reauth: yield* passkeyReauth(server, authenticator) },
      cookie,
    });
    expect(removeTotpFirst.status).toBe(403);
    const removePassword = yield* server.request("/api/auth/account/password/remove", {
      body: { reauth: yield* passkeyReauth(server, authenticator) },
      cookie,
    });
    expect(removePassword.body).toMatchObject({ hasPassword: false });
    const removeTotp = yield* server.request("/api/auth/account/totp/remove", {
      body: { reauth: yield* passkeyReauth(server, authenticator) },
      cookie,
    });
    expect(removeTotp.body).toMatchObject({ totpEnrolled: false });
  }),
);

it.effect("counts wrong TOTP codes toward the sign-in back-off", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const authenticator = yield* makeAuthenticator();
    const { created } = yield* bootstrapOwner(server, authenticator);
    const cookie = created.cookie ?? "";
    const enrollment = yield* server.request("/api/auth/account/totp/enrollment", {
      body: {},
      cookie,
    });
    const secret = enrollment.body.secret as string;
    const now = yield* Clock.currentTimeMillis;
    yield* server.request("/api/auth/account/totp", {
      body: {
        enrollmentId: enrollment.body.enrollmentId,
        code: yield* totpCode(secret, now),
        reauth: yield* passkeyReauth(server, authenticator),
      },
      cookie,
    });
    const password = { loginName: "ada", password: "analytical engine" };
    yield* server.request("/api/auth/account/password", {
      body: { ...password, reauth: yield* passkeyReauth(server, authenticator) },
      cookie,
    });

    const firstStep = yield* server.request("/api/auth/password/sign-in", { body: password });
    const challengeId = firstStep.body.challengeId;
    for (let failure = 0; failure < 5; failure += 1) {
      const wrong = yield* server.request("/api/auth/password/totp", {
        body: { challengeId, code: yield* totpCode(secret, now + 10 * 60_000) },
      });
      expect(wrong.status).toBe(401);
    }
    const locked = yield* server.request("/api/auth/password/sign-in", { body: password });
    expect(locked.status).toBe(429);
  }),
);

it.effect("lets the Owner register a new passkey once from a reset link that expires", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const lostAuthenticator = yield* makeAuthenticator();
    const { created } = yield* bootstrapOwner(server, lostAuthenticator);
    const ownerId = (created.body.user as { id: string }).id;
    // What `t3 auth owner-reset` calls.
    const { token: superseded } = yield* server.environmentAuth.issueOwnerResetLink();
    const { token } = yield* server.environmentAuth.issueOwnerResetLink();
    const supersededStatus = yield* server.request("/api/auth/reset/status", {
      body: { token: superseded },
    });
    expect(supersededStatus.body).toEqual({ status: "invalid" });

    const status = yield* server.request("/api/auth/reset/status", { body: { token } });
    expect(status.body).toEqual({ status: "valid", displayName: "Ada Lovelace" });
    const newAuthenticator = yield* makeAuthenticator();
    const ceremony = yield* server.request("/api/auth/reset/registration", { body: { token } });
    const response = yield* Effect.promise(() =>
      newAuthenticator.create(ceremony.body.options as CreationOptions),
    );
    const redeemed = yield* server.request("/api/auth/reset", {
      body: { token, ceremonyId: ceremony.body.ceremonyId, response },
    });
    const session = yield* server.request("/api/auth/session", { cookie: redeemed.cookie ?? "" });
    expect(session.body).toMatchObject({ authenticated: true, userId: ownerId });
    expect(yield* isSignedIn(server, created.cookie)).toBe(false);

    const signIn = Effect.fn(function* (authenticator: Authenticator) {
      const challenge = yield* server.request("/api/auth/passkey/challenge", { body: {} });
      const assertion = yield* Effect.promise(() =>
        authenticator.get(challenge.body.options as RequestOptions),
      );
      return yield* server.request("/api/auth/passkey/sign-in", {
        body: { ceremonyId: challenge.body.ceremonyId, response: assertion },
      });
    });
    expect((yield* signIn(newAuthenticator)).status).toBe(200);
    expect((yield* signIn(lostAuthenticator)).status).toBe(401);

    const spent = yield* server.request("/api/auth/reset/status", { body: { token } });
    expect(spent.body).toEqual({ status: "invalid" });
    const reused = yield* server.request("/api/auth/reset/registration", { body: { token } });
    expect(reused.status).toBe(401);

    // A registration started from one link cannot be finished with another.
    const first = yield* server.environmentAuth.issueOwnerResetLink();
    const firstCeremony = yield* server.request("/api/auth/reset/registration", {
      body: { token: first.token },
    });
    const second = yield* server.environmentAuth.issueOwnerResetLink();
    const crossingAuthenticator = yield* makeAuthenticator();
    const crossed = yield* server.request("/api/auth/reset", {
      body: {
        token: second.token,
        ceremonyId: firstCeremony.body.ceremonyId,
        response: yield* Effect.promise(() =>
          crossingAuthenticator.create(firstCeremony.body.options as CreationOptions),
        ),
      },
    });
    expect(crossed.status).toBe(401);

    const expiring = yield* server.environmentAuth.issueOwnerResetLink();
    yield* TestClock.adjust("59 minutes");
    const fresh = yield* server.request("/api/auth/reset/status", {
      body: { token: expiring.token },
    });
    expect(fresh.body).toMatchObject({ status: "valid" });
    yield* TestClock.adjust("2 minutes");
    const expired = yield* server.request("/api/auth/reset/registration", {
      body: { token: expiring.token },
    });
    expect(expired.status).toBe(401);
  }),
);
