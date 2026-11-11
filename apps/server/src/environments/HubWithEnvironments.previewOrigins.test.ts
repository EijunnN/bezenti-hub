// @effect-diagnostics nodeBuiltinImport:off -- a dev server on the machine's loopback, and a browser that names the host it asks for.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  HUB_MACHINE_ENVIRONMENT_ID,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  sandboxEnvironmentIdOf,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as HubPreviews from "../preview/HubPreviews.ts";
import { PREVIEW_HANDOFF_PATH, PREVIEW_SANDBOX_POLICY } from "../preview/hubPreviewRoute.ts";
import { parsePreviewOrigin } from "../preview/PreviewOrigin.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { makeHub, seedProject, type Hub } from "./HubWithEnvironments.testkit.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");

/** A machine with the provider but no recorded turns: these tests run none. */
const idleAdapters = ProviderAdapterRegistry.layerFromAdapters([
  {
    instanceId,
    driver: CLAUDE,
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("no turns run here"),
  },
]);

/** `T3CODE_PREVIEW_ORIGIN=http://*.preview.localhost`: browsers treat `*.localhost` as secure. */
const ZONE = "preview.localhost";
const parsed = parsePreviewOrigin(`http://*.${ZONE}`);
if (Result.isFailure(parsed)) throw new Error(parsed.failure);
const PREVIEWS = parsed.success;

const NAVIGATION = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
const NOT_AVAILABLE = "This preview is not available.";

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
}

const textFrame = (text: string) => {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
};

/** A browser's frame: masked, short. */
const maskedTextFrame = (text: string) => {
  const payload = Buffer.from(text);
  const mask = NodeCrypto.randomBytes(4);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!));
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
};

const readMaskedFrames = (data: Buffer) => {
  const frames: Array<{ readonly opcode: number; readonly text: string }> = [];
  let offset = 0;
  while (offset + 6 <= data.length) {
    const opcode = data[offset]! & 0x0f;
    const length = data[offset + 1]! & 0x7f;
    const mask = data.subarray(offset + 2, offset + 6);
    const payload = Buffer.from(data.subarray(offset + 6, offset + 6 + length));
    for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index % 4]!;
    frames.push({ opcode, text: payload.toString("utf8") });
    offset += 6 + length;
  }
  return frames;
};

/**
 * A dev server as Vite is one for this purpose: pages, root-absolute modules, cookies of its own
 * (one reaching for the whole domain, one posing as the preview's), redirects, and an HMR socket.
 */
const startDevServer = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        readonly port: number;
        readonly server: NodeHttp.Server;
        readonly seen: Array<SeenRequest>;
      }>((resolve) => {
        const seen: Array<SeenRequest> = [];
        const sockets = new Set<NodeNet.Socket>();
        const server = NodeHttp.createServer((request, response) => {
          request.resume();
          request.on("end", () => {
            seen.push({
              method: request.method ?? "",
              url: request.url ?? "",
              headers: request.headers,
            });
            const address = server.address() as NodeNet.AddressInfo;
            if (request.url === "/old") {
              response.writeHead(302, { location: "/new?from=old" });
              response.end();
              return;
            }
            if (request.url === "/abs") {
              response.writeHead(302, { location: `http://localhost:${address.port}/elsewhere` });
              response.end();
              return;
            }
            response.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "content-security-policy": "default-src 'self'",
              // On a browser this would clear every cookie of the registrable domain: the Hub's too.
              "clear-site-data": '"cookies"',
              "set-cookie": [
                "app=1; Path=/",
                `wide=1; Path=/; Domain=${ZONE}`,
                "__Host-t3_preview=forged; Path=/; Secure",
              ],
            });
            response.end(
              `<h1>Hello from the dev server</h1><p>${request.method} ${request.url}</p>`,
            );
          });
        });
        server.on("connection", (socket) => {
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
        });
        server.on("upgrade", (request, socket) => {
          const key = String(request.headers["sec-websocket-key"]);
          const accept = NodeCrypto.createHash("sha1")
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
          seen.push({ method: "UPGRADE", url: request.url ?? "", headers: request.headers });
          socket.write(
            [
              "HTTP/1.1 101 Switching Protocols",
              "Upgrade: websocket",
              "Connection: Upgrade",
              `Sec-WebSocket-Accept: ${accept}`,
              "Sec-WebSocket-Protocol: vite-hmr",
              "",
              "",
            ].join("\r\n"),
          );
          socket.on("data", (data: Buffer) => {
            for (const frame of readMaskedFrames(data)) {
              if (frame.opcode === 0x8) {
                socket.end(Buffer.from([0x88, 0]));
                return;
              }
              if (frame.opcode === 0x1) socket.write(textFrame(`echo:${frame.text}`));
            }
          });
        });
        (server as NodeHttp.Server & { sockets?: Set<NodeNet.Socket> }).sockets = sockets;
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve({
            port: typeof address === "object" && address !== null ? address.port : 0,
            server,
            seen,
          });
        });
      }),
  ),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          for (const socket of (server as NodeHttp.Server & { sockets?: Set<NodeNet.Socket> })
            .sockets ?? []) {
            socket.destroy();
          }
          server.close(() => resolve());
        }),
    ),
);

