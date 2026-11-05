import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi, UserId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as AuthHttp from "./http.ts";

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const ORIGIN = "http://127.0.0.1";
const RP_ID = "127.0.0.1";

const layerServices = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-owner-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const serveAuthHttp = Effect.gen(function* () {
  const services = yield* Layer.build(layerServices);
  const routes = HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(Layer.succeedContext(services)),
    Layer.provide(HttpPlatform.layer),
    Layer.provide(Etag.layerWeak),
    Layer.provide(NodeServices.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const environmentAuth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
  // Requests run on this test's clock, so expiry follows TestClock.
  const requestContext = Context.merge(services, yield* Effect.context());
  const request = (path: string, init?: { body?: unknown; cookie?: string }) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`${ORIGIN}${path}`, {
          method: init?.body === undefined ? "GET" : "POST",
          headers: {
            origin: ORIGIN,
            host: RP_ID,
            "content-type": "application/json",
            ...(init?.cookie ? { cookie: init.cookie } : {}),
          },
          ...(init?.body === undefined ? {} : { body: encodeJson(init.body) }),
        }),
        requestContext,
      );
      const text = await response.text();
      return {
        status: response.status,
        body: (text.length > 0 ? JSON.parse(text) : null) as Record<string, unknown>,
        cookie: response.headers
          .getSetCookie()
          .find((cookie) => cookie.startsWith("t3_session_"))
          ?.split(";", 1)[0],
      };
    });
  return {
    environmentAuth,
    request,
    sessions: Context.get(services, SessionStore.SessionStore),
    sql: Context.get(services, SqlClient.SqlClient),
  };
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
type Cbor = Parameters<typeof isoCBOR.encode>[0];

// A software authenticator: a P-256 key, "none" attestation, and DER-encoded assertions.
const utf8 = (text: string) => new TextEncoder().encode(text);
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const concat = (...parts: ReadonlyArray<ArrayLike<number>>) => {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const sha256 = async (data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", data));
const derInteger = (bytes: Uint8Array) => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = bytes.slice(start);
  const value = (trimmed[0] ?? 0) & 0x80 ? concat([0], trimmed) : trimmed;
  return concat([0x02, value.length], value);
};
const derSignature = (raw: Uint8Array) => {
  const r = derInteger(raw.slice(0, 32));
  const s = derInteger(raw.slice(32));
  return concat([0x30, r.length + s.length], r, s);
};

interface CreationOptions {
  readonly challenge: string;
  readonly user: { readonly id: string };
}
interface RequestOptions {
  readonly challenge: string;
}

const makeAuthenticator = () =>
  Effect.promise(async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const credentialId = crypto.getRandomValues(new Uint8Array(16));
    let signCount = 0;
    let userHandle = "";
    const authenticatorData = async (flags: number, attested: Uint8Array = new Uint8Array()) =>
      concat(
        await sha256(utf8(RP_ID)),
        [flags],
        [
          (signCount >>> 24) & 0xff,
          (signCount >>> 16) & 0xff,
          (signCount >>> 8) & 0xff,
          signCount & 0xff,
        ],
        attested,
      );
    const clientData = (type: string, challenge: string) =>
      utf8(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
    return {
      create: async (options: CreationOptions) => {
        userHandle = options.user.id;
        const coseKey = isoCBOR.encode(
          new Map<string | number, Cbor>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, new Uint8Array(Buffer.from(jwk.x ?? "", "base64url"))],
            [-3, new Uint8Array(Buffer.from(jwk.y ?? "", "base64url"))],
          ]),
        );
        const attested = concat(
          new Uint8Array(16),
          [credentialId.length >> 8, credentialId.length & 0xff],
          credentialId,
          coseKey,
        );
        const authData = await authenticatorData(0x01 | 0x04 | 0x40, attested);
        const attestationObject = isoCBOR.encode(
          new Map<string | number, Cbor>([
            ["fmt", "none"],
            ["attStmt", new Map<string | number, Cbor>()],
            ["authData", authData],
          ]),
        );
        return {
          id: b64url(credentialId),
          rawId: b64url(credentialId),
          type: "public-key",
          response: {
            clientDataJSON: b64url(clientData("webauthn.create", options.challenge)),
            attestationObject: b64url(attestationObject),
            transports: ["internal"],
          },
          clientExtensionResults: {},
        };
      },
      get: async (options: RequestOptions) => {
        signCount += 1;
        const authData = await authenticatorData(0x01 | 0x04);
        const clientDataJSON = clientData("webauthn.get", options.challenge);
        const signed = concat(authData, await sha256(clientDataJSON));
        const signature = new Uint8Array(
          await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, signed),
        );
        return {
          id: b64url(credentialId),
          rawId: b64url(credentialId),
          type: "public-key",
          response: {
            clientDataJSON: b64url(clientDataJSON),
            authenticatorData: b64url(authData),
            signature: b64url(derSignature(signature)),
            userHandle,
          },
          clientExtensionResults: {},
        };
      },
    };
  });

