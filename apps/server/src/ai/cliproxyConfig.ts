/**
 * The `config.yaml` the Hub writes for CLIProxyAPI (v8 layout), 0600, beside the `auth-dir`:
 * loopback only, management from loopback behind a random key, no panel, discovery, plugins,
 * usage statistics or request logs (they would keep prompts), and one client key, the Hub's.
 */
import { type AiApiKeyProvider, aiAccountPrefixOf } from "@t3tools/contracts";
import { stringify } from "yaml";

export interface CliproxyConfigInput {
  readonly port: number;
  readonly managementKey: string;
  readonly clientKey: string;
  readonly authDir: string;
}

export const CLIPROXY_HOST = "127.0.0.1";

export const renderCliproxyConfig = (input: CliproxyConfigInput) =>
  stringify({
    "config-version": 8,
    server: {
      host: CLIPROXY_HOST,
      port: input.port,
      tls: { enable: false },
      "trusted-proxies": [],
      discovery: { enabled: false },
    },
    management: {
      "allow-remote": false,
      "secret-key": input.managementKey,
      "disable-control-panel": true,
      "disable-auto-update-panel": true,
    },
    access: { "api-keys": [input.clientKey] },
    oauth: { "auth-dir": input.authDir },
    observability: {
      logs: { debug: false, "logging-to-file": false, "request-log": false },
      usage: { "usage-statistics-enabled": false },
      pprof: { enable: false },
    },
    plugins: { enabled: false },
    // Only `acct-<id>/<model>` is served: the Hub always pins a request to one AI account.
    routing: { "force-model-prefix": true },
  });

/** An AI account as CLIProxyAPI gets it: its credential and, for `openai-compatible`, where. */
export interface CliproxyApiKeyAccount {
  readonly id: string;
  readonly provider: AiApiKeyProvider;
  readonly apiKey: string;
  readonly baseUrl: string | null;
  readonly models: ReadonlyArray<string>;
}

/** Each API-key provider's block under CLIProxyAPI's `api-keys` (v8). */
const API_KEY_BLOCKS = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  vertex: "vertex",
  xai: "xai",
  meta: "meta",
  "openai-compatible": "openai-compatibility",
} as const satisfies Record<AiApiKeyProvider, string>;

/**
 * The whole `api-keys` section for these accounts, every block present (an empty list removes
 * what was there: a PATCH replaces lists), each account under its own `prefix` (`acct-<id>`) so
 * the Hub pins a request to it (`acct-<id>/<model>`).
 */
export const renderCliproxyApiKeys = (accounts: ReadonlyArray<CliproxyApiKeyAccount>) => {
  const blocks: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(
    Object.values(API_KEY_BLOCKS).map((block) => [block, []]),
  );
  for (const account of accounts) {
    const prefix = aiAccountPrefixOf(account.id);
    const keys = [{ "api-key": account.apiKey }];
    blocks[API_KEY_BLOCKS[account.provider]]!.push(
      account.provider === "openai-compatible"
        ? {
            name: prefix,
            prefix,
            "base-url": account.baseUrl ?? "",
            keys,
            models: account.models.map((model) => ({ name: model, alias: model })),
          }
        : { prefix, keys },
    );
  }
  return blocks;
};
