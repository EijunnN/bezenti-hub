/**
 * The Hub's executors for joined Environments, registered while each socket is open. Sessions
 * outlive a dropped socket: a reconnect resends what the Hub did not acknowledge, and the Hub
 * drops what it already has. See docs/internals/overview.md, «Environment executors».
 */
import {
  CheckpointRef,
  type ChatAttachment,
  ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  ENVIRONMENT_EXECUTOR_FRAME_METHODS,
  EnvironmentAttachmentReadRequest,
  EnvironmentExecutorProviderEvent,
  EnvironmentExecutorSessionEnded,
  EnvironmentExecutorUnavailableError,
  type EnvironmentHeartbeatFrame,
  EnvironmentSessionLostError,
  EnvironmentWorkspaceStreamEnd,
  EnvironmentWorkspaceStreamItem,
  type EnvironmentHelloFrame,
  type EnvironmentId,
  type EnvironmentOrchestrationCapabilities,
  type EnvironmentProviderSummary,
  type PreviewEvent,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  TextGenerationError,
  ThreadId,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import type { CheckpointStoreError } from "../checkpointing/Errors.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import type * as HubRepository from "../checkpointing/HubRepository.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import {
  boundSpaceOf,
  SandboxSpaceMismatchError,
  SpaceCheckUnavailableError,
} from "../sandboxes/sandboxSpace.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as EnvironmentDemand from "./EnvironmentDemand.ts";
import * as EnvironmentExecutor from "./EnvironmentExecutor.ts";
import type * as MovedWorkspace from "./MovedWorkspace.ts";
import {
  type ExecutorCallResult,
  makeExecutorChannel,
  type ExecutorChannel,
} from "./ExecutorChannel.ts";
import * as ProjectCheckouts from "./ProjectCheckouts.ts";
import * as ScratchWorkspace from "./ScratchWorkspace.ts";
import {
  ProviderEventJson,
  REMOTE_OPERATIONS,
  REMOTE_STREAM_ITEMS,
  type RemoteOperation,
  type RemoteStreamOperation,
  type WireAttachmentRef,
  type WireCheckout,
  type WireSessionFeatures,
} from "./RemoteExecutorWire.ts";

/** How long a call made for an effect waits for a dropped Environment before giving up. */
const RECONNECT_WAIT = "30 seconds";
/** Resends of one keyed call across reconnects; the machine answers each from its memory. */
const MAX_RESENDS = 3;
/** Lookups of a Thread's Active environment before an event is left for the next resend. */
const ACTIVE_LOOKUP_RETRIES = 3;
/** Items of one forwarded stream the Hub holds for a reader that has not taken them. */
const MAX_STREAM_BACKLOG = 4_096;
/**
 * A proxied preview's items are body chunks of up to 64 KiB, so it holds fewer: 32 MiB of a
 * response, or 64 MiB of a WebSocket's messages, behind a reader that has not taken them.
 */
const STREAM_BACKLOG: Partial<Record<RemoteStreamOperation, number>> = {
  "preview.proxyHttp": 512,
  "preview.proxySocket": 1_024,
};

type SessionQueue = Queue.Queue<
  ProviderAdapter.ProviderAdapterV2Event,
  ProviderAdapter.ProviderAdapterV2Error | Cause.Done
>;

interface AttachmentGrant {
  readonly attachment: ChatAttachment;
  readonly sha256: string;
}

interface SessionSink {
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind;
  readonly queue: SessionQueue;
  /** The highest `seq` delivered; a resent event at or below it is a duplicate. */
  lastSeq: number;
  /**
   * Set when an event could not be decided (its Thread could not be read): this and later events
   * are left unacknowledged, so the machine resends them in order after the next reconnect.
   */
  stalled: boolean;
  /** Attachments this session's turns carry, by id; they go with the session. */
  readonly grants: Map<string, AttachmentGrant>;
  /** Its turns started and not yet ended, by run ordinal, as the Sandboxes are told. */
  readonly turns: Set<number>;
}

interface Link {
  readonly environmentId: EnvironmentId;
  channel: ExecutorChannel | undefined;
  /** Resolves when the next socket attaches; replaced each time one does. */
  attached: Deferred.Deferred<void>;
  workspaceRoot: string;
  providers: ReadonlyArray<EnvironmentProviderSummary>;
  readonly sessions: Map<string, SessionSink>;
  readonly pendingAcks: Map<string, number>;
  /** Each Thread's Active environment as last read; `threadMoved` forgets it. */
  readonly activeByThread: Map<ThreadId, EnvironmentId | null>;
  /** Open workspace streams (terminal output), by subscription id; each lives on one socket. */
  readonly streams: Map<string, WorkspaceStream>;
  /** The executor contract the machine said it runs in its last hello. */
  contractVersion: number;
}

interface WorkspaceStream {
  readonly operation: RemoteStreamOperation;
  readonly channel: ExecutorChannel;
  readonly queue: Queue.Queue<unknown, unknown>;
}

export interface RemoteConnection {
  /** Handles a request, response or event frame; false for any other frame. */
  readonly receive: (frame: unknown) => Effect.Effect<boolean>;
  readonly heartbeat: (frame: EnvironmentHeartbeatFrame) => Effect.Effect<void>;
  /** Acknowledges, in one frame, every event received since the last flush. */
  readonly flushAcks: Effect.Effect<void>;
}

export class RemoteEnvironments extends Context.Service<
  RemoteEnvironments,
  {
    /**
     * A welcomed socket: the Environment's executor is live until the scope closes. With
     * `retire`, closing also ends its provider sessions (it was removed and will not return).
     */
    readonly connect: (input: {
      readonly environmentId: EnvironmentId;
      readonly hello: EnvironmentHelloFrame;
      readonly write: (text: string) => Effect.Effect<void>;
    }) => Effect.Effect<
      RemoteConnection & { readonly retireOnClose: Effect.Effect<void> },
      never,
      Scope.Scope
    >;
    /** A Thread changed Environments: events and attachment reads are checked anew. */
    readonly threadMoved: (threadId: ThreadId) => Effect.Effect<void>;
    /**
     * The Environment was removed: its sessions end (their turns interrupted) even if it was
     * offline, since it will not come back to report them.
     */
    readonly environmentRemoved: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /**
     * The Hub stopped a Sandbox for its disk, or the Owner stopped it: its sessions end now, their
     * turns interrupted with that reason, rather than paused for a return it will not make by
     * itself.
     */
    readonly sandboxSessionsEnded: (
      environmentId: EnvironmentId,
      reason: "sandbox-disk-full" | "sandbox-stopped",
    ) => Effect.Effect<void>;
    /**
     * The Thread leaves a machine that is away while its turn is paused there: the Thread's
     * sessions on it end here (the turn is interrupted) and the machine drops them on return.
     */
    readonly abandonSessions: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<void>;
    /**
     * Forgets the machine's sessions without ending them, as a Hub restart does: their turns stay
     * unfinished until something on the Hub ends them. For tests of that state.
     */
    readonly forgetSessions: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /**
     * Lets a machine a Thread moved away from create exactly `ref` (one push, for a short while)
     * in the Hub repository `key`: the changes it kept, when the Hub asks for them.
     */
    readonly grantRecovery: (input: {
      readonly environmentId: EnvironmentId;
      readonly key: HubRepository.HubRepositoryKey;
      readonly ref: string;
    }) => Effect.Effect<void>;
    /** The machine's grants that have not expired or been used. */
    readonly recoveryGrants: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ReadonlyArray<RecoveryGrant>>;
    /** Uses up the grant of `ref`; false when there is none. */
    readonly takeRecoveryGrant: (
      environmentId: EnvironmentId,
      ref: string,
    ) => Effect.Effect<boolean>;
    /** Every connected machine's preview events, live (each machine streams its own). */
    readonly previewEvents: Stream.Stream<PreviewEvent>;
  }
>()("t3/environment/RemoteEnvironments") {}

export interface RecoveryGrant {
  readonly key: HubRepository.HubRepositoryKey;
  readonly ref: string;
  readonly expiresAt: number;
}

/** How long a machine has to push the changes the Hub asked it for. */
const RECOVERY_GRANT_MS = 5 * 60_000;

const codec = (schema: Schema.Top) => Schema.toCodecJson(schema as Schema.Codec<unknown, unknown>);
const encodeJson = (schema: Schema.Top, value: unknown) =>
  Schema.encodeUnknownEffect(codec(schema))(value);
const decodeJson = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownEffect(codec(schema))(value);
const decodeEvent = Schema.decodeUnknownOption(ProviderEventJson);
const decodeProviderEvent = Schema.decodeUnknownOption(EnvironmentExecutorProviderEvent);
const decodeSessionEnded = Schema.decodeUnknownOption(EnvironmentExecutorSessionEnded);
const decodeAttachmentRead = Schema.decodeUnknownOption(EnvironmentAttachmentReadRequest);
const decodeStreamItem = Schema.decodeUnknownOption(EnvironmentWorkspaceStreamItem);
/** Whether a machine's failure is the operation's own error, by operation. */
const isOperationError = Object.fromEntries(
  Object.entries(REMOTE_OPERATIONS).map(([operation, spec]) => [operation, Schema.is(spec.error)]),
) as unknown as Record<RemoteOperation, (value: unknown) => boolean>;
const decodeStreamEnd = Schema.decodeUnknownOption(EnvironmentWorkspaceStreamEnd);

/** Drops keys set to `undefined`, which an optional key's codec does not accept. */
const definedOnly = <A extends object>(value: A): A =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as A;

type CallOutcome =
  | { readonly _tag: "ok"; readonly value: unknown }
  | { readonly _tag: "failed"; readonly error: unknown }
  | { readonly _tag: "unavailable" };

const make = Effect.gen(function* () {
  const registry = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
  const cache = yield* EnvironmentExecutor.EnvironmentCapabilityCache;
  const checkouts = yield* ProjectCheckouts.ProjectCheckouts;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const digester = yield* Digest.Digest;
  // Without git processes (orchestration-only hosts) a missing checkout is not cloned.
  const vcs = yield* Effect.serviceOption(VcsProcess.VcsProcess);
  // A Sandbox is told which turns run on it, so an image update never cuts one short.
  const demand = yield* Effect.serviceOption(EnvironmentDemand.EnvironmentDemand);
  const turnKey = (providerSessionId: string, runOrdinal: number) =>
    `${providerSessionId}:${runOrdinal}`;
  const turnStarted = (link: Link, providerSessionId: string, sink: SessionSink, run: number) =>
    Effect.suspend(() => {
      sink.turns.add(run);
      return Option.isNone(demand)
        ? Effect.void
        : demand.value.turnStarted(link.environmentId, turnKey(providerSessionId, run));
    });
  const turnEnded = (link: Link, providerSessionId: string, sink: SessionSink, run: number) =>
    Effect.suspend(() => {
      sink.turns.delete(run);
      return Option.isNone(demand)
        ? Effect.void
        : demand.value.turnEnded(link.environmentId, turnKey(providerSessionId, run));
    });
  const sessionTurnsEnded = (link: Link, providerSessionId: string, sink: SessionSink) =>
    Effect.forEach([...sink.turns], (run) => turnEnded(link, providerSessionId, sink, run), {
      discard: true,
    });
  const sql = yield* SqlClient.SqlClient;
  const filePath = yield* Path.Path;
  const links = new Map<EnvironmentId, Link>();
  const grants = new Map<EnvironmentId, ReadonlyArray<RecoveryGrant>>();
  let streamCount = 0;
  const previewEvents = yield* PubSub.unbounded<PreviewEvent>();

  /**
   * A Sandbox, and a machine dedicated to a Space, runs only its own Space's Threads: one whose
   * Project moved to another Space since it was placed (or a machine dedicated elsewhere since)
   * starts nothing new there (spec 3, until ticket 12 moves such Threads).
   */
  const requireSandboxSpace = Effect.fn("RemoteEnvironments.requireSandboxSpace")(function* (
    link: Link,
    driver: ProviderDriverKind,
    threadId: ThreadId,
  ) {
    // Fails closed: a Space the Hub could not read refuses the turn, retryably.
    const refuse = (cause: SpaceCheckUnavailableError) =>
      new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail: cause.message, cause });
    const sandboxSpace = yield* boundSpaceOf(link.environmentId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(refuse),
    );
    if (sandboxSpace === undefined) return;
    const [row] = yield* sql<{ readonly spaceId: string | null }>`
      SELECT COALESCE(t.space_id, p.space_id,
        'personal:' || (SELECT user_id FROM users WHERE is_owner = 1)) AS "spaceId"
      FROM orchestration_v2_projection_threads t
      LEFT JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.thread_id = ${threadId}
    `.pipe(
      Effect.mapError((cause) =>
        refuse(new SpaceCheckUnavailableError({ environmentId: link.environmentId, cause })),
      ),
    );
    if (row?.spaceId === sandboxSpace) return;
    const mismatch = new SandboxSpaceMismatchError({
      environmentId: link.environmentId,
      threadId,
    });
    return yield* new ProviderAdapter.ProviderAdapterProtocolError({
      driver,
      detail: mismatch.message,
      cause: mismatch,
    });
  });

  const sha256Hex = (bytes: Uint8Array) =>
    digester.digest(Digest.sha256, bytes).pipe(
      Effect.orDie,
      Effect.map((digest) => Buffer.from(digest).toString("hex")),
    );

  /**
   * One request to the Environment. A call an effect makes is resent, with the same key, on the
   * next socket when the current one drops; the machine answers it once.
   */
  const invoke = Effect.fn("RemoteEnvironments.invoke")(function* (
    link: Link,
    operation: RemoteOperation,
    input: unknown,
  ): Effect.fn.Return<CallOutcome> {
    const spec = REMOTE_OPERATIONS[operation];
    const payload = yield* encodeJson(spec.input, input).pipe(Effect.orDie);
    const idempotencyKey = yield* EnvironmentExecutor.nextIdempotencyKey(operation);
    let result: ExecutorCallResult | undefined;
    for (let resends = 0; result === undefined; resends += 1) {
      const channel = link.channel;
      if (channel !== undefined) {
        const sent = yield* channel
          .request({
            method: operation,
            payload,
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          })
          .pipe(Effect.option);
        if (Option.isSome(sent)) {
          result = sent.value;
          break;
        }
      }
      // Without a key a resend could run the call twice; with one the machine answers it once.
      if (idempotencyKey === undefined || resends >= MAX_RESENDS) return { _tag: "unavailable" };
      // A newer socket may already be in place; otherwise wait, bounded, for one.
      if (link.channel === undefined || link.channel === channel) {
        const reattached = yield* Deferred.await(link.attached).pipe(
          Effect.timeoutOption(RECONNECT_WAIT),
        );
        if (Option.isNone(reattached)) return { _tag: "unavailable" };
      }
    }
    if (result._tag === "failure") {
      const error = yield* decodeJson(spec.error, result.error).pipe(Effect.option);
      return { _tag: "failed", error: Option.getOrElse(error, () => result.error) };
    }
    const value = yield* decodeJson(spec.output, result.value).pipe(Effect.option);
    if (Option.isNone(value)) return { _tag: "failed", error: "unreadable response" };
    return { _tag: "ok", value: value.value };
  });

  const isAdapterError = Schema.is(ProviderAdapter.ProviderAdapterV2Error);

  const callProvider = <A>(
    link: Link,
    driver: ProviderDriverKind,
    operation: RemoteOperation,
    input: unknown,
  ): Effect.Effect<A, ProviderAdapter.ProviderAdapterV2Error> =>
    invoke(link, operation, input).pipe(
      Effect.flatMap((outcome) => {
        switch (outcome._tag) {
          case "ok":
            return Effect.succeed(outcome.value as A);
          case "failed":
            return Effect.fail(
              isAdapterError(outcome.error)
                ? outcome.error
                : new ProviderAdapter.ProviderAdapterProtocolError({
                    driver,
                    detail: `The Environment answered '${operation}' with an error the Hub cannot read`,
                  }),
            );
          case "unavailable":
            return Effect.fail(
              new ProviderAdapter.ProviderAdapterProtocolError({
                driver,
                detail: `Environment ${link.environmentId} is not connected`,
                cause: new EnvironmentExecutorUnavailableError({
                  environmentId: link.environmentId,
                }),
              }),
            );
        }
      }),
    );

  const callCheckpoint = <A>(
    link: Link,
    operation: RemoteOperation,
    input: unknown,
  ): Effect.Effect<A, CheckpointStoreError> =>
    invoke(link, operation, input).pipe(
      Effect.flatMap((outcome) =>
        outcome._tag === "ok"
          ? Effect.succeed(outcome.value as A)
          : outcome._tag === "failed" && typeof outcome.error === "object" && outcome.error !== null
            ? Effect.fail(outcome.error as CheckpointStoreError)
            : Effect.fail(
                new EnvironmentExecutorUnavailableError({ environmentId: link.environmentId }),
              ),
      ),
    );

  const pathsOf = (link: Link) =>
    ProjectCheckouts.environmentPaths({
      environmentId: link.environmentId,
      workspaceRoot: link.workspaceRoot,
      checkouts,
      projects,
    });

  /** The ready checkpoint refs of the Thread the Hub repository has. */
  const uploadedRefsOf = (threadId: ThreadId | undefined) =>
    threadId === undefined
      ? Effect.succeed([] as ReadonlyArray<CheckpointRef>)
      : sql<{ readonly ref: string }>`
          SELECT json_extract(payload_json, '$.ref') AS ref
          FROM orchestration_v2_projection_checkpoints
          WHERE thread_id = ${threadId} AND status = 'ready' AND uploaded_to_hub = 1
        `.pipe(
          Effect.map((rows) => rows.map((row) => CheckpointRef.make(row.ref))),
          Effect.orElseSucceed(() => [] as ReadonlyArray<CheckpointRef>),
        );

  const scratchThreads = ScratchWorkspace.makeScratchThreads({
    sql,
    path: filePath,
    baseDir: config.baseDir,
  });

  /**
   * The Project's checkout on the Environment, the Hub checkout's `origin` to clone from, and the
   * Thread's checkpoint refs the Hub repository has, which the checkout fetches if it lacks them.
   * For a Thread without a Project (`scratch`) it is the Thread's scratch workspace there, made
   * with git when missing, which fetches from the Thread's own repository.
   */
  const checkoutFor = Effect.fn("RemoteEnvironments.checkoutFor")(function* (
    link: Link,
    projectId: ProjectId,
    threadId: ThreadId | undefined,
    scratch?: { readonly threadId: ThreadId; readonly folder: string },
  ) {
    const path = yield* pathsOf(link)
      .checkout(projectId)
      .pipe(Effect.option, Effect.map(Option.flatten));
    if (Option.isNone(path)) return undefined;
    if (scratch !== undefined) {
      const folder = ScratchWorkspace.scratchFolderIn(filePath, path.value, scratch.folder);
      if (folder === null) return undefined;
      const refs = yield* uploadedRefsOf(threadId);
      return {
        path: folder,
        cloneUrl: null,
        scratch: true,
        ...(refs.length === 0
          ? {}
          : { hubRefs: { projectId, scratchThreadId: scratch.threadId, refs: [...refs] } }),
      } satisfies WireCheckout;
    }
    const project = yield* projects.get(projectId).pipe(Effect.option, Effect.map(Option.flatten));
    const cloneUrl =
      Option.isNone(project) || Option.isNone(vcs)
        ? null
        : yield* vcs.value
            .run({
              operation: "RemoteEnvironments.originUrl",
              command: "git",
              args: ["remote", "get-url", "origin"],
              cwd: project.value.workspaceRoot,
              allowNonZeroExit: true,
            })
            .pipe(
              Effect.map((output) =>
                output.exitCode === 0 && output.stdout.trim().length > 0
                  ? output.stdout.trim()
                  : null,
              ),
              Effect.orElseSucceed(() => null),
            );
    const uploaded = yield* uploadedRefsOf(threadId);
    return {
      path: path.value,
      cloneUrl,
      ...(uploaded.length === 0 ? {} : { hubRefs: { projectId, refs: [...uploaded] } }),
    } satisfies WireCheckout;
  });

  /** Hashes a turn's attachments and lets the session's machine fetch exactly those. */
  const grantAttachments = Effect.fn("RemoteEnvironments.grantAttachments")(function* (
    sink: SessionSink,
    attachments: ReadonlyArray<ChatAttachment>,
  ) {
    const refs: Array<WireAttachmentRef> = [];
    for (const attachment of attachments) {
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (path === null) continue;
      const bytes = yield* fileSystem.readFile(path).pipe(Effect.option);
      if (Option.isNone(bytes)) continue;
      const sha256 = yield* sha256Hex(bytes.value);
      sink.grants.set(attachment.id, { attachment, sha256 });
      refs.push({ id: attachment.id, sha256 });
    }
    return refs;
  });

  const makeRuntime = (
    link: Link,
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    providerSessionId: ProviderAdapter.ProviderAdapterV2SessionRuntime["providerSessionId"],
    opened: {
      readonly providerSession: ProviderAdapter.ProviderAdapterV2SessionRuntime["providerSession"];
      readonly features: WireSessionFeatures;
    },
    sink: SessionSink,
  ): ProviderAdapter.ProviderAdapterV2SessionRuntime => {
    const onSession = <A>(operation: RemoteOperation, input: object) =>
      callProvider<A>(link, driver, operation, { providerSessionId, input: definedOnly(input) });
    const { features } = opened;
    return {
      instanceId,
      driver,
      providerSessionId,
      providerSession: opened.providerSession,
      events: Stream.fromQueue(sink.queue),
      ensureThread: (input) => onSession("provider.ensureThread", input),
      resumeThread: (input) => onSession("provider.resumeThread", input),
      startTurn: (input) =>
        requireSandboxSpace(link, driver, sink.threadId).pipe(
          Effect.andThen(turnStarted(link, providerSessionId, sink, input.runOrdinal)),
          Effect.andThen(grantAttachments(sink, input.message.attachments)),
          Effect.flatMap((attachments) =>
            callProvider<void>(link, driver, "provider.startTurn", {
              providerSessionId,
              input: definedOnly(input),
              attachments,
            }),
          ),
          // A turn that never started (refused, timed out, the link dropped) never reports its end.
          Effect.onError(() => turnEnded(link, providerSessionId, sink, input.runOrdinal)),
        ),
      steerTurn: (input) =>
        grantAttachments(sink, input.message.attachments).pipe(
          Effect.flatMap((attachments) =>
            callProvider<void>(link, driver, "provider.steer", {
              providerSessionId,
              input: definedOnly(input),
              attachments,
            }),
          ),
        ),
      interruptTurn: (input) => onSession("provider.interrupt", input),
      respondToRuntimeRequest: (input) => onSession("provider.respond", input),
      readThreadSnapshot: (input) => onSession("provider.readThreadSnapshot", input),
      rollbackThread: (input) => onSession("provider.rollback", input),
      forkThread: (input) => onSession("provider.forkThread", input),
      ...(features.injectHistory
        ? { injectHistory: (input) => onSession<boolean>("provider.injectHistory", input) }
        : {}),
      ...(features.compactThread
        ? { compactThread: (input) => onSession<void>("provider.compactThread", input) }
        : {}),
      ...(features.stopTask
        ? { stopTask: (input) => onSession<void>("provider.stopTask", input) }
        : {}),
      ...(features.unloadThread
        ? { unloadThread: (input) => onSession<void>("provider.unloadThread", input) }
        : {}),
      ...(features.hasPendingBackgroundWork
        ? {
            hasPendingBackgroundWork: onSession<boolean>(
              "provider.hasPendingBackgroundWork",
              {},
            ).pipe(Effect.orElseSucceed(() => false)),
          }
        : {}),
      ...(features.backgroundTasksEndWithProcess ? { backgroundTasksEndWithProcess: true } : {}),
    } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
  };

  const makeAdapter = (
    link: Link,
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
  ): ProviderAdapter.ProviderAdapterV2["Service"] => ({
    instanceId,
    driver,
    getCapabilities: () =>
      cache.snapshotProvider(link.environmentId, instanceId).pipe(
        Effect.map((snapshot) => snapshot.capabilities),
        Effect.mapError(
          (cause) => new ProviderAdapter.ProviderAdapterCapabilitiesError({ driver, cause }),
        ),
      ),
    // Deciding makes no network call: a model change that may need a new session restarts it.
    planSelectionTransition: () => Effect.succeed({ type: "restart_session" }),
    openSession: Effect.fn("RemoteEnvironments.openSession")(function* (input) {
      yield* requireSandboxSpace(link, driver, input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      const thread = yield* projections.getThread(input.threadId).pipe(Effect.option);
      const checkout = Option.isNone(thread)
        ? undefined
        : yield* checkoutFor(
            link,
            thread.value.projectId,
            input.threadId,
            yield* scratchThreads.scratchWorkspaceOf(input.threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
              ),
            ),
          );
      const mcp = yield* mcpSessions.read(input.threadId);
      const sink: SessionSink = {
        threadId: input.threadId,
        driver,
        queue: yield* Queue.unbounded<
          ProviderAdapter.ProviderAdapterV2Event,
          ProviderAdapter.ProviderAdapterV2Error | Cause.Done
        >(),
        lastSeq: 0,
        stalled: false,
        grants: new Map(),
        turns: new Set(),
      };
      // Before the call: the Environment may stream events ahead of its answer.
      link.sessions.set(input.providerSessionId, sink);
      const forget = Effect.sync(() => {
        if (link.sessions.get(input.providerSessionId) === sink) {
          link.sessions.delete(input.providerSessionId);
        }
      }).pipe(
        Effect.andThen(sessionTurnsEnded(link, input.providerSessionId, sink)),
        Effect.andThen(Queue.end(sink.queue)),
      );
      const opened = yield* callProvider<{
        readonly providerSession: ProviderAdapter.ProviderAdapterV2SessionRuntime["providerSession"];
        readonly features: WireSessionFeatures;
      }>(
        link,
        driver,
        "provider.openSession",
        definedOnly({
          ...input,
          instanceId,
          ...(mcp === undefined
            ? {}
            : {
                mcp: {
                  credentialId: mcp.providerSessionId,
                  authorizationHeader: mcp.authorizationHeader,
                  browserToolsAvailable: mcp.browserToolsAvailable,
                  capabilities: [...(mcp.capabilities ?? [])],
                },
              }),
          ...(checkout === undefined ? {} : { checkout }),
        }),
      ).pipe(
        Effect.onError(() => forget),
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      yield* Effect.addFinalizer(() =>
        callProvider<void>(link, driver, "provider.detach", {
          providerSessionId: input.providerSessionId,
          input: {},
        }).pipe(Effect.ignore, Effect.andThen(forget)),
      );
      return makeRuntime(link, driver, instanceId, input.providerSessionId, opened, sink);
    }),
  });

  const offline = (link: Link) =>
    new EnvironmentExecutorUnavailableError({ environmentId: link.environmentId });

  /** A workspace call: the machine's own error as it sent it, or offline at once (never queued). */
  const forwardCall = (link: Link) =>
    ((operation: RemoteOperation, input: unknown) =>
      invoke(link, operation, input).pipe(
        Effect.flatMap((outcome) => {
          switch (outcome._tag) {
            case "ok":
              return Effect.succeed(outcome.value);
            case "unavailable":
              return Effect.fail(offline(link));
            case "failed":
              return isOperationError[operation](outcome.error)
                ? Effect.fail(outcome.error as EnvironmentExecutorUnavailableError)
                : Effect.die(
                    new Error(`Environment ${link.environmentId} failed '${operation}'`, {
                      cause: outcome.error,
                    }),
                  );
          }
        }),
      )) as EnvironmentExecutor.EnvironmentWorkspaceForward["call"];

  /**
   * A stream the machine feeds with `workspace.stream` frames. It is live only: when its socket
   * drops it fails as offline, and when nobody reads it any more the machine is told to stop.
   */
  const forwardStream = (link: Link) =>
    ((operation: RemoteStreamOperation, input: object) =>
      Stream.callback<unknown, unknown>((queue) =>
        Effect.gen(function* () {
          const channel = link.channel;
          if (channel === undefined) return yield* Queue.fail(queue, offline(link));
          streamCount += 1;
          const subscriptionId = `${operation}:${streamCount}`;
          link.streams.set(subscriptionId, { operation, channel, queue });
          yield* Effect.addFinalizer(() =>
            Effect.suspend(() => {
              if (link.streams.get(subscriptionId)?.queue !== queue) return Effect.void;
              link.streams.delete(subscriptionId);
              return channel.event(ENVIRONMENT_EXECUTOR_FRAME_METHODS.workspaceStreamCancel, {
                subscriptionId,
              });
            }),
          );
          const opened = yield* Effect.exit(
            forwardCall(link)(operation, { ...input, subscriptionId } as never),
          );
          if (opened._tag === "Failure") {
            const error = Cause.findErrorOption(opened.cause);
            yield* Option.isSome(error)
              ? Queue.fail(queue, error.value)
              : Queue.failCause(queue, opened.cause);
          }
        }),
      )) as unknown as EnvironmentExecutor.EnvironmentWorkspaceForward["stream"];

  // Per streamed item (terminal output): too frequent for a span each.
  const onStreamItem = Effect.fnUntraced(function* (link: Link, payload: unknown) {
    const decoded = decodeStreamItem(payload);
    if (Option.isNone(decoded)) return;
    const stream = link.streams.get(decoded.value.subscriptionId);
    if (stream === undefined) return;
    const item = yield* decodeJson(REMOTE_STREAM_ITEMS[stream.operation], decoded.value.item).pipe(
      Effect.option,
    );
    if (Option.isNone(item)) return;
    // Bounded: a reader that falls this far behind loses the stream and opens it again (a
    // terminal reattaches from its snapshot), so a slow client never holds the machine's socket.
    const backlog = STREAM_BACKLOG[stream.operation];
    if ((yield* Queue.size(stream.queue)) >= (backlog ?? MAX_STREAM_BACKLOG)) {
      link.streams.delete(decoded.value.subscriptionId);
      yield* stream.channel.event(ENVIRONMENT_EXECUTOR_FRAME_METHODS.workspaceStreamCancel, {
        subscriptionId: decoded.value.subscriptionId,
      });
      // A proxied response cut short must read as broken, never as a complete shorter one.
      return yield* backlog === undefined
        ? Queue.end(stream.queue)
        : Queue.fail(stream.queue, offline(link));
    }
    yield* Queue.offer(stream.queue, item.value);
  });

  const onStreamEnd = Effect.fn("RemoteEnvironments.onStreamEnd")(function* (
    link: Link,
    payload: unknown,
  ) {
    const decoded = decodeStreamEnd(payload);
    if (Option.isNone(decoded)) return;
    const stream = link.streams.get(decoded.value.subscriptionId);
    if (stream === undefined) return;
    link.streams.delete(decoded.value.subscriptionId);
    if (decoded.value.error === undefined) return yield* Queue.end(stream.queue);
    const error = yield* decodeJson(
      REMOTE_OPERATIONS[stream.operation].error,
      decoded.value.error,
    ).pipe(Effect.option);
    yield* Queue.fail(
      stream.queue,
      Option.getOrElse(error, () => offline(link)),
    );
  });

  /** The streams that ran on a socket that closed end as offline; the client opens them again. */
  const endStreamsOf = (link: Link, channel: ExecutorChannel) =>
    Effect.forEach(
      [...link.streams.entries()].filter(([, stream]) => stream.channel === channel),
      ([subscriptionId, stream]) => {
        link.streams.delete(subscriptionId);
        return Queue.fail(stream.queue, offline(link));
      },
      { discard: true },
    );

  const makeExecutor = (link: Link): EnvironmentExecutor.EnvironmentExecutor => {
    const providerOf = (instanceId: ProviderInstanceId) =>
      link.providers.find((provider) => provider.instanceId === instanceId);
    const adapters: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape = {
      get: (instanceId) => {
        const provider = providerOf(instanceId);
        return provider === undefined
          ? Effect.fail(
              new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
            )
          : Effect.succeed(makeAdapter(link, instanceId, provider.provider));
      },
      list: () => Effect.sync(() => link.providers.map((provider) => provider.instanceId)),
    };
    const paths: ProjectCheckouts.EnvironmentWorkspacePaths = {
      checkout: (projectId) => pathsOf(link).checkout(projectId),
      resolve: (input) => pathsOf(link).resolve(input),
    };
    const checkpoints = CheckpointStore.CheckpointStore.of({
      isGitRepository: Effect.fn("RemoteEnvironments.checkpoints.isGitRepository")((cwd) =>
        callCheckpoint<boolean>(link, "checkpoint.isGitRepository", { cwd }),
      ),
      captureCheckpoint: Effect.fn("RemoteEnvironments.checkpoints.capture")((input) =>
        callCheckpoint<void>(link, "checkpoint.capture", definedOnly(input)),
      ),
      hasCheckpointRef: Effect.fn("RemoteEnvironments.checkpoints.hasRef")((input) =>
        callCheckpoint<boolean>(link, "checkpoint.hasRef", definedOnly(input)),
      ),
      restoreCheckpoint: Effect.fn("RemoteEnvironments.checkpoints.restore")((input) =>
        callCheckpoint<boolean>(link, "checkpoint.restore", definedOnly(input)),
      ),
      diffCheckpoints: Effect.fn("RemoteEnvironments.checkpoints.diff")((input) =>
        callCheckpoint<string>(link, "checkpoint.diff", definedOnly(input)),
      ),
      listAuthoredPaths: Effect.fn("RemoteEnvironments.checkpoints.listAuthoredPaths")((input) =>
        callCheckpoint<ReadonlyArray<string> | null>(
          link,
          "checkpoint.listAuthoredPaths",
          definedOnly(input),
        ).pipe(Effect.map((paths) => (paths === null ? null : new Set(paths)))),
      ),
      deleteCheckpointRefs: Effect.fn("RemoteEnvironments.checkpoints.deleteRefs")((input) =>
        callCheckpoint<void>(link, "checkpoint.deleteRefs", definedOnly(input)),
      ),
    });
    const hubRepository: EnvironmentExecutor.EnvironmentHubRepository = {
      push: Effect.fn("RemoteEnvironments.hubRepository.push")((input) =>
        callCheckpoint<void>(link, "checkpoint.push", input),
      ),
      fetch: Effect.fn("RemoteEnvironments.hubRepository.fetch")((input) =>
        callCheckpoint<void>(link, "checkpoint.fetch", input),
      ),
      ensureScratch: Effect.fn("RemoteEnvironments.hubRepository.ensureScratch")((folder) =>
        callCheckpoint<void>(link, "checkpoint.ensureScratch", { folder }),
      ),
    };
    const move: EnvironmentExecutor.EnvironmentMoveWorkspace = {
      publishScratch: Effect.fn("RemoteEnvironments.move.publishScratch")((input) =>
        callCheckpoint<MovedWorkspace.MovePublishScratchResult>(link, "move.publishScratch", input),
      ),
      fetch: Effect.fn("RemoteEnvironments.move.fetch")(function* (input) {
        const checkout = yield* checkoutFor(link, input.projectId, undefined, input.scratch);
        if (checkout === undefined) {
          return yield* new VcsUnsupportedOperationError({
            operation: "RemoteEnvironments.move.fetch",
            kind: "git",
            detail: `Project ${input.projectId} has no checkout on this machine.`,
          });
        }
        return yield* callCheckpoint<MovedWorkspace.MoveFetchResult>(link, "move.fetch", {
          checkout,
          projectId: input.projectId,
          ...(input.scratch === undefined ? {} : { scratchThreadId: input.scratch.threadId }),
          ...(input.scratch?.history === undefined
            ? {}
            : { scratchHistory: input.scratch.history }),
          refs: input.refs,
        });
      }),
      prepare: Effect.fn("RemoteEnvironments.move.prepare")((input) =>
        callCheckpoint<MovedWorkspace.MovePrepareResult>(link, "move.prepare", input),
      ),
      recover: Effect.fn("RemoteEnvironments.move.recover")((input) =>
        callCheckpoint<MovedWorkspace.MoveRecoverResult>(link, "move.recover", input),
      ),
    };
    // The machine's own text generation; a failure it could not name is reported as one.
    const textGeneration: EnvironmentExecutor.EnvironmentTextGeneration = {
      threadHandoff: Effect.fn("RemoteEnvironments.textGeneration.threadHandoff")(
        function* (input) {
          const outcome = yield* invoke(link, "textGeneration.threadHandoff", input).pipe(
            // The Hub gave up (a timeout): the machine stops the generation instead of paying on.
            Effect.onInterrupt(() =>
              input.generationId === undefined || link.channel === undefined
                ? Effect.void
                : link.channel.event(ENVIRONMENT_EXECUTOR_FRAME_METHODS.textGenerationCancel, {
                    generationId: input.generationId,
                  }),
            ),
          );
          switch (outcome._tag) {
            case "ok":
              return outcome.value as {
                readonly summary: string;
                readonly providerInstanceId?: string;
              };
            case "unavailable":
              return yield* offline(link);
            case "failed":
              return yield* isOperationError["textGeneration.threadHandoff"](outcome.error)
                ? Effect.fail(
                    outcome.error as TextGenerationError | EnvironmentExecutorUnavailableError,
                  )
                : Effect.fail(
                    new TextGenerationError({
                      operation: "generateThreadHandoff",
                      detail:
                        typeof outcome.error === "string"
                          ? outcome.error.slice(0, 500)
                          : "The machine could not write the summary.",
                    }),
                  );
          }
        },
      ),
      threadTitle: Effect.fn("RemoteEnvironments.textGeneration.threadTitle")(function* (input) {
        const outcome = yield* invoke(link, "textGeneration.threadTitle", input);
        switch (outcome._tag) {
          case "ok":
            return outcome.value as { readonly title: string };
          case "unavailable":
            return yield* offline(link);
          case "failed":
            return yield* isOperationError["textGeneration.threadTitle"](outcome.error)
              ? Effect.fail(
                  outcome.error as TextGenerationError | EnvironmentExecutorUnavailableError,
                )
              : Effect.fail(
                  new TextGenerationError({
                    operation: "generateThreadTitle",
                    detail:
                      typeof outcome.error === "string"
                        ? outcome.error.slice(0, 500)
                        : "The machine could not write the title.",
                  }),
                );
        }
      }),
    };
    // Resolved on the Hub from what the Environment reported: the Orchestrator asks while deciding.
    const runtimePolicy: RuntimePolicy.RuntimePolicyV2Shape = {
      resolve: Effect.fn("RemoteEnvironments.runtimePolicy.resolve")(function* (input) {
        const cwd =
          input.thread.worktreePath ??
          Option.getOrNull(
            yield* paths.checkout(input.thread.projectId).pipe(
              Effect.mapError(
                (cause) =>
                  new RuntimePolicy.RuntimePolicyResolveError({
                    projectId: input.thread.projectId,
                    providerInstanceId: input.modelSelection.instanceId,
                    cause,
                  }),
              ),
            ),
          );
        if (cwd === null) {
          return yield* new RuntimePolicy.RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause: "Project not found.",
          });
        }
        const modes = providerOf(input.modelSelection.instanceId)?.capabilities.runtimeModes ?? [];
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode:
            modes.length === 0 || modes.includes(input.thread.runtimeMode)
              ? input.thread.runtimeMode
              : "approval-required",
          interactionMode: input.thread.interactionMode,
          cwd,
        });
      }),
    };
    return {
      environmentId: link.environmentId,
      transport: "remote",
      provider: {
        adapters,
        capabilities: (instanceId) => cache.snapshotProvider(link.environmentId, instanceId),
      },
      workspace: {
        paths,
        checkpoints,
        hubRepository,
        move,
        runtimePolicy,
        rpc: Option.none(),
        forward: Option.some({
          contractVersion: () => link.contractVersion,
          call: forwardCall(link),
          stream: forwardStream(link),
        }),
      },
      textGeneration,
      host: {
        describe: cache.snapshot(link.environmentId).pipe(
          Effect.flatMap(
            Option.match({
              onSome: Effect.succeed,
              onNone: () =>
                DateTime.now.pipe(
                  Effect.map((now) => ({
                    contractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
                    environmentId: link.environmentId,
                    transport: "remote" as const,
                    providers: [],
                    unavailableProviders: [],
                    observedAt: DateTime.formatIso(now),
                  })),
                ),
            }),
          ),
        ),
      },
    };
  };

  const publishCapabilities = Effect.fn("RemoteEnvironments.publishCapabilities")(function* (
    link: Link,
    orchestration: EnvironmentOrchestrationCapabilities,
    hostResources: EnvironmentHelloFrame["hostResources"],
    disk: EnvironmentHelloFrame["disk"],
  ) {
    yield* cache.publish({
      contractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
      environmentId: link.environmentId,
      transport: "remote",
      providers: orchestration.providers,
      unavailableProviders: orchestration.unavailableProviders,
      resources: { hostResources, disk },
      observedAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

  /** Acknowledged up to `seq`, never backwards. */
  const ack = (link: Link, providerSessionId: string, seq: number | undefined) => {
    if (seq === undefined) return;
    link.pendingAcks.set(
      providerSessionId,
      Math.max(link.pendingAcks.get(providerSessionId) ?? 0, seq),
    );
  };

  /**
   * The Thread's Active environment: Some(null) when it has none or is gone, None when it could
   * not be read (nothing is decided on a guess).
   */
  const activeFor = Effect.fn("RemoteEnvironments.activeFor")(function* (
    link: Link,
    threadId: ThreadId,
  ) {
    if (link.activeByThread.has(threadId)) {
      return Option.some(link.activeByThread.get(threadId) ?? null);
    }
    // The projection's column, which a move updates; a Thread not there has no Environment.
    const read = yield* sql<{ readonly environmentId: string | null }>`
      SELECT active_environment_id AS "environmentId"
      FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows): EnvironmentId | null => {
        const environmentId = rows[0]?.environmentId;
        return environmentId === undefined || environmentId === null
          ? null
          : (environmentId as EnvironmentId);
      }),
      Effect.retry({ times: ACTIVE_LOOKUP_RETRIES }),
      Effect.option,
    );
    if (Option.isSome(read)) link.activeByThread.set(threadId, read.value);
    return read;
  });

  /**
   * Whether a framed session event may go on: false (acknowledged unless undecided) when it is a
   * duplicate, for a retired session, or from a machine the Thread no longer runs on.
   */
  const admit = Effect.fn("RemoteEnvironments.admit")(function* (
    link: Link,
    providerSessionId: string,
    seq: number | undefined,
  ) {
    const sink = link.sessions.get(providerSessionId);
    if (sink === undefined) {
      ack(link, providerSessionId, seq);
      yield* Effect.logWarning("Rejected an event for a provider session the Hub retired", {
        environmentId: link.environmentId,
        providerSessionId,
      });
      return undefined;
    }
    if (sink.stalled) return undefined;
    if (seq !== undefined && seq <= sink.lastSeq) {
      ack(link, providerSessionId, seq);
      return undefined;
    }
    const active = yield* activeFor(link, sink.threadId);
    if (Option.isNone(active)) {
      sink.stalled = true;
      yield* Effect.logWarning(
        "Left an Environment's event for its resend: its Thread is unreadable",
        {
          environmentId: link.environmentId,
          threadId: sink.threadId,
        },
      );
      return undefined;
    }
    if (active.value !== link.environmentId) {
      ack(link, providerSessionId, seq);
      yield* Effect.logWarning(
        "Rejected an event from an Environment that is not the Thread's Active environment",
        {
          environmentId: link.environmentId,
          activeEnvironmentId: active.value,
          threadId: sink.threadId,
        },
      );
      return undefined;
    }
    return sink;
  });

  // Per streamed event: too frequent for a span each.
  /** An event the Environment streamed: kept once, in order, and only from the Thread's machine. */
  const onProviderEvent = Effect.fnUntraced(function* (link: Link, payload: unknown) {
    const decoded = decodeProviderEvent(payload);
    if (Option.isNone(decoded)) {
      return yield* Effect.logWarning("Rejected an unreadable provider event from an Environment", {
        environmentId: link.environmentId,
      });
    }
    const { providerSessionId, seq, event } = decoded.value;
    const sink = yield* admit(link, providerSessionId, seq);
    if (sink === undefined) return;
    const parsed = decodeEvent(event);
    if (Option.isNone(parsed)) {
      ack(link, providerSessionId, seq);
      return yield* Effect.logWarning("Rejected an unreadable provider event from an Environment", {
        environmentId: link.environmentId,
        providerSessionId,
      });
    }
    if (seq !== undefined) sink.lastSeq = seq;
    if (parsed.value.type === "turn.terminal") {
      yield* turnEnded(link, providerSessionId, sink, parsed.value.runOrdinal);
    }
    yield* Queue.offer(sink.queue, parsed.value);
    ack(link, providerSessionId, seq);
  });

  const onSessionEnded = Effect.fn("RemoteEnvironments.onSessionEnded")(function* (
    link: Link,
    payload: unknown,
  ) {
    const decoded = decodeSessionEnded(payload);
    if (Option.isNone(decoded)) return;
    const sink = yield* admit(link, decoded.value.providerSessionId, decoded.value.seq);
    if (sink === undefined) return;
    link.sessions.delete(decoded.value.providerSessionId);
    yield* sessionTurnsEnded(link, decoded.value.providerSessionId, sink);
    ack(link, decoded.value.providerSessionId, decoded.value.seq);
    if (decoded.value.error === undefined) return yield* Queue.end(sink.queue);
    const error = yield* decodeJson(
      ProviderAdapter.ProviderAdapterV2Error,
      decoded.value.error,
    ).pipe(Effect.option);
    yield* Queue.fail(
      sink.queue,
      Option.getOrElse(
        error as Option.Option<ProviderAdapter.ProviderAdapterV2Error>,
        () =>
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: sink.driver,
            providerSessionId: decoded.value.providerSessionId,
            cause: "The provider session failed on its Environment.",
          }),
      ),
    );
  });

  /**
   * `attachment.read`: only an attachment a live session's turn on this machine carries, by its
   * hash, while the Thread still runs here.
   */
  const onAttachmentRead = Effect.fn("RemoteEnvironments.onAttachmentRead")(function* (
    link: Link,
    payload: unknown,
  ): Effect.fn.Return<ExecutorCallResult> {
    const refused = {
      _tag: "failure",
      error: "This attachment is not available to this Environment.",
    } as const;
    const decoded = decodeAttachmentRead(payload);
    if (Option.isNone(decoded)) return refused;
    const { threadId, attachmentId, sha256 } = decoded.value;
    const grant = [...link.sessions.values()]
      .filter((sink) => sink.threadId === threadId)
      .map((sink) => sink.grants.get(attachmentId))
      .find((candidate) => candidate !== undefined && candidate.sha256 === sha256);
    if (grant === undefined) return refused;
    // Read again, not from the cache: this is an access decision.
    link.activeByThread.delete(threadId);
    const active = yield* activeFor(link, threadId);
    if (Option.isNone(active) || active.value !== link.environmentId) return refused;
    const path = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: grant.attachment,
    });
    const bytes =
      path === null ? Option.none() : yield* fileSystem.readFile(path).pipe(Effect.option);
    if (Option.isNone(bytes)) {
      return { _tag: "failure", error: "The Hub no longer has this attachment." };
    }
    return { _tag: "success", value: { base64: Buffer.from(bytes.value).toString("base64") } };
  });

  const nameOf = (environmentId: EnvironmentId) =>
    sql<{ readonly name: string }>`
      SELECT name FROM environments WHERE environment_id = ${environmentId}
    `.pipe(
      Effect.map((rows) => rows[0]?.name ?? "The Environment"),
      Effect.orElseSucceed(() => "The Environment"),
    );

  /**
   * Ends a session the machine no longer runs: its turn is interrupted, not failed
   * (`EnvironmentSessionLostError`), so the Thread goes on there or elsewhere.
   */
  const loseSession = Effect.fn("RemoteEnvironments.loseSession")(function* (
    link: Link,
    providerSessionId: string,
    sink: SessionSink,
    reason: EnvironmentSessionLostError["reason"],
  ) {
    // Its turns end with it: none of them reports a `turn.terminal` now.
    yield* sessionTurnsEnded(link, providerSessionId, sink);
    yield* Queue.fail(
      sink.queue,
      new ProviderAdapter.ProviderAdapterEventStreamError({
        driver: sink.driver,
        providerSessionId:
          providerSessionId as ProviderAdapter.ProviderAdapterV2SessionRuntime["providerSessionId"],
        cause: new EnvironmentSessionLostError({
          environmentId: link.environmentId,
          environmentName: yield* nameOf(link.environmentId),
          reason,
        }),
      }),
    );
  });

  const retire = (
    link: Link,
    reason: EnvironmentSessionLostError["reason"] = "environment-removed",
  ) =>
    Effect.forEach(
      [...link.sessions.entries()],
      ([providerSessionId, sink]) => loseSession(link, providerSessionId, sink, reason),
      { discard: true },
    ).pipe(Effect.andThen(Effect.sync(() => link.sessions.clear())));

  const connect: RemoteEnvironments["Service"]["connect"] = Effect.fn("RemoteEnvironments.connect")(
    function* ({ environmentId, hello, write }) {
      const existing = links.get(environmentId);
      const link: Link = existing ?? {
        environmentId,
        channel: undefined,
        attached: yield* Deferred.make<void>(),
        workspaceRoot: hello.workspaceRoot,
        providers: hello.providers,
        sessions: new Map(),
        pendingAcks: new Map(),
        activeByThread: new Map(),
        streams: new Map(),
        contractVersion: hello.executorContractVersion ?? 7,
      };
      links.set(environmentId, link);
      link.workspaceRoot = hello.workspaceRoot;
      link.providers = hello.providers;
      // A machine that comes back updated (or not) is judged by what it says now.
      link.contractVersion = hello.executorContractVersion ?? 7;
      const previous = link.channel;
      const channel = yield* makeExecutorChannel({
        environmentId,
        write,
        onRequest: ({ method, payload }) =>
          method === ENVIRONMENT_EXECUTOR_FRAME_METHODS.attachmentRead
            ? onAttachmentRead(link, payload)
            : Effect.succeed({ _tag: "failure", error: `Unknown method '${method}'.` }),
        onEvent: (method, payload) => {
          switch (method) {
            case ENVIRONMENT_EXECUTOR_FRAME_METHODS.providerEvent:
              return onProviderEvent(link, payload);
            case ENVIRONMENT_EXECUTOR_FRAME_METHODS.sessionEnded:
              return onSessionEnded(link, payload);
            case ENVIRONMENT_EXECUTOR_FRAME_METHODS.workspaceStreamItem:
              return onStreamItem(link, payload);
            case ENVIRONMENT_EXECUTOR_FRAME_METHODS.workspaceStreamEnd:
              return onStreamEnd(link, payload);
            default:
              return Effect.void;
          }
        },
      });
      // In place before the old socket closes: calls it fails resend on this one.
      link.channel = channel;
      yield* previous?.close ?? Effect.void;
      if (previous !== undefined) yield* endStreamsOf(link, previous);
      link.pendingAcks.clear();
      link.activeByThread.clear();
      for (const sink of link.sessions.values()) sink.stalled = false;
      // What runs on the machine now is what it reported: sessions it lost end here, and those
      // the Hub no longer has (it restarted, or ended them) end there.
      const reported = new Set(hello.sessions.map((session) => session.providerSessionId));
      for (const [providerSessionId, sink] of link.sessions) {
        if (reported.has(providerSessionId)) continue;
        link.sessions.delete(providerSessionId);
        yield* loseSession(link, providerSessionId, sink, "process-ended");
      }
      const unknown = hello.sessions
        .map((session) => session.providerSessionId)
        .filter((providerSessionId) => !link.sessions.has(providerSessionId));
      if (unknown.length > 0) {
        yield* channel.event(ENVIRONMENT_EXECUTOR_FRAME_METHODS.retired, {
          providerSessionIds: unknown,
        });
      }
      yield* publishCapabilities(link, hello.orchestration, hello.hostResources, hello.disk);
      yield* registry.register(makeExecutor(link));
      const attached = link.attached;
      link.attached = yield* Deferred.make<void>();
      yield* Deferred.succeed(attached, undefined);
      // The machine's previews reach the Hub's clients while this socket lives.
      // Only a Thread's own machine reports on its previews; anything else is dropped and logged.
      yield* forwardStream(link)("preview.events", {}).pipe(
        Stream.runForEach((event) =>
          activeFor(link, ThreadId.make(event.threadId)).pipe(
            Effect.flatMap((active) =>
              Option.isSome(active) && active.value === link.environmentId
                ? PubSub.publish(previewEvents, event)
                : Effect.logWarning(
                    "Rejected a preview event from an Environment that is not the Thread's Active environment",
                    { environmentId: link.environmentId, threadId: event.threadId },
                  ),
            ),
          ),
        ),
        Effect.ignore,
        Effect.forkScoped,
      );

      let retireOnClose = false;
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* channel.close;
          yield* endStreamsOf(link, channel);
          if (link.channel !== channel) return;
          link.channel = undefined;
          yield* registry.unregister(environmentId);
          if (retireOnClose) {
            yield* retire(link);
            links.delete(environmentId);
          }
        }),
      );

      const flushAcks = Effect.suspend(() => {
        if (link.pendingAcks.size === 0) return Effect.void;
        const acks = [...link.pendingAcks.entries()].map(([providerSessionId, seq]) => ({
          providerSessionId,
          seq,
        }));
        link.pendingAcks.clear();
        return channel.event(ENVIRONMENT_EXECUTOR_FRAME_METHODS.ack, { acks });
      });

      return {
        receive: channel.receive,
        // Every ten seconds per machine: too frequent for a span each.
        heartbeat: Effect.fnUntraced(function* (frame) {
          if (frame.providers !== undefined) link.providers = frame.providers;
          if (frame.orchestration !== undefined) {
            yield* publishCapabilities(link, frame.orchestration, frame.hostResources, frame.disk);
          }
        }),
        flushAcks,
        retireOnClose: Effect.sync(() => {
          retireOnClose = true;
        }),
      };
    },
  );

  return RemoteEnvironments.of({
    connect,
    environmentRemoved: Effect.fn("RemoteEnvironments.environmentRemoved")(
      function* (environmentId) {
        const link = links.get(environmentId);
        if (link === undefined) return;
        yield* retire(link);
        // A socket still open is closed by the removal; its finalizer finds nothing left to end.
        if (link.channel === undefined) links.delete(environmentId);
      },
    ),
    sandboxSessionsEnded: Effect.fn("RemoteEnvironments.sandboxSessionsEnded")(
      function* (environmentId, reason) {
        const link = links.get(environmentId);
        if (link === undefined) return;
        yield* retire(link, reason);
      },
    ),
    forgetSessions: Effect.fn("RemoteEnvironments.forgetSessions")(function* (environmentId) {
      yield* Effect.sync(() => {
        const link = links.get(environmentId);
        if (link === undefined) return;
        link.sessions.clear();
        link.activeByThread.clear();
      });
    }),
    grantRecovery: Effect.fn("RemoteEnvironments.grantRecovery")(function* (input) {
      const now = yield* Clock.currentTimeMillis;
      const kept = (grants.get(input.environmentId) ?? []).filter(
        (grant) => grant.expiresAt > now && grant.ref !== input.ref,
      );
      grants.set(input.environmentId, [
        ...kept,
        { key: input.key, ref: input.ref, expiresAt: now + RECOVERY_GRANT_MS },
      ]);
    }),
    recoveryGrants: Effect.fn("RemoteEnvironments.recoveryGrants")(function* (environmentId) {
      const now = yield* Clock.currentTimeMillis;
      return (grants.get(environmentId) ?? []).filter((grant) => grant.expiresAt > now);
    }),
    takeRecoveryGrant: Effect.fn("RemoteEnvironments.takeRecoveryGrant")(
      function* (environmentId, ref) {
        const now = yield* Clock.currentTimeMillis;
        const current = grants.get(environmentId) ?? [];
        const found = current.some((grant) => grant.ref === ref && grant.expiresAt > now);
        grants.set(
          environmentId,
          current.filter((grant) => grant.ref !== ref && grant.expiresAt > now),
        );
        return found;
      },
    ),
    abandonSessions: Effect.fn("RemoteEnvironments.abandonSessions")(
      function* (environmentId, threadId) {
        const link = links.get(environmentId);
        if (link === undefined) return;
        for (const [providerSessionId, sink] of link.sessions) {
          if (sink.threadId !== threadId) continue;
          link.sessions.delete(providerSessionId);
          yield* loseSession(link, providerSessionId, sink, "moved-while-offline");
        }
      },
    ),
    previewEvents: Stream.fromPubSub(previewEvents),
    threadMoved: Effect.fn("RemoteEnvironments.threadMoved")(function* (threadId) {
      yield* Effect.sync(() => {
        for (const link of links.values()) link.activeByThread.delete(threadId);
      });
    }),
  });
});

export const layer = Layer.effect(RemoteEnvironments, make);
