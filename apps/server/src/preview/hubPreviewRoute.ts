/**
 * The Hub's relay to a dev server on a Thread's Active environment (`HubPreviews.ts`), checked per
 * request. Without `T3CODE_PREVIEW_ORIGIN`: `/preview/<token>/…`, sandboxed on the Hub's origin. With
 * it, that path only hands a signed-in browser to the address's own origin (`previewOriginLayer`).
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
import * as Cookies from "effect/http/Cookies";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
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
import { type PreviewOriginPattern, previewHostOf, previewOriginOf } from "./PreviewOrigin.ts";

/** The largest request body relayed: it travels in one frame of the Environment channel. */
const PREVIEW_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The page runs sandboxed in an opaque origin: scripts, forms and popups work, but it shares no
 * origin, cookies or storage with the Hub that serves it.
 */
export const PREVIEW_SANDBOX_POLICY =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation";

/** On a preview's own origin: where a handoff from the Hub is spent (never relayed). */
export const PREVIEW_HANDOFF_PATH = "/__t3_preview/handoff";

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

/** Never passed back from any origin: framing, and what would pin or move the host itself. */
const DROPPED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  "content-length",
  "content-encoding",
  "content-type",
  "content-security-policy",
  "set-cookie",
  "strict-transport-security",
  "public-key-pins",
  "alt-svc",
  // Browsers apply `"cookies"` to the whole registrable domain: the Hub's session, other previews.
  "clear-site-data",
]);

/** Also dropped on the Hub's origin: what would set or clear state there. */
const DROPPED_ON_HUB_ORIGIN = new Set(["service-worker-allowed", "referrer-policy"]);

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
/**
 * On a preview's own origin: host-only, `Secure`, on `/`, so no other host (a sibling preview
 * included) can set or shadow it. `localhost` counts as secure for browsers, plain HTTP there too.
 */
const PREVIEW_ORIGIN_COOKIE_NAME = "__Host-t3_preview";

/**
 * How a request and its answer cross between the browser and the dev server. On the Hub's origin
 * the page is sandboxed and holds no state; on its own origin it keeps its cookies and storage,
 * minus the preview's own cookie and anything that would reach past its host.
 */
interface RelayPolicy {
  /** The page's cookies the dev server sees, if any. */
  readonly forwardCookies: (header: string | undefined) => string | undefined;
  /** The page's own `Authorization` (on its own origin it is the page's, never the Hub's). */
  readonly forwardAuthorization: boolean;
  readonly responseHeaders: (
    headers: PreviewProxyHeaders,
    port: number,
  ) => {
    readonly headers: Record<string, string>;
    readonly contentType: string | undefined;
    readonly cookies: Cookies.Cookies;
  };
}

/**
 * Schemes a browser attaches by itself (HTTP auth, proxy or SSO: Kerberos, NTLM), never the page:
 * they could carry the User's credentials for other services to the dev server, which runs repo
 * code. A page's own `Bearer` and other schemes pass.
 */
const BROWSER_AMBIENT_AUTH_SCHEME = /^\s*(basic|digest|negotiate|ntlm)\b/i;

const requestHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  port: number,
  policy: RelayPolicy,
): PreviewProxyHeaders => {
  const kept: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined) continue;
    if (
      DROPPED_REQUEST_HEADERS.has(lower) &&
      !(
        lower === "authorization" &&
        policy.forwardAuthorization &&
        !BROWSER_AMBIENT_AUTH_SCHEME.test(value)
      )
    ) {
      continue;
    }
    if (lower.startsWith("x-forwarded-") || lower.startsWith("x-t3-")) continue;
    // The dev server sees itself as the origin (Vite checks it on its HMR socket).
    kept.push([lower, lower === "origin" ? `http://localhost:${port}` : value]);
  }
  const cookie = policy.forwardCookies(headers.cookie);
  if (cookie !== undefined) kept.push(["cookie", cookie]);
  return kept;
};

const isLocalUrl = (url: URL, port: number) =>
  ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname) &&
  url.port === String(port) &&
  (url.protocol === "http:" || url.protocol === "https:");

/** A redirect to the dev server itself stays under the preview's address. */
const rewriteLocation = (location: string, prefix: string, port: number) => {
  if (location.startsWith("/") && !location.startsWith("//")) return prefix + location.slice(1);
  try {
    const url = new URL(location);
    if (isLocalUrl(url, port)) return prefix + `${url.pathname}${url.search}${url.hash}`.slice(1);
  } catch {
    // A relative location resolves against the page, already under the prefix.
  }
  return location;
};

