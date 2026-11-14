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
 * Never kept from an imported file: the prefix and switch the Hub sets itself, and anything that
 * would choose where CLIProxyAPI sends a request or the token.
 */
const DROPPED_FIELDS = ["prefix", "disabled", "base_url", "proxy_url"] as const;

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
  const token: Record<string, unknown> = { ...parsed };
  for (const field of DROPPED_FIELDS) delete token[field];
  return { _tag: "token", provider, signedInAs, token };
};

/**
 * Who a token is signed in as, to tell one account from another: its provider, its email, and the
 * provider's own account or project id when it carries one.
 */
export const identityOf = (provider: string, token: Record<string, unknown>) => {
  const email = signedInAsOf(token.email)?.toLowerCase() ?? "";
  const ids = ["account_uuid", "account_id", "project_id"]
    .map((field) => token[field])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return JSON.stringify([provider, email, ids[0] ?? null]);
};

/** «Claude (owner@example.com)», kept to an account name's length. */
export const importedNameOf = (provider: AiSubscriptionProvider, signedInAs: string) => {
  const label = LABELS[provider] ?? provider;
  const room = NAME_MAX - label.length - 3;
  const shown = signedInAs.length <= room ? signedInAs : `${signedInAs.slice(0, room - 1)}…`;
  return `${label} (${shown})`;
};
