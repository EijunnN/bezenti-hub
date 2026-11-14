/**
 * Spec 4 ticket 15: reading another CLIProxyAPI's auth files (Claude, Codex and Antigravity
 * sign-ins, as CLIProxyAPI 8.0.x writes them in its `auth-dir`) into what the Hub seals for a
 * subscription AI account. No I/O; nothing here logs or returns a token.
 */
import type { AiSubscriptionProvider } from "@t3tools/contracts";

import { parseToken, signedInAsOf } from "./subscriptionLogin.ts";

/** The `type`s the import takes, and the subscription each becomes. */
const IMPORTED_TYPES: Readonly<Record<string, AiSubscriptionProvider>> = {
  claude: "claude",
  codex: "codex",
  antigravity: "antigravity",
};

/** How an imported account is named: «<label> (<email>)». */
const LABELS: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "ChatGPT",
  antigravity: "Antigravity",
};

/**
 * The only keys kept from an imported file: those CLIProxyAPI's Claude, Codex and Antigravity
 * sign-ins write. Anything else goes (headers, the prefix and switch the Hub sets itself, any
 * spelling of a base or proxy URL), so a file never chooses where a request or its token goes.
 */
const KEPT_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "email",
  "access_token",
  "refresh_token",
  "id_token",
  "expired",
  "expires_in",
  "timestamp",
  "last_refresh",
  "account_uuid",
  "account_id",
  "organization_name",
  "organization_uuid",
  "claude_device_ids",
  "project_id",
  "priority",
]);

/** The longest AI account name. */
const NAME_MAX = 80;

export type ReadCliproxyFile =
  | {
      readonly _tag: "token";
      readonly provider: AiSubscriptionProvider;
      readonly signedInAs: string;
      readonly token: Record<string, unknown>;
    }
  | { readonly _tag: "skipped"; readonly reason: string };

/** One auth file, checked: a subscription the import knows, with who it is and a refresh token. */
export const readCliproxyAuthFile = (contents: string): ReadCliproxyFile => {
  const skip = (reason: string) => ({ _tag: "skipped" as const, reason });
  const parsed = parseToken(new TextEncoder().encode(contents.trim()));
  if (parsed === undefined) {
    return skip("Not a CLIProxyAPI auth file (JSON with a type, at most 64 KB).");
  }
  const type = parsed.type as string;
  const provider = Object.hasOwn(IMPORTED_TYPES, type) ? IMPORTED_TYPES[type] : undefined;
  if (provider === undefined) {
    const shown = /^[a-z0-9-]{1,40}$/u.test(type) ? type : "another";
    return skip(
      `Not a subscription the import takes (${shown}): only Claude, Codex and Antigravity.`,
    );
  }
  const signedInAs = signedInAsOf(parsed.email);
  if (signedInAs === null) return skip("It names no account (no email).");
  if (typeof parsed.refresh_token !== "string" || parsed.refresh_token.length === 0) {
    return skip("It holds no refresh token, so it would stop working within the hour.");
  }
  const token = Object.fromEntries(Object.entries(parsed).filter(([key]) => KEPT_FIELDS.has(key)));
  return { _tag: "token", provider, signedInAs, token };
};

/** Who a token is signed in as: its provider, its email, and the provider's own id if it has one. */
export interface CliproxyIdentity {
  readonly provider: string;
  readonly email: string;
  readonly id: string | null;
}

export const identityOf = (provider: string, token: Record<string, unknown>): CliproxyIdentity => {
  const email = signedInAsOf(token.email)?.toLowerCase() ?? "";
  const id = ["account_uuid", "account_id", "project_id"]
    .map((field) => token[field])
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return { provider, email, id: id ?? null };
};

/**
 * The same account: same provider and email, and the same provider id when both carry one. A token
 * without an id (a sign-in may leave none) matches any, so one refresh token never becomes two.
 */
export const sameIdentity = (a: CliproxyIdentity, b: CliproxyIdentity) =>
  a.provider === b.provider &&
  a.email === b.email &&
  (a.id === null || b.id === null || a.id === b.id);

/** «Claude (owner@example.com)», kept to an account name's length. */
export const importedNameOf = (provider: AiSubscriptionProvider, signedInAs: string) => {
  const label = LABELS[provider] ?? provider;
  const room = NAME_MAX - label.length - 3;
  const shown = signedInAs.length <= room ? signedInAs : `${signedInAs.slice(0, room - 1)}…`;
  return `${label} (${shown})`;
};