const relayedHeaders = (
  headers: PreviewProxyHeaders,
  dropped: ReadonlySet<string>,
  location: (value: string) => string,
) => {
  const kept: Record<string, string> = {};
  let contentType: string | undefined;
  let policy: string | undefined;
  const setCookies: Array<string> = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === "content-type") contentType = value;
    if (lower === "content-security-policy") policy = value;
    if (lower === "set-cookie") setCookies.push(value);
    if (DROPPED_RESPONSE_HEADERS.has(lower) || dropped.has(lower)) continue;
    kept[lower] = lower === "location" ? location(value) : value;
  }
  return { kept, contentType, policy, setCookies };
};

/** On the Hub's origin: sandboxed, stateless, and the address never leaves in a Referer. */
const hubOriginPolicy = (prefix: string): RelayPolicy => ({
  forwardCookies: () => undefined,
  forwardAuthorization: false,
  responseHeaders: (headers, port) => {
    const { kept, contentType, policy } = relayedHeaders(headers, DROPPED_ON_HUB_ORIGIN, (value) =>
      rewriteLocation(value, prefix, port),
    );
    // Both policies apply: the dev server's own, and the sandbox that keeps the page off the Hub.
    kept["content-security-policy"] =
      policy === undefined ? PREVIEW_SANDBOX_POLICY : `${policy}, ${PREVIEW_SANDBOX_POLICY}`;
    kept["referrer-policy"] = "no-referrer";
    return { headers: kept, contentType, cookies: Cookies.empty };
  },
});

const cookieNameOf = (pair: string) => pair.slice(0, Math.max(pair.indexOf("="), 0)).trim();

/**
 * The preview's own cookie is the only one kept from the dev server, both ways. The Hub's are
 * host-only and never reach a preview host, so a page's `t3_session…` (T3 Code previewing itself)
 * is its own.
 */
const isReservedCookie = (name: string) => name === PREVIEW_ORIGIN_COOKIE_NAME;

/**
 * The dev server's cookies, host-only: a `Domain` would reach the Hub's domain or a sibling
 * preview (cookie tossing), so it goes; the preview's own cookie is never theirs to set.
 */
const hostOnlyCookies = (setCookies: ReadonlyArray<string>): Cookies.Cookies => {
  const parsed = Cookies.fromSetCookie(
    setCookies.map((cookie) => cookie.replace(/;\s*domain\s*=[^;]*/gi, "")),
  );
  return Cookies.fromIterable(
    Object.values(parsed.cookies).filter((cookie) => {
      if (isReservedCookie(cookie.name)) return false;
      try {
        Cookies.serializeCookie(cookie);
        return true;
      } catch {
        return false;
      }
    }),
  );
};

/** On the preview's own origin: the page's cookies and state are its own. */
const ownOriginPolicy = (origin: string): RelayPolicy => ({
  forwardAuthorization: true,
  forwardCookies: (header) => {
    if (header === undefined) return undefined;
    const kept = header
      .split(";")
      .map((pair) => pair.trim())
      .filter((pair) => pair.length > 0 && !isReservedCookie(cookieNameOf(pair)));
    return kept.length === 0 ? undefined : kept.join("; ");
  },
  responseHeaders: (headers, port) => {
    const { kept, contentType, policy, setCookies } = relayedHeaders(
      headers,
      new Set(),
      (value) => {
        try {
          const url = new URL(value);
          return isLocalUrl(url, port) ? `${origin}${url.pathname}${url.search}${url.hash}` : value;
        } catch {
          return value;
        }
      },
    );
    if (policy !== undefined) kept["content-security-policy"] = policy;
    return { headers: kept, contentType, cookies: hostOnlyCookies(setCookies) };
  },
});

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
    readonly policy: RelayPolicy;
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
        headers: requestHeaders(request.headers, input.port, input.policy),
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
    const { headers, contentType, cookies } = input.policy.responseHeaders(
      head.headers,
      input.port,
    );
    if (method === "HEAD" || head.status === 204 || head.status === 304) {
      return HttpServerResponse.mergeCookies(
        HttpServerResponse.empty({
          status: head.status,
          headers:
            contentType === undefined ? headers : { ...headers, "content-type": contentType },
        }),
        cookies,
      );
    }
    streaming = true;
    return HttpServerResponse.mergeCookies(
      HttpServerResponse.stream(responseBody, {
        status: head.status,
        headers,
        ...(contentType === undefined ? {} : { contentType }),
      }),
      cookies,
    );
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
    readonly policy: RelayPolicy;
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
          headers: requestHeaders(request.headers, input.port, input.policy),
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

