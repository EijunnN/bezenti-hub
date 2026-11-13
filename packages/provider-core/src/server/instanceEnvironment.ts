import {
  AI_GATEWAY_KEY_VARIABLE,
  AiGatewaySessionError,
  type ProviderInstanceEnvironment,
  SecretDeliveryError,
  type SecretEnv,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";
import {
  type AiGatewaySessionInput,
  ProviderAdapterOpenSessionError,
  type ProviderAdapterV2,
  type ProviderAdapterV2OpenSessionInput,
} from "./ProviderAdapter.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = windows ? variable.name.toUpperCase() : variable.name;
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() === name) delete next[inherited];
      }
    }
    next[name] =
      name === "CODEX_HOME" || name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});

/**
 * `env` with a Thread's secrets (spec 5) set over it, for the one process about to start. The
 * secrets win over every variable they name; on Windows names compare without case, as there.
 */
export const applySecretEnv = (
  env: NodeJS.ProcessEnv,
  secretEnv: SecretEnv | undefined,
  platform: string,
): NodeJS.ProcessEnv => {
  if (secretEnv?.variables === undefined || secretEnv.variables.length === 0) return env;
  const windows = platform === "win32";
  const next: NodeJS.ProcessEnv = { ...env };
  for (const variable of secretEnv.variables ?? []) {
    const name = windows ? variable.name.toUpperCase() : variable.name;
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() === name) delete next[inherited];
      }
    }
    next[name] = variable.value;
  }
  return next;
};

/** Whether a session would carry secrets. */
const hasSecretEnv = (secretEnv: SecretEnv | undefined): secretEnv is SecretEnv =>
  secretEnv?.variables !== undefined && secretEnv.variables.length > 0;

/**
 * Opens a session; one with secrets only on an adapter that puts them in its processes
 * (`receivesSecretEnv`), one on the AI gateway only on an adapter that points its processes at it
 * (`usesAiGateway`): never on one that would start without them, or on a login of the machine.
 */
export const openSessionWithSecrets = (
  adapter: ProviderAdapterV2["Service"],
  input: ProviderAdapterV2OpenSessionInput,
) =>
  hasSecretEnv(input.secretEnv) && adapter.receivesSecretEnv !== true
    ? Effect.fail(
        new ProviderAdapterOpenSessionError({
          driver: adapter.driver,
          providerSessionId: input.providerSessionId,
          cause: new SecretDeliveryError({ reason: "provider", provider: adapter.driver }),
        }),
      )
    : input.aiGateway !== undefined && adapter.usesAiGateway !== true
      ? Effect.fail(
          new ProviderAdapterOpenSessionError({
            driver: adapter.driver,
            providerSessionId: input.providerSessionId,
            cause: new AiGatewaySessionError({ reason: "provider", provider: adapter.driver }),
          }),
        )
      : adapter.openSession(input);

/**
 * A session's AI gateway, as its driver starts a process with it (spec 4 ticket 06): the Thread's
 * key, account and model from the Hub, and the relay and provider home of this machine.
 */
export interface AiGatewayProcess extends AiGatewaySessionInput {
  readonly baseUrl: string;
  readonly home: string;
}

/**
 * The session's gateway, complete, or the refusal: a session the Hub put on the gateway never
 * starts without its relay and home (it would fall back to a login of the machine).
 */
export const aiGatewayProcessOf = (
  driver: ProviderAdapterV2["Service"]["driver"],
  input: Pick<ProviderAdapterV2OpenSessionInput, "aiGateway" | "providerSessionId">,
): Effect.Effect<AiGatewayProcess | undefined, ProviderAdapterOpenSessionError> => {
  const gateway = input.aiGateway;
  if (gateway === undefined) return Effect.succeed(undefined);
  if (gateway.baseUrl === undefined || gateway.home === undefined) {
    return Effect.fail(
      new ProviderAdapterOpenSessionError({
        driver,
        providerSessionId: input.providerSessionId,
        cause: new AiGatewaySessionError({ reason: "unreachable" }),
      }),
    );
  }
  return Effect.succeed({ ...gateway, baseUrl: gateway.baseUrl, home: gateway.home });
};

