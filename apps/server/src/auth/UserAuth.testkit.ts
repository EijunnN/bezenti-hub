import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi, UserId } from "@t3tools/contracts";
import { expect } from "@effect/vitest";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as SpacesHttp from "../spaces/http.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectHttp from "../project/http.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

class AuthTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.spaces)
  .add(EnvironmentHttpApi.groups.projects) {}

const ORIGIN = "http://127.0.0.1";
const RP_ID = "127.0.0.1";

// Real Projects over the same database; workspaces and repository lookups are not under test.
const layerProjects = RuntimeLayer.layerProjectService.pipe(
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(WorkspacePaths.WorkspacePaths, {
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
        resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
          Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
      }),
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
        enqueueCommand: (effect) => effect,
      }),
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ discard: () => Effect.void }),
    ),
  ),
);

const layerServices = Layer.mergeAll(
  EnvironmentAuth.layer,
  SpaceDirectory.layer,
  layerProjects,
).pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-owner-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

export const serveAuthHttp = Effect.gen(function* () {
  const services = yield* Layer.build(layerServices);
  const routes = HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(SpacesHttp.layer),
    Layer.provide(ProjectHttp.layer),
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
  const request = (
    path: string,
    init?: { body?: unknown; cookie?: string; authorization?: string },
  ) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`${ORIGIN}${path}`, {
          method: init?.body === undefined ? "GET" : "POST",
          headers: {
            origin: ORIGIN,
            host: RP_ID,
            "content-type": "application/json",
            ...(init?.cookie ? { cookie: init.cookie } : {}),
            ...(init?.authorization ? { authorization: init.authorization } : {}),
          },
          ...(init?.body === undefined ? {} : { body: encodeJson(init.body) }),
        }),
        requestContext,
      );
      const text = await response.text();
      return {
        status: response.status,
        body: (text.length > 0 ? decodeJson(text) : null) as Record<string, unknown>,
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
    projects: Context.get(services, ProjectService.ProjectService),
    sql: Context.get(services, SqlClient.SqlClient),
  };
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
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

export interface CreationOptions {
  readonly challenge: string;
  readonly user: { readonly id: string };
}
export interface RequestOptions {
  readonly challenge: string;
}

export const makeAuthenticator = () =>
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

export const startOwnerRegistration = Effect.fn(function* (
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

export const finishOwnerRegistration = Effect.fn(function* (
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

export const bootstrapOwner = Effect.fn(function* (
  server: Effect.Success<typeof serveAuthHttp>,
  authenticator: Effect.Success<ReturnType<typeof makeAuthenticator>>,
) {
  const { credential } = yield* server.environmentAuth.issueStartupPairingCredential();
  const ceremony = yield* startOwnerRegistration(server, credential);
  const created = yield* finishOwnerRegistration(server, authenticator, credential, ceremony);
  return { credential, created };
});

export type Server = Effect.Success<typeof serveAuthHttp>;
export type Authenticator = Effect.Success<ReturnType<typeof makeAuthenticator>>;

export const passkeyReauth = Effect.fn(function* (server: Server, authenticator: Authenticator) {
  const challenge = yield* server.request("/api/auth/passkey/challenge", { body: {} });
  const response = yield* Effect.promise(() =>
    authenticator.get(challenge.body.options as RequestOptions),
  );
  return { method: "passkey", ceremonyId: challenge.body.ceremonyId, response };
});

export const isSignedIn = Effect.fn(function* (server: Server, cookie: string | undefined) {
  const session = yield* server.request("/api/auth/session", { cookie: cookie ?? "" });
  return session.body.authenticated === true;
});

/** A User other than the Owner, signed in in one browser; Invitations will create these. */
export const addMember = Effect.fn(function* (
  server: Server,
  member: { readonly id: string; readonly displayName: string } = {
    id: "member-1",
    displayName: "Grace Hopper",
  },
) {
  yield* server.sql`
    INSERT INTO users (user_id, display_name, is_owner, created_at)
    VALUES (${member.id}, ${member.displayName}, 0, '2026-01-01T00:00:00.000Z')
  `;
  const memberSession = yield* server.sessions.issue({
    method: "browser-session-cookie",
    subject: EnvironmentAuth.USER_SIGN_IN_SUBJECT,
    userId: UserId.make(member.id),
  });
  return `${server.sessions.cookieName}=${memberSession.token}`;
});

/** Makes a User a Member of an Organization; Invitations (ticket 06) will do this. */
export const joinOrganization = Effect.fn(function* (
  server: Server,
  spaceId: string,
  userId: string,
  role: "admin" | "member" | "guest",
) {
  yield* server.sql`
    INSERT INTO space_memberships (space_id, user_id, role, created_at)
    VALUES (${spaceId}, ${userId}, ${role}, '2026-01-01T00:00:00.000Z')
  `;
});
