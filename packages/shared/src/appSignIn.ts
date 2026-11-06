// App sign-in: the Hub's `/app-sign-in` page sends a one-time code back to the desktop or mobile
// app that asked, only to a loopback port or the mobile app's own scheme, so it is never an open
// redirect. See docs/internals/environment-auth.md#app-sign-in.
import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isTailnetHost,
  normalizeHostname,
} from "./hostClassification.ts";

/** The URL schemes of the T3 Code mobile app variants (see apps/mobile/app.config.ts). */
export const APP_SIGN_IN_SCHEMES = ["t3code", "t3code-dev", "t3code-preview"] as const;
export type AppSignInScheme = (typeof APP_SIGN_IN_SCHEMES)[number];

/** The page on the Hub that approves an app sign-in. */
const APP_SIGN_IN_PAGE_PATH = "/app-sign-in";
const LOOPBACK_CALLBACK_PATH = "/callback";
// Loopback IP literals only: `localhost` may resolve elsewhere (RFC 8252 §8.3).
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "[::1]"]);
const MAX_REDIRECT_URI_LENGTH = 256;
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type AppSignInRedirectKind = "this-computer" | "mobile-app";

/** The mobile app's callback for a scheme: `t3code://auth/callback`. */
export const appSignInMobileRedirectUri = (scheme: AppSignInScheme) => `${scheme}://auth/callback`;

/** The desktop app's callback on a loopback port it listens on. */
export const appSignInLoopbackRedirectUri = (port: number) =>
  `http://127.0.0.1:${port}${LOOPBACK_CALLBACK_PATH}`;

/**
 * Where an app sign-in may send its code, or null. Only a loopback `http://<host>:<port>/callback`
 * (RFC 8252 §7.3) or one of the mobile app's exact callbacks: never another site, so the page is
 * not an open redirect and the code never leaves the device that asked for it.
 */
export function appSignInRedirectKind(redirectUri: string): AppSignInRedirectKind | null {
  if (redirectUri.length > MAX_REDIRECT_URI_LENGTH) return null;
  if (APP_SIGN_IN_SCHEMES.some((scheme) => redirectUri === appSignInMobileRedirectUri(scheme))) {
    return "mobile-app";
  }
  if (!URL.canParse(redirectUri)) return null;
  const url = new URL(redirectUri);
  return url.protocol === "http:" &&
    LOOPBACK_HOSTNAMES.has(url.hostname) &&
    url.port !== "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === LOOPBACK_CALLBACK_PATH &&
    url.search === "" &&
    !redirectUri.includes("#") &&
    url.href === redirectUri
    ? "this-computer"
    : null;
}

/**
 * Whether an app may reach the Hub over plain HTTP: as the Hub's transport rule allows plain HTTP
 * only from this machine, the LAN and the tailnet (never link-local, nor IPv6 off the tailnet).
 */
function appSignInAllowsPlainHttp(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (isLocalLoopbackHost(host) || isTailnetHost(host)) return true;
  if (host.includes(":") || host.startsWith("169.254.")) return false;
  return isPrivateNetworkHost(host);
}

/** Refuses a Hub address the Hub would refuse a sign-in over. */
export function assertAppSignInHubUrl(hubUrl: string): void {
  const url = new URL(hubUrl);
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && appSignInAllowsPlainHttp(url.hostname)) return;
  throw new Error("The Hub's address must start with https://.");
}

export const isAppSignInCodeChallenge = (value: string) => CODE_CHALLENGE_PATTERN.test(value);
export const isAppSignInCodeVerifier = (value: string) => CODE_VERIFIER_PATTERN.test(value);
export const isAppSignInState = (value: string) => STATE_PATTERN.test(value);

export interface AppSignInPageRequest {
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
  /** Shown on the page: "T3 Code desktop", "Ada's iPhone". Chosen by the app, so only a label. */
  readonly clientLabel?: string;
}

/** The page the app opens in the system browser. */
export function appSignInPageUrl(hubUrl: string, request: AppSignInPageRequest): string {
  const url = new URL(APP_SIGN_IN_PAGE_PATH, hubUrl);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", request.state);
  if (request.clientLabel) url.searchParams.set("client", request.clientLabel);
  return url.toString();
}

/** Reads the page's request back from its URL; null when a part is missing or malformed. */
export function readAppSignInPageRequest(pageUrl: string): AppSignInPageRequest | null {
  if (!URL.canParse(pageUrl)) return null;
  const params = new URL(pageUrl).searchParams;
  const redirectUri = params.get("redirect_uri") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const state = params.get("state") ?? "";
  const clientLabel = params.get("client")?.trim().slice(0, 80);
  if (
    appSignInRedirectKind(redirectUri) === null ||
    params.get("code_challenge_method") !== "S256" ||
    !isAppSignInCodeChallenge(codeChallenge) ||
    !isAppSignInState(state)
  ) {
    return null;
  }
  return { redirectUri, codeChallenge, state, ...(clientLabel ? { clientLabel } : {}) };
}

/** The redirect the approved page navigates to. */
export function appSignInCallbackUrl(redirectUri: string, code: string, state: string): string {
  const separator = redirectUri.includes("?") ? "&" : "?";
  return `${redirectUri}${separator}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
}

/** Where a cancelled approval sends the app, so it stops waiting (RFC 6749 §4.1.2.1). */
export function appSignInCancelledUrl(redirectUri: string, state: string): string {
  return `${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`;
}

export type AppSignInCallback =
  | { readonly _tag: "code"; readonly code: string }
  | { readonly _tag: "cancelled" }
  | { readonly _tag: "invalid" };

/**
 * Reads the callback the app received. A callback whose `state` is not the one this app sent was
 * not started here (another app, or a forged link) and is refused.
 */
export function readAppSignInCallback(
  callbackUrl: string,
  expected: { readonly redirectUri: string; readonly state: string },
): AppSignInCallback {
  if (!URL.canParse(callbackUrl)) return { _tag: "invalid" };
  const url = new URL(callbackUrl);
  const expectedUrl = new URL(expected.redirectUri);
  if (
    url.protocol !== expectedUrl.protocol ||
    url.host !== expectedUrl.host ||
    url.pathname !== expectedUrl.pathname
  ) {
    return { _tag: "invalid" };
  }
  if (url.searchParams.get("state") !== expected.state) return { _tag: "invalid" };
  if (url.searchParams.get("error") === "access_denied") return { _tag: "cancelled" };
  const code = url.searchParams.get("code");
  return code ? { _tag: "code", code } : { _tag: "invalid" };
}