/**
 * What a gateway process never inherits, from the machine or a Vault: the AI providers' keys,
 * base URLs, login tokens and config homes a CLI would use instead of the gateway.
 */
export const AMBIENT_AI_VARIABLES: ReadonlyArray<string> = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_AUTH_CONTENT",
];

/** The provider id OpenCode, Pi and Codex know the gateway by. */
const AI_GATEWAY_PROVIDER_ID = "t3";

/** The OpenAI shape of the gateway, through the relay: what OpenCode, Pi and Codex call. */
const aiGatewayOpenAiBaseUrl = (gateway: AiGatewayProcess) => `${gateway.baseUrl}/api/ai/openai/v1`;

/**
 * The model the gateway serves: the selection without the gateway provider's `t3/`. Anything else
 * is the gateway's model name as is (it may hold `/`, as `deepseek/deepseek-chat`).
 */
const gatewayModelId = (model: string) =>
  model.startsWith(`${AI_GATEWAY_PROVIDER_ID}/`)
    ? model.slice(AI_GATEWAY_PROVIDER_ID.length + 1)
    : model;

/** A model slug of OpenCode or Pi on the gateway: always the gateway's provider (`t3/<model>`). */
export const aiGatewayModelSlug = (model: string) =>
  `${AI_GATEWAY_PROVIDER_ID}/${gatewayModelId(model)}`;

/**
 * The variables a driver's process gets on the gateway (spec table, «Variables por provider»).
 * The key is only ever a value here: never in arguments nor files.
 */
export const aiGatewayVariables = (
  driver: "claudeAgent" | "codex" | "opencode" | "pi",
  gateway: AiGatewayProcess,
): Record<string, string> => {
  const model = gateway.model ?? undefined;
  switch (driver) {
    case "claudeAgent":
      // NO_PROXY: `applyAiGatewayEnv` keeps the machine's and adds loopback.
      const { NO_PROXY: _noProxy, ...settingsEnv } = claudeGatewaySettingsEnv(gateway);
      return {
        ...settingsEnv,
        ANTHROPIC_AUTH_TOKEN: gateway.key,
        CLAUDE_CONFIG_DIR: gateway.home,
      };
    case "codex":
      return { [AI_GATEWAY_KEY_VARIABLE]: gateway.key, CODEX_HOME: gateway.home };
    case "opencode": {
      const id = model === undefined ? undefined : gatewayModelId(model);
      return {
        [AI_GATEWAY_KEY_VARIABLE]: gateway.key,
        XDG_CONFIG_HOME: `${gateway.home}/config`,
        XDG_DATA_HOME: `${gateway.home}/data`,
        XDG_STATE_HOME: `${gateway.home}/state`,
        XDG_CACHE_HOME: `${gateway.home}/cache`,
        // A project's opencode.json or .opencode/ (its plugins run in the server, with the key in
        // reach) never redefines the gateway's provider.
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        // The key by name: OpenCode reads `{env:…}` when it loads the provider.
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          enabled_providers: [AI_GATEWAY_PROVIDER_ID],
          provider: {
            [AI_GATEWAY_PROVIDER_ID]: {
              npm: "@ai-sdk/openai-compatible",
              name: "T3 Code AI gateway",
              options: {
                baseURL: aiGatewayOpenAiBaseUrl(gateway),
                apiKey: `{env:${AI_GATEWAY_KEY_VARIABLE}}`,
              },
              models: id === undefined ? {} : { [id]: { name: id } },
            },
          },
          ...(id === undefined ? {} : { model: `${AI_GATEWAY_PROVIDER_ID}/${id}` }),
          autoupdate: false,
          share: "disabled",
        }),
      };
    }
    case "pi":
      return {
        [AI_GATEWAY_KEY_VARIABLE]: gateway.key,
        PI_CODING_AGENT_DIR: gateway.home,
        PI_OFFLINE: "1",
      };
  }
};