interface Answer {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly setCookie: ReadonlyArray<string>;
  readonly text: string;
}

/**
 * A request to the Hub's listening port as a browser at `host` sends it (the preview's DNS name
 * resolves to the Hub): redirects left to the caller.
 */
const request = (
  hub: Hub,
  host: string | undefined,
  path: string,
  options: { readonly method?: string; readonly headers?: Record<string, string> } = {},
) =>
  Effect.promise(
    () =>
      new Promise<Answer>((resolve, reject) => {
        const port = Number(new URL(hub.server.url).port);
        const sent = NodeHttp.request(
          {
            host: "127.0.0.1",
            port,
            path,
            method: options.method ?? "GET",
            headers: { ...(host === undefined ? {} : { host }), ...options.headers },
          },
          (response) => {
            let text = "";
            response.on("data", (chunk: Buffer) => {
              text += chunk.toString("utf8");
            });
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                setCookie: response.headers["set-cookie"] ?? [],
                text,
              }),
            );
          },
        );
        sent.on("error", reject);
        sent.end();
      }),
  );

/**
 * A WebSocket at `host` (Vite's HMR client connects to the page's own host): `reply` is the
 * answer to "ping" once open, `refused` the status otherwise; `closed` resolves when it ends.
 */
const socketAt = (hub: Hub, host: string, path: string, cookie: string | undefined) =>
  Effect.promise(
    () =>
      new Promise<
        | {
            readonly _tag: "open";
            readonly protocol: string;
            readonly reply: string;
            readonly closed: Promise<void>;
          }
        | { readonly _tag: "refused"; readonly status: number }
      >((resolve, reject) => {
        const port = Number(new URL(hub.server.url).port);
        const sent = NodeHttp.request({
          host: "127.0.0.1",
          port,
          path,
          headers: {
            host,
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": NodeCrypto.randomBytes(16).toString("base64"),
            "sec-websocket-protocol": "vite-hmr",
            origin: `http://${host}`,
            ...(cookie === undefined ? {} : { cookie }),
          },
        });
        sent.on("response", (response) => {
          response.resume();
          resolve({ _tag: "refused", status: response.statusCode ?? 0 });
        });
        sent.on("upgrade", (response, socket) => {
          let first = true;
          // Closed: the Hub's close frame, or the connection itself ending.
          const closed = new Promise<void>((done) => {
            socket.on("close", () => done());
            socket.on("end", () => done());
            socket.on("data", (data: Buffer) => {
              if (!first && (data[0]! & 0x0f) === 0x8) done();
            });
          });
          socket.once("data", (data: Buffer) => {
            first = false;
            const length = data[1]! & 0x7f;
            resolve({
              _tag: "open",
              protocol: String(response.headers["sec-websocket-protocol"] ?? ""),
              reply: data.subarray(2, 2 + length).toString("utf8"),
              closed,
            });
          });
          socket.write(maskedTextFrame("ping"));
        });
        sent.on("error", reject);
        sent.end();
      }),
  );

