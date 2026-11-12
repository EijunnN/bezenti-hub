import {
  type ProviderInstanceEnvironment,
  SecretDeliveryError,
  type SecretEnv,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";
import {
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
  if (secretEnv === undefined || secretEnv.variables.length === 0) return env;
  const windows = platform === "win32";
  const next: NodeJS.ProcessEnv = { ...env };
  for (const variable of secretEnv.variables) {
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
  secretEnv !== undefined && secretEnv.variables.length > 0;

/**
 * Opens a session; one with secrets only on an adapter that puts them in its processes
 * (`receivesSecretEnv`), never on one that would start without them.
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
    : adapter.openSession(input);
