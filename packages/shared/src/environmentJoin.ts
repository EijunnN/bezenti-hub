// `t3 join`: the machine opens the Hub's «Register this machine» page with a PKCE challenge and
// the labels it shows, and the page sends a one-time code back to the loopback port `t3 join`
// listens on, the same way app sign-in does. See docs/internals/environment-auth.md.
import { appSignInRedirectKind, isAppSignInCodeChallenge, isAppSignInState } from "./appSignIn.ts";
import { isLocalLoopbackHost } from "./hostClassification.ts";

const REGISTER_PAGE_PATH = "/register-environment";
const MAX_LABEL_LENGTH = 64;

/**
 * The Environment credential and everything it opens travel to this address, so it must be
 * HTTPS. Plain HTTP is only for a Hub on this same machine.
 */
export function assertEnvironmentHubUrl(hubUrl: string): URL {
  if (!URL.canParse(hubUrl)) throw new Error(`Not a Hub address: ${hubUrl}`);
  const url = new URL(hubUrl);
  if (url.username !== "" || url.password !== "") {
    throw new Error("The Hub's address must not carry a user name or password.");
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLocalLoopbackHost(url.hostname)) return url;
  throw new Error("The Hub's address must start with https:// (plain http only for localhost).");
}

export interface EnvironmentJoinPageRequest {
  /** A loopback `http://127.0.0.1:<port>/callback`, as app sign-in uses. */
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
  /** Suggested name: the machine's hostname. The Owner may change it on the page. */
  readonly name: string;
  readonly os: string;
  readonly hostname: string;
  /** ISO time `t3 join` started, shown so the Owner recognises the request. */
  readonly requestedAt: string;
}

const label = (value: string | null) => value?.trim().slice(0, MAX_LABEL_LENGTH) ?? "";

export function environmentJoinPageUrl(hubUrl: string, request: EnvironmentJoinPageRequest) {
  const url = new URL(REGISTER_PAGE_PATH, hubUrl);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", request.state);
  url.searchParams.set("name", request.name);
  url.searchParams.set("os", request.os);
  url.searchParams.set("hostname", request.hostname);
  url.searchParams.set("requested_at", request.requestedAt);
  return url.toString();
}

/** The page's request read back from its URL; null when a part is missing or malformed. */
export function readEnvironmentJoinPageRequest(pageUrl: string): EnvironmentJoinPageRequest | null {
  if (!URL.canParse(pageUrl)) return null;
  const params = new URL(pageUrl).searchParams;
  const redirectUri = params.get("redirect_uri") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const state = params.get("state") ?? "";
  const hostname = label(params.get("hostname"));
  const os = label(params.get("os"));
  const requestedAt = params.get("requested_at") ?? "";
  if (
    // Only `t3 join` on the machine itself receives the code: never a scheme or another site.
    appSignInRedirectKind(redirectUri) !== "this-computer" ||
    params.get("code_challenge_method") !== "S256" ||
    !isAppSignInCodeChallenge(codeChallenge) ||
    !isAppSignInState(state) ||
    hostname === "" ||
    os === "" ||
    Number.isNaN(Date.parse(requestedAt))
  ) {
    return null;
  }
  return {
    redirectUri,
    codeChallenge,
    state,
    name: label(params.get("name")) || hostname,
    os,
    hostname,
    requestedAt,
  };
}
