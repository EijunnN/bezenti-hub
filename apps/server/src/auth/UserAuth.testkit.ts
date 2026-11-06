import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentHttpApi,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  UserId,
} from "@t3tools/contracts";
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
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AuditHttp from "../audit/http.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentConnectRoute from "../environments/connectRoute.ts";
import * as EnvironmentRegistry from "../environments/EnvironmentRegistry.ts";
import * as HubEnvironmentsHttp from "../environments/http.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { layerTestPeer, TEST_PEER_HEADER } from "./clientConnection.testkit.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as OwnerPresence from "./OwnerPresence.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as AuthHttp from "./http.ts";
import * as AppSignInHttp from "./appSignInHttp.ts";
import * as McpOAuth from "./McpOAuth.ts";
import * as McpOAuthHttp from "./mcpOAuthHttp.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import * as SpacesHttp from "../spaces/http.ts";
import * as InvitationService from "../spaces/InvitationService.ts";
import * as MembershipService from "../spaces/MembershipService.ts";
import * as OrganizationLifecycle from "../spaces/OrganizationLifecycle.ts";
import * as InvitationsHttp from "../spaces/invitationsHttp.ts";
import * as InstallationUsersHttp from "../spaces/installationUsersHttp.ts";
import * as InstallationUserService from "../spaces/InstallationUserService.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as PullRequestHttp from "../pullRequest/http.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as OrchestrationHttp from "../orchestration-v2/http.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
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
  .add(EnvironmentHttpApi.groups.appSignIn)
  .add(EnvironmentHttpApi.groups.spaces)
  .add(EnvironmentHttpApi.groups.invitations)
  .add(EnvironmentHttpApi.groups.installationUsers)
  .add(EnvironmentHttpApi.groups.audit)
  .add(EnvironmentHttpApi.groups.environments)
  .add(EnvironmentHttpApi.groups.projects)
  .add(EnvironmentHttpApi.groups.orchestration)
  .add(EnvironmentHttpApi.groups.pullRequests)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

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

// Real Thread reads over the same database. Threads are written with `eventSink`; the
// orchestrator, which would run their turns, is not under test.
const layerThreadReads = Layer.effect(
  ThreadManagementService.ThreadManagementService,
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    return {
      readShellSnapshot: store.readShellSnapshot,
      getShellSnapshot: store.getShellSnapshot,
      listActiveShellIndex: store.listActiveShellIndex,
      listOlderSettledThreads: store.listOlderSettledThreads,
      listActiveSubagentThreadIds: store.listActiveSubagentThreadIds,
      getThreadShell: store.getThreadShell,
      getThreadSnapshot: store.getThreadSnapshot,
      getThreadSnapshotWindow: store.getThreadSnapshotWindow,
      ensureLegacyTranscript: () => Effect.void,
    } as unknown as ThreadManagementService.ThreadManagementService["Service"];
  }),
);
const layerThreads = Layer.mergeAll(
  layerThreadReads,
  RuntimeLayer.layerEventSink,
  ThreadSearch.layer,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      RuntimeLayer.layerEventInfrastructure,
      ProjectionStore.layer,
      ProjectStore.layer,
    ),
  ),
);

// Pull Request reads are not under test; one that reaches the service says so.
const layerPullRequests = Layer.mock(PullRequestService.PullRequestService)({
  diff: () => Effect.die("the diff was read"),
});

