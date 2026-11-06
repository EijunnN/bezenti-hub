import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  bootstrapOwner,
  type CreationOptions,
  isSignedIn,
  makeAuthenticator,
  type Server,
  serveAuthHttp,
  totpCode,
} from "../auth/UserAuth.testkit.ts";

const PASSWORD = "correct horse battery";

/** The Owner (Ada) with an Organization called Acme. */
const ownerWithOrganization = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
  const owner = created.cookie ?? "";
  const acme = yield* server.request("/api/spaces/organizations", {
    body: { name: "Acme" },
    cookie: owner,
  });
  return { server, owner, acmeId: acme.body.id as string };
});

/** A User who accepted an Invitation with a password, signed in in one browser. */
const invited = Effect.fn(function* (
  server: Server,
  inviter: string,
  spaceId: string,
  loginName: string,
  role: "member" | "guest" = "member",
) {
  const invitation = yield* server.request(`/api/spaces/${spaceId}/invitations`, {
    body: { role },
    cookie: inviter,
  });
  expect(invitation.status).toBe(200);
  const accepted = yield* server.request("/api/invitations/accept", {
    body: {
      token: invitation.body.token,
      method: "password",
      displayName: loginName,
      loginName,
      password: PASSWORD,
    },
  });
  expect(accepted.status).toBe(200);
  return { cookie: accepted.cookie ?? "", userId: accepted.body.userId as string, loginName };
});

const roleChange = (
  server: Server,
  cookie: string,
  spaceId: string,
  userId: string,
  role: "admin" | "member" | "guest",
) => server.request(`/api/spaces/${spaceId}/members/role`, { body: { userId, role }, cookie });

const removal = (server: Server, cookie: string, spaceId: string, userId: string) =>
  server.request(`/api/spaces/${spaceId}/members/remove`, { body: { userId }, cookie });

const resetLink = (server: Server, cookie: string, spaceId: string, userId: string) =>
  server.request(`/api/spaces/${spaceId}/members/reset-link`, { body: { userId }, cookie });

const membersOf = (server: Server, cookie: string, spaceId: string) =>
  server
    .request(`/api/spaces/${spaceId}/members`, { cookie })
    .pipe(
      Effect.map((response) =>
        (response.body.members as ReadonlyArray<{ displayName: string; role: string }>).map(
          (member) => `${member.displayName}:${member.role}`,
        ),
      ),
    );

/** Signs in with a password, setting up the authenticator app the account now needs. */
const signInSettingUpTotp = Effect.fn(function* (server: Server, loginName: string) {
  const started = yield* server.request("/api/auth/password/sign-in", {
    body: { loginName, password: PASSWORD },
  });
  expect(started.body).toMatchObject({ authenticated: false, secondFactor: "totp-setup" });
  const code = yield* totpCode(started.body.secret as string, yield* Clock.currentTimeMillis);
  const finished = yield* server.request("/api/auth/password/totp", {
    body: { challengeId: started.body.challengeId, code },
  });
  expect(finished.status).toBe(200);
  return finished.cookie ?? "";
});

