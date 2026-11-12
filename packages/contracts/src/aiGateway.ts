import * as Schema from "effect/Schema";

/**
 * What the Hub's AI gateway (the CLIProxyAPI it runs, docs/internals/ai-gateway.md) is doing:
 * `off` (`T3CODE_AI_GATEWAY=off`), `unsupported` (no release for this platform), `installing`,
 * `starting`, `running`, `restarting` (it stopped; again after a pause) or `failed` (`lastError`).
 */
export const AiGatewayState = Schema.Literals([
  "off",
  "unsupported",
  "installing",
  "starting",
  "running",
  "restarting",
  "failed",
]);
export type AiGatewayState = typeof AiGatewayState.Type;

/** A CLIProxyAPI release version, `8.0.67` (never a path, a URL or a tag with a prefix). */
export const AiGatewayVersion = Schema.String.check(
  Schema.isPattern(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/u),
);
export type AiGatewayVersion = typeof AiGatewayVersion.Type;

export const AiGatewayStatus = Schema.Struct({
  state: AiGatewayState,
  /** The release in use: the one running, or the one the Hub is starting. */
  version: Schema.NullOr(Schema.String),
  /** The release this Hub's code pins. */
  pinnedVersion: Schema.String,
  /** The release «Roll back» returns to, kept on disk after an update. */
  previousVersion: Schema.NullOr(Schema.String),
  /** When the running process started (ISO 8601). */
  startedAt: Schema.NullOr(Schema.String),
  /** Times it stopped by itself and was started again since the Hub started. */
  restarts: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
  /** False when the subscription credentials sit on the disk: no folder in memory here. */
  credentialsInMemory: Schema.Boolean,
  /** The releases this Hub pins, oldest first: the only ones it can run. */
  pinnedVersions: Schema.Array(Schema.String),
  /** Whether the Owner may turn it on or off here (not on a joined machine, nor when the environment decides). */
  switchable: Schema.Boolean,
});
export type AiGatewayStatus = typeof AiGatewayStatus.Type;

export const AiGatewayUpdateCheck = Schema.Struct({
  currentVersion: Schema.NullOr(Schema.String),
  latestVersion: AiGatewayVersion,
  updateAvailable: Schema.Boolean,
});
export type AiGatewayUpdateCheck = typeof AiGatewayUpdateCheck.Type;

export const AiGatewayUpdateInput = Schema.Struct({ version: AiGatewayVersion });
export type AiGatewayUpdateInput = typeof AiGatewayUpdateInput.Type;

export const AiGatewaySetEnabledInput = Schema.Struct({ enabled: Schema.Boolean });
export type AiGatewaySetEnabledInput = typeof AiGatewaySetEnabledInput.Type;

/** Why an AI gateway action failed, in words for the Owner; never a key. */
export class AiGatewayError extends Schema.TaggedError<AiGatewayError>()("AiGatewayError", {
  message: Schema.String,
}) {}

/**
 * Spec 4 ticket 04: the Hub's AI gateway layer, `/api/ai/{openai,anthropic,gemini}/…`, in front of
 * CLIProxyAPI. Agents and local CLIs reach it with a gateway key, never a session or an
 * Environment credential.
 */
export const AI_GATEWAY_ROUTE_PREFIX = "/api/ai";

/** Every gateway key starts so: `t3gk_` and 32 random bytes, base64url. Stored only hashed. */
export const AI_GATEWAY_KEY_PREFIX = "t3gk_";

/** `thread`: issued for one Thread's provider session; `user`: a User's key for a local CLI. */
export const AiGatewayKeyKind = Schema.Literals(["thread", "user"]);
export type AiGatewayKeyKind = typeof AiGatewayKeyKind.Type;
