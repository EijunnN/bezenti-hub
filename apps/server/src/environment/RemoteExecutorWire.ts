/**
 * The payloads of the executor operations a joined Environment runs for the Hub, in their JSON
 * codecs. The envelope (frames, operation names, event and ack payloads) is the versioned contract
 * in `@t3tools/contracts` (`environmentExecutor.ts`); these are built from the provider adapter's
 * own schemas, which live beside the adapters, so both halves of the server share them here.
 */
import {
  CheckpointId,
  CheckpointRef,
  EnvironmentExecutorUnavailableError,
  ModelSelection,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderApprovalDecision,
  ProviderSessionId,
  ProviderTurnId,
  ProviderUserInputAnswers,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  VcsError,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";

const RuntimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy;
const ProviderThread = OrchestrationV2ProviderThread;

/** An attachment the turn carries, by the id the Hub stores it under and its content hash. */
export const WireAttachmentRef = Schema.Struct({ id: Schema.String, sha256: Schema.String });
export type WireAttachmentRef = typeof WireAttachmentRef.Type;

/** The per-Thread MCP credential the Hub issued; the Environment points it at the Hub's `/mcp`. */
export const WireMcpCredential = Schema.Struct({
  credentialId: Schema.String,
  authorizationHeader: Schema.String,
  browserToolsAvailable: Schema.Boolean,
  capabilities: Schema.Array(Schema.String),
});
export type WireMcpCredential = typeof WireMcpCredential.Type;

/**
 * Where the Project's checkout is on the Environment, the remote to clone it from, and the
 * Thread's checkpoint refs the Hub repository has, for the checkout to fetch the ones it lacks.
 */
export const WireCheckout = Schema.Struct({
  path: Schema.String,
  cloneUrl: Schema.NullOr(Schema.String),
  hubRefs: Schema.optionalKey(
    Schema.Struct({ projectId: ProjectId, refs: Schema.Array(CheckpointRef) }),
  ),
});
export type WireCheckout = typeof WireCheckout.Type;

const OpenSessionInput = Schema.Struct({
  threadId: ThreadId,
  providerSessionId: ProviderSessionId,
  instanceId: Schema.String,
  modelSelection: ModelSelection,
  runtimePolicy: RuntimePolicy,
  resumeFromSession: Schema.optionalKey(OrchestrationV2ProviderSession),
  initialNativeThreadId: Schema.optionalKey(Schema.String),
  initialProviderItemIdentityVersion: Schema.optionalKey(Schema.Literal(2)),
  mcp: Schema.optionalKey(WireMcpCredential),
  checkout: Schema.optionalKey(WireCheckout),
});

/** Which optional session methods the Environment's runtime has. */
const SessionFeatures = Schema.Struct({
  injectHistory: Schema.Boolean,
  compactThread: Schema.Boolean,
  stopTask: Schema.Boolean,
  unloadThread: Schema.Boolean,
  hasPendingBackgroundWork: Schema.Boolean,
  backgroundTasksEndWithProcess: Schema.Boolean,
});
export type WireSessionFeatures = typeof SessionFeatures.Type;

const OpenSessionResult = Schema.Struct({
  providerSession: OrchestrationV2ProviderSession,
  features: SessionFeatures,
});

/** A call on a session the Environment already opened. */
const onSession = <S extends Schema.Top>(input: S) =>
  Schema.Struct({ providerSessionId: ProviderSessionId, input });

const TurnMessage = ProviderAdapter.ProviderAdapterV2TurnMessage;

const TurnInput = Schema.Struct({
  appThread: OrchestrationV2AppThread,
  threadId: ThreadId,
  runId: RunId,
  runOrdinal: Schema.Number,
  nativeThreadHasTurns: Schema.optionalKey(Schema.Boolean),
  providerTurnOrdinal: Schema.Number,
  restartContinuationOfRunId: Schema.optionalKey(RunId),
  attemptId: RunAttemptId,
  rootNodeId: NodeId,
  providerThread: ProviderThread,
  message: TurnMessage,
  modelSelection: ModelSelection,
  runtimePolicy: RuntimePolicy,
  appContext: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, text: Schema.String })),
  ),
});

const SteerInput = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  providerThread: ProviderThread,
  providerTurnId: ProviderTurnId,
  message: TurnMessage,
});

