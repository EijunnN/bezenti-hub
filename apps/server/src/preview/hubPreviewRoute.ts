/**
 * `/preview/<token>/…`: the Hub's relay to a dev server on a Thread's Active environment
 * (`HubPreviews.ts`). HTTP requests and WebSockets go to the port over the Environment channel;
 * each is checked against the address's User, session and Thread as it comes.
 */
import { HUB_PREVIEW_ROUTE_PREFIX, type UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Pull from "effect/Pull";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as SessionStore from "../auth/SessionStore.ts";
import { requestUrl } from "../requestUrl.ts";
import * as HubPreviews from "./HubPreviews.ts";
import { PreviewProxyError as PreviewProxyErrorClass } from "./PreviewProxy.ts";
import type {
  PreviewProxyError,
  PreviewProxyHeaders,
  PreviewProxyHttpItem,
  PreviewProxySocketItem,
  PreviewProxyTarget,
} from "./PreviewProxy.ts";

/** The largest request body relayed: it travels in one frame of the Environment channel. */
const PREVIEW_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The page runs sandboxed in an opaque origin: scripts, forms and popups work, but it shares no
 * origin, cookies or storage with the Hub that serves it.
 */
export const PREVIEW_SANDBOX_POLICY =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation";

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** Never sent on to the dev server: the Hub's own credentials, framing and client addresses. */
const DROPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP,
  "host",
  "cookie",
  "authorization",
  "content-length",
  // The Hub reads the whole body before relaying it: there is nothing to continue.
  "expect",
  "forwarded",
  "x-real-ip",
  "x-client-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "fastly-client-ip",
  "x-cluster-client-ip",
  "referer",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "sec-websocket-accept",
]);

/** Never passed back: what would set or clear state on the Hub's origin, and the body's framing. */
const DROPPED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  "content-length",
  "content-encoding",
  "content-type",
  "content-security-policy",
  "set-cookie",
  "clear-site-data",
  "strict-transport-security",
  "public-key-pins",
  "alt-svc",
  "service-worker-allowed",
  "referrer-policy",
]);

class PreviewRequestTooLargeError extends Schema.TaggedError<PreviewRequestTooLargeError>()(
  "PreviewRequestTooLargeError",
  {},
) {}

const notAvailable = () =>
  HttpServerResponse.text("This preview is not available.", {
    status: 404,
    headers: { "cache-control": "no-store" },
  });

const unreachable = (port: number) =>
  HttpServerResponse.text(
    `Nothing answers on port ${port} on this Thread's Environment. Start the dev server there, then reload.`,
    { status: 502, headers: { "cache-control": "no-store" } },
  );

const environmentOffline = (name: string | undefined) =>
  HttpServerResponse.text(
    `Environment offline: ${name ?? "this Thread's Environment"} is not connected.`,
    { status: 503, headers: { "cache-control": "no-store", "retry-after": "5" } },
  );

const plain = (status: number, text: string) =>
  HttpServerResponse.text(text, { status, headers: { "cache-control": "no-store" } });

/** Why the dev server's answer never came, as the page the browser shows. */
const failedBeforeAnswer = (error: PreviewProxyError, name: string | undefined) => {
  switch (error.reason) {
    case "offline":
      return environmentOffline(name);
    case "unreachable":
      return unreachable(error.port);
    case "timeout":
      return plain(504, `Port ${error.port} on this Thread's Environment did not answer in time.`);
    case "invalid":
      return plain(400, "This request cannot be sent to the dev server.");
    case "outdated":
      return plain(
        502,
        `${name ?? "This Thread's Environment"} runs a T3 too old to serve previews through the Hub. Update it and reconnect.`,
      );
    case "closed":
      return plain(502, "Bad Gateway");
  }
};

/** Methods no browser page sends and no dev server needs; undici refuses them anyway. */
const UNRELAYED_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);
/** The machine relays the dev server's answer: past this, it is not coming. */
const ANSWER_TIMEOUT = "45 seconds";

const timedOut = (port: number) => new PreviewProxyErrorClass({ reason: "timeout", port });

