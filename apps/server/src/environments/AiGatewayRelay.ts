/**
 * Spec 4 ticket 06: the local relay a machine's agents reach the Hub's AI gateway through. It
 * listens on 127.0.0.1 alone, forwards only the gateway's own routes to the Hub (by the Sandbox's
 * socket, or the Hub's URL), and adds, keeps and logs nothing: the gateway key is the identity.
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off -- a raw loopback HTTP relay that streams both ways.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { type AiGatewayAccess, AiGatewaySessionError } from "@t3tools/contracts";
import type { AiGatewaySessionInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Scope from "effect/Scope";

import { matchGatewayRoute, parseRequestPath } from "../ai/gatewayShapes.ts";

/** The request headers an agent's call may carry to the gateway: its key and the wire's own. */
const FORWARDED_REQUEST_HEADERS = [
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "user-agent",
] as const;

/** The answer headers that cross back. */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "www-authenticate"] as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export interface AiGatewayRelay {
  /** `http://127.0.0.1:<port>`, the relay started on first use; the refusal if it cannot listen. */
  readonly baseUrl: Effect.Effect<string, AiGatewaySessionError>;
}

const refuse = (response: NodeHttp.ServerResponse, status: number, message: string) => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-cache, no-transform",
  });
  response.end(JSON.stringify({ error: { message } }));
};

/**
 * Whether a request may cross: an origin-form path of one of the gateway's routes, sent to this
 * relay by its loopback name (never an absolute or protocol-relative target, never a browser's
 * page by another name), else the status that refuses it.
 */
export const relayDecision = (
  request: Pick<NodeHttp.IncomingMessage, "method" | "url" | "headers">,
  port: number,
):
  | { readonly _tag: "forward"; readonly path: string }
  | { readonly _tag: "refuse"; readonly status: number } => {
  const target = request.url ?? "";
  if (!target.startsWith("/") || target.startsWith("//")) return { _tag: "refuse", status: 400 };
  const url = parseRequestPath(target);
  if (url === undefined || url.host !== "hub.invalid") return { _tag: "refuse", status: 400 };
  const host = request.headers.host ?? "";
  const separator = host.lastIndexOf(":");
  const hostName = separator < 0 ? host : host.slice(0, separator);
  const hostPort = separator < 0 ? "" : host.slice(separator + 1);
  if (!LOOPBACK_HOSTS.has(hostName) || hostPort !== String(port)) {
    return { _tag: "refuse", status: 421 };
  }
  // A page in a browser of this machine sends an Origin: never an agent's call.
  if (request.headers.origin !== undefined) return { _tag: "refuse", status: 403 };
  const route = matchGatewayRoute(request.method ?? "GET", url.pathname);
  if (route._tag === "not-found") return { _tag: "refuse", status: 404 };
  if (route._tag === "method-not-allowed") return { _tag: "refuse", status: 405 };
  return { _tag: "forward", path: `${url.pathname}${url.search}` };
};

/**
 * The relay to the Hub at `hubUrl`, started on first use and stopped with the scope. In a Sandbox
 * or dedicated machine `hubUrl` is the Hub's socket (the only way to the Hub, which forwards only
 * its allowed paths); on a personal machine, the Hub's own URL.
 */
export const make = Effect.fn("AiGatewayRelay.make")(function* (hubUrl: string) {
  const hubOrigin = new URL(hubUrl).origin;
  let started: Promise<number> | undefined;
  let server: NodeHttp.Server | undefined;

  const handle = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    const port = (server?.address() as NodeNet.AddressInfo | null)?.port ?? 0;
    const decision = relayDecision(request, port);
    if (decision._tag === "refuse") {
      request.resume();
      refuse(response, decision.status, "Not a route of the AI gateway.");
      return;
    }
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    fetch(`${hubOrigin}${decision.path}`, {
      method: request.method ?? "GET",
      headers,
      redirect: "manual",
      signal: abort.signal,
      ...(hasBody
        ? { body: NodeStream.Readable.toWeb(request) as ReadableStream, duplex: "half" }
        : {}),
    } as RequestInit)
      .then((answer) => {
        // The Hub never redirects the gateway; a redirect is not followed nor passed on.
        if (answer.status >= 300 && answer.status < 400) {
          refuse(response, 502, "The AI gateway did not answer.");
          return;
        }
        const back: Record<string, string> = { "x-accel-buffering": "no" };
        for (const name of FORWARDED_RESPONSE_HEADERS) {
          const value = answer.headers.get(name);
          if (value !== null) back[name] = value;
        }
        response.writeHead(answer.status, back);
        response.flushHeaders();
        if (answer.body === null) {
          response.end();
          return;
        }
        NodeStream.Readable.fromWeb(answer.body as never)
          .on("error", () => response.destroy())
          .pipe(response);
      })
      .catch(() => {
        // Never the request nor its headers in a log: only that the Hub could not be reached.
        refuse(response, 502, "The Hub's AI gateway could not be reached.");
      });
  };

  const listen = () => {
    started ??= new Promise<number>((resolve, reject) => {
      const made = NodeHttp.createServer(handle);
      // Never a tunnel nor an upgraded connection: CONNECT and Upgrade are closed.
      made.on("connect", (_request, socket: NodeNet.Socket) => socket.destroy());
      made.on("upgrade", (_request, socket: NodeNet.Socket) => socket.destroy());
      made.on("clientError", (_error, socket: NodeNet.Socket) => socket.destroy());
      made.once("error", (error) => {
        started = undefined;
        reject(error);
      });
      made.listen(0, "127.0.0.1", () => {
        server = made;
        resolve((made.address() as NodeNet.AddressInfo).port);
      });
    });
    return started;
  };

  yield* Effect.addFinalizer(() =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          if (server === undefined) return resolve();
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );

  const baseUrl = Effect.tryPromise({
    try: listen,
    catch: () => new AiGatewaySessionError({ reason: "unreachable" }),
  }).pipe(Effect.map((port) => `http://127.0.0.1:${port}`));

  return { baseUrl } satisfies AiGatewayRelay;
}) satisfies (hubUrl: string) => Effect.Effect<AiGatewayRelay, never, Scope.Scope>;

/**
 * The Thread's own provider home on this machine, `<stateDir>/provider-homes/<thread>/<driver>`
 * (0700): no login, setting or credential of the machine's user, kept for the Thread's next
 * session (its transcripts resume there).
 */
export const providerHomeOf = (stateDir: string, threadId: string, driver: string) =>
  NodePath.join(
    stateDir,
    "provider-homes",
    NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 32),
    driver.replace(/[^A-Za-z0-9_-]/gu, "-"),
  );

/**
 * A session's gateway as the Hub sent it, completed on the machine that starts its process: the
 * relay's address and the Thread's provider home (made now). Nothing is kept here.
 */
export const prepareGatewaySession = Effect.fn("AiGatewayRelay.prepareGatewaySession")(
  function* (input: {
    readonly access: AiGatewayAccess | undefined;
    readonly threadId: string;
    readonly driver: string;
    readonly stateDir: string;
    readonly baseUrl: Effect.Effect<string, AiGatewaySessionError>;
  }) {
    if (input.access === undefined) return undefined;
    const fileSystem = yield* FileSystem.FileSystem;
    const home = providerHomeOf(input.stateDir, input.threadId, input.driver);
    yield* fileSystem
      .makeDirectory(home, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(() => new AiGatewaySessionError({ reason: "unreachable" })));
    const baseUrl = yield* input.baseUrl;
    return { ...input.access, baseUrl, home } satisfies AiGatewaySessionInput;
  },
);
