/**
 * What the Hub asks of the machine that runs a Thread, grouped as provider, workspace and host.
 * The Hub machine runs it in process; a joined Environment carries it over its WebSocket. Bump the
 * version on any change a peer on the previous version would misread.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  ProviderSessionId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationV2ProviderCapabilities } from "./orchestrationV2.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";

export const ENVIRONMENT_EXECUTOR_CONTRACT_VERSION = 1;

/**
 * The Hub machine's Environment id. It is a constant so the `environments` table can seed the
 * Hub machine's row; it is not the server's connection `EnvironmentId` (`ServerEnvironment`).
 */
export const HUB_MACHINE_ENVIRONMENT_ID = EnvironmentId.make("environment:hub-machine");

export const EnvironmentExecutorTransport = Schema.Literals(["in-process", "remote"]);
export type EnvironmentExecutorTransport = typeof EnvironmentExecutorTransport.Type;

/** Every operation the Hub can ask of an executor, by group. */
const ENVIRONMENT_EXECUTOR_OPERATIONS = {
  provider: [
    "provider.openSession",
    "provider.startTurn",
    "provider.interrupt",
    "provider.steer",
    "provider.respond",
    "provider.rollback",
    "provider.detach",
  ],
  workspace: [
    "checkpoint.capture",
    "checkpoint.restore",
    "checkpoint.diff",
    "checkpoint.listAuthoredPaths",
    "checkpoint.deleteRefs",
    "runtimePolicy.resolve",
    "launch.prepareWorktree",
    "launch.runSetupScript",
    "files.read",
    "files.write",
    "files.metadata",
    "search.paths",
    "search.contents",
    "entries.list",
    "entries.listIgnored",
    "entries.browse",
    "terminal.open",
    "terminal.write",
    "terminal.resize",
    "terminal.clear",
    "terminal.close",
    "terminal.stream",
    "preview.open",
    "preview.resize",
    "preview.adjust",
    "preview.close",
    "preview.events",
    "ports.scan",
    "ports.stopServer",
  ],
  host: ["host.describe"],
} as const;

export const EnvironmentExecutorOperationGroup = Schema.Literals(["provider", "workspace", "host"]);
export type EnvironmentExecutorOperationGroup = typeof EnvironmentExecutorOperationGroup.Type;

export const EnvironmentExecutorOperation = Schema.Literals([
  ...ENVIRONMENT_EXECUTOR_OPERATIONS.provider,
  ...ENVIRONMENT_EXECUTOR_OPERATIONS.workspace,
  ...ENVIRONMENT_EXECUTOR_OPERATIONS.host,
]);
export type EnvironmentExecutorOperation = typeof EnvironmentExecutorOperation.Type;

/** What an Environment publishes about one provider instance, in its hello and each heartbeat. */
export const EnvironmentProviderCapabilitySnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  continuationKey: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  capabilities: OrchestrationV2ProviderCapabilities,
});
export type EnvironmentProviderCapabilitySnapshot =
  typeof EnvironmentProviderCapabilitySnapshot.Type;

/** The executor's self-description. The Orchestrator decides from the last one it received. */
export const EnvironmentExecutorSnapshot = Schema.Struct({
  contractVersion: Schema.Number,
  environmentId: EnvironmentId,
  transport: EnvironmentExecutorTransport,
  providers: Schema.Array(EnvironmentProviderCapabilitySnapshot),
  resources: Schema.optional(HostResourcesSnapshot),
  observedAt: IsoDateTime,
});
export type EnvironmentExecutorSnapshot = typeof EnvironmentExecutorSnapshot.Type;

/** A Hub → Environment request. Requests made by an effect carry `effectId:attempt`. */
export const EnvironmentExecutorRequest = Schema.Struct({
  contractVersion: Schema.Number,
  requestId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  operation: EnvironmentExecutorOperation,
  idempotencyKey: Schema.optional(TrimmedNonEmptyString),
  payload: Schema.Unknown,
});
export type EnvironmentExecutorRequest = typeof EnvironmentExecutorRequest.Type;

export const EnvironmentExecutorResponse = Schema.Union([
  Schema.Struct({
    requestId: TrimmedNonEmptyString,
    status: Schema.Literal("succeeded"),
    result: Schema.Unknown,
  }),
  Schema.Struct({
    requestId: TrimmedNonEmptyString,
    status: Schema.Literal("failed"),
    error: Schema.Unknown,
  }),
]);
export type EnvironmentExecutorResponse = typeof EnvironmentExecutorResponse.Type;

/** An Environment → Hub provider event, ordered and deduplicated by `(providerSessionId, seq)`. */
export const EnvironmentExecutorProviderEvent = Schema.Struct({
  environmentId: EnvironmentId,
  providerSessionId: ProviderSessionId,
  seq: Schema.Number,
  event: Schema.Unknown,
});
export type EnvironmentExecutorProviderEvent = typeof EnvironmentExecutorProviderEvent.Type;