/** The cookie a page opened signed in gets, so its own requests prove it without the Hub's. */
const PREVIEW_COOKIE_NAME = "t3_preview";

const requestHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  port: number,
): PreviewProxyHeaders => {
  const kept: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith("x-forwarded-") || lower.startsWith("x-t3-")) continue;
    // The page's origin is opaque ("null"); the dev server sees itself as the origin.
    kept.push([lower, lower === "origin" ? `http://localhost:${port}` : value]);
  }
  return kept;
};

/** A redirect to the dev server itself stays under the preview's address. */
const rewriteLocation = (location: string, prefix: string, port: number) => {
  if (location.startsWith("/") && !location.startsWith("//")) return prefix + location.slice(1);
  try {
    const url = new URL(location);
    const local = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname);
    if (
      local &&
      url.port === String(port) &&
      (url.protocol === "http:" || url.protocol === "https:")
    ) {
      return prefix + `${url.pathname}${url.search}${url.hash}`.slice(1);
    }
  } catch {
    // A relative location resolves against the page, already under the prefix.
  }
  return location;
};

const responseHeaders = (
  headers: PreviewProxyHeaders,
  prefix: string,
  port: number,
): { readonly headers: Record<string, string>; readonly contentType: string | undefined } => {
  const kept: Record<string, string> = {};
  let contentType: string | undefined;
  let policy: string | undefined;
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === "content-type") contentType = value;
    if (lower === "content-security-policy") policy = value;
    if (DROPPED_RESPONSE_HEADERS.has(lower)) continue;
    kept[lower] = lower === "location" ? rewriteLocation(value, prefix, port) : value;
  }
  // Both policies apply: the dev server's own, and the sandbox that keeps the page off the Hub.
  kept["content-security-policy"] =
    policy === undefined ? PREVIEW_SANDBOX_POLICY : `${policy}, ${PREVIEW_SANDBOX_POLICY}`;
  // The address is a credential: it never leaves in a Referer.
  kept["referrer-policy"] = "no-referrer";
  return { headers: kept, contentType };
};

const readBody = (request: HttpServerRequest.HttpServerRequest) => {
  let size = 0;
  const chunks: Array<Uint8Array> = [];
  return request.stream.pipe(
    Stream.runForEach((chunk) => {
      size += chunk.byteLength;
      if (size > PREVIEW_MAX_REQUEST_BODY_BYTES) {
        return Effect.fail(new PreviewRequestTooLargeError());
      }
      chunks.push(chunk);
      return Effect.void;
    }),
    Effect.map(() => Buffer.concat(chunks).toString("base64")),
  );
};

const relayHttp = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  target: PreviewProxyTarget,
  input: {
    readonly port: number;
    readonly path: string;
    readonly prefix: string;
    readonly name: string | undefined;
  },
) {
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : yield* readBody(request);
  // The response streams after this handler returns: its pull lives until the body ends.
  const scope = yield* Scope.make();
  let streaming = false;
  return yield* Effect.gen(function* () {
    const pull = yield* Stream.toPull(
      target.http({
        port: input.port,
        method,
        path: input.path,
        headers: requestHeaders(request.headers, input.port),
        ...(body === undefined || body.length === 0 ? {} : { body }),
      }),
    );
    const answered = yield* pull.pipe(
      Pull.catchDone(() => Effect.succeed(undefined)),
      Effect.timeoutOrElse({
        duration: ANSWER_TIMEOUT,
        orElse: () => Effect.fail(timedOut(input.port)),
      }),
      Effect.result,
    );
    if (Result.isFailure(answered)) return failedBeforeAnswer(answered.failure, input.name);
    const first = answered.success;
    if (first === undefined || first[0]._tag !== "head") {
      return HttpServerResponse.text("Bad Gateway", { status: 502 });
    }
    const head = first[0];
    const bytesOf = (item: PreviewProxyHttpItem) =>
      item._tag === "chunk" ? [new Uint8Array(Buffer.from(item.base64, "base64"))] : [];
    const responseBody = Stream.concat(
      Stream.fromIterable(first.slice(1)),
      Stream.fromPull(Effect.succeed(pull)),
    ).pipe(
      Stream.flatMap((item) => Stream.fromIterable(bytesOf(item))),
      Stream.ensuring(Scope.close(scope, Exit.void)),
    );
    const { headers, contentType } = responseHeaders(head.headers, input.prefix, input.port);
    if (method === "HEAD" || head.status === 204 || head.status === 304) {
      return HttpServerResponse.empty({
        status: head.status,
        headers: contentType === undefined ? headers : { ...headers, "content-type": contentType },
      });
    }
    streaming = true;
    return HttpServerResponse.stream(responseBody, {
      status: head.status,
      headers,
      ...(contentType === undefined ? {} : { contentType }),
    });
  }).pipe(
    Effect.provideService(Scope.Scope, scope),
    // Unless the body took it over, nothing more reads the dev server's answer.
    Effect.onExit(() => (streaming ? Effect.void : Scope.close(scope, Exit.void))),
  );
});