it.effect("an Admin invites Members and Guests and manages them, but never an Admin", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization;
    const ada = yield* invited(server, owner, acmeId, "ada");
    const hedy = yield* invited(server, owner, acmeId, "hedy");
    expect((yield* roleChange(server, owner, acmeId, ada.userId, "admin")).status).toBe(200);
    expect((yield* roleChange(server, owner, acmeId, hedy.userId, "admin")).status).toBe(200);
    const admin = yield* signInSettingUpTotp(server, "ada");

    const grace = yield* invited(server, admin, acmeId, "grace");
    const linus = yield* invited(server, admin, acmeId, "linus", "guest");
    const asAdmin = yield* server.request(`/api/spaces/${acmeId}/invitations`, {
      body: { role: "admin" },
      cookie: admin,
    });
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.message).toBe("Only the Owner invites Admins.");
    // Invitations the Owner made for an Admin are not an Admin's to revoke.
    const ownersAdminInvite = yield* server.request(`/api/spaces/${acmeId}/invitations`, {
      body: { role: "admin" },
      cookie: owner,
    });
    const revoke = (cookie: string) =>
      server.request("/api/invitations/revoke", {
        body: { invitationId: (ownersAdminInvite.body.invitation as { id: string }).id },
        cookie,
      });
    expect((yield* revoke(admin)).status).toBe(403);
    expect((yield* revoke(owner)).status).toBe(200);
    const listed = yield* server.request(`/api/spaces/${acmeId}/invitations`, { cookie: admin });
    expect(listed.status).toBe(200);
    expect(
      (yield* server.request(`/api/spaces/${acmeId}/invitations`, { cookie: grace.cookie })).status,
    ).toBe(403);

    // Another Admin is the Owner's alone.
    expect((yield* roleChange(server, admin, acmeId, hedy.userId, "member")).status).toBe(403);
    expect((yield* removal(server, admin, acmeId, hedy.userId)).status).toBe(403);
    expect((yield* resetLink(server, admin, acmeId, hedy.userId)).status).toBe(403);
    expect((yield* roleChange(server, admin, acmeId, grace.userId, "admin")).status).toBe(403);
    // Members and Guests are the Admin's to change.
    expect((yield* roleChange(server, admin, acmeId, grace.userId, "guest")).status).toBe(200);
    expect((yield* roleChange(server, admin, acmeId, linus.userId, "member")).status).toBe(200);
    expect((yield* removal(server, admin, acmeId, linus.userId)).status).toBe(200);
    // A Member changes nobody.
    expect((yield* roleChange(server, grace.cookie, acmeId, ada.userId, "guest")).status).toBe(403);
    expect(yield* membersOf(server, owner, acmeId)).toEqual([
      "ada:admin",
      "hedy:admin",
      "grace:guest",
    ]);

    // The Owner names and removes Admins, both ways.
    expect((yield* roleChange(server, owner, acmeId, hedy.userId, "member")).status).toBe(200);
    expect((yield* removal(server, owner, acmeId, ada.userId)).status).toBe(200);
    expect(yield* membersOf(server, owner, acmeId)).toEqual(["hedy:member", "grace:guest"]);

    // Someone outside the Organization learns nothing about it, not even that it exists.
    const outsider = yield* server.request("/api/spaces/organizations", {
      body: { name: "Globex" },
      cookie: owner,
    });
    const globexId = outsider.body.id as string;
    const linusInGlobex = yield* invited(server, owner, globexId, "linus2");
    const hidden = yield* server.request(`/api/spaces/${acmeId}/members`, {
      cookie: linusInGlobex.cookie,
    });
    const missing = yield* server.request("/api/spaces/no-such-space/members", {
      cookie: linusInGlobex.cookie,
    });
    expect(hidden.status).toBe(403);
    expect(hidden.body).toEqual(missing.body);
  }),
);

it.effect("becoming an Admin needs a passkey or an authenticator app from the next sign-in", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization;
    const grace = yield* invited(server, owner, acmeId, "grace");

    const promoted = yield* roleChange(server, owner, acmeId, grace.userId, "admin");
    expect(promoted.body).toMatchObject({
      member: { role: "admin" },
      mustSetUpStrongSignIn: true,
    });
    // Her password-only session ends; signing in again sets up the app before letting her in.
    expect(yield* isSignedIn(server, grace.cookie)).toBe(false);
    const started = yield* server.request("/api/auth/password/sign-in", {
      body: { loginName: "grace", password: PASSWORD },
    });
    expect(started.body).toMatchObject({ authenticated: false, secondFactor: "totp-setup" });
    const wrong = yield* server.request("/api/auth/password/totp", {
      body: { challengeId: started.body.challengeId, code: "000000" },
    });
    expect(wrong.status).toBe(401);
    const code = yield* totpCode(started.body.secret as string, yield* Clock.currentTimeMillis);
    const finished = yield* server.request("/api/auth/password/totp", {
      body: { challengeId: started.body.challengeId, code },
    });
    expect(finished.status).toBe(200);
    expect(yield* isSignedIn(server, finished.cookie)).toBe(true);
    // From now on she signs in with the code, like any Admin.
    const again = yield* server.request("/api/auth/password/sign-in", {
      body: { loginName: "grace", password: PASSWORD },
    });
    expect(again.body).toMatchObject({ authenticated: false, secondFactor: "totp" });
    // A wrong password learns nothing about the setup.
    const guessed = yield* server.request("/api/auth/password/sign-in", {
      body: { loginName: "grace", password: "wrong password" },
    });
    expect(guessed.body).toMatchObject({ secondFactor: "totp" });

    // Demoting keeps her signed in; promoting someone who already has a second factor does too.
    const demoted = yield* roleChange(server, owner, acmeId, grace.userId, "member");
    expect(demoted.body).toMatchObject({ mustSetUpStrongSignIn: false });
    expect((yield* roleChange(server, owner, acmeId, grace.userId, "admin")).body).toMatchObject({
      mustSetUpStrongSignIn: false,
    });
    expect(yield* isSignedIn(server, finished.cookie)).toBe(true);
  }),
);

