/**
 * AI accounts (spec 4 «AI accounts y AI gateway»): the Owner's subscriptions and API keys, kept on
 * the Hub, written into the CLIProxyAPI it runs, and allowed to Spaces and Users. A credential
 * enters only in `create`/`update` (Redacted) and never leaves the Hub: no RPC returns it, not to
 * the Owner either; the Owner sees its last four characters at most.
 */
import * as Schema from "effect/Schema";

import { makeEntityId, SpaceId, TrimmedNonEmptyString, UserId } from "./baseSchemas.ts";

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
  provider: AiApiKeyProvider,
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

export const AiAccountErrorReason = Schema.Literals([
  "not-found",
  "forbidden",
  "invalid",
  "duplicate-name",
  "storage",
  "unavailable",
  /** Saved on the Hub, but the gateway has not dropped the old key yet: the Hub keeps trying. */
  "still-live",
]);
export type AiAccountErrorReason = typeof AiAccountErrorReason.Type;

/** Never carries a credential: messages name accounts, never what they hold. */
export class AiAccountError extends Schema.TaggedError<AiAccountError>()("AiAccountError", {
  reason: AiAccountErrorReason,
  message: Schema.String,
}) {}

/** The prefix CLIProxyAPI serves an account's models under (`acct-<id>/<model>`). */
export const aiAccountPrefixOf = (accountId: string) => `acct-${accountId}`;