const relaySocket = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  target: PreviewProxyTarget,
  input: {
    readonly port: number;
    readonly path: string;
    readonly connectionId: string;
    readonly name: string | undefined;
    readonly whileValid: Effect.Effect<void>;
  },
) {
  const protocols = (request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const pull = yield* Stream.toPull(
        target.socket({
          connectionId: input.connectionId,
          port: input.port,
          path: input.path,
          protocols,
          headers: requestHeaders(request.headers, input.port),
        }),
      );
      // The dev server answers the handshake before the browser's is accepted.
      const answered = yield* pull.pipe(
        Pull.catchDone(() => Effect.succeed(undefined)),
        Effect.timeoutOrElse({
          duration: ANSWER_TIMEOUT,
          orElse: () => Effect.fail(timedOut(input.port)),
        }),
        Effect.result,
      );
      if (Result.isFailure(answered)) return failedBeforeAnswer(answered.failure, input.name);
      const first = answered.success;
      if (first === undefined || first[0]._tag !== "open") return unreachable(input.port);
      const socket = yield* request.upgrade;
      const writer = yield* socket.writer;
      const reader = yield* socket.reader;
      const deliver = (item: PreviewProxySocketItem) => {
        switch (item._tag) {
          case "open":
            return Effect.void;
          case "text":
            return writer.write(item.data);
          case "binary":
            return writer.write(new Uint8Array(Buffer.from(item.base64, "base64")));
          case "close":
            return writer
              .write(new Socket.CloseEvent(item.code, item.reason))
              .pipe(Effect.andThen(Effect.interrupt));
        }
      };
      const fromUpstream = Effect.forEach(first.slice(1), deliver, { discard: true }).pipe(
        Effect.andThen(
          Effect.forever(
            pull.pipe(Effect.flatMap((items) => Effect.forEach(items, deliver, { discard: true }))),
          ),
        ),
      );
      const toUpstream = Effect.forever(
        reader.pull.pipe(
          Effect.flatMap((chunks) =>
            // In order: each message waits for the one before it.
            Effect.forEach(
              chunks,
              (chunk) =>
                target.send({
                  connectionId: input.connectionId,
                  message:
                    typeof chunk === "string"
                      ? { _tag: "text", data: chunk }
                      : { _tag: "binary", base64: Buffer.from(chunk).toString("base64") },
                }),
              { discard: true },
            ),
          ),
        ),
      );
      yield* Effect.raceAll([
        fromUpstream.pipe(Effect.ignore),
        toUpstream.pipe(Effect.ignore),
        input.whileValid,
      ]);
      return HttpServerResponse.empty();
    }),
  ).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty()));
});