it.effect(
  "leaving or being removed keeps what you made in the Organization; re-invited, you're back",
  () =>
    Effect.gen(function* () {
      const { server, owner, acmeId } = yield* ownerWithOrganization;
      const grace = yield* invited(server, owner, acmeId, "grace");
      const linus = yield* invited(server, owner, acmeId, "linus");
      const created = yield* server.request("/api/projects/mutate", {
        cookie: grace.cookie,
        body: {
          type: "project.create",
          commandId: "create-graces-app",
          projectId: "graces-app",
          title: "Grace's app",
          workspaceRoot: "/work/graces-app",
          spaceId: acmeId,
        },
      });
      expect(created.status).toBe(200);
      const projectIds = (cookie: string) =>
        server
          .request("/api/projects", { cookie })
          .pipe(
            Effect.map((response) =>
              (response.body.projects as ReadonlyArray<{ id: string }>).map(
                (project) => project.id,
              ),
            ),
          );

      const left = yield* server.request(`/api/spaces/${acmeId}/leave`, {
        body: {},
        cookie: grace.cookie,
      });
      expect(left.status).toBe(200);
      expect(
        (left.body.spaces as ReadonlyArray<{ id: string }>).map((space) => space.id),
      ).not.toContain(acmeId);
      expect(yield* projectIds(grace.cookie)).toEqual([]);
      expect(yield* projectIds(linus.cookie)).toEqual(["graces-app"]);
      expect(yield* projectIds(owner)).toEqual(["graces-app"]);
      // Leaving twice, or leaving as the Owner, has nothing to leave.
      expect(
        (yield* server.request(`/api/spaces/${acmeId}/leave`, { body: {}, cookie: grace.cookie }))
          .status,
      ).toBe(403);
      expect(
        (yield* server.request(`/api/spaces/${acmeId}/leave`, { body: {}, cookie: owner })).status,
      ).toBe(403);

      // The way back in is a new Invitation, joined from her existing account.
      const invitation = yield* server.request(`/api/spaces/${acmeId}/invitations`, {
        body: { role: "member" },
        cookie: owner,
      });
      const joined = yield* server.request("/api/invitations/join", {
        body: { token: invitation.body.token },
        cookie: grace.cookie,
      });
      expect(joined.status).toBe(200);
      expect(yield* projectIds(grace.cookie)).toEqual(["graces-app"]);

      expect((yield* removal(server, owner, acmeId, grace.userId)).status).toBe(200);
      expect(yield* projectIds(grace.cookie)).toEqual([]);
      expect(yield* projectIds(linus.cookie)).toEqual(["graces-app"]);
    }),
);

it.effect("a Member's reset link from an Admin works once and expires", () =>
  Effect.gen(function* () {
    const { server, owner, acmeId } = yield* ownerWithOrganization;
    const grace = yield* invited(server, owner, acmeId, "grace");

    const issued = yield* resetLink(server, owner, acmeId, grace.userId);
    expect(issued.status).toBe(200);
    const token = issued.body.token as string;
    const status = yield* server.request("/api/auth/reset/status", { body: { token } });
    expect(status.body).toEqual({ status: "valid", displayName: "grace" });
    const authenticator = yield* makeAuthenticator();
    const ceremony = yield* server.request("/api/auth/reset/registration", { body: { token } });
    const response = yield* Effect.promise(() =>
      authenticator.create(ceremony.body.options as CreationOptions),
    );
    const redeemed = yield* server.request("/api/auth/reset", {
      body: { token, ceremonyId: ceremony.body.ceremonyId, response },
    });
    expect(redeemed.status).toBe(200);
    const session = yield* server.request("/api/auth/session", { cookie: redeemed.cookie ?? "" });
    expect(session.body).toMatchObject({
      authenticated: true,
      userId: grace.userId,
      isOwner: false,
    });
    // Her old sessions end: whoever had them may be who she is locking out.
    expect(yield* isSignedIn(server, grace.cookie)).toBe(false);
    const reused = yield* server.request("/api/auth/reset/registration", { body: { token } });
    expect(reused.status).toBe(401);

    const expiring = yield* resetLink(server, owner, acmeId, grace.userId);
    yield* TestClock.adjust("61 minutes");
    const expired = yield* server.request("/api/auth/reset/status", {
      body: { token: expiring.body.token },
    });
    expect(expired.body).toEqual({ status: "invalid" });
    // A Member issues none.
    const linus = yield* invited(server, owner, acmeId, "linus");
    expect((yield* resetLink(server, linus.cookie, acmeId, grace.userId)).status).toBe(403);
  }),
);
