/**
 * Copyable setup for a local CLI pointed at a Hub's AI gateway with a User's own gateway key
 * (spec 4 ticket 10): Claude Code's `settings.json` and Codex's `config.toml`. Pure, shared by
 * the web, desktop and mobile Settings. docs/internals/ai-gateway.md, «Local CLI keys».
 */

/** Where the key goes when the setup is copied later: the key itself is shown only once. */
export const LOCAL_CLI_KEY_PLACEHOLDER = "<your T3 Code gateway key>";

/** The environment variable Codex reads the key from (`env_key`). */
const CODEX_GATEWAY_KEY_ENV = "T3_AI_GATEWAY_KEY";

export interface LocalCliSetup {
  /** Claude Code: `~/.claude/settings.json` (merge `env` into an existing file). */
  readonly claudeCode: string;
  /** Codex: `~/.codex/config.toml`, plus the key in the shell's environment. */
  readonly codex: string;
}

/** The Hub's origin without a trailing slash, path or query; null when it is not http(s). */
export function gatewayOrigin(hubUrl: string): string | null {
  try {
    const url = new URL(hubUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function localCliSetup(hubOrigin: string, key: string | null): LocalCliSetup {
  const secret = key ?? LOCAL_CLI_KEY_PLACEHOLDER;
  const claudeCode = JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: `${hubOrigin}/api/ai/anthropic`,
        ANTHROPIC_AUTH_TOKEN: secret,
      },
    },
    null,
    2,
  );
  const codex = [
    "# ~/.codex/config.toml",
    'model_provider = "t3"',
    "",
    "[model_providers.t3]",
    'name = "T3 Code Hub"',
    `base_url = ${JSON.stringify(`${hubOrigin}/api/ai/openai/v1`)}`,
    `env_key = "${CODEX_GATEWAY_KEY_ENV}"`,
    'wire_api = "responses"',
    "",
    "# In your shell profile:",
    `# export ${CODEX_GATEWAY_KEY_ENV}=${shellQuoted(secret)}`,
  ].join("\n");
  return { claudeCode, codex };
}

const shellQuoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