// Request middleware owns tracing, including long-lived WebSocket sessions.
const makeHandler = Effect.fnUntraced(function* (
  previews: HubPreviews.HubPreviews["Service"],
  sessions: SessionStore.SessionStore["Service"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const rest = url.value.pathname.slice(HUB_PREVIEW_ROUTE_PREFIX.length + 1);
  const slash = rest.indexOf("/");
  const token = slash === -1 ? rest : rest.slice(0, slash);
  if (token.length === 0) return notAvailable();
  const prefix = `${HUB_PREVIEW_ROUTE_PREFIX}/${token}/`;
  // Relative links on the page resolve under the address only with its trailing slash.
  if (slash === -1) {
    return HttpServerResponse.empty({
      status: 308,
      headers: { location: `${prefix}${url.value.search}`, "cache-control": "no-store" },
    });
  }
  if (UNRELAYED_METHODS.has(request.method.toUpperCase())) {
    return plain(501, "This method is not relayed to the dev server.");
  }
  // The Hub session this request carries, if any: it must be the address's own User's.
  const cookie =
    request.cookies[sessions.cookieName] ??
    (sessions.legacyCookieName === undefined
      ? undefined
      : request.cookies[sessions.legacyCookieName]);
  const hubUser: Option.Option<UserId | undefined> =
    cookie === undefined
      ? Option.none()
      : Option.map(yield* Effect.option(sessions.verify(cookie)), (session) => session.userId);
  // A browser opening the page carries its Hub session (top-level navigations always send it);
  // the page's own requests, from its opaque origin, carry the preview cookie instead.
  const opensPage =
    request.headers["sec-fetch-mode"] === "navigate" &&
    request.headers["sec-fetch-dest"] === "document";
  const signIn = () => plain(401, "Sign in to the Hub to open this preview.");
  if (opensPage && Option.isNone(hubUser)) return signIn();
  const resolution = yield* previews.resolve(token, {
    hubUser,
    pass: Option.fromUndefinedOr(request.cookies[PREVIEW_COOKIE_NAME]),
  });
  if (resolution._tag === "unauthenticated") return signIn();
  if (resolution._tag === "refused") return notAvailable();
  if (resolution._tag === "offline") return environmentOffline(resolution.name);
  const { address, target, name } = resolution;
  const path = `/${rest.slice(slash + 1)}${url.value.search}`;
  if (request.headers.upgrade?.toLowerCase() === "websocket") {
    return yield* relaySocket(request, target, {
      port: address.port,
      path,
      connectionId: HubPreviews.randomToken(),
      name,
      // A live socket closes once its User may no longer use the address.
      whileValid: previews.whileAllowed(address),
    });
  }
  const response = yield* relayHttp(request, target, {
    port: address.port,
    path,
    prefix,
    name,
  }).pipe(
    Effect.catchTags({
      PreviewRequestTooLargeError: () =>
        Effect.succeed(HttpServerResponse.text("Payload Too Large", { status: 413 })),
    }),
  );
  if (!opensPage || Option.isNone(hubUser)) return response;
  // HttpOnly, and for this address only. SameSite=None: the page's own requests come from its
  // opaque origin, so they are cross-site; Secure, which that needs (localhost counts).
  return HttpServerResponse.setHeader(
    response,
    "set-cookie",
    `${PREVIEW_COOKIE_NAME}=${address.pass}; Path=${prefix}; Max-Age=${HubPreviews.PREVIEW_ADDRESS_IDLE_TTL_MS / 1000}; HttpOnly; Secure; SameSite=None`,
  );
});

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const previews = yield* Effect.serviceOption(HubPreviews.HubPreviews);
    if (Option.isNone(previews)) return;
    const sessions = yield* SessionStore.SessionStore;
    // The port this server answers on: no address may lead back to it.
    const server = yield* Effect.serviceOption(HttpServer.HttpServer);
    if (Option.isSome(server) && server.value.address._tag !== "UnixPathAddress") {
      yield* previews.value.hubPorts([server.value.address.port]);
    }
    const handler = makeHandler(previews.value, sessions).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Hub preview request failed", { cause }).pipe(
          Effect.as(HttpServerResponse.text("Bad Gateway", { status: 502 })),
        ),
      ),
    );
    yield* router.add("*", `${HUB_PREVIEW_ROUTE_PREFIX}/*`, handler);
  }),
);
