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
  seq: number;
  readonly spool: Array<{ readonly seq: number; readonly frame: unknown }>;
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
const decodeAttachment = Schema.decodeUnknownOption(EnvironmentAttachmentReadResult);
const encodeEvent = Schema.encodeUnknownEffect(ProviderEventJson);

export const make = Effect.fn("EnvironmentAgent.make")(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly hubUrl: string;
}) {
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
  const answered = new Map<string, Deferred.Deferred<ExecutorCallResult>>();
  let channel: ExecutorChannel | undefined;

  const sha256Hex = (bytes: Uint8Array) =>
    digester.digest(Digest.sha256, bytes).pipe(
      Effect.orDie,
      Effect.map((digest) => Buffer.from(digest).toString("hex")),
    );

  const send = (frame: {
    readonly seq?: number;
    readonly providerSessionId: string;
    readonly event: unknown;
  }) =>
    channel === undefined
      ? Effect.void
      : channel.event(ENVIRONMENT_EXECUTOR_FRAME_METHODS.providerEvent, frame);

  /** Streams a session's events: spooled with a `seq` until acknowledged, live output as is. */
  const pump = (providerSessionId: string, session: LocalSession) =>
    session.runtime.events.pipe(
      Stream.runForEach((event) =>
        encodeEvent(event).pipe(
          Effect.orDie,
          Effect.flatMap((encoded) => {
            if (event.type === "command_output.delta") {
              return send({ providerSessionId, event: encoded });
            }
            session.seq += 1;
            const frame = { providerSessionId, seq: session.seq, event: encoded };
            session.spool.push({ seq: session.seq, frame });
            if (session.spool.length > SPOOL_LIMIT) {
              session.spool.shift();
              return Effect.logWarning("Dropped an unacknowledged event past the spool limit", {
                providerSessionId,
              }).pipe(Effect.andThen(send(frame)));
            }
            return send(frame);
          }),
        ),
      ),
      Effect.exit,
      Effect.flatMap((exit) => {
        if (sessions.get(providerSessionId) !== session) return Effect.void;
        sessions.delete(providerSessionId);
        const error =
          Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
            ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
            : undefined;
        return (
          channel === undefined
            ? Effect.void
            : Effect.gen(function* () {
                const encoded =
                  error === undefined
                    ? undefined
                    : yield* Schema.encodeUnknownEffect(
                        codec(ProviderAdapter.ProviderAdapterV2Error),
                      )(error).pipe(Effect.option, Effect.map(Option.getOrUndefined));
                yield* channel!.event(ENVIRONMENT_EXECUTOR_FRAME_METHODS.sessionEnded, {
                  providerSessionId,
                  ...(encoded === undefined ? {} : { error: encoded }),
                });
              })
        ).pipe(Effect.andThen(Scope.close(session.scope, Exit.void)));
      }),
    );

  /** The Project's checkout: used where it is, else cloned from the Project's own remote. */
  const ensureCheckout = Effect.fnUntraced(function* (checkout: WireCheckout) {
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

  /** Fetches from the Hub, by hash, the attachments a turn needs and this machine lacks. */
  const ensureAttachments = Effect.fnUntraced(function* (
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

  const openSession = Effect.fnUntraced(function* (request: RemoteInput<"provider.openSession">) {
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
      seq: 0,
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
          if (session === undefined) return Effect.void;
          sessions.delete(providerSessionId);
          return Scope.close(session.scope, Exit.void).pipe(
            Effect.andThen(mcpSessions.clear(session.threadId)),
          );
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
    }
  };

  /** Decodes, runs and encodes one request; errors outside the operation's own become protocol errors. */
  const answer = Effect.fnUntraced(function* (
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

  /** An idempotency key answers once; a resend waits for, and returns, the same answer. */
  const onRequest = (request: {
    readonly method: string;
    readonly payload: unknown;
    readonly idempotencyKey: string | undefined;
  }): Effect.Effect<ExecutorCallResult> => {
    const key = request.idempotencyKey;
    if (key === undefined) return answer(request.method, request.payload);
    return Effect.suspend(() => {
      const known = answered.get(key);
      if (known !== undefined) return Deferred.await(known);
      const pending = Deferred.makeUnsafe<ExecutorCallResult>();
      answered.set(key, pending);
      while (answered.size > IDEMPOTENCY_MEMORY) {
        const oldest = answered.keys().next().value;
        if (oldest === undefined) break;
        answered.delete(oldest);
      }
      return answer(request.method, request.payload).pipe(
        Effect.tap((result) => Deferred.succeed(pending, result)),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (answered.get(key) === pending) answered.delete(key);
          }),
        ),
      );
    });
  };

  const onEvent = (method: string, payload: unknown) =>
    Effect.sync(() => {
      if (method !== ENVIRONMENT_EXECUTOR_FRAME_METHODS.ack) return;
      const acks = decodeAck(payload);
      if (Option.isNone(acks)) return;
      for (const ack of acks.value.acks) {
        const session = sessions.get(ack.providerSessionId);
        if (session === undefined) continue;
        while (session.spool.length > 0 && session.spool[0]!.seq <= ack.seq) session.spool.shift();
      }
    });

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
            yield* connected.event(ENVIRONMENT_EXECUTOR_FRAME_METHODS.providerEvent, entry.frame);
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

export const layer = (input: { readonly environmentId: EnvironmentId; readonly hubUrl: string }) =>
  Layer.effect(EnvironmentAgent, make(input));