const ThreadSnapshot = Schema.Struct({
  providerThread: ProviderThread,
  providerTurns: Schema.Array(OrchestrationV2ProviderTurn),
  messages: Schema.Array(OrchestrationV2ConversationMessage),
  runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequest),
  providerPayload: Schema.optionalKey(Schema.Unknown),
});

const RollbackTarget = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread_start"),
    checkpointId: CheckpointId,
    appRunOrdinal: Schema.Literal(0),
  }),
  Schema.Struct({
    type: Schema.Literal("provider_turn"),
    checkpointId: CheckpointId,
    appRunOrdinal: Schema.Number,
    providerTurn: OrchestrationV2ProviderTurn,
    message: Schema.optionalKey(
      Schema.Struct({
        role: OrchestrationV2ConversationMessage.fields.role,
        text: OrchestrationV2ConversationMessage.fields.text,
        attachments: OrchestrationV2ConversationMessage.fields.attachments,
      }),
    ),
  }),
]);

const Empty = Schema.Struct({});

const provider = <I extends Schema.Top, O extends Schema.Top>(input: I, output: O) => ({
  input,
  output,
  error: ProviderAdapter.ProviderAdapterV2Error,
});

const checkpoint = <I extends Schema.Top, O extends Schema.Top>(input: I, output: O) => ({
  input,
  output,
  error: Schema.Union([VcsError, EnvironmentExecutorUnavailableError]),
});

const DiffInput = Schema.Struct({
  cwd: Schema.String,
  fromCheckpointRef: CheckpointRef,
  toCheckpointRef: CheckpointRef,
  fallbackFromToHead: Schema.optionalKey(Schema.Boolean),
  ignoreWhitespace: Schema.Boolean,
  format: Schema.optionalKey(Schema.Literals(["patch", "numstat"])),
  maxOutputBytes: Schema.optionalKey(Schema.Number),
  filePaths: Schema.optionalKey(Schema.Array(Schema.String)),
});

const HubRepositoryTransfer = Schema.Struct({
  cwd: Schema.String,
  projectId: ProjectId,
  checkpointRefs: Schema.Array(CheckpointRef),
});