/** One request an address's check opened, relayed under `policy`. */
const relay = Effect.fnUntraced(function* (
  previews: HubPreviews.HubPreviews["Service"],
  request: HttpServerRequest.HttpServerRequest,
  resolution: Extract<HubPreviews.PreviewResolution, { readonly _tag: "open" }>,
  path: string,
  policy: RelayPolicy,
) {
  const { address, target, name } = resolution;
  if (request.headers.upgrade?.toLowerCase() === "websocket") {
    return yield* relaySocket(request, target, {
      port: address.port,
      path,
      policy,
      connectionId: HubPreviews.randomToken(),
      name,
      // A live socket closes once its User may no longer use the address.
      whileValid: previews.whileAllowed(address),
    });
  }
  return yield* relayHttp(request, target, { port: address.port, path, policy, name }).pipe(
    Effect.catchTags({
      PreviewRequestTooLargeError: () =>
        Effect.succeed(HttpServerResponse.text("Payload Too Large", { status: 413 })),
    }),
  );
});

/** A browser opening the page: a top-level navigation, which always carries the Hub session. */
const opensPage = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["sec-fetch-mode"] === "navigate" &&
  request.headers["sec-fetch-dest"] === "document";

// Request middleware owns tracing, including long-lived WebSocket sessions.
const makeHandler = Effect.fnUntraced(function* (
  previews: HubPreviews.HubPreviews["Service"],
  sessions: SessionStore.SessionStore["Service"],
  previewOrigin: PreviewOriginPattern | undefined,
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
  // The Hub session this request carries, if any: it must be the address's own User's. Read as
  // every Hub cookie is (`readHubCookie`): never from a page on a preview's own origin.
  const credential = EnvironmentAuth.selectRequestCredential(request, sessions);
  const hubUser: Option.Option<UserId | undefined> =
    credential === undefined || !EnvironmentAuth.isBrowserCookieCredential(credential.source)
      ? Option.none()
      : Option.map(
          yield* Effect.option(sessions.verify(credential.token)),
          (session) => session.userId,
        );
  const signIn = () => plain(401, "Sign in to the Hub to open this preview.");
  const path = `/${rest.slice(slash + 1)}${url.value.search}`;

  if (previewOrigin !== undefined) {
    // The address lives on its own origin: here a signed-in browser opening it is handed over,
    // and nothing is relayed on the Hub's origin.
    if (!opensPage(request)) return notAvailable();
    if (Option.isNone(hubUser)) return signIn();
    const resolution = yield* previews.resolve(token, { hubUser, pass: Option.none() });
    if (resolution._tag === "unauthenticated") return signIn();
    if (resolution._tag === "refused") return notAvailable();
    if (resolution._tag === "offline") return environmentOffline(resolution.name);
    const code = yield* previews.handoff(resolution.address);
    const target = new URL(
      PREVIEW_HANDOFF_PATH,
      previewOriginOf(previewOrigin, resolution.address.originId),
    );
    target.searchParams.set("code", code);
    target.searchParams.set("path", path);
    return HttpServerResponse.empty({
      status: 303,
      headers: {
        location: target.href,
        "cache-control": "no-store",
        // The code is spent on arrival, but it never leaves in a Referer either.
        "referrer-policy": "no-referrer",
      },
    });
  }

  // A browser opening the page carries its Hub session (top-level navigations always send it);
  // the page's own requests, from its opaque origin, carry the preview cookie instead.
  if (opensPage(request) && Option.isNone(hubUser)) return signIn();
  const resolution = yield* previews.resolve(token, {
    hubUser,
    pass: Option.fromUndefinedOr(request.cookies[PREVIEW_COOKIE_NAME]),
  });
  if (resolution._tag === "unauthenticated") return signIn();
  if (resolution._tag === "refused") return notAvailable();
  if (resolution._tag === "offline") return environmentOffline(resolution.name);
  const response = yield* relay(previews, request, resolution, path, hubOriginPolicy(prefix));
  if (!opensPage(request) || Option.isNone(hubUser)) return response;
  // HttpOnly, and for this address only. SameSite=None: the page's own requests come from its
  // opaque origin, so they are cross-site; Secure, which that needs (localhost counts).
  return HttpServerResponse.setHeader(
    response,
    "set-cookie",
    `${PREVIEW_COOKIE_NAME}=${resolution.address.pass}; Path=${prefix}; Max-Age=${HubPreviews.PREVIEW_ADDRESS_IDLE_TTL_MS / 1000}; HttpOnly; Secure; SameSite=None`,
  );
});

