import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  type Authenticator,
  bootstrapOwner,
  makeAuthenticator,
  passkeyReauth,
  type Server,
  serveAuthHttpWith,
} from "../auth/UserAuth.testkit.ts";

export const REDIRECT = "http://127.0.0.1:51234/callback";
export const VERIFIER = "a-code-verifier-that-is-long-enough-for-pkce-0123456789";
const STATE = "state-0123456789abcdef";

const challengeOf = (verifier: string) =>
  Effect.promise(async () =>
    Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString(
      "base64url",
    ),
  );

/** A Hub with its Owner signed in with a passkey; `listen` also serves a real port. */
export const hubWithOwner = (options: { readonly listen?: boolean } = {}) =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttpWith(options);
    const authenticator = yield* makeAuthenticator();
    const { created } = yield* bootstrapOwner(server, authenticator);
    return { server, authenticator, owner: created.cookie ?? "" };
  });

/** What the «Register this machine» page posts, as `t3 join` asked for it. */
export const approveJoin = Effect.fn(function* (
  server: Server,
  cookie: string,
  input: { readonly reauth?: unknown; readonly name?: string } = {},
) {
  return yield* server.request("/api/environments/join/approve", {
    cookie,
    body: {
      redirectUri: REDIRECT,
      codeChallenge: yield* challengeOf(VERIFIER),
      codeChallengeMethod: "S256",
      state: STATE,
      name: input.name ?? "Laptop",
      os: "linux",
      hostname: "ada-laptop",
      ...(input.reauth === undefined ? {} : { reauth: input.reauth }),
    },
  });
});

export const codeOf = (redirectTo: unknown) => {
  const url = new URL(String(redirectTo));
  assert.equal(`${url.origin}${url.pathname}`, REDIRECT);
  assert.equal(url.searchParams.get("state"), STATE);
  return url.searchParams.get("code") ?? "";
};

/** Approves with a passkey and redeems the code: the machine's credential, as `t3 join` gets it. */
export const joinMachine = Effect.fn(function* (
  server: Server,
  authenticator: Authenticator,
  owner: string,
  name = "Laptop",
) {
  const approved = yield* approveJoin(server, owner, {
    name,
    reauth: yield* passkeyReauth(server, authenticator),
  });
  assert.equal(approved.status, 200);
  const redeemed = yield* server.request("/api/environments/join/token", {
    body: { code: codeOf(approved.body.redirectTo), codeVerifier: VERIFIER, redirectUri: REDIRECT },
  });
  assert.equal(redeemed.status, 200);
  return redeemed.body as {
    environmentId: string;
    hubEnvironmentId: string;
    name: string;
    credential: string;
  };
});

export const listEnvironments = Effect.fn(function* (server: Server, cookie: string) {
  const listed = yield* server.request("/api/environments", { cookie });
  assert.equal(listed.status, 200);
  return listed.body.environments as ReadonlyArray<{
    id: string;
    name: string;
    kind: string;
    status: string;
    ownerUserId: string | null;
    hostname: string | null;
    providers: ReadonlyArray<{ instanceId: string }>;
  }>;
});