/** Every operation a joined Environment answers today, with its codecs. */
export const REMOTE_OPERATIONS = {
  "provider.openSession": provider(OpenSessionInput, OpenSessionResult),
  "provider.ensureThread": provider(
    onSession(
      Schema.Struct({
        threadId: ThreadId,
        title: Schema.optionalKey(Schema.String),
        modelSelection: ModelSelection,
        runtimePolicy: RuntimePolicy,
        providerSessionId: Schema.optionalKey(ProviderSessionId),
        existingProviderThread: Schema.optionalKey(ProviderThread),
        forceNewNativeThread: Schema.optionalKey(Schema.Boolean),
      }),
    ),
    ProviderThread,
  ),
  "provider.resumeThread": provider(
    onSession(
      Schema.Struct({
        providerThread: ProviderThread,
        threadId: Schema.optionalKey(ThreadId),
        modelSelection: Schema.optionalKey(ModelSelection),
        runtimePolicy: Schema.optionalKey(RuntimePolicy),
      }),
    ),
    ProviderThread,
  ),
  "provider.startTurn": provider(
    Schema.Struct({
      providerSessionId: ProviderSessionId,
      input: TurnInput,
      attachments: Schema.Array(WireAttachmentRef),
    }),
    Schema.Void,
  ),
  "provider.compactThread": provider(onSession(TurnInput), Schema.Void),
  "provider.steer": provider(
    Schema.Struct({
      providerSessionId: ProviderSessionId,
      input: SteerInput,
      attachments: Schema.Array(WireAttachmentRef),
    }),
    Schema.Void,
  ),
  "provider.interrupt": provider(
    onSession(
      Schema.Struct({
        providerThread: ProviderThread,
        providerTurnId: ProviderTurnId,
        requestRuntimeRestart: Schema.optionalKey(Schema.Boolean),
      }),
    ),
    Schema.Void,
  ),
  "provider.respond": provider(
    onSession(
      Schema.Struct({
        requestId: RuntimeRequestId,
        decision: Schema.optionalKey(ProviderApprovalDecision),
        feedback: Schema.optionalKey(Schema.String),
        answers: Schema.optionalKey(ProviderUserInputAnswers),
      }),
    ),
    Schema.Void,
  ),
  "provider.readThreadSnapshot": provider(
    onSession(Schema.Struct({ providerThread: ProviderThread })),
    ThreadSnapshot,
  ),
  "provider.rollback": provider(
    onSession(
      Schema.Struct({
        providerThread: ProviderThread,
        target: RollbackTarget,
        providerThreadTurns: Schema.Array(OrchestrationV2ProviderTurn),
      }),
    ),
    ThreadSnapshot,
  ),
  "provider.forkThread": provider(
    onSession(
      Schema.Struct({
        sourceProviderThread: ProviderThread,
        sourceProviderTurns: Schema.optionalKey(Schema.Array(OrchestrationV2ProviderTurn)),
        providerTurnId: Schema.optionalKey(ProviderTurnId),
        targetThreadId: ThreadId,
        ownerNodeId: Schema.optionalKey(NodeId),
        modelSelection: Schema.optionalKey(ModelSelection),
        runtimePolicy: Schema.optionalKey(RuntimePolicy),
      }),
    ),
    ProviderThread,
  ),
  "provider.injectHistory": provider(
    onSession(
      Schema.Struct({
        messages: Schema.Array(OrchestrationV2HistoricalMessage),
        context: Schema.String,
        providerThread: ProviderThread,
      }),
    ),
    Schema.Boolean,
  ),
  "provider.stopTask": provider(
    onSession(Schema.Struct({ providerThread: ProviderThread, taskId: Schema.String })),
    Schema.Void,
  ),
  "provider.unloadThread": provider(
    onSession(Schema.Struct({ providerThread: ProviderThread })),
    Schema.Void,
  ),
  "provider.hasPendingBackgroundWork": provider(onSession(Empty), Schema.Boolean),
  "provider.detach": provider(onSession(Empty), Schema.Void),
  "checkpoint.isGitRepository": checkpoint(Schema.Struct({ cwd: Schema.String }), Schema.Boolean),
  "checkpoint.hasRef": checkpoint(
    Schema.Struct({ cwd: Schema.String, checkpointRef: CheckpointRef }),
    Schema.Boolean,
  ),
  "checkpoint.capture": checkpoint(
    Schema.Struct({ cwd: Schema.String, checkpointRef: CheckpointRef }),
    Schema.Void,
  ),
  "checkpoint.restore": checkpoint(
    Schema.Struct({
      cwd: Schema.String,
      checkpointRef: CheckpointRef,
      fallbackToHead: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Boolean,
  ),
  "checkpoint.diff": checkpoint(DiffInput, Schema.String),
  "checkpoint.listAuthoredPaths": checkpoint(
    Schema.Struct({
      cwd: Schema.String,
      fromCheckpointRef: CheckpointRef,
      toCheckpointRef: CheckpointRef,
    }),
    Schema.NullOr(Schema.Array(Schema.String)),
  ),
  "checkpoint.deleteRefs": checkpoint(
    Schema.Struct({ cwd: Schema.String, checkpointRefs: Schema.Array(CheckpointRef) }),
    Schema.Void,
  ),
  "checkpoint.push": checkpoint(HubRepositoryTransfer, Schema.Void),
  "checkpoint.fetch": checkpoint(HubRepositoryTransfer, Schema.Void),
} as const;

export type RemoteOperation = keyof typeof REMOTE_OPERATIONS;
export type RemoteInput<O extends RemoteOperation> = (typeof REMOTE_OPERATIONS)[O]["input"]["Type"];
export type RemoteOutput<O extends RemoteOperation> =
  (typeof REMOTE_OPERATIONS)[O]["output"]["Type"];
export type RemoteError<O extends RemoteOperation> = (typeof REMOTE_OPERATIONS)[O]["error"]["Type"];

export const isRemoteOperation = (method: string): method is RemoteOperation =>
  Object.hasOwn(REMOTE_OPERATIONS, method);

/** The provider event a session streams, in its JSON codec. */
export const ProviderEventJson = Schema.toCodecJson(ProviderAdapter.ProviderAdapterV2Event);