/**
 * What Claude Code must take from the gateway over any settings file: flag settings (`--settings`)
 * outrank a project's `.claude/settings.json` and `settings.local.json`, whose `env` would otherwise
 * beat the process's and send the key elsewhere. Never the key itself (flag settings may travel in
 * arguments): a project that replaces the token only fails against the gateway.
 */
export const claudeGatewaySettingsEnv = (
  gateway: AiGatewayProcess,
  processNoProxy?: string,
): Record<string, string> => {
  const model = gateway.model ?? undefined;
  return {
    ANTHROPIC_BASE_URL: `${gateway.baseUrl}/api/ai/anthropic`,
    // The Bash tool's commands do not inherit Claude Code's Anthropic credentials.
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    // A proxy a project sets never sees the calls to the loopback relay.
    NO_PROXY: processNoProxy ?? LOOPBACK_NO_PROXY,
    ...(model === undefined
      ? {}
      : {
          ANTHROPIC_MODEL: model,
          // Claude Code's background calls ask for a small model the account may not serve.
          ANTHROPIC_SMALL_FAST_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        }),
  };
};

/** Loopback, kept out of any proxy so the relay's calls never leave the machine. */
const LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";

/**
 * Pi's `models.json` on the gateway, in the Thread's Pi home: the gateway's provider, with the key
 * read from the environment by name (`$T3_AI_GATEWAY_KEY`), never written.
 */
export const piGatewayModelsJson = (gateway: AiGatewayProcess) => {
  const model = gateway.model === null ? undefined : gatewayModelId(gateway.model);
  return JSON.stringify(
    {
      providers: {
        [AI_GATEWAY_PROVIDER_ID]: {
          baseUrl: aiGatewayOpenAiBaseUrl(gateway),
          api: "openai-completions",
          apiKey: `$${AI_GATEWAY_KEY_VARIABLE}`,
          models: model === undefined ? [] : [{ id: model, name: model }],
        },
      },
    },
    null,
    2,
  );
};

/** Codex's model provider on the gateway, as `-c` overrides: the key by name (`env_key`) only. */
export const codexGatewayConfigArgs = (gateway: AiGatewayProcess): ReadonlyArray<string> => [
  "-c",
  `model_provider="${AI_GATEWAY_PROVIDER_ID}"`,
  "-c",
  `model_providers.${AI_GATEWAY_PROVIDER_ID}.name="T3 Code AI gateway"`,
  "-c",
  `model_providers.${AI_GATEWAY_PROVIDER_ID}.base_url="${aiGatewayOpenAiBaseUrl(gateway)}"`,
  "-c",
  `model_providers.${AI_GATEWAY_PROVIDER_ID}.env_key="${AI_GATEWAY_KEY_VARIABLE}"`,
  "-c",
  `model_providers.${AI_GATEWAY_PROVIDER_ID}.wire_api="responses"`,
];

/**
 * `env` (the machine's, with the Thread's secrets over it) for a gateway process: every ambient AI
 * variable gone, then the gateway's, which nothing overrides. Without a gateway, `env` unchanged.
 */
export const applyAiGatewayEnv = (
  env: NodeJS.ProcessEnv,
  variables: Record<string, string> | undefined,
  platform: string,
): NodeJS.ProcessEnv => {
  if (variables === undefined) return env;
  const windows = platform === "win32";
  const fold = (name: string) => (windows ? name.toUpperCase() : name);
  const drop = new Set([...AMBIENT_AI_VARIABLES, ...Object.keys(variables)].map(fold));
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!drop.has(fold(name))) next[name] = value;
  }
  for (const [name, value] of Object.entries(variables)) next[name] = value;
  // The relay is on loopback: never through a proxy of the machine's or a Vault's.
  for (const name of ["NO_PROXY", "no_proxy"]) {
    const current = Object.entries(next).find(([key]) => fold(key) === fold(name))?.[1];
    next[name] =
      current === undefined || current.length === 0
        ? LOOPBACK_NO_PROXY
        : `${current},${LOOPBACK_NO_PROXY}`;
    if (windows) break;
  }
  return next;
};
