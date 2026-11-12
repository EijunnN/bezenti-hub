// @effect-diagnostics nodeBuiltinImport:off -- compares a pasted sign-in state in constant time.
/**
 * Subscription AI accounts (spec 4 ticket 03), the parts with no I/O: which address the Owner may
 * paste back after signing in, how the Hub names an account's token in CLIProxyAPI's `auth-dir`,
 * and which of two copies of a token is the newer one. Nothing here logs or returns a token.
 */
import * as NodeCrypto from "node:crypto";

import {
  AI_LOGIN_REDIRECT_MAX_LENGTH,
  AI_SERVICE_ACCOUNT_MAX_LENGTH,
  type AiSubscriptionProvider,
  aiAccountPrefixOf,
} from "@t3tools/contracts";

/** How long a sign-in the Owner started stands. */
export const LOGIN_TTL_MS = 10 * 60_000;

/** A token file the Hub reads from or writes to CLIProxyAPI is at most this big. */
const TOKEN_MAX_BYTES = 64 * 1024;

/**
 * The name CLIProxyAPI uses for each provider (in its sign-in API and as a token's `type`).
 * Vertex is imported (`/oauth/import?provider=vertex`), never signed in to.
 */
export const CLIPROXY_PROVIDER = {
  claude: "claude",
  codex: "codex",
  antigravity: "antigravity",
  kimi: "kimi",
  xai: "xai",
  devin: "devin",
  meta: "meta",
} as const satisfies Record<AiSubscriptionProvider, string>;

/**
 * An account's token as CLIProxyAPI holds it: `acct-<account id>-<token id>.json`. The token id
 * changes at each sign-in, so an old token and its replacement never share a name.
 */
export const tokenFileNameOf = (accountId: string, tokenId: string) =>
  `${aiAccountPrefixOf(accountId)}-${tokenId}.json`;

const TOKEN_FILE = /^acct-([0-9a-f]{16})-(tok-[0-9a-f]{32})\.json$/u;

/** The account and token a file of the Hub's is for; undefined for any other file. */
export const parseTokenFileName = (name: string) => {
  const match = TOKEN_FILE.exec(name);
  return match === null ? undefined : { accountId: match[1]!, tokenId: match[2]! };
};

/** Equal strings, compared in constant time. */
const sameSecret = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
};

/** Why a pasted address is refused; said to the Owner, never echoing what was pasted. */
export type PastedRedirectProblem =
  | { readonly _tag: "malformed"; readonly message: string }
  | { readonly _tag: "foreign"; readonly message: string }
  | { readonly _tag: "state"; readonly message: string }
  | { readonly _tag: "provider-error"; readonly message: string };

/** Query parameters CLIProxyAPI gets back; anything else pasted is dropped. */
const KEPT_PARAMETERS = ["code", "state", "scope"] as const;

/**
 * The address the Owner pasted, checked against the sign-in the Hub started: the same scheme,
 * host, port and path as the `redirect_uri` the provider was given, and that sign-in's `state`.
 * The Hub never fetches it: CLIProxyAPI gets an address rebuilt from that `redirect_uri` with only
 * `code`, `state` and `scope`, so nothing else pasted reaches it.
 */
export const checkPastedRedirect = (
  pasted: string,
  expected: { readonly redirectUri: string; readonly state: string },
):
  | { readonly _tag: "ok"; readonly redirectUrl: string }
  | { readonly _tag: "refused"; readonly problem: PastedRedirectProblem } => {
  const refuse = (problem: PastedRedirectProblem) => ({ _tag: "refused" as const, problem });
  const text = pasted.trim();
  if (text.length === 0 || text.length > AI_LOGIN_REDIRECT_MAX_LENGTH) {
    return refuse({
      _tag: "malformed",
      message: "Paste the whole address the browser landed on after signing in.",
    });
  }
  let url: URL;
  let redirect: URL;
  try {
    url = new URL(text);
    redirect = new URL(expected.redirectUri);
  } catch {
    return refuse({
      _tag: "malformed",
      message: "That is not an address. Paste the whole address the browser landed on.",
    });
  }
  if (
    url.protocol !== redirect.protocol ||
    url.hostname !== redirect.hostname ||
    url.port !== redirect.port ||
    url.pathname !== redirect.pathname ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return refuse({
      _tag: "foreign",
      message: `That is not the address this sign-in returns to (it starts with ${redirect.origin}${redirect.pathname}).`,
    });
  }
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || !sameSecret(states[0]!, expected.state)) {
    return refuse({
      _tag: "state",
      message:
        "That address is from another sign-in. Use «Open sign-in» again and paste the address it lands on.",
    });
  }
  if (url.searchParams.has("error")) {
    return refuse({
      _tag: "provider-error",
      message: "The provider did not sign you in. Try again.",
    });
  }
  const codes = url.searchParams.getAll("code");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
  if (codes.length !== 1 || codes[0]!.length === 0 || /[\s\u0000-\u001f\u007f]/u.test(codes[0]!)) {
    return refuse({
      _tag: "malformed",
      message: "That address has no sign-in code. Paste the whole address the browser landed on.",
    });
  }
  const rebuilt = new URL(`${redirect.origin}${redirect.pathname}`);
  for (const name of KEPT_PARAMETERS) {
    const value = url.searchParams.get(name);
    if (value !== null) rebuilt.searchParams.set(name, value);
  }
  return { _tag: "ok", redirectUrl: rebuilt.toString() };
};