/** Only a path on the same origin: a handoff never sends a browser anywhere else. */
const safeLocalPath = (path: string | null) =>
  path !== null && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\")
    ? path
    : "/";

/**
 * A request to a host under the preview zone: the preview whose subdomain it is, or nothing. The
 * Hub's own routes are never reached from there, whatever the path.
 */
const makePreviewHostHandler = Effect.fnUntraced(function* (
  previews: HubPreviews.HubPreviews["Service"],
  previewOrigin: PreviewOriginPattern,
  id: string | undefined,
  url: URL,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (id === undefined) return notAvailable();
  if (UNRELAYED_METHODS.has(request.method.toUpperCase())) {
    return plain(501, "This method is not relayed to the dev server.");
  }
  const origin = previewOriginOf(previewOrigin, id);
  if (url.pathname === PREVIEW_HANDOFF_PATH) {
    const code = url.searchParams.get("code");
    const address = code === null ? Option.none() : yield* previews.redeemHandoff(id, code);
    if (Option.isNone(address)) {
      return plain(
        403,
        "This preview link has expired or was already used. Open the preview again from T3 Code.",
      );
    }
    // This origin's own cookie: host-only, for this address alone, never the Hub's session.
    return HttpServerResponse.empty({
      status: 303,
      headers: {
        location: safeLocalPath(url.searchParams.get("path")),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "set-cookie": `${PREVIEW_ORIGIN_COOKIE_NAME}=${address.value.pass}; Path=/; Max-Age=${HubPreviews.PREVIEW_ADDRESS_IDLE_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }
  const resolution = yield* previews.resolveOrigin(
    id,
    Option.fromUndefinedOr(request.cookies[PREVIEW_ORIGIN_COOKIE_NAME]),
  );
  if (resolution._tag === "unauthenticated") {
    return plain(401, "Open this preview from T3 Code: its link signs this browser in to it.");
  }
  if (resolution._tag === "refused") return notAvailable();
  if (resolution._tag === "offline") return environmentOffline(resolution.name);
  return yield* relay(
    previews,
    request,
    resolution,
    `${url.pathname}${url.search}`,
    ownOriginPolicy(origin),
  );
});

/**
 * Every request whose host is under `T3CODE_PREVIEW_ORIGIN`'s zone, before any route: a preview's
 * own origin, or a 404. Nothing on those hosts reaches the Hub's API, sign-in, sockets, static
 * files or the server browser's streams, whatever the path or method.
 */
export const previewOriginLayer = HttpRouter.middleware(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const previews = yield* Effect.serviceOption(HubPreviews.HubPreviews);
    const previewOrigin = config.previewOrigin;
    return (httpApp) =>
      Effect.gen(function* () {
        if (previewOrigin === undefined) return yield* httpApp;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = requestUrl(request);
        const host = Option.isNone(url) ? undefined : previewHostOf(previewOrigin, url.value);
        if (host === undefined) return yield* httpApp;
        if (Option.isNone(previews) || Option.isNone(url)) return notAvailable();
        return yield* makePreviewHostHandler(
          previews.value,
          previewOrigin,
          host.id,
          url.value,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Preview origin request failed", { cause }).pipe(
              Effect.as(HttpServerResponse.text("Bad Gateway", { status: 502 })),
            ),
          ),
        );
      });
  }),
  { global: true },
);

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const previews = yield* Effect.serviceOption(HubPreviews.HubPreviews);
    if (Option.isNone(previews)) return;
    const sessions = yield* SessionStore.SessionStore;
    const config = yield* ServerConfig.ServerConfig;
    // The port this server answers on: no address may lead back to it.
    const server = yield* Effect.serviceOption(HttpServer.HttpServer);
    if (Option.isSome(server) && server.value.address._tag !== "UnixPathAddress") {
      yield* previews.value.hubPorts([server.value.address.port]);
    }
    const handler = makeHandler(previews.value, sessions, config.previewOrigin).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Hub preview request failed", { cause }).pipe(
          Effect.as(HttpServerResponse.text("Bad Gateway", { status: 502 })),
        ),
      ),
    );
    yield* router.add("*", `${HUB_PREVIEW_ROUTE_PREFIX}/*`, handler);
  }),
);
