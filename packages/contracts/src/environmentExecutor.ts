/**
 * What the Hub asks of the machine that runs a Thread, grouped as provider, workspace and host.
 * The Hub machine runs it in process; a joined Environment carries it over its WebSocket. Bump the
 * version on any change a peer on the previous version would misread.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProviderSessionId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  EnvironmentHostResources,
  EnvironmentProviderCapabilitySnapshot,
  EnvironmentUnavailableProvider,
} from "./environmentConnection.ts";

export const ENVIRONMENT_EXECUTOR_CONTRACT_VERSION = 5;

/**
 * The Hub machine's Environment id. It is a constant so the `environments` table can seed the
 * Hub machine's row; it is not the server's connection `EnvironmentId` (`ServerEnvironment`).
 */
export const HUB_MACHINE_ENVIRONMENT_ID = EnvironmentId.make("environment:hub-machine");

/** The Environment has no executor right now (never joined, removed, or not connected). */
export class EnvironmentExecutorUnavailableError extends Schema.TaggedError<EnvironmentExecutorUnavailableError>()(
  "EnvironmentExecutorUnavailableError",
  { environmentId: EnvironmentId },
) {
  override get message(): string {
    return `Environment ${this.environmentId} has no executor.`;
  }
}

export const EnvironmentExecutorTransport = Schema.Literals(["in-process", "remote"]);
export type EnvironmentExecutorTransport = typeof EnvironmentExecutorTransport.Type;

/** Every operation the Hub can ask of an executor, by group. */
const ENVIRONMENT_EXECUTOR_OPERATIONS = {
  provider: [
    "provider.openSession",
    "provider.ensureThread",
    "provider.resumeThread",
    "provider.startTurn",
    "provider.compactThread",
    "provider.interrupt",
    "provider.steer",
    "provider.respond",
    "provider.readThreadSnapshot",
    "provider.rollback",
    "provider.forkThread",
    "provider.injectHistory",
    "provider.stopTask",
    "provider.unloadThread",
    "provider.hasPendingBackgroundWork",
    "provider.detach",
  ],
  workspace: [
    "checkpoint.isGitRepository",
    "checkpoint.hasRef",
    "checkpoint.capture",
    "checkpoint.restore",
    "checkpoint.diff",
    "checkpoint.listAuthoredPaths",
    "checkpoint.deleteRefs",
    "checkpoint.push",
    "checkpoint.fetch",
    "checkpoint.ensureScratch",
    "move.publishScratch",
    "move.fetch",
    "move.prepare",
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
    "preview.list",
    "preview.reportStatus",
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

/** The executor's self-description. A remote Environment's capabilities come from its last one. */
export const EnvironmentExecutorSnapshot = Schema.Struct({
  contractVersion: Schema.Number,
  environmentId: EnvironmentId,
  transport: EnvironmentExecutorTransport,
  providers: Schema.Array(EnvironmentProviderCapabilitySnapshot),
  unavailableProviders: Schema.Array(EnvironmentUnavailableProvider),
  resources: Schema.optional(EnvironmentHostResources),
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

/**
 * An Environment → Hub provider event (frame method `provider.event`), ordered and deduplicated
 * by `(providerSessionId, seq)`. Live-only output (`command_output.delta`) carries no `seq`: it
 * is never spooled or resent. `event` is a `ProviderAdapterV2Event` in its JSON encoding.
 */
export const EnvironmentExecutorProviderEvent = Schema.Struct({
  providerSessionId: ProviderSessionId,
  seq: Schema.optionalKey(NonNegativeInt),
  event: Schema.Unknown,
});
export type EnvironmentExecutorProviderEvent = typeof EnvironmentExecutorProviderEvent.Type;

/** The Environment's provider session ended on its own (process exit, failure). */
export const EnvironmentExecutorSessionEnded = Schema.Struct({
  providerSessionId: ProviderSessionId,
  /** In the session's event order: spooled and resent like its events until acknowledged. */
  seq: Schema.optionalKey(NonNegativeInt),
  /** A `ProviderAdapterV2Error` in its JSON encoding, when the stream failed. */
  error: Schema.optionalKey(Schema.Unknown),
});
export type EnvironmentExecutorSessionEnded = typeof EnvironmentExecutorSessionEnded.Type;

/** Hub → Environment (frame method `provider.ack`): the highest `seq` committed per session. */
export const EnvironmentExecutorEventAck = Schema.Struct({
  acks: Schema.Array(Schema.Struct({ providerSessionId: ProviderSessionId, seq: NonNegativeInt })),
});
export type EnvironmentExecutorEventAck = typeof EnvironmentExecutorEventAck.Type;

/**
 * Hub → Environment (frame method `provider.retired`), right after a connection is welcomed: the
 * sessions the machine reported that the Hub no longer has (after a Hub restart, or ones it ended).
 * The machine detaches them instead of keeping their processes alive.
 */
export const EnvironmentExecutorRetiredSessions = Schema.Struct({
  providerSessionIds: Schema.Array(ProviderSessionId),
});
export type EnvironmentExecutorRetiredSessions = typeof EnvironmentExecutorRetiredSessions.Type;

/**
 * Environment → Hub request (method `attachment.read`): a Thread attachment the Hub stores,
 * asked for by id and content hash while a turn on this Environment needs it.
 */
export const EnvironmentAttachmentReadRequest = Schema.Struct({
  threadId: ThreadId,
  attachmentId: TrimmedNonEmptyString,
  sha256: TrimmedNonEmptyString,
});
export type EnvironmentAttachmentReadRequest = typeof EnvironmentAttachmentReadRequest.Type;

export const EnvironmentAttachmentReadResult = Schema.Struct({ base64: Schema.String });
export type EnvironmentAttachmentReadResult = typeof EnvironmentAttachmentReadResult.Type;

/** Frame methods outside the operation catalog. */
export const ENVIRONMENT_EXECUTOR_FRAME_METHODS = {
  providerEvent: "provider.event",
  sessionEnded: "provider.sessionEnded",
  ack: "provider.ack",
  retired: "provider.retired",
  attachmentRead: "attachment.read",
  workspaceStreamItem: "workspace.stream",
  workspaceStreamEnd: "workspace.streamEnd",
  workspaceStreamCancel: "workspace.streamCancel",
} as const;

/**
 * Environment → Hub (frame method `workspace.stream`): one item of a stream the Hub opened with a
 * workspace request (`terminal.stream`, `preview.events`). Live only: never spooled or resent; a
 * dropped socket ends the stream on the Hub, and the client opens it again.
 */
export const EnvironmentWorkspaceStreamItem = Schema.Struct({
  subscriptionId: TrimmedNonEmptyString,
  item: Schema.Unknown,
});
export type EnvironmentWorkspaceStreamItem = typeof EnvironmentWorkspaceStreamItem.Type;

/** Environment → Hub (`workspace.streamEnd`): the stream ended there, with its error if it failed. */
export const EnvironmentWorkspaceStreamEnd = Schema.Struct({
  subscriptionId: TrimmedNonEmptyString,
  error: Schema.optionalKey(Schema.Unknown),
});
export type EnvironmentWorkspaceStreamEnd = typeof EnvironmentWorkspaceStreamEnd.Type;

/** Hub → Environment (`workspace.streamCancel`): nobody reads the stream any more. */
export const EnvironmentWorkspaceStreamCancel = Schema.Struct({
  subscriptionId: TrimmedNonEmptyString,
});
export type EnvironmentWorkspaceStreamCancel = typeof EnvironmentWorkspaceStreamCancel.Type;
