/**
 * Spec 4 ticket 06: a Thread's provider session on the Hub's AI gateway. The Hub sends the key, AI
 * account and model in `provider.openSession` (`aiGateway`); the machine adds its relay and the
 * Thread's provider home. docs/internals/ai-gateway.md, «Agents through the gateway».
 */
import * as Schema from "effect/Schema";

import { AiAccountId, AiAccountProvider } from "./aiAccounts.ts";

/** The executor contract from which a machine receives `aiGateway`. */
export const AI_GATEWAY_CONTRACT_VERSION = 11;

/** The key `aiGateway` travels under in a `provider.openSession` payload. */
export const AI_GATEWAY_FIELD = "aiGateway";

/**
 * The drivers whose CLI takes a base URL: their Hub turns go through the gateway (spec table,
 * «Variables por provider»). The rest are ticket 07's (a direct credential, or nothing).
 */
export const AI_GATEWAY_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "opencode",
  "pi",
]);

/** The variable every gateway process reads its key from (Codex's `env_key`, Pi's `$NAME`). */
export const AI_GATEWAY_KEY_VARIABLE = "T3_AI_GATEWAY_KEY";

/**
 * What a gateway session sets in its process's environment: a Vault never sets one, not even the
 * Owner's (spec 5's shared list; `T3_` and `T3CODE_` names are refused as a whole).
 */
export const AI_GATEWAY_ENV_NAMES: ReadonlySet<string> = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "OPENAI_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "PI_CODING_AGENT_DIR",
]);

/**
 * The Thread's gateway session as the Hub sends it: the Thread's key (`t3gk_…`, revoked when the
 * session ends), the AI account its requests go to and the model. Never logged, kept or written.
 */
export const AiGatewayAccess = Schema.Struct({
  key: Schema.String,
  aiAccountId: AiAccountId,
  aiAccountName: Schema.String,
  provider: AiAccountProvider,
  model: Schema.NullOr(Schema.String),
});
export type AiGatewayAccess = typeof AiGatewayAccess.Type;

/** The AI account a provider session uses, as the Thread shows it (never a key). */
export const ProviderSessionAiAccount = Schema.Struct({
  id: AiAccountId,
  name: Schema.String,
  provider: AiAccountProvider,
  model: Schema.NullOr(Schema.String),
});
export type ProviderSessionAiAccount = typeof ProviderSessionAiAccount.Type;

/**
 * Why a gateway session was not started (never without the gateway, nor on a login): a machine
 * before contract 11, no allowed AI account, the Thread's account no longer allowed, a provider
 * that can't take it, or no way from the machine to the gateway.
 */
export class AiGatewaySessionError extends Schema.TaggedError<AiGatewaySessionError>()(
  "AiGatewaySessionError",
  {
    reason: Schema.Literals([
      "outdated-machine",
      "no-ai-account",
      "not-allowed",
      "provider",
      "unreachable",
    ]),
    environmentName: Schema.optional(Schema.String),
    provider: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "outdated-machine":
        return `${this.environmentName ?? "This machine"} needs an update to use the Hub's AI accounts.`;
      case "no-ai-account":
        return "No AI account is allowed to you in this Space. Ask the Owner to allow one in Settings → AI accounts.";
      case "not-allowed":
        return "This Thread's AI account is no longer allowed to you here. Switch AI account.";
      case "provider":
        return `${this.provider ?? "This provider"} can't use the Hub's AI accounts.`;
      case "unreachable":
        return `${this.environmentName ?? "This machine"} can't reach the Hub's AI gateway.`;
    }
  }
}
