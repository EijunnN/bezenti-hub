/**
 * What a joined Environment does for its Hub: it runs the executor operations the Hub asks for on
 * this machine's own executor, streams each provider session's events back in order, and keeps
 * the ones the Hub has not acknowledged to resend after a reconnect. See
 * docs/internals/environment-auth.md#joined-environments.
 */
// @effect-diagnostics nodeBuiltinImport:off -- path joins only; no I/O.
// @effect-diagnostics anyUnknownInErrorContext:off -- each operation's errors are encoded by its own schema.
import * as NodePath from "node:path";

import {
  type ChatAttachment,
  ENVIRONMENT_EXECUTOR_FRAME_METHODS,
  EnvironmentAttachmentReadResult,
  EnvironmentExecutorEventAck,
  EnvironmentExecutorRetiredSessions,
  type EnvironmentId,
  type EnvironmentLiveProviderSession,
  type EnvironmentOrchestrationCapabilities,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import {
  type ExecutorCallResult,
  type ExecutorChannel,
  makeExecutorChannel,
} from "../environment/ExecutorChannel.ts";
import {
  isRemoteOperation,
  ProviderEventJson,
  REMOTE_OPERATIONS,
  type RemoteInput,
  type RemoteOperation,
  type WireAttachmentRef,
  type WireCheckout,
} from "../environment/RemoteExecutorWire.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

/** Calls answered, by idempotency key, so a resend gets the first answer instead of a rerun. */
const IDEMPOTENCY_MEMORY = 512;
/** Unacknowledged events kept per session; past it the oldest go and a reconnect cannot fill them. */
const SPOOL_LIMIT = 5_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
/** The driver named in errors about a session this machine does not have. */
const UNKNOWN_DRIVER = ProviderDriverKind.make("environment");

interface LocalSession {
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind;
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly scope: Scope.Closeable;
  readonly features: {
    readonly injectHistory: boolean;
    readonly compactThread: boolean;
    readonly stopTask: boolean;
    readonly unloadThread: boolean;
    readonly hasPendingBackgroundWork: boolean;
    readonly backgroundTasksEndWithProcess: boolean;
  };
  /** The Hub-issued MCP credential this session's agent uses, if any. */
  readonly credentialId: string | undefined;
  seq: number;
  /** Ended on this machine; kept until the Hub acknowledges its last frame. */
  ended: boolean;
  readonly spool: Array<{ readonly seq: number; readonly method: string; readonly frame: unknown }>;
}

export class EnvironmentAgent extends Context.Service<
  EnvironmentAgent,
  {
    /** What the hello and each heartbeat say about this machine's orchestration side. */
    readonly report: Effect.Effect<{
      readonly workspaceRoot: string;
      readonly orchestration: EnvironmentOrchestrationCapabilities;
      readonly sessions: ReadonlyArray<EnvironmentLiveProviderSession>;
    }>;
    /** Serves one welcomed connection until the scope closes. */
    readonly attach: (
      write: (text: string) => Effect.Effect<void>,
    ) => Effect.Effect<
      { readonly receive: (frame: unknown) => Effect.Effect<boolean> },
      never,
      Scope.Scope
    >;
  }
>()("t3/environments/EnvironmentAgent") {}

const codec = (schema: Schema.Top) => Schema.toCodecJson(schema as Schema.Codec<unknown, unknown>);
const decodeAck = Schema.decodeUnknownOption(EnvironmentExecutorEventAck);
const decodeRetired = Schema.decodeUnknownOption(EnvironmentExecutorRetiredSessions);
const decodeAttachment = Schema.decodeUnknownOption(EnvironmentAttachmentReadResult);
const encodeEvent = Schema.encodeUnknownEffect(ProviderEventJson);

export interface EnvironmentAgentInput {
  readonly environmentId: EnvironmentId;
  readonly hubUrl: string;
  /** The Environment credential, for the Hub repository; without it nothing is uploaded. */
  readonly credential: string | undefined;
}

export const make = Effect.fn("EnvironmentAgent.make")(function* (input: EnvironmentAgentInput) {
  const registry = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
  const local = yield* registry.get(registry.hubMachineEnvironmentId).pipe(Effect.orDie);
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const digester = yield* Digest.Digest;
  // Optional so joined mode needs nothing the Hub's routes do not; the server always has it.
  const vcs = yield* Effect.serviceOption(VcsProcess.VcsProcess);
  const agentScope = yield* Effect.scope;
  const workspaceRoot = NodePath.resolve(config.baseDir, "projects");
  const mcpEndpoint = new URL("/mcp", input.hubUrl).toString();

  const sessions = new Map<string, LocalSession>();
  const answered = new Map<
    string,
    { readonly answer: Deferred.Deferred<ExecutorCallResult>; settled: boolean }
  >();
  let channel: ExecutorChannel | undefined;

  const sha256Hex = (bytes: Uint8Array) =>
    digester.digest(Digest.sha256, bytes).pipe(
      Effect.orDie,
      Effect.map((digest) => Buffer.from(digest).toString("hex")),
    );

  const send = (method: string, frame: unknown) =>
    Effect.suspend(() => (channel === undefined ? Effect.void : channel.event(method, frame)));

  /** Next in the session's order: kept until acknowledged, and sent now if connected. */
  const spoolAndSend = (
    providerSessionId: string,
    session: LocalSession,
    method: string,
    frame: (seq: number) => unknown,
  ) =>
    Effect.suspend(() => {
      session.seq += 1;
      const framed = frame(session.seq);
      session.spool.push({ seq: session.seq, method, frame: framed });
      const sent = send(method, framed);
      if (session.spool.length <= SPOOL_LIMIT) return sent;
      session.spool.shift();
      return Effect.logWarning("Dropped an unacknowledged event past the spool limit", {
        providerSessionId,
      }).pipe(Effect.andThen(sent));
    });

  /** Gone from this machine: its process, its spool and, if still its own, its MCP credential. */
  const forgetSession = Effect.fn("EnvironmentAgent.forgetSession")(function* (
    providerSessionId: string,
    session: LocalSession,
  ) {
    if (sessions.get(providerSessionId) === session) sessions.delete(providerSessionId);
    yield* Scope.close(session.scope, Exit.void);
    const current = yield* mcpSessions.read(session.threadId);
    // A newer session of the Thread may hold a newer credential; only this one's goes.
    if (session.credentialId !== undefined && current?.providerSessionId === session.credentialId) {
      yield* mcpSessions.clear(session.threadId);
    }
  });

  /**
   * Streams a session's events: spooled with a `seq` until acknowledged, live output as is. Its
   * end goes in the same order, so a machine offline when it happens still reports it.
   */
  const pump = (providerSessionId: string, session: LocalSession) =>
    session.runtime.events.pipe(
      Stream.runForEach((event) =>
        encodeEvent(event).pipe(
          Effect.orDie,
          Effect.flatMap((encoded) =>
            event.type === "command_output.delta"
              ? send(ENVIRONMENT_EXECUTOR_FRAME_METHODS.providerEvent, {
                  providerSessionId,
                  event: encoded,
                })
              : spoolAndSend(
                  providerSessionId,
                  session,
                  ENVIRONMENT_EXECUTOR_FRAME_METHODS.providerEvent,
                  (seq) => ({ providerSessionId, seq, event: encoded }),
                ),
          ),
        ),
      ),
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          if (sessions.get(providerSessionId) !== session) return;
          const error =
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
              : undefined;
          const encoded =
            error === undefined
              ? undefined
              : yield* Schema.encodeUnknownEffect(codec(ProviderAdapter.ProviderAdapterV2Error))(
                  error,
                ).pipe(Effect.option, Effect.map(Option.getOrUndefined));
          session.ended = true;
          yield* spoolAndSend(
            providerSessionId,
            session,
            ENVIRONMENT_EXECUTOR_FRAME_METHODS.sessionEnded,
            (seq) => ({
              providerSessionId,
              seq,
              ...(encoded === undefined ? {} : { error: encoded }),
            }),
          );
          yield* Scope.close(session.scope, Exit.void);
        }),
      ),
    );

  /** The Project's checkout: used where it is, else cloned from the Project's own remote. */
  const ensureCheckout = Effect.fn("EnvironmentAgent.ensureCheckout")(function* (
    checkout: WireCheckout,
  ) {
    if (yield* fileSystem.exists(checkout.path).pipe(Effect.orElseSucceed(() => false))) return;
    if (checkout.cloneUrl === null || Option.isNone(vcs)) {
      return yield* Effect.fail(
        `The Project's checkout ${checkout.path} does not exist on this machine, and the Project has no remote to clone.`,
      );
    }
    yield* fileSystem
      .makeDirectory(NodePath.dirname(checkout.path), { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => `Could not create ${NodePath.dirname(checkout.path)}: ${cause.message}`,
        ),
      );
    yield* vcs.value
      .run({
        operation: "EnvironmentAgent.cloneCheckout",
        command: "git",
        args: ["clone", "--", checkout.cloneUrl, checkout.path],
        cwd: NodePath.dirname(checkout.path),
        timeoutMs: CLONE_TIMEOUT_MS,
      })
      .pipe(Effect.mapError((cause) => `Could not clone the Project: ${cause.message}`));
  });

  // The Hub's repository of a Project, over HTTP with this machine's credential.
  const credential = input.credential;
  const hubRepository = HubRepository.makeCheckoutTransfers({
    vcs: Option.getOrUndefined(vcs),
    remoteOf:
      credential === undefined
        ? undefined
        : (projectId) =>
            Effect.succeed(
              HubRepository.withEnvironmentCredential(
                HubRepository.hubRepositoryUrl(input.hubUrl, projectId),
                credential,
              ),
            ),
    unavailable: "This machine cannot reach the Hub repository.",
  });

  /** Fetches from the Hub, by hash, the attachments a turn needs and this machine lacks. */
  const ensureAttachments = Effect.fn("EnvironmentAgent.ensureAttachments")(function* (
    driver: ProviderDriverKind,
    threadId: ThreadId,
    attachments: ReadonlyArray<ChatAttachment>,
    refs: ReadonlyArray<WireAttachmentRef>,
  ) {
    for (const ref of refs) {
      const attachment = attachments.find((candidate) => candidate.id === ref.id);
      const path =
        attachment === undefined
          ? null
          : resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (path === null) continue;
      const existing = yield* fileSystem.readFile(path).pipe(Effect.option);
      if (Option.isSome(existing) && (yield* sha256Hex(existing.value)) === ref.sha256) continue;
      const unreadable = new ProviderAdapter.ProviderAdapterProtocolError({
        driver,
        detail: "An attachment could not be fetched from the Hub",
        reason: "attachment_unreadable",
      });
      if (channel === undefined) return yield* unreadable;
      const answer = yield* channel
        .request({
          method: ENVIRONMENT_EXECUTOR_FRAME_METHODS.attachmentRead,
          payload: { threadId, attachmentId: ref.id, sha256: ref.sha256 },
        })
        .pipe(Effect.mapError(() => unreadable));
      const result = answer._tag === "success" ? decodeAttachment(answer.value) : Option.none();
      if (Option.isNone(result)) return yield* unreadable;
      const bytes = Buffer.from(result.value.base64, "base64");
      if ((yield* sha256Hex(bytes)) !== ref.sha256) return yield* unreadable;
      yield* fileSystem
        .makeDirectory(config.attachmentsDir, { recursive: true })
        .pipe(Effect.ignore);
      yield* fileSystem.writeFile(path, bytes).pipe(Effect.mapError(() => unreadable));
    }
  });

  const sessionOf = (providerSessionId: string) =>
    Effect.suspend(() => {
      const session = sessions.get(providerSessionId);
      return session === undefined
        ? Effect.fail(
            new ProviderAdapter.ProviderAdapterSessionStoppedError({ driver: UNKNOWN_DRIVER }),
          )
        : Effect.succeed(session);
    });

  const openSession = Effect.fn("EnvironmentAgent.openSession")(function* (
    request: RemoteInput<"provider.openSession">,
  ) {
    const known = sessions.get(request.providerSessionId);
    if (known !== undefined) {
      return { providerSession: known.runtime.providerSession, features: known.features };
    }
    const instanceId = request.instanceId as ProviderInstanceId;
    const openError = (cause: unknown) =>
      new ProviderAdapter.ProviderAdapterOpenSessionError({
        driver: UNKNOWN_DRIVER,
        providerSessionId: request.providerSessionId,
        cause,
      });
    const adapter = yield* local.provider.adapters.get(instanceId).pipe(Effect.mapError(openError));
    if (request.checkout !== undefined) {
      yield* ensureCheckout(request.checkout).pipe(Effect.mapError(openError));
      const hubRefs = request.checkout.hubRefs;
      // Once the Hub repository has the Thread's checkpoints, this checkout gets the ones it lacks.
      if (hubRefs !== undefined) {
        yield* hubRepository
          .fetch({
            cwd: request.checkout.path,
            projectId: hubRefs.projectId,
            checkpointRefs: hubRefs.refs,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not fetch the Thread's checkpoints from the Hub", { cause }),
            ),
          );
      }
    }
    // The agent here reaches the Hub's MCP, with the credential the Hub issued for this Thread.
    if (request.mcp === undefined) {
      yield* mcpSessions.clear(request.threadId);
    } else {
      yield* mcpSessions.set({
        environmentId: input.environmentId,
        threadId: request.threadId,
        providerSessionId: request.mcp.credentialId,
        providerInstanceId: instanceId,
        endpoint: mcpEndpoint,
        authorizationHeader: request.mcp.authorizationHeader,
        browserToolsAvailable: request.mcp.browserToolsAvailable,
        capabilities: new Set(request.mcp.capabilities),
      });
    }
    const scope = yield* Scope.fork(agentScope);
    const runtime = yield* adapter
      .openSession({
        threadId: request.threadId,
        providerSessionId: request.providerSessionId,
        modelSelection: request.modelSelection,
        runtimePolicy: request.runtimePolicy,
        ...(request.resumeFromSession === undefined
          ? {}
          : { resumeFromSession: request.resumeFromSession }),
        ...(request.initialNativeThreadId === undefined
          ? {}
          : { initialNativeThreadId: request.initialNativeThreadId }),
        ...(request.initialProviderItemIdentityVersion === undefined
          ? {}
          : { initialProviderItemIdentityVersion: request.initialProviderItemIdentityVersion }),
      })
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
    const session: LocalSession = {
      threadId: request.threadId,
      driver: adapter.driver,
      runtime,
      scope,
      features: {
        injectHistory: runtime.injectHistory !== undefined,
        compactThread: runtime.compactThread !== undefined,
        stopTask: runtime.stopTask !== undefined,
        unloadThread: runtime.unloadThread !== undefined,
        hasPendingBackgroundWork: runtime.hasPendingBackgroundWork !== undefined,
        backgroundTasksEndWithProcess: runtime.backgroundTasksEndWithProcess === true,
      },
      credentialId: request.mcp?.credentialId,
      seq: 0,
      ended: false,
      spool: [],
    };
    sessions.set(request.providerSessionId, session);
    yield* pump(request.providerSessionId, session).pipe(Effect.forkIn(agentScope));
    return { providerSession: runtime.providerSession, features: session.features };
  });

  const unsupported = (session: LocalSession, operation: string) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: session.driver,
      detail: `This session does not support ${operation}`,
    });

  /** Runs one decoded operation on this machine. */
  const run = (operation: RemoteOperation, request: unknown): Effect.Effect<unknown, unknown> => {
    const onSession = <A>(
      body: (session: LocalSession, input: never) => Effect.Effect<A, unknown>,
    ) => {
      const { providerSessionId, input: sessionInput } = request as {
        readonly providerSessionId: string;
        readonly input: never;
      };
      return sessionOf(providerSessionId).pipe(
        Effect.flatMap((session) => body(session, sessionInput)),
      );
    };
    const checkpoints = local.workspace.checkpoints;
    switch (operation) {
      case "provider.openSession":
        return openSession(request as RemoteInput<"provider.openSession">);
      case "provider.ensureThread":
        return onSession((session, input) => session.runtime.ensureThread(input));
      case "provider.resumeThread":
        return onSession((session, input) => session.runtime.resumeThread(input));
      case "provider.startTurn": {
        const {
          providerSessionId,
          input: turn,
          attachments,
        } = request as RemoteInput<"provider.startTurn">;
        return sessionOf(providerSessionId).pipe(
          Effect.flatMap((session) =>
            ensureAttachments(
              session.driver,
              turn.threadId,
              turn.message.attachments,
              attachments,
            ).pipe(Effect.andThen(session.runtime.startTurn(turn))),
          ),
        );
      }
      case "provider.steer": {
        const {
          providerSessionId,
          input: steer,
          attachments,
        } = request as RemoteInput<"provider.steer">;
        return sessionOf(providerSessionId).pipe(
          Effect.flatMap((session) =>
            ensureAttachments(
              session.driver,
              steer.threadId,
              steer.message.attachments,
              attachments,
            ).pipe(Effect.andThen(session.runtime.steerTurn(steer))),
          ),
        );
      }
      case "provider.compactThread":
        return onSession((session, input) =>
          session.runtime.compactThread === undefined
            ? Effect.fail(unsupported(session, "compaction"))
            : session.runtime.compactThread(input),
        );
      case "provider.interrupt":
        return onSession((session, input) => session.runtime.interruptTurn(input));
      case "provider.respond":
        return onSession((session, input) => session.runtime.respondToRuntimeRequest(input));
      case "provider.readThreadSnapshot":
        return onSession((session, input) => session.runtime.readThreadSnapshot(input));
      case "provider.rollback":
        return onSession((session, input) => session.runtime.rollbackThread(input));
      case "provider.forkThread":
        return onSession((session, input) => session.runtime.forkThread(input));
      case "provider.injectHistory":
        return onSession((session, input) =>
          session.runtime.injectHistory === undefined
            ? Effect.succeed(false)
            : session.runtime.injectHistory(input),
        );
      case "provider.stopTask":
        return onSession((session, input) =>
          session.runtime.stopTask === undefined
            ? Effect.fail(unsupported(session, "stopping a task"))
            : session.runtime.stopTask(input),
        );
      case "provider.unloadThread":
        return onSession((session, input) =>
          session.runtime.unloadThread === undefined
            ? Effect.void
            : session.runtime.unloadThread(input),
        );
      case "provider.hasPendingBackgroundWork":
        return onSession(
          (session) => session.runtime.hasPendingBackgroundWork ?? Effect.succeed(false),
        );
      case "provider.detach": {
        const { providerSessionId } = request as RemoteInput<"provider.detach">;
        return Effect.suspend(() => {
          const session = sessions.get(providerSessionId);
          return session === undefined ? Effect.void : forgetSession(providerSessionId, session);
        });
      }
      case "checkpoint.isGitRepository":
        return checkpoints.isGitRepository(
          (request as RemoteInput<"checkpoint.isGitRepository">).cwd,
        );
      case "checkpoint.hasRef":
        return checkpoints.hasCheckpointRef(request as RemoteInput<"checkpoint.hasRef">);
      case "checkpoint.capture":
        return checkpoints.captureCheckpoint(request as RemoteInput<"checkpoint.capture">);
      case "checkpoint.restore":
        return checkpoints.restoreCheckpoint(request as RemoteInput<"checkpoint.restore">);
      case "checkpoint.diff":
        return checkpoints.diffCheckpoints(request as RemoteInput<"checkpoint.diff">);
      case "checkpoint.listAuthoredPaths":
        return checkpoints
          .listAuthoredPaths(request as RemoteInput<"checkpoint.listAuthoredPaths">)
          .pipe(Effect.map((paths) => (paths === null ? null : [...paths])));
      case "checkpoint.deleteRefs":
        return checkpoints.deleteCheckpointRefs(request as RemoteInput<"checkpoint.deleteRefs">);
      case "checkpoint.push":
        return hubRepository.push(request as RemoteInput<"checkpoint.push">);
      case "checkpoint.fetch":
        return hubRepository.fetch(request as RemoteInput<"checkpoint.fetch">);
    }
  };

  /** Decodes, runs and encodes one request; errors outside the operation's own become protocol errors. */
  const answer = Effect.fn("EnvironmentAgent.answer")(function* (
    method: string,
    payload: unknown,
  ): Effect.fn.Return<ExecutorCallResult> {
    if (!isRemoteOperation(method)) {
      return { _tag: "failure", error: `This machine does not answer '${method}'.` };
    }
    const spec = REMOTE_OPERATIONS[method];
    const request = yield* Schema.decodeUnknownEffect(codec(spec.input))(payload).pipe(
      Effect.option,
    );
    if (Option.isNone(request)) {
      return { _tag: "failure", error: `The request for '${method}' could not be read.` };
    }
    const exit = yield* Effect.exit(run(method, request.value));
    if (Exit.isSuccess(exit)) {
      const value = yield* Schema.encodeUnknownEffect(codec(spec.output))(exit.value).pipe(
        Effect.orElseSucceed(() => null),
      );
      return { _tag: "success", value };
    }
    const failure = Cause.findErrorOption(exit.cause);
    if (Option.isSome(failure)) {
      const encoded = yield* Schema.encodeUnknownEffect(codec(spec.error))(failure.value).pipe(
        Effect.option,
      );
      if (Option.isSome(encoded)) return { _tag: "failure", error: encoded.value };
    }
    yield* Effect.logWarning("An Environment request failed", { method, cause: exit.cause });
    const fallback = method.startsWith("provider.")
      ? new ProviderAdapter.ProviderAdapterProtocolError({
          driver: UNKNOWN_DRIVER,
          detail: Cause.pretty(exit.cause).slice(0, 500),
        })
      : undefined;
    const encodedFallback =
      fallback === undefined
        ? Option.none()
        : yield* Schema.encodeUnknownEffect(codec(spec.error))(fallback).pipe(Effect.option);
    return {
      _tag: "failure",
      error: Option.getOrElse(encodedFallback, () => Cause.pretty(exit.cause).slice(0, 500)),
    };
  });

  /**
   * An idempotency key runs once: a resend while it runs joins it, and one after it succeeded gets
   * the same answer. A failure is not kept, so the effect's next attempt runs the call again.
   */
  const onRequest = (request: {
    readonly method: string;
    readonly payload: unknown;
    readonly idempotencyKey: string | undefined;
  }): Effect.Effect<ExecutorCallResult> => {
    const key = request.idempotencyKey;
    if (key === undefined) return answer(request.method, request.payload);
    return Effect.suspend(() => {
      const known = answered.get(key);
      if (known !== undefined) {
        // Most recently used last, so eviction takes the oldest settled answers.
        answered.delete(key);
        answered.set(key, known);
        return Deferred.await(known.answer);
      }
      const entry = { answer: Deferred.makeUnsafe<ExecutorCallResult>(), settled: false };
      answered.set(key, entry);
      for (const [candidate, kept] of answered) {
        if (answered.size <= IDEMPOTENCY_MEMORY) break;
        // A call still running is never forgotten: its resend must join it.
        if (kept.settled) answered.delete(candidate);
      }
      return answer(request.method, request.payload).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            entry.settled = true;
            if (result._tag === "failure" && answered.get(key) === entry) answered.delete(key);
          }).pipe(Effect.andThen(Deferred.succeed(entry.answer, result))),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (answered.get(key) === entry) answered.delete(key);
          }),
        ),
      );
    });
  };

  const onEvent = (method: string, payload: unknown): Effect.Effect<void> => {
    if (method === ENVIRONMENT_EXECUTOR_FRAME_METHODS.retired) {
      // Sessions the Hub no longer has: nothing would read them, so their processes go.
      const retired = decodeRetired(payload);
      if (Option.isNone(retired)) return Effect.void;
      return Effect.forEach(
        retired.value.providerSessionIds,
        (providerSessionId) => {
          const session = sessions.get(providerSessionId);
          return session === undefined ? Effect.void : forgetSession(providerSessionId, session);
        },
        { discard: true },
      );
    }
    if (method !== ENVIRONMENT_EXECUTOR_FRAME_METHODS.ack) return Effect.void;
    return Effect.sync(() => {
      const acks = decodeAck(payload);
      if (Option.isNone(acks)) return;
      for (const ack of acks.value.acks) {
        const session = sessions.get(ack.providerSessionId);
        if (session === undefined) continue;
        while (session.spool.length > 0 && session.spool[0]!.seq <= ack.seq) session.spool.shift();
        // Its end reached the Hub: nothing about it is left to resend.
        if (session.ended && session.spool.length === 0) sessions.delete(ack.providerSessionId);
      }
    });
  };

  return EnvironmentAgent.of({
    report: Effect.gen(function* () {
      const described = yield* local.host.describe;
      return {
        workspaceRoot,
        orchestration: {
          providers: described.providers,
          unavailableProviders: described.unavailableProviders,
        },
        sessions: [...sessions.entries()].map(([providerSessionId, session]) => ({
          providerSessionId,
          threadId: session.threadId,
          lastSeq: session.seq,
        })),
      };
    }),
    attach: Effect.fn("EnvironmentAgent.attach")(function* (write) {
      const connected = yield* makeExecutorChannel({
        environmentId: input.environmentId,
        write,
        onRequest,
        onEvent,
      });
      yield* Effect.addFinalizer(() =>
        connected.close.pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (channel === connected) channel = undefined;
            }),
          ),
        ),
      );
      // What the Hub had not acknowledged when the last connection dropped, in order; it drops
      // duplicates. New events wait in the spool until the replay catches up, then go live: the
      // check and the switch happen without yielding, so none is skipped or overtakes an older one.
      const replayed = new Map<LocalSession, number>();
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const session of sessions.values()) {
          for (const entry of session.spool) {
            if (entry.seq <= (replayed.get(session) ?? 0)) continue;
            yield* connected.event(entry.method, entry.frame);
            replayed.set(session, entry.seq);
            progressed = true;
          }
        }
      }
      channel = connected;
      return { receive: connected.receive };
    }),
  });
});

export const layer = (input: EnvironmentAgentInput) => Layer.effect(EnvironmentAgent, make(input));
