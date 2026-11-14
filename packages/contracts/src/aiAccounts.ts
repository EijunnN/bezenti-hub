/**
 * AI accounts (spec 4 «AI accounts y AI gateway»): the Owner's subscriptions and API keys, kept on
 * the Hub, written into the CLIProxyAPI it runs, and allowed to Spaces and Users. A credential
 * enters only in `create`/`update` (Redacted) and never leaves the Hub: no RPC returns it, not to
 * the Owner either; the Owner sees its last four characters at most.
 */
import * as Schema from "effect/Schema";

import { makeEntityId, SpaceId, TrimmedNonEmptyString, UserId } from "./baseSchemas.ts";
import { ServerProviderUsageLimits } from "./providerUsageLimits.ts";

export const AiAccountId = makeEntityId("AiAccountId");
export type AiAccountId = typeof AiAccountId.Type;

/**
 * `subscription`: an OAuth login in CLIProxyAPI (ticket 03). `api-key`: an API key the gateway
 * uses, which never enters a Sandbox. `direct`: a revocable credential handed to an agent whose
 * provider takes no base URL (ticket 07).
 */
export const AiAccountType = Schema.Literals(["subscription", "api-key", "direct"]);
export type AiAccountType = typeof AiAccountType.Type;

export const AiAccountProvider = Schema.Literals([
  "claude",
  "codex",
  "antigravity",
  "kimi",
  "xai",
  "devin",
  "meta",
  "gemini",
  "vertex",
  "openai-compatible",
  "cursor",
  "kiro",
  "fx",
]);
export type AiAccountProvider = typeof AiAccountProvider.Type;

/** The providers an API-key AI account is for, each with its own block in CLIProxyAPI. */
const AI_API_KEY_PROVIDERS = [
  "claude",
  "codex",
  "gemini",
  "vertex",
  "xai",
  "meta",
  "openai-compatible",
] as const satisfies ReadonlyArray<AiAccountProvider>;
export const AiApiKeyProvider = Schema.Literals(AI_API_KEY_PROVIDERS);
export type AiApiKeyProvider = typeof AiApiKeyProvider.Type;

/**
 * The providers a direct AI account is for (ticket 07): an API key handed to an agent whose CLI
 * takes no base URL (`AI_DIRECT_DRIVERS` names which agent gets it, under which variable). Never a
 * subscription login.
 */
const AI_DIRECT_PROVIDERS = [
  "gemini",
  "vertex",
  "cursor",
  "kiro",
  "fx",
  "meta",
  "devin",
  "xai",
] as const satisfies ReadonlyArray<AiAccountProvider>;
export const AiDirectProvider = Schema.Literals(AI_DIRECT_PROVIDERS);
export type AiDirectProvider = typeof AiDirectProvider.Type;
export const isAiDirectProvider = Schema.is(AiDirectProvider);
export const isAiApiKeyProvider = Schema.is(AiApiKeyProvider);

/**
 * The providers a subscription AI account signs in to through CLIProxyAPI (OAuth), plus Vertex,
 * whose service account is imported (ticket 03).
 */
const AI_SUBSCRIPTION_PROVIDERS = [
  "claude",
  "codex",
  "antigravity",
  "kimi",
  "xai",
  "devin",
  "meta",
] as const satisfies ReadonlyArray<AiAccountProvider>;
export const AiSubscriptionProvider = Schema.Literals(AI_SUBSCRIPTION_PROVIDERS);
export type AiSubscriptionProvider = typeof AiSubscriptionProvider.Type;

/**
 * `unverified`: in the gateway, model list unreadable. `removing`: deleted, its key maybe still
 * live in the gateway. `needs-sign-in` and `quota-exhausted`: subscriptions (ticket 03).
 */
export const AiAccountStatus = Schema.Literals([
  "pending",
  "working",
  "unverified",
  "error",
  "disabled",
  "removing",
  "needs-sign-in",
  "quota-exhausted",
]);
export type AiAccountStatus = typeof AiAccountStatus.Type;

/** Who an AI account is allowed to: the Users who work in a Space, or one User. */
export const AiAccountAllowances = Schema.Struct({
  spaceIds: Schema.Array(SpaceId),
  userIds: Schema.Array(UserId),
});
export type AiAccountAllowances = typeof AiAccountAllowances.Type;

