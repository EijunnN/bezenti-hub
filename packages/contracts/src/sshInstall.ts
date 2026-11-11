import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, SpaceId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HubEnvironmentName } from "./hubEnvironments.ts";

/**
 * «Add a machine over SSH» (docs/internals/sandboxes.md, «Installing over SSH»): the Owner gives
 * the Hub a machine's SSH address and key; the Hub checks it, installs T3, registers it dedicated
 * to a Space with a one-use grant and starts its service, step by step.
 */

/**
 * How the Hub signs in: a private key (with its passphrase, if any) used in memory for this run,
 * or the SSH agent of the Hub's own process (`SSH_AUTH_SOCK`).
 */
export const SshInstallAuth = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("key"),
    privateKey: Schema.RedactedFromValue(Schema.String),
    passphrase: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
  }),
  Schema.Struct({ kind: Schema.Literal("agent") }),
]);
export type SshInstallAuth = typeof SshInstallAuth.Type;

export const SshInstallStartRequest = Schema.Struct({
  host: TrimmedNonEmptyString,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  username: TrimmedNonEmptyString,
  auth: SshInstallAuth,
  /** The Organization the machine is dedicated to. */
  spaceId: SpaceId,
  /** The name the Hub shows. */
  name: HubEnvironmentName,
  /** The Hub's address as the machine reaches it: https://, or http:// on loopback only. */
  hubUrl: TrimmedNonEmptyString,
  /** Keep the key in the Hub's secret store for later runs; otherwise it is forgotten. */
  keepForUpdates: Schema.Boolean,
});
export type SshInstallStartRequest = typeof SshInstallStartRequest.Type;

export const SshInstallRunRef = Schema.Struct({ runId: TrimmedNonEmptyString });
export type SshInstallRunRef = typeof SshInstallRunRef.Type;

/** The Owner confirms the host key the Hub was shown (trust on first use). */
export const SshInstallConfirmRequest = Schema.Struct({
  runId: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
});
export type SshInstallConfirmRequest = typeof SshInstallConfirmRequest.Type;

export const SshInstallStepId = Schema.Literals(["check", "install", "register", "service"]);
export type SshInstallStepId = typeof SshInstallStepId.Type;

export const SshInstallStep = Schema.Struct({
  id: SshInstallStepId,
  title: Schema.String,
  state: Schema.Literals(["pending", "running", "succeeded", "failed", "cancelled"]),
  /** The step's output, scrubbed of the key and the grant; the last lines the Hub keeps. */
  output: Schema.Array(Schema.String),
});
export type SshInstallStep = typeof SshInstallStep.Type;

export const SshInstallHostKey = Schema.Struct({
  /** `ssh-ed25519`, `ecdsa-sha2-nistp256`, … */
  algorithm: Schema.String,
  /** `SHA256:<base64>`, as `ssh-keygen -lf` prints it. */
  fingerprint: Schema.String,
  /** A machine registered from this address stored this same key. */
  known: Schema.Boolean,
});
export type SshInstallHostKey = typeof SshInstallHostKey.Type;

export const SshInstallRunState = Schema.Literals([
  /** The Hub read the host key and waits for the Owner to confirm it. */
  "awaiting-host-key",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type SshInstallRunState = typeof SshInstallRunState.Type;

export const SshInstallRun = Schema.Struct({
  runId: TrimmedNonEmptyString,
  host: Schema.String,
  port: Schema.Int,
  username: Schema.String,
  spaceId: SpaceId,
  spaceName: Schema.String,
  name: Schema.String,
  state: SshInstallRunState,
  hostKey: Schema.NullOr(SshInstallHostKey),
  steps: Schema.Array(SshInstallStep),
  /** Why it failed or stopped. */
  error: Schema.NullOr(Schema.String),
  /** The machine, once registered and its service is up. */
  environmentId: Schema.NullOr(EnvironmentId),
  /** Whether the key went to the Hub's secret store. */
  keyKept: Schema.Boolean,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type SshInstallRun = typeof SshInstallRun.Type;

/**
 * `t3 join --grant-on-stdin` on the machine, run by the Hub over SSH: the one-use grant the Hub
 * issued to that run registers the machine with its credential's hash, dedicated to the run's
 * Space, with no approval page.
 */
export const EnvironmentJoinGrantRequest = Schema.Struct({
  grant: Schema.RedactedFromValue(TrimmedNonEmptyString),
  credentialHash: TrimmedNonEmptyString,
  os: TrimmedNonEmptyString,
  hostname: TrimmedNonEmptyString,
});
export type EnvironmentJoinGrantRequest = typeof EnvironmentJoinGrantRequest.Type;
