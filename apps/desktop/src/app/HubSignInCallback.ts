// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native loopback helper uses a bounded Node listener with AbortController cleanup.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import {
  appSignInLoopbackRedirectUri,
  appSignInPageUrl,
  assertAppSignInHubUrl,
  isAppSignInCodeChallenge,
  isAppSignInState,
  readAppSignInCallback,
} from "@t3tools/shared/appSignIn";

// Desktop app sign-in (RFC 8252 §7.3): the Hub's page in the system browser sends the one-time
// code to a port this app listens on for one sign-in only. The PKCE verifier stays in the renderer
// that exchanges the code, so this listener never holds anything that grants a session.

const SIGN_IN_TIMEOUT_MS = 300_000;
const listeners = new Map<string, AbortController>();

export function cancelHubSignIn(state: string) {
  listeners.get(state)?.abort();
}

const RETURN_PAGE =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>T3 Code</title><style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:360px;padding:32px}h1{font-size:24px}p{line-height:1.6;opacity:.7}</style></head><body><main><h1>Return to T3 Code</h1><p>You are signed in. T3 Code is finishing the connection. You can close this tab.</p></main></body></html>';

export async function receiveHubSignIn(
  request: {
    readonly hubUrl: string;
    readonly codeChallenge: string;
    readonly state: string;
    readonly clientLabel?: string;
  },
  openBrowser: (url: string) => Promise<boolean>,
): Promise<{ readonly code: string; readonly redirectUri: string }> {
  assertAppSignInHubUrl(request.hubUrl);
  const hubUrl = new URL(request.hubUrl);
  if (!isAppSignInCodeChallenge(request.codeChallenge) || !isAppSignInState(request.state)) {
    throw new Error("Invalid sign-in request.");
  }
  if (listeners.has(request.state)) throw new Error("This sign-in is already open.");
  const abort = new AbortController();
  listeners.set(request.state, abort);
  const received = Promise.withResolvers<string>();
  // Keep early bind failures from leaving an unobserved rejection behind.
  void received.promise.catch(() => undefined);
  let redirectUri = "";
  const server = NodeHttp.createServer((incoming, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    // A malformed request target must not throw here: this listener runs in the main process.
    const target = incoming.url ?? "/";
    const callback =
      incoming.method === "GET" && URL.canParse(target, redirectUri)
        ? readAppSignInCallback(new URL(target, redirectUri).toString(), {
            redirectUri,
            state: request.state,
          })
        : ({ _tag: "invalid" } as const);
    if (callback._tag === "invalid") {
      // Not this sign-in's answer (a stray request or another state): keep waiting for it.
      response.writeHead(400).end("This response does not belong to the active sign-in.");
      return;
    }
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(RETURN_PAGE);
    if (callback._tag === "code") received.resolve(callback.code);
    else received.reject(new Error("Sign-in cancelled."));
  });
  const cancelled = () => received.reject(new Error("Sign-in cancelled."));
  abort.signal.addEventListener("abort", cancelled, { once: true });
  const timer = setTimeout(
    () => received.reject(new Error("Sign-in expired. Try again.")),
    SIGN_IN_TIMEOUT_MS,
  );
  timer.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Port 0: the system picks a free port for this sign-in only.
      server.listen(0, "127.0.0.1", resolve);
    });
    redirectUri = appSignInLoopbackRedirectUri((server.address() as NodeNet.AddressInfo).port);
    const page = appSignInPageUrl(hubUrl.toString(), {
      redirectUri,
      codeChallenge: request.codeChallenge,
      state: request.state,
      ...(request.clientLabel ? { clientLabel: request.clientLabel } : {}),
    });
    if (!(await openBrowser(page))) throw new Error("Could not open your browser.");
    return { code: await received.promise, redirectUri };
  } finally {
    clearTimeout(timer);
    abort.signal.removeEventListener("abort", cancelled);
    listeners.delete(request.state);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