/** The `redirect_uri` a provider's sign-in page was given, when it carries one. */
export const redirectUriOf = (authUrl: string): string | undefined => {
  try {
    const value = new URL(authUrl).searchParams.get("redirect_uri");
    if (value === null) return undefined;
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

/** A token as JSON, or undefined when it is not an object with a `type` or is too big. */
export const parseToken = (bytes: Uint8Array): Record<string, unknown> | undefined => {
  if (bytes.byteLength === 0 || bytes.byteLength > TOKEN_MAX_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const token = parsed as Record<string, unknown>;
    return typeof token.type === "string" && token.type.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The token as the Hub hands it to CLIProxyAPI: under the account's prefix (so the Hub can pin a
 * request to it) and enabled. Everything else is CLIProxyAPI's own.
 */
export const tokenForAccount = (token: Record<string, unknown>, accountId: string) =>
  new TextEncoder().encode(
    JSON.stringify({ ...token, prefix: aiAccountPrefixOf(accountId), disabled: false }),
  );

/** A token as the Hub seals it: without the prefix and switch it sets for CLIProxyAPI. */
export const sealedTokenBytes = (token: Record<string, unknown>) => {
  const { prefix: _prefix, disabled: _disabled, ...plain } = token;
  return new TextEncoder().encode(JSON.stringify(plain));
};

/** A sign-in page the Owner may open: an https address, never another scheme. */
export const httpsPageOf = (url: string): string | undefined => {
  try {
    const page = new URL(url);
    return page.protocol === "https:" ? page.toString() : undefined;
  } catch {
    return undefined;
  }
};

/** A Vertex service account key (its JSON file), small enough to keep. */
export const isVertexServiceAccount = (text: string) => {
  if (text.length === 0 || text.length > AI_SERVICE_ACCOUNT_MAX_LENGTH) return false;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown> | null;
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      parsed.type === "service_account" &&
      typeof parsed.project_id === "string" &&
      typeof parsed.client_email === "string" &&
      typeof parsed.private_key === "string"
    );
  } catch {
    return false;
  }
};

/** Fields where CLIProxyAPI's token formats keep when they were issued or expire. */
const TIME_FIELDS = ["expired", "expires_at", "expiry", "expire", "last_refresh", "timestamp"];

const timeOf = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds or milliseconds since the epoch.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

/**
 * How recent a token is: the latest time it carries (its access token's expiry, its last
 * refresh). A refresh always moves one forward, so the newer of two copies has the larger one.
 */
const freshnessOf = (token: Record<string, unknown>): number | undefined => {
  const times = TIME_FIELDS.flatMap((field) => {
    const time = timeOf(token[field]);
    return time === undefined ? [] : [time];
  });
  return times.length === 0 ? undefined : Math.max(...times);
};

/** The same token, whatever prefix or switch the Hub set on it. */
const sameToken = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const strip = ({ prefix: _prefix, disabled: _disabled, ...rest }: Record<string, unknown>) =>
    JSON.stringify(Object.entries(rest).toSorted(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return strip(a) === strip(b);
};

/**
 * Which copy of an account's token to keep: the one CLIProxyAPI holds when it is newer (it
 * refreshed it, and a refresh may have rotated the refresh token, so the sealed copy is dead), the
 * sealed one when it is newer (a stale file a restart left in memory), else neither changes.
 * Without times to compare, a copy that differs from the sealed one is CLIProxyAPI's refresh.
 */
export const newerToken = (
  sealed: Record<string, unknown>,
  inGateway: Record<string, unknown>,
): "gateway" | "sealed" | "same" => {
  if (sameToken(sealed, inGateway)) return "same";
  const ours = freshnessOf(sealed);
  const theirs = freshnessOf(inGateway);
  if (ours !== undefined && theirs !== undefined) {
    if (theirs > ours) return "gateway";
    if (ours > theirs) return "sealed";
    return "same";
  }
  if (theirs !== undefined && ours === undefined) return "gateway";
  if (ours !== undefined && theirs === undefined) return "sealed";
  return "gateway";
};

/** A CLIProxyAPI token's account label (an email), safe to show the Owner. */
export const signedInAsOf = (email: unknown): string | null =>
  typeof email === "string" && email.length > 0 && email.length <= 254 && !/\s/u.test(email)
    ? email
    : null;