/** The Owner's view: everything about the account but the credential. */
export const AiAccountDetails = Schema.Struct({
  /** The last four characters of the key; null when it is too short to show any. */
  keyHint: Schema.NullOr(Schema.String),
  /** `openai-compatible`: where the provider answers. */
  baseUrl: Schema.NullOr(Schema.String),
  /** `openai-compatible`: the models the Owner listed. */
  models: Schema.Array(Schema.String),
  allowances: AiAccountAllowances,
  /** A subscription: the account the provider says it signed in as (an email), when it says. */
  signedInAs: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** A Claude or Codex subscription: its quota windows, when the provider reports them. */
  usageLimits: Schema.optionalKey(Schema.NullOr(ServerProviderUsageLimits)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type AiAccountDetails = typeof AiAccountDetails.Type;

/**
 * An AI account as a User sees it. Everyone sees the name, provider and status of the accounts
 * they may use in their Spaces (`usableIn`); only the Owner gets `details`.
 */
export const AiAccountSummary = Schema.Struct({
  id: AiAccountId,
  name: Schema.String,
  type: AiAccountType,
  provider: AiAccountProvider,
  /** 1 is tried first; one order for the whole Installation. */
  priority: Schema.Number,
  status: AiAccountStatus,
  statusMessage: Schema.NullOr(Schema.String),
  disabled: Schema.Boolean,
  /** The Spaces where this User may use it (not filled in for the Owner's full list). */
  usableIn: Schema.Array(SpaceId),
  details: Schema.NullOr(AiAccountDetails),
});
export type AiAccountSummary = typeof AiAccountSummary.Type;

export const AiAccountListInput = Schema.Struct({});
export type AiAccountListInput = typeof AiAccountListInput.Type;
export const AiAccountListResult = Schema.Struct({
  accounts: Schema.Array(AiAccountSummary),
  /** Whether this session manages AI accounts (the Owner, not limited to one Space). */
  canManage: Schema.Boolean,
});
export type AiAccountListResult = typeof AiAccountListResult.Type;

const AiAccountName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
/** A credential going into the Hub: Redacted, so no log, span or error shows it. */
const AiCredentialInput = Schema.RedactedFromValue(Schema.String);
const AiBaseUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
const AiModelName = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

/** A credential is UTF-8 text without spaces or control characters, at most this long. */
export const AI_CREDENTIAL_MAX_LENGTH = 8 * 1024;

export const AiAccountCreateInput = Schema.Struct({
  name: AiAccountName,
  /**
   * `api-key` (the default): used by the gateway, never enters a Sandbox. `direct`: handed to the
   * agent as an environment variable, so it is visible to it (ticket 07); `provider` must then be
   * an `AiDirectProvider`, and the credential an API key (never a subscription login).
   */
  type: Schema.optionalKey(Schema.Literals(["api-key", "direct"])),
  provider: Schema.Literals([...new Set([...AI_API_KEY_PROVIDERS, ...AI_DIRECT_PROVIDERS])]),
  apiKey: AiCredentialInput,
  /** Required for `openai-compatible`; its `/v1` base URL. */
  baseUrl: Schema.optionalKey(AiBaseUrl),
  /** Required for `openai-compatible`: the models it serves. */
  models: Schema.optionalKey(Schema.Array(AiModelName).check(Schema.isMaxLength(200))),
});
export type AiAccountCreateInput = typeof AiAccountCreateInput.Type;

/** Rename, disable or enable, «Replace credential», or (`openai-compatible`) its URL and models. */
export const AiAccountUpdateInput = Schema.Struct({
  accountId: AiAccountId,
  name: Schema.optionalKey(AiAccountName),
  disabled: Schema.optionalKey(Schema.Boolean),
  apiKey: Schema.optionalKey(AiCredentialInput),
  baseUrl: Schema.optionalKey(AiBaseUrl),
  models: Schema.optionalKey(Schema.Array(AiModelName).check(Schema.isMaxLength(200))),
});
export type AiAccountUpdateInput = typeof AiAccountUpdateInput.Type;

export const AiAccountDeleteInput = Schema.Struct({ accountId: AiAccountId });
export type AiAccountDeleteInput = typeof AiAccountDeleteInput.Type;
/**
 * `removed`: the gateway confirmed it no longer holds the key. `not-running`: the gateway is not
 * running, so the key is live nowhere. Otherwise the call fails with `still-live`.
 */
export const AiAccountDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
  gateway: Schema.Literals(["removed", "not-running"]),
});
export type AiAccountDeleteResult = typeof AiAccountDeleteResult.Type;

/** The account's allowances, replaced as a whole. */
export const AiAccountAllowInput = Schema.Struct({
  accountId: AiAccountId,
  spaceIds: Schema.Array(SpaceId).check(Schema.isMaxLength(500)),
  userIds: Schema.Array(UserId).check(Schema.isMaxLength(500)),
});
export type AiAccountAllowInput = typeof AiAccountAllowInput.Type;

/** Every AI account, first to last: the Installation's one priority. */
export const AiAccountReorderInput = Schema.Struct({
  accountIds: Schema.Array(AiAccountId).check(Schema.isMaxLength(1000)),
});
export type AiAccountReorderInput = typeof AiAccountReorderInput.Type;

/**
 * «Add subscription» or «Sign in again» (`accountId`): asks CLIProxyAPI for the provider's
 * sign-in page. One sign-in at a time; it lasts 10 minutes and only the session that started it
 * may complete it.
 */
export const AiAccountLoginStartInput = Schema.Struct({
  provider: AiSubscriptionProvider,
  /** A new account's name; omitted with `accountId`. */
  name: Schema.optionalKey(AiAccountName),
  /** «Sign in again» on this account. */
  accountId: Schema.optionalKey(AiAccountId),
});
export type AiAccountLoginStartInput = typeof AiAccountLoginStartInput.Type;

export const AiAccountLoginStartResult = Schema.Struct({
  loginId: Schema.String,
  provider: AiSubscriptionProvider,
  /**
   * `redirect`: the browser lands on a localhost address, which the Owner pastes back.
   * `device`: the Owner types `userCode` on the provider's page; nothing is pasted.
   */
  flow: Schema.Literals(["redirect", "device"]),
  /** The provider's sign-in page. */
  url: Schema.String,
  userCode: Schema.NullOr(Schema.String),
  expiresAt: Schema.String,
});
export type AiAccountLoginStartResult = typeof AiAccountLoginStartResult.Type;

/** The address the browser landed on holds a one-time code: Redacted, never logged. */
export const AI_LOGIN_REDIRECT_MAX_LENGTH = 4096;

export const AiAccountLoginCompleteInput = Schema.Struct({
  loginId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  /** `redirect` flows: the address the browser landed on, pasted. */
  redirectUrl: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
  /** «Sign in again» came back as another account: use it anyway. */
  confirmIdentity: Schema.optionalKey(Schema.Boolean),
});
export type AiAccountLoginCompleteInput = typeof AiAccountLoginCompleteInput.Type;

/** A Vertex service account (its JSON key), imported as a subscription AI account. */
export const AI_SERVICE_ACCOUNT_MAX_LENGTH = 16 * 1024;
export const AiAccountImportVertexInput = Schema.Struct({
  name: AiAccountName,
  serviceAccount: AiCredentialInput,
});
export type AiAccountImportVertexInput = typeof AiAccountImportVertexInput.Type;

export const AiAccountErrorReason = Schema.Literals([
  "not-found",
  "forbidden",
  "invalid",
  "duplicate-name",
  "storage",
  "unavailable",
  /** Saved on the Hub, but the gateway has not dropped the old key yet: the Hub keeps trying. */
  "still-live",
  /** No sign-in with that id for this session, or it is over (10 minutes, or the gateway restarted). */
  "expired",
  /** A device sign-in the Owner has not finished on the provider's page yet. */
  "pending",
  /** The provider or CLIProxyAPI refused the sign-in. */
  "sign-in-failed",
  /** «Sign in again» came back as another account: the Owner confirms before it replaces it. */
  "identity-mismatch",
]);
export type AiAccountErrorReason = typeof AiAccountErrorReason.Type;

/** Never carries a credential: messages name accounts, never what they hold. */
export class AiAccountError extends Schema.TaggedError<AiAccountError>()("AiAccountError", {
  reason: AiAccountErrorReason,
  message: Schema.String,
}) {}

/** The prefix CLIProxyAPI serves an account's models under (`acct-<id>/<model>`). */
export const aiAccountPrefixOf = (accountId: string) => `acct-${accountId}`;

/**
 * Spec 4 ticket 09: provider-instance variables that are AI credentials. Where AI accounts are in
 * use, the Hub moves them into AI accounts at its start and settings writes refuse them; each names
 * the provider of the account it becomes.
 */
export const AI_ACCOUNT_CREDENTIAL_VARIABLES: ReadonlyMap<string, AiAccountProvider> = new Map<
  string,
  AiAccountProvider
>([
  ["ANTHROPIC_API_KEY", "claude"],
  ["ANTHROPIC_AUTH_TOKEN", "claude"],
  ["OPENAI_API_KEY", "codex"],
  ["GEMINI_API_KEY", "gemini"],
  ["XAI_API_KEY", "xai"],
  ["CURSOR_API_KEY", "cursor"],
  ["KIRO_API_KEY", "kiro"],
  ["META_API_KEY", "meta"],
  ["AI_GATEWAY_API_KEY", "fx"],
  ["DEVIN_TOKEN", "devin"],
]);

/** Ticket 09: provider settings fields that are AI credentials, by driver. */
export const AI_ACCOUNT_CREDENTIAL_FIELDS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["antigravity", ["apiKey"]],
]);
