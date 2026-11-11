// @effect-diagnostics nodeBuiltinImport:off -- a dev server on the machine's loopback, as a User starts one.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  HUB_MACHINE_ENVIRONMENT_ID,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  sandboxEnvironmentIdOf,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { fetch as undiciFetch, WebSocket as UndiciWebSocket } from "undici";

import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as Sandboxes from "../sandboxes/Sandboxes.ts";
import { listEnvironments } from "./environments.testkit.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as HubPreviews from "../preview/HubPreviews.ts";
import { PREVIEW_SANDBOX_POLICY } from "../preview/hubPreviewRoute.ts";
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

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

/** One unmasked WebSocket text frame (short payloads only). */
const textFrame = (text: string) => {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
};

/** The frames a browser sent: masked, short. */
const readFrames = (data: Buffer) => {
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
 * A dev server as a User starts one in a Thread's terminal: a page, a redirect, a body echo,
 * and a WebSocket that answers each message (the HMR socket of a real one). It records what
 * reached it.
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
          let body = "";
          request.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
          });
          request.on("end", () => {
            seen.push({
              method: request.method ?? "",
              url: request.url ?? "",
              headers: request.headers,
              body,
            });
            // A response that never ends, as a dev server's event stream.
            if (request.url === "/events") {
              response.writeHead(200, { "content-type": "text/event-stream" });
              response.write("data: hello" + String.fromCharCode(10, 10));
              return;
            }
            if (request.url === "/old") {
              response.writeHead(302, { location: "/new?from=old" });
              response.end();
              return;
            }
            response.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "set-cookie": "dev=1; Path=/",
              "clear-site-data": '"cookies"',
            });
            response.end(
              `<h1>Hello from the dev server</h1><p>${request.method} ${request.url} ${body}</p>`,
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
          const protocol = String(request.headers["sec-websocket-protocol"] ?? "")
            .split(",")[0]
            ?.trim();
          seen.push({
            method: "UPGRADE",
            url: request.url ?? "",
            headers: request.headers,
            body: "",
          });
          socket.write(
            [
              "HTTP/1.1 101 Switching Protocols",
              "Upgrade: websocket",
              "Connection: Upgrade",
              `Sec-WebSocket-Accept: ${accept}`,
              ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
              "",
              "",
            ].join("\r\n"),
          );
          socket.on("data", (data: Buffer) => {
            for (const frame of readFrames(data)) {
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

const ownerIdOf = Effect.fn(function* (hub: Hub) {
  const [row] = yield* hub.server.sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM users WHERE is_owner = 1
  `;
  assert.isDefined(row);
  return UserId.make(row.userId);
});

/** The session a `name=token` cookie carries. */
const sessionOf = Effect.fn(function* (hub: Hub, cookie: string) {
  const token = cookie.slice(cookie.indexOf("=") + 1);
  return yield* hub.server.sessions.verify(token).pipe(Effect.orDie);
});

/** A request as a browser sends it, redirects left to the caller. */
const fetchPage = async (url: string, init: Parameters<typeof undiciFetch>[1] = {}) => {
  const response = await undiciFetch(url, { redirect: "manual", ...init });
  return { status: response.status, headers: response.headers, text: await response.text() };
};

const get = (url: string, init: Parameters<typeof undiciFetch>[1] = {}) =>
  Effect.promise(() => fetchPage(url, init));

/** A GET with exactly these headers (fetch sets its own `Sec-Fetch-Mode`). */
const navigate = (url: string, headers: Record<string, string>) =>
  Effect.promise(
    () =>
      new Promise<{
        readonly status: number;
        readonly text: string;
        readonly setCookie: ReadonlyArray<string>;
      }>((resolve, reject) => {
        const request = NodeHttp.get(url, { headers }, (response) => {
          let text = "";
          response.on("data", (chunk: Buffer) => {
            text += chunk.toString("utf8");
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              text,
              setCookie: response.headers["set-cookie"] ?? [],
            }),
          );
        });
        request.on("error", reject);
      }),
  );

/** A browser opening the page: a top-level navigation. */
const NAVIGATION = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

/** The preview cookie a navigation set, as `name=value`. */
const previewCookieOf = (setCookie: ReadonlyArray<string>) => {
  const found = setCookie.find((cookie) => cookie.startsWith("t3_preview="));
  assert.isDefined(found);
  return { cookie: found.split(";", 1)[0]!, attributes: found };
};

/** A WebSocket to the Hub, open; `closed` resolves with its close code. */
const openSocket = (url: string, cookie: string) =>
  Effect.promise(
    () =>
      new Promise<{ readonly closed: Promise<number> }>((resolve, reject) => {
        const socket = new UndiciWebSocket(url, { protocols: ["vite-hmr"], headers: { cookie } });
        const closed = new Promise<number>((done) =>
          socket.addEventListener("close", (event) => done(event.code)),
        );
        socket.addEventListener("open", () => resolve({ closed }));
        socket.addEventListener("error", () => reject(new Error("the preview socket failed")));
      }),
  );

/** A WebSocket to the Hub, as a browser opens one, answered once with what it sent first. */
const echoOnce = (url: string, cookie: string, message: string) =>
  Effect.promise(
    () =>
      new Promise<{ readonly protocol: string; readonly reply: string }>((resolve, reject) => {
        const socket = new UndiciWebSocket(url, {
          protocols: ["vite-hmr"],
          headers: { cookie },
        });
        socket.addEventListener("open", () => socket.send(message));
        socket.addEventListener("message", (event) => {
          resolve({ protocol: socket.protocol, reply: String(event.data) });
          socket.close(1000);
        });
        socket.addEventListener("error", () => reject(new Error("the preview socket failed")));
      }),
  );

/** A Thread of the Owner's in a Project of Acme, running in Acme's Sandbox. */
const threadInSandbox = Effect.fn(function* () {
  const hub = yield* makeHub({ sandboxAdapters: idleAdapters });
  const owner = yield* ownerIdOf(hub);
  const acme = (yield* hub
    .service(SpaceDirectory.SpaceDirectory)
    .createOrganization(owner, "Acme")
    .pipe(Effect.orDie)).id;
  const globex = (yield* hub
    .service(SpaceDirectory.SpaceDirectory)
    .createOrganization(owner, "Globex")
    .pipe(Effect.orDie)).id;
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

describe("Hub con Environments: previews through the Hub", () => {
  it.live(
    "a dev server in a Space's Sandbox opens at an address on the Hub, pages and sockets",
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
        assert.match(address.path, /^\/preview\/[\w-]{43}\/$/);
        // Asked again while it lasts, it is the same address.
        assert.equal(
          (yield* previews.address({
            userId: owner,
            sessionId: ownerSession.sessionId,
            threadId,
            port: dev.port,
          })).path,
          address.path,
        );
        const base = `${hub.server.url}${address.path}`;

        const page = yield* get(`${base}docs/index.html?tab=1`, {
          headers: { cookie: hub.owner, "x-forwarded-for": "203.0.113.9" },
        });
        assert.equal(page.status, 200);
        assert.include(page.text, "<h1>Hello from the dev server</h1>");
        assert.include(page.text, "GET /docs/index.html?tab=1");
        // Sandboxed: the page shares no origin, cookies or storage with the Hub.
        assert.equal(page.headers.get("content-security-policy"), PREVIEW_SANDBOX_POLICY);
        assert.equal(page.headers.get("referrer-policy"), "no-referrer");
        assert.isNull(page.headers.get("set-cookie"));
        assert.isNull(page.headers.get("clear-site-data"));
        assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
        // The Hub's session and the client's addresses never reach the dev server.
        const reached = dev.seen.at(-1);
        assert.isUndefined(reached?.headers.cookie);
        assert.isUndefined(reached?.headers["x-forwarded-for"]);
        assert.equal(reached?.headers.host, `localhost:${dev.port}`);

        const posted = yield* get(`${base}api/echo`, {
          method: "POST",
          body: "name=preview",
          headers: { cookie: hub.owner, "content-type": "application/x-www-form-urlencoded" },
        });
        assert.include(posted.text, "POST /api/echo name=preview");

        // A redirect to the dev server itself stays under the address.
        const moved = yield* get(`${base}old`, { headers: { cookie: hub.owner } });
        assert.equal(moved.status, 302);
        assert.equal(moved.headers.get("location"), `${address.path}new?from=old`);
        // Without its trailing slash, relative links would leave it.
        const bare = yield* get(`${hub.server.url}${address.path.slice(0, -1)}`);
        assert.equal(bare.status, 308);
        assert.equal(bare.headers.get("location"), address.path);

        // The dev server's WebSocket (HMR), with the subprotocol it chose, both ways.
        const socket = yield* echoOnce(
          `${base.replace(/^http/, "ws")}hmr?token=abc`,
          hub.owner,
          "ping",
        );
        assert.deepEqual(socket, { protocol: "vite-hmr", reply: "echo:ping" });
        assert.equal(dev.seen.at(-1)?.url, "/hmr?token=abc");

        // Nothing listening on a port: said so, not a hang.
        const idle = yield* previews.address({
          userId: owner,
          sessionId: ownerSession.sessionId,
          threadId,
          port: 9,
        });
        const nothing = yield* get(`${hub.server.url}${idle.path}`, {
          headers: { cookie: hub.owner },
        });
        assert.equal(nothing.status, 502);
        assert.match(nothing.text, /^Nothing answers on port 9/);
      }).pipe(Effect.scoped),
  );

  it.live(
    "only its User opens it: not a Member of another Space, nor another Member, nor once the session ends",
    () =>
      Effect.gen(function* () {
        const { hub, owner, acme, globex, threadId, ownerSession, previews } =
          yield* threadInSandbox();
        const dev = yield* startDevServer;
        const grace = UserId.make("member-acme");
        const hopper = UserId.make("member-globex");
        const graceCookie = yield* addMember(hub.server, { id: grace, displayName: "Grace" });
        const hopperCookie = yield* addMember(hub.server, { id: hopper, displayName: "Hopper" });
        yield* joinOrganization(hub.server, acme, grace, "member");
        yield* joinOrganization(hub.server, globex, hopper, "member");
        yield* hub.service(SpaceDirectory.SpaceDirectory).changed;
        const address = yield* previews.address({
          userId: owner,
          sessionId: ownerSession.sessionId,
          threadId,
          port: dev.port,
        });
        const url = `${hub.server.url}${address.path}`;
        assert.equal((yield* get(url, { headers: { cookie: hub.owner } })).status, 200);

        // The same link opened by a Member of another Space, or another Member of Acme.
        const asked = dev.seen.length;
        for (const cookie of [hopperCookie, graceCookie]) {
          const refused = yield* get(url, { headers: { cookie } });
          assert.equal(refused.status, 404);
          assert.equal(refused.text, "This preview is not available.");
        }
        const socketRefused = yield* Effect.exit(
          echoOnce(`${url.replace(/^http/, "ws")}hmr`, hopperCookie, "ping"),
        );
        assert.isTrue(socketRefused._tag === "Failure");
        assert.equal(dev.seen.length, asked);
        // Neither can they make one for the Thread.
        for (const [userId, cookie] of [
          [hopper, hopperCookie],
          [grace, graceCookie],
        ] as const) {
          const session = yield* sessionOf(hub, cookie);
          const made = yield* previews
            .address({ userId, sessionId: session.sessionId, threadId, port: dev.port })
            .pipe(Effect.flip);
          assert.equal(made.reason, "outside_thread_workspace");
        }
        // A browser opening the page without being signed in to the Hub (a link that leaked).
        const signedOut = yield* navigate(url, NAVIGATION);
        assert.equal(signedOut.status, 401);
        assert.equal(signedOut.text, "Sign in to the Hub to open this preview.");
        const opened = yield* navigate(url, { ...NAVIGATION, cookie: hub.owner });
        assert.equal(opened.status, 200);
        const preview = previewCookieOf(opened.setCookie).cookie;
        // An address never given out reaches nothing.
        assert.equal(
          (yield* get(`${hub.server.url}/preview/${"x".repeat(43)}/`, {
            headers: { cookie: hub.owner },
          })).status,
          404,
        );

        // Signed out: the session that made it is gone, and so is the address.
        const served = dev.seen.length;
        yield* hub.server.sessions.revoke(ownerSession.sessionId).pipe(Effect.orDie);
        assert.equal((yield* get(url, { headers: { cookie: preview } })).status, 404);
        assert.equal(dev.seen.length, served);
      }).pipe(Effect.scoped),
  );

  it.live(
    "works the same on a joined machine, and says «environment offline» while it is away",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const owner = yield* ownerIdOf(hub);
        const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters });
        const projectId = ProjectId.make("project:laptop-web");
        yield* seedProject(hub.server, { projectId, title: "Web", defaultModelSelection: null });
        const threadId = ThreadId.make("thread:laptop-preview");
        yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:laptop-preview"),
          threadId,
          projectId,
          title: "Preview",
          modelSelection: { instanceId, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeEnvironmentId: laptop.environmentId,
        });
        const dev = yield* startDevServer;
        const ownerSession = yield* sessionOf(hub, hub.owner);
        const previews = hub.service(HubPreviews.HubPreviews);
        const address = yield* previews.address({
          userId: owner,
          sessionId: ownerSession.sessionId,
          threadId,
          port: dev.port,
        });
        const url = `${hub.server.url}${address.path}`;
        assert.equal((yield* get(url, { headers: { cookie: hub.owner } })).status, 200);

        yield* laptop.disconnect;
        const away = yield* get(url, { headers: { cookie: hub.owner } });
        assert.equal(away.status, 503);
        assert.equal(away.text, "Environment offline: Laptop is not connected.");
        const socketAway = yield* Effect.exit(
          echoOnce(`${url.replace(/^http/, "ws")}hmr`, hub.owner, "ping"),
        );
        assert.isTrue(socketAway._tag === "Failure");

        yield* laptop.connect;
        assert.equal((yield* get(url, { headers: { cookie: hub.owner } })).status, 200);

        // The Thread moved: its dev servers are elsewhere, and the address leads nowhere.
        yield* hub.server.sql`
        UPDATE orchestration_v2_projection_threads
        SET active_environment_id = ${HUB_MACHINE_ENVIRONMENT_ID} WHERE thread_id = ${threadId}
      `;
        assert.equal((yield* get(url, { headers: { cookie: hub.owner } })).status, 404);
      }).pipe(Effect.scoped),
  );
});

describe("Hub con Environments: a preview and its Sandbox's lifecycle", () => {
  it.live(
    "a stopped Sandbox starts when its preview is opened, and an open preview socket keeps it from idling",
    () =>
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        const hub = yield* makeHub({ sandboxAdapters: idleAdapters, sandboxLifecycle: { clock } });
        const owner = yield* ownerIdOf(hub);
        const acme = (yield* hub
          .service(SpaceDirectory.SpaceDirectory)
          .createOrganization(owner, "Acme")
          .pipe(Effect.orDie)).id;
        const projectId = ProjectId.make("project:acme-idle");
        yield* seedProject(hub.server, {
          projectId,
          title: "Acme web",
          defaultModelSelection: null,
          spaceId: acme,
        });
        const sandboxId = sandboxEnvironmentIdOf(acme);
        // Chosen, the Sandbox is made; placing never starts it.
        yield* hub.service(EnvironmentRegistry.EnvironmentRegistry).chooseForThread({
          userId: owner,
          requested: sandboxId,
          projectId,
          providerInstanceId: instanceId,
        });
        const threadId = ThreadId.make("thread:acme-idle");
        yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:acme-idle"),
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
        const status = Effect.map(
          listEnvironments(hub.server, hub.owner),
          (listed) => listed.find((entry) => entry.id === sandboxId)?.status,
        );
        const sandboxes = hub.service(Sandboxes.Sandboxes);
        assert.equal(yield* status, "stopped");

        // Asking for the address starts it: opening a preview is the User's own action.
        const dev = yield* startDevServer;
        const ownerSession = yield* sessionOf(hub, hub.owner);
        const address = yield* hub.service(HubPreviews.HubPreviews).address({
          userId: owner,
          sessionId: ownerSession.sessionId,
          threadId,
          port: dev.port,
        });
        assert.equal(yield* status, "online");
        // Idle with nothing open, it stops; opening the page starts it again.
        yield* clock.adjust("31 minutes");
        yield* sandboxes.stopIdle;
        assert.equal(yield* status, "stopped");
        const url = `${hub.server.url}${address.path}`;
        const page = yield* get(url, { headers: { cookie: hub.owner } });
        assert.equal(page.status, 200);
        assert.include(page.text, "Hello from the dev server");
        assert.equal(yield* status, "online");

        // An open preview socket (the page's HMR) holds it however long it stays open.
        yield* openSocket(`${url.replace(/^http/, "ws")}hmr`, hub.owner);
        yield* clock.adjust("2 hours");
        yield* sandboxes.stopIdle;
        assert.equal(yield* status, "online");
      }).pipe(Effect.scoped),
  );
});

describe("Hub con Environments: what a preview address never does", () => {
  it.live("never reaches the Hub itself: not its own port, nor a Thread on the Hub machine", () =>
    Effect.gen(function* () {
      const { hub, owner, threadId, ownerSession, previews } = yield* threadInSandbox();
      const hubPort = Number(new URL(hub.server.url).port);
      const refused = yield* previews
        .address({ userId: owner, sessionId: ownerSession.sessionId, threadId, port: hubPort })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "outside_thread_workspace");

      const onHub = ThreadId.make("thread:on-hub-machine");
      yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:on-hub-machine"),
        threadId: onHub,
        projectId: ProjectId.make("project:acme-web"),
        title: "On the Hub",
        modelSelection: { instanceId, model: "claude-sonnet-4-6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeEnvironmentId: HUB_MACHINE_ENVIRONMENT_ID,
      });
      const dev = yield* startDevServer;
      const hubMachine = yield* previews
        .address({
          userId: owner,
          sessionId: ownerSession.sessionId,
          threadId: onHub,
          port: dev.port,
        })
        .pipe(Effect.flip);
      assert.equal(hubMachine.reason, "outside_thread_workspace");
    }).pipe(Effect.scoped),
  );

  it.live(
    "the address alone opens nothing: each request carries the User's session or the preview cookie",
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
        const url = `${hub.server.url}${address.path}`;
        const ws = `${url.replace(/^http/, "ws")}hmr`;
        // A leaked URL, fetched without any cookie: refused, and the dev server sees nothing.
        const asked = dev.seen.length;
        assert.equal((yield* get(url)).status, 401);
        assert.isTrue((yield* Effect.exit(echoOnce(ws, "", "ping")))._tag === "Failure");
        assert.equal(dev.seen.length, asked);

        // Opening the page signed in sets the preview cookie, for this address only.
        const opened = yield* navigate(url, { ...NAVIGATION, cookie: hub.owner });
        assert.equal(opened.status, 200);
        const preview = previewCookieOf(opened.setCookie);
        assert.include(preview.attributes, `Path=${address.path}`);
        assert.match(preview.attributes, /HttpOnly/i);
        assert.match(preview.attributes, /Secure/i);
        assert.match(preview.attributes, /SameSite=None/i);
        // The page's own requests, sent from its opaque origin, carry only that cookie.
        assert.equal(
          (yield* get(`${url}app.js`, { headers: { cookie: preview.cookie } })).status,
          200,
        );
        assert.deepEqual(yield* echoOnce(ws, preview.cookie, "ping"), {
          protocol: "vite-hmr",
          reply: "echo:ping",
        });
        // A made-up one is no better than none.
        assert.equal((yield* get(url, { headers: { cookie: "t3_preview=forged" } })).status, 401);
      }).pipe(Effect.scoped),
  );

  it.live("a live socket closes once access ends: the Thread moved", () =>
    Effect.gen(function* () {
      const { hub, owner, threadId, ownerSession, previews } = yield* threadInSandbox();
      const dev = yield* startDevServer;
      const address = yield* previews.address({
        userId: owner,
        sessionId: ownerSession.sessionId,
        threadId,
        port: dev.port,
      });
      const socket = yield* openSocket(
        `${hub.server.url.replace(/^http/, "ws")}${address.path}hmr`,
        hub.owner,
      );
      yield* hub.server.sql`
        UPDATE orchestration_v2_projection_threads
        SET active_environment_id = ${HUB_MACHINE_ENVIRONMENT_ID} WHERE thread_id = ${threadId}
      `;
      const code = yield* Effect.promise(() => socket.closed).pipe(Effect.timeout("10 seconds"));
      assert.isNumber(code);
    }).pipe(Effect.scoped),
  );

  it.live("a Project moving to another Space ends its Thread's previews in the old Sandbox", () =>
    Effect.gen(function* () {
      const { hub, owner, globex, threadId, ownerSession, previews } = yield* threadInSandbox();
      const dev = yield* startDevServer;
      const address = yield* previews.address({
        userId: owner,
        sessionId: ownerSession.sessionId,
        threadId,
        port: dev.port,
      });
      const page = `${hub.server.url}${address.path}`;
      assert.equal((yield* navigate(page, { ...NAVIGATION, cookie: hub.owner })).status, 200);
      const socket = yield* openSocket(
        `${hub.server.url.replace(/^http/, "ws")}${address.path}hmr`,
        hub.owner,
      );
      const moved = yield* hub.server.request("/api/projects/mutate", {
        cookie: hub.owner,
        body: {
          type: "project.move",
          commandId: "move:acme-web:globex",
          projectId: "project:acme-web",
          spaceId: globex,
        },
      });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      // The live socket closes, and the address opens nothing any more.
      const code = yield* Effect.promise(() => socket.closed).pipe(Effect.timeout("10 seconds"));
      assert.isNumber(code);
      assert.equal((yield* navigate(page, { ...NAVIGATION, cookie: hub.owner })).status, 404);
    }).pipe(Effect.scoped),
  );

  it.live("a long-lived preview response in the old Sandbox is cut when its Project moves", () =>
    Effect.gen(function* () {
      const { hub, owner, globex, threadId, ownerSession, previews } = yield* threadInSandbox();
      const dev = yield* startDevServer;
      const address = yield* previews.address({
        userId: owner,
        sessionId: ownerSession.sessionId,
        threadId,
        port: dev.port,
      });
      const firstChunk = yield* Deferred.make<void>();
      const ended = yield* Deferred.make<void>();
      const request = NodeHttp.get(
        `${hub.server.url}${address.path}events`,
        { headers: { ...NAVIGATION, cookie: hub.owner } },
        (response) => {
          response.on("data", () => Deferred.doneUnsafe(firstChunk, Effect.void));
          response.on("end", () => Deferred.doneUnsafe(ended, Effect.void));
          response.on("error", () => Deferred.doneUnsafe(ended, Effect.void));
          response.on("close", () => Deferred.doneUnsafe(ended, Effect.void));
        },
      );
      request.on("error", () => Deferred.doneUnsafe(ended, Effect.void));
      yield* Effect.addFinalizer(() => Effect.sync(() => request.destroy()));
      yield* Deferred.await(firstChunk);
      const moved = yield* hub.server.request("/api/projects/mutate", {
        cookie: hub.owner,
        body: {
          type: "project.move",
          commandId: "move:acme-web:globex:events",
          projectId: "project:acme-web",
          spaceId: globex,
        },
      });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      // The stream from the machine the Thread left ends; it never runs on.
      yield* Deferred.await(ended);
    }).pipe(Effect.scoped),
  );

  it.live("a session of the Owner's without a User is the Owner's", () =>
    Effect.gen(function* () {
      const { hub, threadId, ownerSession, previews } = yield* threadInSandbox();
      const dev = yield* startDevServer;
      // Asked by a principal without a User (the Owner's local access), on the Owner's session.
      const address = yield* previews.address({
        userId: undefined,
        sessionId: ownerSession.sessionId,
        threadId,
        port: dev.port,
      });
      // The Owner's own browser session opens it.
      const opened = yield* navigate(`${hub.server.url}${address.path}`, {
        ...NAVIGATION,
        cookie: hub.owner,
      });
      assert.equal(opened.status, 200);
    }).pipe(Effect.scoped),
  );
});