const ownerIdOf = Effect.fn(function* (hub: Hub) {
  const [row] = yield* hub.server.sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM users WHERE is_owner = 1
  `;
  assert.isDefined(row);
  return UserId.make(row.userId);
});

const sessionOf = Effect.fn(function* (hub: Hub, cookie: string) {
  const token = cookie.slice(cookie.indexOf("=") + 1);
  return yield* hub.server.sessions.verify(token).pipe(Effect.orDie);
});

/** A Thread of the Owner's in a Project of Acme, in Acme's Sandbox, on a Hub with preview origins. */
const threadInSandbox = Effect.fn(function* () {
  const hub = yield* makeHub({ sandboxAdapters: idleAdapters, previewOrigin: PREVIEWS });
  const owner = yield* ownerIdOf(hub);
  const spaces = hub.service(SpaceDirectory.SpaceDirectory);
  const acme = (yield* spaces.createOrganization(owner, "Acme").pipe(Effect.orDie)).id;
  const globex = (yield* spaces.createOrganization(owner, "Globex").pipe(Effect.orDie)).id;
  const projectId = ProjectId.make("project:acme-web");
  yield* seedProject(hub.server, {
    projectId,
    title: "Acme web",
    defaultModelSelection: null,
    spaceId: acme,
  });
  const sandboxId = sandboxEnvironmentIdOf(acme);
  yield* hub.service(EnvironmentRegistry.EnvironmentRegistry).chooseForThread({
    userId: owner,
    requested: sandboxId,
    projectId,
    providerInstanceId: instanceId,
  });
  const threadId = ThreadId.make("thread:acme-preview");
  yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:acme-preview"),
    threadId,
    projectId,
    title: "Preview",
    modelSelection: { instanceId, model: "claude-sonnet-4-6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeEnvironmentId: sandboxId,
  });
  const ownerSession = yield* sessionOf(hub, hub.owner);
  const previews = hub.service(HubPreviews.HubPreviews);
  return { hub, owner, acme, globex, sandboxId, threadId, ownerSession, previews };
});

/**
 * Opens `address` as its User's browser does: the Hub's address, signed in, hands over to the
 * preview's own origin, which sets that origin's cookie. Answers the host and the cookie.
 */
const openOnOwnOrigin = Effect.fn(function* (hub: Hub, cookie: string, path: string) {
  const opened = yield* request(hub, undefined, path, { headers: { ...NAVIGATION, cookie } });
  assert.equal(opened.status, 303, opened.text);
  const handoff = new URL(String(opened.headers.location));
  const landed = yield* request(hub, handoff.host, `${handoff.pathname}${handoff.search}`, {
    headers: NAVIGATION,
  });
  assert.equal(landed.status, 303, landed.text);
  const set = landed.setCookie.find((value) => value.startsWith("__Host-t3_preview="));
  assert.isDefined(set);
  return { host: handoff.host, handoff, landed, set: set!, cookie: set!.split(";", 1)[0]! };
});

describe("Hub con Environments: previews on their own origin", () => {
  it.live(
    "a preview opens on its own origin through a one-time handoff: its cookies, modules and HMR socket",
    () =>
      Effect.gen(function* () {
        const { hub, owner, threadId, ownerSession, previews } = yield* threadInSandbox();
        const dev = yield* startDevServer;
        const address = yield* previews.address({
          userId: owner,
          sessionId: ownerSession.sessionId,
          threadId,
          port: dev.port,
        });
        // The address a client opens is still the Hub's own, stable while it lasts.
        assert.match(address.path, /^\/preview\/[\w-]{43}\/$/);
        const onHub = `${address.path}docs/index.html?tab=1`;

        // On the Hub's origin nothing is relayed any more: a signed-out browser is told to sign
        // in, and a page's request (not a navigation) finds nothing.
        const signedOut = yield* request(hub, undefined, onHub, { headers: NAVIGATION });
        assert.equal(signedOut.status, 401);
        const fetched = yield* request(hub, undefined, onHub, { headers: { cookie: hub.owner } });
        assert.equal(fetched.status, 404);
        assert.equal(dev.seen.length, 0);

        // Signed in, the browser is handed to the preview's own origin, with nothing set here.
        const opened = yield* request(hub, undefined, onHub, {
          headers: { ...NAVIGATION, cookie: hub.owner },
        });
        assert.equal(opened.status, 303);
        assert.deepEqual(opened.setCookie, []);
        assert.equal(opened.headers["referrer-policy"], "no-referrer");
        const handoff = new URL(String(opened.headers.location));
        assert.equal(handoff.protocol, "http:");
        assert.match(handoff.hostname, new RegExp(`^[a-z2-7]{52}\\.${ZONE.replace(".", "\\.")}$`));
        assert.equal(handoff.pathname, PREVIEW_HANDOFF_PATH);
        assert.equal(handoff.searchParams.get("path"), "/docs/index.html?tab=1");
        assert.equal(dev.seen.length, 0);

        // The handoff sets the origin's own cookie, host-only, and goes on to the page.
        const host = handoff.host;
        const handoffPath = `${handoff.pathname}${handoff.search}`;
        const landed = yield* request(hub, host, handoffPath, { headers: NAVIGATION });
        assert.equal(landed.status, 303);
        assert.equal(landed.headers.location, "/docs/index.html?tab=1");
        assert.lengthOf(landed.setCookie, 1);
        const set = landed.setCookie[0]!;
        assert.match(set, /^__Host-t3_preview=[\w-]{43};/);
        assert.match(set, /;\s*Path=\/;/);
        assert.match(set, /;\s*HttpOnly/i);
        assert.match(set, /;\s*Secure/i);
        assert.match(set, /;\s*SameSite=Lax/i);
        assert.notMatch(set, /Domain=/i);
        const preview = set.split(";", 1)[0]!;
        // Spent on first use: the same link again opens nothing.
        const replayed = yield* request(hub, host, handoffPath, { headers: NAVIGATION });
        assert.equal(replayed.status, 403);
        assert.deepEqual(replayed.setCookie, []);

        // The page runs as itself: the dev server's own policy, no sandbox; its cookies are its
        // own, host-only; the Hub's session and the preview's cookie never reach the dev server.
        const page = yield* request(hub, host, "/docs/index.html?tab=1", {
          headers: {
            ...NAVIGATION,
            // The page's own: a cookie named like T3 Code's (T3 Code previewing itself) and an
            // Authorization header (on its own origin it is the page's, never the Hub's).
            cookie: `${preview}; app=1; t3_session_app=own`,
            authorization: "Bearer page-token",
          },
        });
        assert.equal(page.status, 200);
        assert.include(page.text, "GET /docs/index.html?tab=1");
        assert.equal(page.headers["content-security-policy"], "default-src 'self'");
        assert.notEqual(page.headers["content-security-policy"], PREVIEW_SANDBOX_POLICY);
        assert.include(page.setCookie, "app=1; Path=/");
        assert.include(page.setCookie, "wide=1; Path=/");
        assert.isFalse(page.setCookie.some((cookie) => /Domain=/i.test(cookie)));
        assert.isFalse(page.setCookie.some((cookie) => cookie.startsWith("__Host-t3_preview=")));
        const reached = dev.seen.at(-1)!;
        assert.equal(reached.headers.cookie, "app=1; t3_session_app=own");
        assert.equal(reached.headers.authorization, "Bearer page-token");
        // A dev server never clears the Hub's session or other previews' cookies.
        assert.isUndefined(page.headers["clear-site-data"]);
        assert.equal(reached.headers.host, `localhost:${dev.port}`);

        // What Vite serves the page: root-absolute module URLs and fetch() calls, with cookies,
        // from the page's own origin (which the dev server sees as itself).
        const module = yield* request(hub, host, "/src/main.ts?t=1", {
          headers: {
            cookie: preview,
            origin: `http://${host}`,
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
          },
        });
        assert.equal(module.status, 200);
        assert.equal(dev.seen.at(-1)!.url, "/src/main.ts?t=1");
        assert.equal(dev.seen.at(-1)!.headers.origin, `http://localhost:${dev.port}`);
        const posted = yield* request(hub, host, "/api/echo", {
          method: "POST",
          headers: { cookie: preview, origin: `http://${host}` },
        });
        assert.equal(posted.status, 200);
        assert.equal(dev.seen.at(-1)!.method, "POST");

        // Redirects stay on the origin: a relative one as it is, one to the dev server itself
        // onto the preview's origin.
        const moved = yield* request(hub, host, "/old", { headers: { cookie: preview } });
        assert.equal(moved.headers.location, "/new?from=old");
        const absolute = yield* request(hub, host, "/abs", { headers: { cookie: preview } });
        assert.equal(absolute.headers.location, `http://${host}/elsewhere`);

        // Vite's HMR socket, on the page's own host, with the cookie it carries.
        const socket = yield* socketAt(hub, host, "/?token=hmr", preview);
        assert.equal(socket._tag, "open");
        if (socket._tag === "open") {
          assert.equal(socket.protocol, "vite-hmr");
          assert.equal(socket.reply, "echo:ping");
        }
        assert.equal(dev.seen.at(-1)!.url, "/?token=hmr");
        assert.isUndefined(dev.seen.at(-1)!.headers.cookie);

        // Without the origin's cookie nothing reaches the dev server: not a leaked URL, not the
        // Hub's session (which never counts there), not a forged cookie, not the socket.
        const served = dev.seen.length;
        for (const cookie of [undefined, hub.owner, "__Host-t3_preview=forged"]) {
          const refused = yield* request(hub, host, "/docs/", {
            headers: { ...NAVIGATION, ...(cookie === undefined ? {} : { cookie }) },
          });
          assert.equal(refused.status, 401, String(cookie));
        }
        const socketRefused = yield* socketAt(hub, host, "/", hub.owner);
        assert.deepEqual(socketRefused, { _tag: "refused", status: 401 });
        assert.equal(dev.seen.length, served);
      }).pipe(Effect.scoped),
  );

  it.live("nothing under the preview zone reaches the Hub, whatever the host or path", () =>
    Effect.gen(function* () {
      const { hub, owner, threadId, ownerSession, previews } = yield* threadInSandbox();
      const dev = yield* startDevServer;
      const address = yield* previews.address({
        userId: owner,
        sessionId: ownerSession.sessionId,
        threadId,
        port: dev.port,
      });
      const { host, cookie } = yield* openOnOwnOrigin(hub, hub.owner, address.path);
      const doors = [
        "/api/auth/session",
        "/api/spaces",
        "/api/environments",
        "/",
        "/sign-in",
        address.path,
        "/api/preview-stream/x",
        "/mcp",
        "/ws",
      ];
      // Hosts in the zone that are no preview's: the Hub answers none of its own routes there,
      // even with its own session cookie (Host header confusion).
      for (const other of [
        `${"a".repeat(52)}.${ZONE}`,
        `hub.${ZONE}`,
        `x.${host}`,
        `${host.split(".")[0]}.${ZONE}:8443`,
      ]) {
        for (const path of doors) {
          const answer = yield* request(hub, other, path, { headers: { cookie: hub.owner } });
          assert.equal(answer.status, 404, `${other}${path}`);
          assert.equal(answer.text, NOT_AVAILABLE, `${other}${path}`);
        }
        const socket = yield* socketAt(hub, other, "/ws", hub.owner);
        assert.deepEqual(socket, { _tag: "refused", status: 404 });
      }
      // On the preview's own host, the same paths are the dev server's, never the Hub's.
      const asked = dev.seen.length;
      for (const path of doors) {
        const answer = yield* request(hub, host, path, { headers: { cookie } });
        assert.equal(answer.status, 200, path);
        assert.include(answer.text, "Hello from the dev server", path);
      }
      assert.deepEqual(
        dev.seen.slice(asked).map((seen) => seen.url),
        doors,
      );
      // The Hub's own host is untouched.
      const session = yield* request(hub, undefined, "/api/auth/session", {
        headers: { cookie: hub.owner },
      });
      assert.equal(session.status, 200);
      assert.include(session.text, '"authenticated":true');
    }).pipe(Effect.scoped),
  );

  it.live(
    "only its User opens it, on an origin of its own: not an Admin, Member or Guest of its Space, nor another Space's",
    () =>
      Effect.gen(function* () {
        const { hub, owner, acme, globex, threadId, ownerSession, previews } =
          yield* threadInSandbox();
        const dev = yield* startDevServer;
        const others = [
          { id: UserId.make("admin-acme"), space: acme, role: "admin" },
          { id: UserId.make("member-acme"), space: acme, role: "member" },
          { id: UserId.make("guest-acme"), space: acme, role: "guest" },
          { id: UserId.make("member-globex"), space: globex, role: "member" },
        ] as const;
        const cookies = new Map<string, string>();
        for (const other of others) {
          cookies.set(
            other.id,
            yield* addMember(hub.server, { id: other.id, displayName: other.id }),
          );
          yield* joinOrganization(hub.server, other.space, other.id, other.role);
        }
        yield* hub.service(SpaceDirectory.SpaceDirectory).changed;
        const address = yield* previews.address({
          userId: owner,
          sessionId: ownerSession.sessionId,
          threadId,
          port: dev.port,
        });
        const mine = yield* openOnOwnOrigin(hub, hub.owner, address.path);

        for (const other of others) {
          const cookie = cookies.get(other.id)!;
          // The Owner's link, opened by them: no handoff, so no way onto the origin.
          const opened = yield* request(hub, undefined, address.path, {
            headers: { ...NAVIGATION, cookie },
          });
          assert.equal(opened.status, 404, other.id);
          assert.equal(opened.text, NOT_AVAILABLE, other.id);
          // The origin itself, with their own Hub session: it does not count there.
          const direct = yield* request(hub, mine.host, "/", {
            headers: { ...NAVIGATION, cookie },
          });
          assert.equal(direct.status, 401, other.id);
          // Nor may they get an address of their own for the Thread.
          const session = yield* sessionOf(hub, cookie);
          const made = yield* previews
            .address({ userId: other.id, sessionId: session.sessionId, threadId, port: dev.port })
            .pipe(Effect.flip);
          assert.equal(made.reason, "outside_thread_workspace", other.id);
        }
        // A handoff code is for its own origin only: spent on another preview's host, nothing.
        const second = yield* previews.address({
          userId: owner,
          sessionId: ownerSession.sessionId,
          threadId,
          port: 9,
        });
        const handedOver = yield* request(hub, undefined, second.path, {
          headers: { ...NAVIGATION, cookie: hub.owner },
        });
        const secondHandoff = new URL(String(handedOver.headers.location));
        assert.notEqual(secondHandoff.host, mine.host);
        const misplaced = yield* request(
          hub,
          mine.host,
          `${secondHandoff.pathname}${secondHandoff.search}`,
          { headers: NAVIGATION },
        );
        assert.equal(misplaced.status, 403);
        // And one origin's cookie opens no other.
        const crossed = yield* request(hub, secondHandoff.host, "/", {
          headers: { cookie: mine.cookie },
        });
        assert.equal(crossed.status, 401);

        // Another session of the same User gets an origin of its own too.
        const otherSession = yield* hub.server.sessions
          .issue({
            method: "browser-session-cookie",
            subject: EnvironmentAuth.USER_SIGN_IN_SUBJECT,
            userId: owner,
          })
          .pipe(Effect.orDie);
        const theirs = yield* openOnOwnOrigin(
          hub,
          `${hub.server.sessions.cookieName}=${otherSession.token}`,
          (yield* previews.address({
            userId: owner,
            sessionId: otherSession.sessionId,
            threadId,
            port: dev.port,
          })).path,
        );
        assert.notEqual(theirs.host, mine.host);
      }).pipe(Effect.scoped),
  );

  it.live(
    "access on that origin ends with the access: the Thread moves (a live HMR socket closes), the session ends",
    () =>
      Effect.gen(function* () {
        const { hub, owner, sandboxId, threadId, ownerSession, previews } =
          yield* threadInSandbox();
        const dev = yield* startDevServer;
        const address = yield* previews.address({
          userId: owner,
          sessionId: ownerSession.sessionId,
          threadId,
          port: dev.port,
        });
        const { host, cookie } = yield* openOnOwnOrigin(hub, hub.owner, address.path);
        assert.equal((yield* request(hub, host, "/", { headers: { cookie } })).status, 200);
        const socket = yield* socketAt(hub, host, "/", cookie);
        assert.equal(socket._tag, "open");

        yield* hub.server.sql`
          UPDATE orchestration_v2_projection_threads
          SET active_environment_id = ${HUB_MACHINE_ENVIRONMENT_ID} WHERE thread_id = ${threadId}
        `;
        assert.equal((yield* request(hub, host, "/", { headers: { cookie } })).status, 404);
        if (socket._tag === "open") {
          yield* Effect.promise(() => socket.closed).pipe(Effect.timeout("10 seconds"));
        }

        // Back on the Sandbox, then signed out: the session takes its addresses and origins.
        yield* hub.server.sql`
          UPDATE orchestration_v2_projection_threads
          SET active_environment_id = ${sandboxId} WHERE thread_id = ${threadId}
        `;
        const reopened = yield* previews.address({
          userId: owner,
          sessionId: ownerSession.sessionId,
          threadId,
          port: dev.port,
        });
        const again = yield* openOnOwnOrigin(hub, hub.owner, reopened.path);
        assert.equal(
          (yield* request(hub, again.host, "/", { headers: { cookie: again.cookie } })).status,
          200,
        );
        yield* hub.server.sessions.revoke(ownerSession.sessionId).pipe(Effect.orDie);
        const asked = dev.seen.length;
        assert.equal(
          (yield* request(hub, again.host, "/", { headers: { cookie: again.cookie } })).status,
          404,
        );
        assert.equal(dev.seen.length, asked);
      }).pipe(Effect.scoped),
  );

  it.live("one User's pending handoffs never push out another User's", () =>
    Effect.gen(function* () {
      const { hub, owner, threadId, ownerSession, previews } = yield* threadInSandbox();
      const dev = yield* startDevServer;
      const address = yield* previews.address({
        userId: owner,
        sessionId: ownerSession.sessionId,
        threadId,
        port: dev.port,
      });
      const { host } = yield* openOnOwnOrigin(hub, hub.owner, address.path);
      const id = host.split(".")[0]!;
      const resolved = yield* previews.resolve(address.path.split("/")[2]!, {
        hubUser: Option.some(owner),
        pass: Option.none(),
      });
      assert.equal(resolved._tag, "open");
      if (resolved._tag !== "open") return;
      // Another User's code, then far more of the Owner's than any one User may hold.
      const theirs = yield* previews.handoff({
        ...resolved.address,
        principal: UserId.make("someone-else"),
      });
      const first = yield* previews.handoff(resolved.address);
      for (let index = 0; index < 1_100; index++) yield* previews.handoff(resolved.address);
      // The Owner's oldest went; the other User's is still good.
      assert.isTrue(Option.isNone(yield* previews.redeemHandoff(id, first)));
      assert.isTrue(Option.isSome(yield* previews.redeemHandoff(id, theirs)));
      assert.isAtLeast(HubPreviews.MAX_HANDOFFS_PER_USER, 1);
    }).pipe(Effect.scoped),
  );
});