const startOwnerRegistration = Effect.fn(function* (
  server: Effect.Success<typeof serveAuthHttp>,
  credential: string,
) {
  const status = yield* server.request("/api/auth/owner/status", { body: { credential } });
  expect(status.body).toEqual({ status: "available" });
  const ceremony = yield* server.request("/api/auth/owner/registration", {
    body: { credential, displayName: "Ada Lovelace" },
  });
  expect(ceremony.status).toBe(200);
  return ceremony.body as { ceremonyId: string; options: CreationOptions };
});

const finishOwnerRegistration = Effect.fn(function* (
  server: Effect.Success<typeof serveAuthHttp>,
  authenticator: Effect.Success<ReturnType<typeof makeAuthenticator>>,
  credential: string,
  ceremony: { ceremonyId: string; options: CreationOptions },
) {
  const response = yield* Effect.promise(() => authenticator.create(ceremony.options));
  return yield* server.request("/api/auth/owner", {
    body: { credential, ceremonyId: ceremony.ceremonyId, response },
  });
});

const bootstrapOwner = Effect.fn(function* (
  server: Effect.Success<typeof serveAuthHttp>,
  authenticator: Effect.Success<ReturnType<typeof makeAuthenticator>>,
) {
  const { credential } = yield* server.environmentAuth.issueStartupPairingCredential();
  const ceremony = yield* startOwnerRegistration(server, credential);
  const created = yield* finishOwnerRegistration(server, authenticator, credential, ceremony);
  return { credential, created };
});

it.effect("bootstraps exactly one Owner whose session carries its user id", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const authenticator = yield* makeAuthenticator();

    const { created } = yield* bootstrapOwner(server, authenticator);
    expect(created.status).toBe(200);
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

// An authenticator app, written from RFC 6238 independently of the server's code.
const totpCode = (base32Secret: string, nowMillis: number) =>
  Effect.promise(async () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const char of base32Secret) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
    const keyBytes = Uint8Array.from(bits.match(/.{8}/g) ?? [], (byte) => Number.parseInt(byte, 2));
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const counter = new Uint8Array(8);
    new DataView(counter.buffer).setBigUint64(0, BigInt(Math.floor(nowMillis / 30_000)));
    const tag = new DataView(await crypto.subtle.sign("HMAC", key, counter));
    const offset = tag.getUint8(tag.byteLength - 1) & 0x0f;
    return String((tag.getUint32(offset) & 0x7fff_ffff) % 1_000_000).padStart(6, "0");
  });

