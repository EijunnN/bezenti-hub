/**
 * Each Space's Sandbox, as the Hub keeps it: its row in `sandboxes`, its Environment (kind
 * `sandbox`, the Space's, with the credential the Hub issued itself) and its server through the
 * Sandbox runtime. The first Thread placed on it creates it; work that needs it starts it, and it
 * stops after the idle timeout with no turns, terminals or previews. See docs/internals/sandboxes.md.
 */
import {
  type EnvironmentId,
  sandboxEnvironmentIdOf,
  sandboxEnvironmentName,
  type SpaceId,
  type UserId,
} from "@t3tools/contracts";
import { base64UrlEncode } from "@t3tools/shared/base64Url";
import { formatEnvironmentCredential } from "@t3tools/shared/environmentJoin";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AuditLog from "../audit/AuditLog.ts";
import * as EnvironmentDemand from "../environment/EnvironmentDemand.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentConnections from "../environments/EnvironmentConnections.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { SandboxRuntime, sandboxIdOf } from "./SandboxRuntime.ts";
import { sandboxSpaceOf } from "./sandboxSpace.ts";

/** How long a starting Sandbox has to connect before its start counts as failed. */
const START_TIMEOUT = "2 minutes";
/** Seconds without turns, terminals or previews before a running Sandbox stops. */
const IDLE_TIMEOUT_SETTING = "T3CODE_SANDBOX_IDLE_SECONDS";
const DEFAULT_IDLE_TIMEOUT_SECONDS = 30 * 60;
/** A Sandbox that exits by itself this often within the window is not started again by itself. */
const CRASH_RESTART_LIMIT = 3;
const CRASH_RESTART_WINDOW_MS = 10 * 60 * 1000;

export class SandboxStartError extends Schema.TaggedError<SandboxStartError>()(
  "SandboxStartError",
  { spaceId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `The Sandbox could not start: ${this.detail}`;
  }
}

export interface SandboxStatusRow {
  readonly spaceId: SpaceId;
  readonly environmentId: EnvironmentId;
  readonly status: "stopped" | "starting" | "running" | "failed";
  readonly lastError: string | null;
}

/** Why a start happened, as the audit log records it. */
export type SandboxStartVia = "demand" | "retry";

/**
 * How the idle stop measures time: the timeout, and the clock it reads (a test's own clock, so a
 * test advances it without waiting). Absent: `T3CODE_SANDBOX_IDLE_SECONDS`, else 30 minutes, on
 * the Hub's clock.
 */
export class SandboxIdlePolicy extends Context.Service<
  SandboxIdlePolicy,
  { readonly timeout?: Duration.Input; readonly clock?: Clock.Clock }
>()("t3/sandboxes/Sandboxes/SandboxIdlePolicy") {}

export class Sandboxes extends Context.Service<
  Sandboxes,
  {
    /**
     * Makes the Space's Sandbox if it has none (its Environment, credential and home), without
     * starting it: placing a Thread on it. Who asks is checked before (`environment.use`); `actor`
     * is who the audit log names.
     */
    readonly ensureCreated: (input: {
      readonly spaceId: SpaceId;
      readonly actorUserId: UserId | undefined;
    }) => Effect.Effect<EnvironmentId, SandboxStartError>;
    /** Makes it if needed, starts it and waits until it is connected and its executor serves. */
    readonly ensureRunning: (input: {
      readonly spaceId: SpaceId;
      readonly actorUserId: UserId | undefined;
      readonly via?: SandboxStartVia;
    }) => Effect.Effect<EnvironmentId, SandboxStartError>;
    /** The Sandboxes that exist, by Space. */
    readonly list: Effect.Effect<ReadonlyArray<SandboxStatusRow>, SandboxStartError>;
    /** Stops the Space's Sandbox, keeping its home: its Organization was archived. */
    readonly stop: (input: {
      readonly spaceId: SpaceId;
      readonly actor: AuditLog.AuditActor;
    }) => Effect.Effect<void, SandboxStartError>;
    /**
     * Stops it, revokes its credential and removes its row and home: its Space is deleted. True
     * when there was one.
     */
    readonly delete: (input: {
      readonly spaceId: SpaceId;
      readonly actor: AuditLog.AuditActor;
    }) => Effect.Effect<boolean, SandboxStartError>;
    /** Stops every running Sandbox that has been idle for the timeout; run on a schedule. */
    readonly stopIdle: Effect.Effect<void>;
  }