const makeLayerServices = (config: { readonly publicUrl?: URL }) =>
  // Archive and delete reach Projects and Thread reads; no Thread in these tests runs.
  OrganizationLifecycle.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerPullRequests,
        // Outside MCP clients: OAuth approval and the bearer check /mcp runs.
        Layer.mergeAll(
          InvitationService.layer,
          MembershipService.layer,
          InstallationUserService.layer,
          SpaceVisibility.layer,
          AuditLog.layer,
          EnvironmentRegistry.layer,
          Layer.merge(McpOAuth.layer, McpOAuth.layerMcpClientAuthenticator).pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-test")),
              }),
            ),
          ),
        ).pipe(
          Layer.provideMerge(EnvironmentAuth.layer.pipe(Layer.provideMerge(SpaceDirectory.layer))),
        ),
        layerProjects,
        layerThreads,
      ),
    ),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(OwnerPresence.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.map(ServerConfig.ServerConfig, (base) => ({ ...base, ...config })),
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-owner-test-" }))),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

/**
 * A Hub over HTTP routes, optionally published on `publicUrl`. With `listen`, the same routes and
 * the Environment socket also answer on a real loopback port (`url`), for WebSocket clients.
 */
export const serveAuthHttpWith = Effect.fn(function* (
  config: { readonly publicUrl?: URL; readonly listen?: boolean } = {},
) {
  const services = yield* Layer.build(
    makeLayerServices(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }),
  );
  const routes = HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(AppSignInHttp.layer),
    Layer.provide(SpacesHttp.layer),
    Layer.provide(InvitationsHttp.layer),
    Layer.provide(InstallationUsersHttp.layer),
    Layer.provide(AuditHttp.layer),
    Layer.provide(HubEnvironmentsHttp.layer),
    Layer.provide(ProjectHttp.layer),
    Layer.provide(OrchestrationHttp.layer),
    Layer.provide(PullRequestHttp.layer),
    Layer.provide(McpOAuthHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(layerTestPeer),
    Layer.provide(Layer.succeedContext(services)),
    Layer.provide(HttpPlatform.layer),
    Layer.provide(Etag.layerWeak),
    Layer.provide(NodeServices.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  let url = "";
  if (config.listen === true) {
    const served = yield* HttpRouter.serve(
      Layer.mergeAll(
        routes,
        EnvironmentConnectRoute.layer.pipe(Layer.provide(Layer.succeedContext(services))),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(
      Layer.provide(Layer.succeedContext(services)),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.fresh,
      Layer.build,
    );
    const address = Context.get(served, HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
    url = `http://127.0.0.1:${address.port}`;
  }
  const environmentAuth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
  // Requests run on this test's clock, so expiry follows TestClock.
  const requestContext = Context.merge(services, yield* Effect.context());
  const request = (
    path: string,
    init?: {
      body?: unknown;
      cookie?: string;
      authorization?: string;
      /** The direct peer's address; loopback when omitted. */
      peer?: string;
      headers?: Record<string, string>;
      /** An `application/x-www-form-urlencoded` body, as OAuth token requests send. */
      form?: Record<string, string>;
    },
  ) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`${ORIGIN}${path}`, {
          method: init?.body === undefined && init?.form === undefined ? "GET" : "POST",
          headers: {
            [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
            origin: ORIGIN,
            host: RP_ID,
            "content-type":
              init?.form === undefined ? "application/json" : "application/x-www-form-urlencoded",
            ...(init?.cookie ? { cookie: init.cookie } : {}),
            ...(init?.authorization ? { authorization: init.authorization } : {}),
            ...(init?.peer ? { [TEST_PEER_HEADER]: init.peer } : {}),
            ...init?.headers,
          },
          ...(init?.body === undefined ? {} : { body: encodeJson(init.body) }),
          ...(init?.form === undefined ? {} : { body: new URLSearchParams(init.form).toString() }),
        }),
        requestContext,
      );
      const text = await response.text();
      const setCookie = response.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith("t3_session_"));
      return {
        status: response.status,
        body: (text.length > 0 ? decodeJson(text) : null) as Record<string, unknown>,
        cookie: setCookie?.split(";", 1)[0],
        setCookie,
      };
    });
  return {
    environmentAuth,
    services,
    /** The real loopback address, with `listen`. */
    url,
    request,
    sessions: Context.get(services, SessionStore.SessionStore),
    projects: Context.get(services, ProjectService.ProjectService),
    eventSink: Context.get(services, EventSink.EventSinkV2),
    sql: Context.get(services, SqlClient.SqlClient),
  };
});

export const serveAuthHttp = serveAuthHttpWith();

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

/** A User other than the Owner, signed in in one browser, without going through an Invitation. */
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

/** Makes a User a Member of an Organization directly, for tests not about Invitations. */
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

// An authenticator app, written from RFC 6238 independently of the server's code.
export const totpCode = (base32Secret: string, nowMillis: number) =>
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
