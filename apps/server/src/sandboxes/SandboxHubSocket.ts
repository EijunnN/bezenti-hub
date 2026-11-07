// @effect-diagnostics nodeBuiltinImport:off -- a raw HTTP proxy on a UNIX socket, upgrades included.
/**
 * A container's only way to its Hub: a UNIX socket per Sandbox, forwarding the Environment
 * connection, git and MCP to the Hub's loopback listener (or, on a dedicated machine, to the
 * Hub's own https address) and answering 404 to any other path. Forwarding headers from the
 * container are dropped. See docs/internals/sandboxes.md.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";

import { ENVIRONMENT_CONNECT_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { HUB_REPOSITORY_ROUTE_PREFIX } from "../checkpointing/HubRepository.ts";

/** Whether a Sandbox may reach this path of its Hub. `pathname` is already normalized. */
export const isSandboxHubPath = (pathname: string) =>
  pathname === ENVIRONMENT_CONNECT_PATH ||
  pathname.startsWith(`${HUB_REPOSITORY_ROUTE_PREFIX}/`) ||
  pathname === "/mcp";

/** Headers a client could use to pose as another address or scheme, and hop-by-hop ones. */
const DROPPED_REQUEST_HEADERS = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "proxy-connection",
  "proxy-authorization",
  "keep-alive",
  "te",
  "trailer",
  "host",
]);

const requestHeaders = (headers: NodeHttp.IncomingHttpHeaders, upgrade: boolean) => {
  const kept: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue;
    if (!upgrade && (name === "connection" || name === "upgrade")) continue;
    kept[name] = value;
  }
  return kept;
};

/** The path to forward, normalized (`..` and its encodings resolved), or undefined if refused. */
const allowedPath = (rawUrl: string | undefined) => {
  try {
    const url = new URL(rawUrl ?? "/", "http://sandbox.invalid");
    return isSandboxHubPath(url.pathname) ? `${url.pathname}${url.search}` : undefined;
  } catch {
    return undefined;
  }
};

/** A response head to write raw; `closing` re-frames a decoded body as ending with the connection. */
const rawResponseHead = (response: NodeHttp.IncomingMessage, closing = false) => {
  const lines = [`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ""}`];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index] ?? "";
    if (closing && /^(transfer-encoding|content-length|connection|keep-alive)$/iu.test(name)) {
      continue;
    }
    lines.push(`${name}: ${response.rawHeaders[index + 1]}`);
  }
  if (closing) lines.push("Connection: close");
  return `${lines.join("\r\n")}\r\n\r\n`;
};

const makeProxy = (hubUrl: () => string) => {
  const target = () => {
    const url = new URL(hubUrl());
    const secure = url.protocol === "https:";
    const hostname = url.hostname.replace(/^\[(.*)\]$/u, "$1");
    return {
      secure,
      options: {
        hostname,
        port: Number(url.port || (secure ? 443 : 80)),
        // The Host the Hub's address names, as a reverse proxy in front of it expects.
        // SNI names a host only: an IP literal sends none.
        ...(secure && NodeNet.isIP(hostname) === 0 ? { servername: hostname } : {}),
      },
    };
  };
  /** A request to the Hub over its address's own scheme. */
  const toHub = (
    options: NodeHttp.RequestOptions,
    onResponse?: (response: NodeHttp.IncomingMessage) => void,
  ) => {
    const { secure, options: base } = target();
    return (secure ? NodeHttps.request : NodeHttp.request)({ ...base, ...options }, onResponse);
  };
  const server = NodeHttp.createServer((request, response) => {
    const path = allowedPath(request.url);
    if (path === undefined) {
      response.writeHead(404, { "content-type": "text/plain", connection: "close" });
      response.end("Not reachable from a Sandbox.\n");
      return;
    }
    const upstream = toHub(
      {
        method: request.method,
        path,
        headers: requestHeaders(request.headers, false),
        agent: false,
      },
      (hubResponse) => {
        const headers = { ...hubResponse.headers };
        delete headers.connection;
        delete headers["keep-alive"];
        response.writeHead(hubResponse.statusCode ?? 502, headers);
        hubResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  server.on("upgrade", (request: NodeHttp.IncomingMessage, client: NodeNet.Socket, head) => {
    const path = allowedPath(request.url);
    if (path === undefined) {
      client.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    client.on("error", () => client.destroy());
    const upstream = toHub({
      method: request.method,
      path,
      headers: requestHeaders(request.headers, true),
      agent: false,
    });
    upstream.on("upgrade", (hubResponse, hubSocket, hubHead) => {
      client.write(rawResponseHead(hubResponse));
      if (hubHead.length > 0) client.write(hubHead);
      if (head.length > 0) hubSocket.write(head);
      hubSocket.on("error", () => client.destroy());
      client.on("close", () => hubSocket.destroy());
      hubSocket.on("close", () => client.destroy());
      hubSocket.pipe(client);
      client.pipe(hubSocket);
    });
    // Refused: the answer goes back, its body delimited by the connection ending, so nothing
    // else rides on it.
    upstream.on("response", (hubResponse) => {
      client.write(rawResponseHead(hubResponse, true));
      hubResponse.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    upstream.end();
  });
  return server;
};

/**
 * Listens on `socketPath` (replacing a stale socket file) until the scope closes. `hubUrl` is the
 * Hub's loopback address, read per request since a dev Hub's port can change.
 */
export const serveSandboxHubSocket = (input: {
  readonly socketPath: string;
  readonly hubUrl: () => string;
}): Effect.Effect<void, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<{ server: NodeHttp.Server; sockets: Set<NodeNet.Socket> }, Error>((resume) => {
      NodeFS.rmSync(input.socketPath, { force: true });
      const server = makeProxy(input.hubUrl);
      // Upgraded connections included, which the HTTP server no longer counts as its own.
      const sockets = new Set<NodeNet.Socket>();
      server.on("connection", (socket: NodeNet.Socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      server.once("error", (cause) => resume(Effect.fail(cause)));
      server.listen(input.socketPath, () => {
        NodeFS.chmodSync(input.socketPath, 0o600);
        resume(Effect.succeed({ server, sockets }));
      });
    }),
    ({ server, sockets }) =>
      Effect.callback<void>((resume) => {
        server.close(() => {
          NodeFS.rmSync(input.socketPath, { force: true });
          resume(Effect.void);
        });
        for (const socket of sockets) socket.destroy();
      }),
  ).pipe(Effect.asVoid);