>()("t3/sandboxes/Sandboxes") {}

const errorDetail = (cause: unknown) =>
  typeof cause === "string" ? cause : cause instanceof Error ? cause.message : String(cause);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runtime = yield* SandboxRuntime;
  const audit = yield* AuditLog.AuditLog;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const connections = yield* EnvironmentConnections.EnvironmentConnections;
  const random = yield* SecureRandom.SecureRandom;
  const digester = yield* Digest.Digest;
  const hubId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity).getEnvironmentId;
  const policy = yield* Effect.serviceOption(SandboxIdlePolicy);
  const idleClock = Option.flatMap(policy, (value) => Option.fromUndefinedOr(value.clock)).pipe(
    Option.getOrUndefined,
  );
  const clock = idleClock ?? (yield* Clock.Clock);
  const configuredSeconds = yield* Config.Int(IDLE_TIMEOUT_SETTING).pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<number>()),
  );
  const idleTimeoutMs = Option.match(
    Option.flatMap(policy, (value) => Option.fromUndefinedOr(value.timeout)),
    {
      onSome: (timeout) => Duration.toMillis(Duration.fromInputUnsafe(timeout)),
      onNone: () =>
        Math.max(
          1,
          Option.getOrElse(configuredSeconds, () => DEFAULT_IDLE_TIMEOUT_SECONDS),
        ) * 1000,
    },
  );
  const serviceScope = yield* Effect.scope;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const locks = new Map<SpaceId, Semaphore.Semaphore>();
  const lockOf = (spaceId: SpaceId) => {
    let lock = locks.get(spaceId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(spaceId, lock);
    }
    return lock;
  };

  // What keeps each Sandbox from idling: its last use, and what holds it open now.
  const activity = new Map<EnvironmentId, { last: number; holds: number }>();
  const activityOf = (environmentId: EnvironmentId) => {
    let entry = activity.get(environmentId);
    if (entry === undefined) {
      entry = { last: clock.currentTimeMillisUnsafe(), holds: 0 };
      activity.set(environmentId, entry);
    }
    return entry;
  };
  const touch = (environmentId: EnvironmentId) =>
    Effect.sync(() => {
      if (sandboxSpaceOf(environmentId) === undefined) return;
      activityOf(environmentId).last = clock.currentTimeMillisUnsafe();
    });
  // Starts asked for and not yet settled, so a burst of work starts one.
  const requested = new Set<SpaceId>();
  // When each Sandbox last exited by itself, for the crash-restart limit.
  const crashes = new Map<SpaceId, Array<number>>();

  const selectRow = (spaceId: SpaceId) =>
    sql<SandboxStatusRow>`
      SELECT space_id AS "spaceId", environment_id AS "environmentId", status,
        last_error AS "lastError"
      FROM sandboxes WHERE space_id = ${spaceId}
    `.pipe(Effect.map((rows) => rows[0]));

  const setStatus = Effect.fn("Sandboxes.setStatus")(function* (
    spaceId: SpaceId,
    status: SandboxStatusRow["status"],
    error?: string,
  ) {
    const now = yield* nowIso;
    yield* sql`
      UPDATE sandboxes SET status = ${status}, last_error = ${error ?? null},
        started_at = CASE WHEN ${status} = 'running' THEN ${now} ELSE started_at END,
        stopped_at = CASE WHEN ${status} = 'stopped' THEN ${now} ELSE stopped_at END,
        updated_at = ${now}
      WHERE space_id = ${spaceId}
    `;
  });

  /** Threads on the Sandbox with a run in progress: a turn keeps it from idling. */
  const unfinishedRuns = (environmentId: EnvironmentId) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM orchestration_v2_projection_threads AS thread
      WHERE thread.active_environment_id = ${environmentId}
        AND thread.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs AS run
          WHERE run.thread_id = thread.thread_id
            AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
        )
    `.pipe(
      Effect.map((rows) => rows[0]?.count ?? 0),
      Effect.orElseSucceed(() => 0),
    );

  /** A new credential: the Sandbox keeps it in its home, the Hub only its hash. */
  const issueCredential = Effect.gen(function* () {
    const credential = formatEnvironmentCredential(
      hubId,
      base64UrlEncode(yield* random.randomBytes(32)),
    );
    const hash = base64UrlEncode(
      yield* digester.digest(Digest.sha256, new TextEncoder().encode(credential)),
    );
    return { credential: Redacted.make(credential), hash };
  });

  /** Its row, Environment and home, made (or its home made again) when missing. */
  const createLocked = Effect.fn("Sandboxes.create")(function* (input: {
    readonly spaceId: SpaceId;
    readonly actorUserId: UserId | undefined;
  }) {
    const { spaceId } = input;
    const environmentId = sandboxEnvironmentIdOf(spaceId);
    const sandboxId = sandboxIdOf(spaceId);
    const space = yield* spaces.spaceById(spaceId);
    if (Option.isNone(space)) return yield* Effect.fail("its Space no longer exists.");
    // Nothing starts in an archived Organization or a frozen Personal space.
    if (space.value.resource.archived) return yield* Effect.fail("its Space is archived.");
    if (space.value.resource.frozen) return yield* Effect.fail("its Space is frozen.");
    const name = sandboxEnvironmentName(space.value.name);
    const existing = yield* selectRow(spaceId);
    const inspected = yield* runtime.inspect(sandboxId);
    // Its home is made, or made again after it was lost, with a credential issued for it.
    if (existing === undefined || inspected.state._tag === "missing") {
      const issued = yield* issueCredential;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* nowIso;
          // A deleted Sandbox's row stays revoked; making it again revives the same id.
          yield* sql`
            INSERT INTO environments (
              environment_id, name, kind, mode, space_id, credential_hash, credential_issued_at,
              registered_at
            ) VALUES (
              ${environmentId}, ${name}, 'sandbox', 'sandbox', ${spaceId}, ${issued.hash}, ${now},
              ${now}
            )
            ON CONFLICT (environment_id) DO UPDATE SET name = excluded.name,
              credential_hash = excluded.credential_hash,
              credential_issued_at = excluded.credential_issued_at, revoked_at = NULL
          `;
          if (existing !== undefined) return;
          yield* sql`
            INSERT INTO sandboxes (
              space_id, environment_id, runtime, status, created_at, updated_at
            ) VALUES (${spaceId}, ${environmentId}, ${runtime.kind}, 'stopped', ${now}, ${now})
          `;
          yield* audit.record({
            actor:
              input.actorUserId === undefined
                ? { source: "system" }
                : AuditLog.userActor(input.actorUserId),
            action: "sandbox.create",
            spaceId,
            target: { kind: "environment", id: environmentId, name },
            detail: { runtime: runtime.kind },
          });
        }),
      );
      yield* runtime.create({
        sandboxId,
        spaceId,
        environmentId,
        name,
        hubEnvironmentId: hubId,
        credential: issued.credential,
        limits: { cpus: null, memoryBytes: null, pids: null, diskBytes: null },
      });
      return { environmentId, name, running: false };
    }
    return { environmentId, name, running: inspected.state._tag === "running" };
  });

  const startLocked = Effect.fn("Sandboxes.start")(function* (input: {
    readonly spaceId: SpaceId;
    readonly actorUserId: UserId | undefined;
    readonly via: SandboxStartVia;
  }) {
    const { spaceId } = input;
    const sandboxId = sandboxIdOf(spaceId);
    const created = yield* createLocked(input);
    const { environmentId } = created;
    if (!created.running) yield* setStatus(spaceId, "starting");
    const started = yield* runtime.start(sandboxId);
    // Ready once welcomed with its executor serving, so work can run on it at once; a server that
    // ends first fails the start at once, with its exit code.
    const ready = yield* Effect.raceFirst(
      connections.awaitReady(environmentId).pipe(Effect.as("ready" as const)),
      started.exited.pipe(Effect.map((exitCode) => ({ exitCode }))),
    ).pipe(Effect.timeoutOption(START_TIMEOUT));
    if (Option.isNone(ready)) {
      return yield* Effect.fail("it did not connect to the Hub in time.");
    }
    if (ready.value !== "ready") {
      return yield* Effect.fail(
        `its server exited before connecting (exit code ${ready.value.exitCode ?? "unknown"}).`,
      );
    }
    yield* touch(environmentId);
    if (created.running) return environmentId;
    yield* setStatus(spaceId, "running");
    yield* audit.record({
      actor:
        input.actorUserId === undefined
          ? { source: "system" }
          : AuditLog.userActor(input.actorUserId),
      action: "sandbox.start",
      spaceId,
      target: { kind: "environment", id: environmentId, name: created.name },
      detail: { via: input.via },
    });
    return environmentId;
  });

  /** A failure as the Thread shows it: the Sandbox is `failed`, with why. */
  const failedStart = (spaceId: SpaceId) => (cause: unknown) => {
    const detail = errorDetail(cause);
    return setStatus(spaceId, "failed", detail).pipe(
      Effect.ignore,
      Effect.andThen(Effect.fail(new SandboxStartError({ spaceId, detail }))),
    );
  };

  const ensureCreated: Sandboxes["Service"]["ensureCreated"] = (input) =>
    lockOf(input.spaceId)
      .withPermits(1)(createLocked(input))
      .pipe(
        Effect.map((created) => created.environmentId),
        Effect.mapError(
          (cause) => new SandboxStartError({ spaceId: input.spaceId, detail: errorDetail(cause) }),
        ),
      );

  const ensureRunning: Sandboxes["Service"]["ensureRunning"] = (input) =>
    lockOf(input.spaceId)
      .withPermits(1)(startLocked({ ...input, via: input.via ?? "demand" }))
      .pipe(Effect.catch(failedStart(input.spaceId)));

  const list: Sandboxes["Service"]["list"] = sql<SandboxStatusRow>`
    SELECT space_id AS "spaceId", environment_id AS "environmentId", status,
      last_error AS "lastError"
    FROM sandboxes ORDER BY created_at
  `.pipe(Effect.mapError((cause) => new SandboxStartError({ spaceId: "", detail: String(cause) })));

  const stopLocked = Effect.fn("Sandboxes.stopLocked")(function* (input: {
    readonly spaceId: SpaceId;
    readonly actor: AuditLog.AuditActor;
    readonly via: "archived" | "idle";
  }) {
    const { spaceId } = input;
    const row = yield* selectRow(spaceId);
    if (row === undefined) return;
    const sandboxId = sandboxIdOf(spaceId);
    const wasRunning = (yield* runtime.inspect(sandboxId)).state._tag === "running";
    yield* runtime.stop(sandboxId);
    // Its server is gone: its socket is not waited on to notice, so nothing takes it as ready.
    yield* connections.close(row.environmentId, "heartbeat-timeout");
    yield* setStatus(spaceId, "stopped");
    activity.delete(row.environmentId);
    if (!wasRunning) return;
    yield* audit.record({
      actor: input.actor,
      action: "sandbox.stop",
      spaceId,
      target: { kind: "environment", id: row.environmentId },
      detail: { via: input.via },
    });
  });

  const stop: Sandboxes["Service"]["stop"] = (input) =>
    lockOf(input.spaceId)
      .withPermits(1)(stopLocked({ ...input, via: "archived" }))
      .pipe(
        Effect.mapError(
          (cause) => new SandboxStartError({ spaceId: input.spaceId, detail: String(cause) }),
        ),
        Effect.withSpan("Sandboxes.stop"),
      );

  const remove: Sandboxes["Service"]["delete"] = Effect.fn("Sandboxes.delete")(
    function* ({ spaceId, actor }) {
      const row = yield* selectRow(spaceId);
      const environmentId = sandboxEnvironmentIdOf(spaceId);
      yield* runtime.delete(sandboxIdOf(spaceId));
      activity.delete(environmentId);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE environments SET revoked_at = ${yield* nowIso}
            WHERE environment_id = ${environmentId} AND revoked_at IS NULL
          `;
          yield* sql`DELETE FROM sandboxes WHERE space_id = ${spaceId}`;
          if (row === undefined) return;
          yield* audit.record({
            actor,
            action: "sandbox.delete",
            spaceId,
            target: { kind: "environment", id: environmentId },
          });
        }),
      );
      yield* connections.close(environmentId, "environment-removed");
      return row !== undefined;
    },
    (effect, input) => lockOf(input.spaceId).withPermits(1)(effect),
    (effect, input) =>
      Effect.mapError(
        effect,
        (cause) => new SandboxStartError({ spaceId: input.spaceId, detail: String(cause) }),
      ),
  );

  /**
   * Stops each running Sandbox nothing used for the idle timeout: no run in progress on it, no
   * open terminal or preview holding it, and no other use since. Checked again under its lock, so
   * work that just started it keeps it.
   */
  const stopIdle: Sandboxes["Service"]["stopIdle"] = Effect.gen(function* () {
    const rows = yield* list.pipe(Effect.orElseSucceed(() => []));
    for (const row of rows) {
      if (row.status !== "running") continue;
      const idleSince = Effect.gen(function* () {
        const entry = activityOf(row.environmentId);
        if (entry.holds > 0 || (yield* unfinishedRuns(row.environmentId)) > 0) {
          entry.last = clock.currentTimeMillisUnsafe();
          return false;
        }
        return clock.currentTimeMillisUnsafe() - entry.last >= idleTimeoutMs;
      });
      if (!(yield* idleSince)) continue;
      yield* lockOf(row.spaceId)
        .withPermits(1)(
          Effect.gen(function* () {
            const current = yield* selectRow(row.spaceId);
            if (current?.status !== "running" || !(yield* idleSince)) return;
            yield* Effect.logInfo("Stopping an idle Sandbox", { spaceId: row.spaceId });
            yield* stopLocked({ spaceId: row.spaceId, actor: { source: "system" }, via: "idle" });
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not stop an idle Sandbox", { spaceId: row.spaceId, cause }),
          ),
        );
    }
  }).pipe(Effect.withSpan("Sandboxes.stopIdle"));

  /** Starts it in the background, unless a start is under way or its last one failed. */
  const requestStart = Effect.fn("Sandboxes.requestStart")(function* (spaceId: SpaceId) {
    if (requested.has(spaceId)) return;
    const row = yield* selectRow(spaceId).pipe(Effect.orElseSucceed(() => undefined));
    if (row === undefined || row.status === "failed") return;
    if (yield* connections.isReady(row.environmentId)) return;
    requested.add(spaceId);
    yield* ensureRunning({ spaceId, actorUserId: undefined, via: "demand" }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("A Sandbox did not start for its work", {
          spaceId,
          detail: error.detail,
        }),
      ),
      Effect.ensuring(Effect.sync(() => requested.delete(spaceId))),
      Effect.forkIn(serviceScope),
    );
  });

  // What the runtime does not run is not running, whatever the last Hub recorded.
  const recorded = yield* list.pipe(Effect.orElseSucceed(() => []));
  for (const row of recorded) {
    if (row.status !== "starting" && row.status !== "running") continue;
    const inspected = yield* runtime.inspect(sandboxIdOf(row.spaceId)).pipe(Effect.option);
    if (Option.isSome(inspected) && inspected.value.state._tag === "running") continue;
    yield* setStatus(row.spaceId, "stopped").pipe(Effect.ignore);
  }
  // A server that ended by itself counts as stopped. One that ended under a turn starts again,
  // so the turn resumes or ends interrupted as on any machine that came back (spec 2); one that
  // keeps ending is left `failed` for a User to try again.
  yield* runtime.exits.pipe(
    Stream.runForEach((exit) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly spaceId: SpaceId; readonly status: string }>`
          SELECT space_id AS "spaceId", status FROM sandboxes
        `;
        const row = rows.find((candidate) => sandboxIdOf(candidate.spaceId) === exit.sandboxId);
        // A start under way reports its own failure; only a running one is marked here.
        if (row === undefined || row.status !== "running") return;
        const environmentId = sandboxEnvironmentIdOf(row.spaceId);
        const exitMessage = `It exited with code ${exit.exitCode ?? "?"}.`;
        activity.delete(environmentId);
        // Its socket is gone with it: its Threads are away now, as on any machine that dropped.
        yield* connections.close(environmentId, "heartbeat-timeout");
        if ((yield* unfinishedRuns(environmentId)) === 0) {
          yield* setStatus(row.spaceId, "stopped", exitMessage);
          return;
        }
        const now = clock.currentTimeMillisUnsafe();
        const recent = (crashes.get(row.spaceId) ?? []).filter(
          (at) => now - at < CRASH_RESTART_WINDOW_MS,
        );
        recent.push(now);
        crashes.set(row.spaceId, recent);
        if (recent.length > CRASH_RESTART_LIMIT) {
          yield* setStatus(row.spaceId, "failed", `It kept exiting. ${exitMessage}`);
          return;
        }
        yield* setStatus(row.spaceId, "stopped", exitMessage);
        yield* requestStart(row.spaceId);
      }).pipe(Effect.ignore),
    ),
    Effect.forkScoped,
  );
  // The idle check runs on the idle clock, often enough to stop within a quarter of the timeout.
  const checkEvery = Duration.millis(Math.min(60_000, Math.max(1_000, idleTimeoutMs / 4)));
  yield* Effect.sleep(checkEvery).pipe(
    Effect.andThen(stopIdle),
    Effect.forever,
    Effect.provideService(Clock.Clock, clock),
    Effect.forkScoped,
  );

  const service = Sandboxes.of({
    ensureCreated,
    ensureRunning,
    list,
    stop,
    delete: remove,
    stopIdle,
  });

  const demand = EnvironmentDemand.EnvironmentDemand.of({
    awaitStarted: Effect.fn("Sandboxes.awaitStarted")(function* (environmentId) {
      const spaceId = sandboxSpaceOf(environmentId);
      if (spaceId === undefined) return;
      if (yield* connections.isReady(environmentId)) return yield* touch(environmentId);
      yield* ensureRunning({ spaceId, actorUserId: undefined, via: "demand" }).pipe(
        Effect.mapError(
          (error) =>
            new EnvironmentDemand.EnvironmentStartError({ environmentId, detail: error.detail }),
        ),
      );
    }),
    request: Effect.fn("Sandboxes.request")(function* (environmentIds) {
      for (const environmentId of environmentIds) {
        const spaceId = sandboxSpaceOf(environmentId);
        if (spaceId !== undefined) yield* requestStart(spaceId);
      }
    }),
    touch,
    hold: Effect.fn("Sandboxes.hold")(function* (environmentId) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          if (sandboxSpaceOf(environmentId) === undefined) return;
          const entry = activityOf(environmentId);
          entry.holds += 1;
          entry.last = clock.currentTimeMillisUnsafe();
        }),
        () =>
          Effect.sync(() => {
            const entry = activity.get(environmentId);
            if (entry === undefined) return;
            entry.holds = Math.max(0, entry.holds - 1);
            entry.last = clock.currentTimeMillisUnsafe();
          }),
      );
    }),
  });

  return Context.make(Sandboxes, service).pipe(
    Context.add(EnvironmentDemand.EnvironmentDemand, demand),
  );
});

/** Each Space's Sandbox, and the starts and idle stops other services ask for (`EnvironmentDemand`). */
export const layer = Layer.effectContext(make).pipe(Layer.provide(AuditLog.layer));