it.effect("lets a Member sign in with a password alone", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    yield* server.sql`
      INSERT INTO users (user_id, display_name, is_owner, created_at)
      VALUES ('member-1', 'Grace Hopper', 0, '2026-01-01T00:00:00.000Z')
    `;
    const memberSession = yield* server.sessions.issue({
      method: "browser-session-cookie",
      subject: EnvironmentAuth.USER_SIGN_IN_SUBJECT,
      userId: UserId.make("member-1"),
    });
    const cookie = `${server.sessions.cookieName}=${memberSession.token}`;

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

    const changeWithoutCurrent = yield* server.request("/api/auth/account/password", {
      body: { loginName: "grace", password: "another horse battery" },
      cookie,
    });
    expect(changeWithoutCurrent.status).toBe(403);
  }),
);

it.effect("requires the Owner's password to come with a TOTP code", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const cookie = created.cookie ?? "";
    const ownerId = (created.body.user as { id: string }).id;
    const password = { loginName: "ada", password: "analytical engine" };

    const refused = yield* server.request("/api/auth/account/password", { body: password, cookie });
    expect(refused.status).toBe(403);

    const enrollment = yield* server.request("/api/auth/account/totp/enrollment", {
      body: {},
      cookie,
    });
    const secret = enrollment.body.secret as string;
    expect(enrollment.body.otpauthUri).toContain(`secret=${secret}`);
    const now = yield* Clock.currentTimeMillis;
    const wrongEnrollmentCode = yield* server.request("/api/auth/account/totp", {
      body: { code: yield* totpCode(secret, now + 5 * 60_000) },
      cookie,
    });
    expect(wrongEnrollmentCode.status).toBe(403);
    const unenrolled = yield* server.request("/api/auth/account", { cookie });
    expect(unenrolled.body).toMatchObject({ totpEnrolled: false, passwordRequiresTotp: true });
    const confirmed = yield* server.request("/api/auth/account/totp", {
      body: { code: yield* totpCode(secret, now) },
      cookie,
    });
    expect(confirmed.body).toMatchObject({ totpEnrolled: true });

    const set = yield* server.request("/api/auth/account/password", { body: password, cookie });
    expect(set.body).toMatchObject({ hasPassword: true, totpEnrolled: true });

    const firstStep = yield* server.request("/api/auth/password/sign-in", { body: password });
    expect(firstStep.body).toEqual({ authenticated: false, secondFactor: "totp" });
    expect(firstStep.cookie).toBeUndefined();

    yield* TestClock.adjust("1 minute");
    const later = yield* Clock.currentTimeMillis;
    const wrongCode = yield* server.request("/api/auth/password/sign-in", {
      body: { ...password, totpCode: yield* totpCode(secret, later + 10 * 60_000) },
    });
    expect(wrongCode.status).toBe(401);
    const code = yield* totpCode(secret, later);
    const signedIn = yield* server.request("/api/auth/password/sign-in", {
      body: { ...password, totpCode: code },
    });
    const session = yield* server.request("/api/auth/session", { cookie: signedIn.cookie ?? "" });
    expect(session.body).toMatchObject({ authenticated: true, userId: ownerId });

    const replayed = yield* server.request("/api/auth/password/sign-in", {
      body: { ...password, totpCode: code },
    });
    expect(replayed.status).toBe(401);
  }),
);

it.effect("lets the Owner register a new passkey once from a reset link that expires", () =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const ownerId = (created.body.user as { id: string }).id;
    // What `t3 auth owner-reset` calls.
    const { token } = yield* server.environmentAuth.issueOwnerResetLink();

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

    const challenge = yield* server.request("/api/auth/passkey/challenge", { body: {} });
    const assertion = yield* Effect.promise(() =>
      newAuthenticator.get(challenge.body.options as RequestOptions),
    );
    const signedIn = yield* server.request("/api/auth/passkey/sign-in", {
      body: { ceremonyId: challenge.body.ceremonyId, response: assertion },
    });
    expect(signedIn.status).toBe(200);

    const spent = yield* server.request("/api/auth/reset/status", { body: { token } });
    expect(spent.body).toEqual({ status: "invalid" });
    const reused = yield* server.request("/api/auth/reset/registration", { body: { token } });
    expect(reused.status).toBe(401);

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
