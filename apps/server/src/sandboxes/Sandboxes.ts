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
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
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
import {
  BUILT_IN_DEFAULT_LIMITS,
  diskFullMessage,
  effectiveLimits,
  homeUsageBytes,
  type SandboxLimits,
} from "./sandboxLimits.ts";
import { SandboxRuntime, type SandboxRuntimeKind, sandboxIdOf } from "./SandboxRuntime.ts";
import { sandboxSpaceOf } from "./sandboxSpace.ts";

/** How long a starting Sandbox has to connect before its start counts as failed. */
const START_TIMEOUT = "2 minutes";
/** Seconds without turns, terminals or previews before a running Sandbox stops. */
const IDLE_TIMEOUT_SETTING = "T3CODE_SANDBOX_IDLE_SECONDS";
const DEFAULT_IDLE_TIMEOUT_SECONDS = 30 * 60;
/** A Sandbox that exits by itself more often than this within the window is left `failed`. */
const CRASH_RESTART_LIMIT = 3;
const CRASH_RESTART_WINDOW_MS = 10 * 60 * 1000;
/** After a failed start, a User's work tries again only once this much time has passed. */
const RETRY_BACKOFF_MS = 10_000;
/** Seconds between measurements of running Sandboxes' homes against their disk limit. */
const DISK_CHECK_SETTING = "T3CODE_SANDBOX_DISK_CHECK_SECONDS";
const DEFAULT_DISK_CHECK_SECONDS = 60;
/** The longest a caller waits for a start it asked for; the start itself has its own timeout. */
const CALLER_WAIT = "3 minutes";

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
export type SandboxStartVia = "demand" | "retry" | "settings" | "restart";

/** Why a Sandbox was stopped, as the audit log records it. */
export type SandboxStopVia = "archived" | "idle" | "settings" | "restart" | "disk-full";

/**
 * How long a Sandbox may idle and may take to start, and the clock the idle stop reads (a test's
 * TestClock). Absent: `T3CODE_SANDBOX_IDLE_SECONDS` (else 30 minutes), 2 minutes, the Hub's clock.
 */
export class SandboxLifecyclePolicy extends Context.Service<
  SandboxLifecyclePolicy,
  {
    readonly idleTimeout?: Duration.Input;
    readonly startTimeout?: Duration.Input;
    /** How often running Sandboxes' homes are measured against their disk limit. */
    readonly diskCheckEvery?: Duration.Input;
    readonly clock?: Clock.Clock;
  }
>()("t3/sandboxes/Sandboxes/SandboxLifecyclePolicy") {}

/** One Sandbox with its limits and what it uses, for Settings. */
export interface SandboxDetailRow {
  readonly spaceId: SpaceId;
  readonly environmentId: EnvironmentId;
  readonly runtime: SandboxRuntimeKind;
  readonly imageVersion: string | null;
  /** When it last became running (its uptime while it runs). */
  readonly startedAt: string | null;
  /** The Space's own values; null takes the default. */
  readonly overrides: SandboxLimits;
  /** What it starts with. */
  readonly limits: SandboxLimits;
  readonly usage: {
    readonly cpuPercent: number | null;
    readonly memoryBytes: number | null;
    readonly diskBytes: number | null;
    readonly diskMeasuredAt: string | null;
  };
}

export interface SandboxOverview {
  readonly defaults: SandboxLimits;
  /** What the runtime enforces here, with the Hub's own disk check. */
  readonly enforcement: {
    readonly cpus: boolean;
    readonly memory: boolean;
    readonly pids: boolean;
    readonly disk: boolean;
    readonly note: string | null;
  };
  readonly sandboxes: ReadonlyArray<SandboxDetailRow>;
}

export class SandboxNotFoundError extends Schema.TaggedError<SandboxNotFoundError>()(
  "SandboxNotFoundError",
  { spaceId: Schema.String },
) {}

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
    /**
     * Starts it (joining a start under way) and waits until it is connected and its executor
     * serves. The start is the Hub's: a caller that stops waiting does not stop it.
     */
    readonly ensureRunning: (input: {
      readonly spaceId: SpaceId;
      readonly actorUserId: UserId | undefined;
      readonly via?: SandboxStartVia;
    }) => Effect.Effect<EnvironmentId, SandboxStartError>;
    /** Starts it in the background (joining one under way); answers once it is `starting`. */
    readonly requestStart: (input: {
      readonly spaceId: SpaceId;
      readonly actorUserId: UserId | undefined;
      readonly via: SandboxStartVia;
    }) => Effect.Effect<void>;
    /** The Sandboxes that exist, by Space. */
    readonly list: Effect.Effect<ReadonlyArray<SandboxStatusRow>, SandboxStartError>;
    /**
     * Stops the Space's Sandbox, keeping its home: its Organization was archived (the default
     * `via`), or the Owner stopped it.
     */
    readonly stop: (input: {
      readonly spaceId: SpaceId;
      readonly actor: AuditLog.AuditActor;
      readonly via?: "archived" | "settings";
    }) => Effect.Effect<void, SandboxStartError>;
    /** The Owner restarts it: stopped, then started in the background with its current limits. */
    readonly restart: (input: {
      readonly spaceId: SpaceId;
      readonly actorUserId: UserId;
    }) => Effect.Effect<void, SandboxStartError>;
    /** Each Sandbox `include` keeps, with its limits and use; the Installation's defaults. */
    readonly overview: (
      include: (spaceId: SpaceId) => boolean,
    ) => Effect.Effect<SandboxOverview, SandboxStartError>;
    /**
     * Changes the Installation's defaults (no `spaceId`) or a Space's override, audited. Applies
     * on each Sandbox's next start; the disk limit is checked again at once.
     */
    readonly setLimits: (input: {
      readonly spaceId: SpaceId | undefined;
      readonly limits: SandboxLimits;
      readonly actor: AuditLog.AuditActor;
    }) => Effect.Effect<void, SandboxNotFoundError | SandboxStartError>;
    /**
     * Measures each running Sandbox's home and stops, as `failed` with why, each one over its
     * disk limit; run on a schedule.
     */
    readonly checkDisk: Effect.Effect<void>;
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

/** A start under way: settled once it is running or failed; `begun` once it is `starting`. */
interface InFlight {
  readonly done: Deferred.Deferred<EnvironmentId, SandboxStartError>;
  readonly begun: Deferred.Deferred<void>;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runtime = yield* SandboxRuntime;
  const audit = yield* AuditLog.AuditLog;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const connections = yield* EnvironmentConnections.EnvironmentConnections;
  const random = yield* SecureRandom.SecureRandom;
  const digester = yield* Digest.Digest;
  const hubId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity).getEnvironmentId;
  const policy = yield* Effect.serviceOption(SandboxLifecyclePolicy);
  const policyValue = <K extends "idleTimeout" | "startTimeout" | "diskCheckEvery" | "clock">(
    key: K,
  ) => Option.flatMap(policy, (value) => Option.fromUndefinedOr(value[key]));
  const clock = Option.getOrUndefined(policyValue("clock")) ?? (yield* Clock.Clock);
  const configuredSeconds = yield* Config.Int(IDLE_TIMEOUT_SETTING).pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<number>()),
  );
  const idleTimeoutMs = Option.match(policyValue("idleTimeout"), {
    onSome: (timeout) => Duration.toMillis(Duration.fromInputUnsafe(timeout)),
    onNone: () =>
      Math.max(
        1,
        Option.getOrElse(configuredSeconds, () => DEFAULT_IDLE_TIMEOUT_SECONDS),
      ) * 1000,
  });
  const configuredDiskSeconds = yield* Config.Int(DISK_CHECK_SETTING).pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<number>()),
  );
  const diskCheckEvery = Option.match(policyValue("diskCheckEvery"), {
    onSome: (every) => Duration.fromInputUnsafe(every),
    onNone: () =>
      Duration.seconds(
        Math.max(
          5,
          Option.getOrElse(configuredDiskSeconds, () => DEFAULT_DISK_CHECK_SECONDS),
        ),
      ),
  });
  const startTimeout = Option.getOrElse(
    policyValue("startTimeout"),
    (): Duration.Input => START_TIMEOUT,
  );
  const serviceScope = yield* Effect.scope;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nowMs = () => clock.currentTimeMillisUnsafe();
  // Held only for short transitions (made, marked starting, stopped), never across a boot.
  const locks = new Map<SpaceId, Semaphore.Semaphore>();
  const lockOf = (spaceId: SpaceId) => {
    let lock = locks.get(spaceId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(spaceId, lock);
    }
    return lock;
  };
  const locked = <A, E, R>(spaceId: SpaceId, effect: Effect.Effect<A, E, R>) =>
    lockOf(spaceId).withPermits(1)(effect);

  // The one start under way per Space, and the idle stop under way.
  const inFlight = new Map<SpaceId, InFlight>();
  const stopping = new Map<SpaceId, Deferred.Deferred<void>>();
  // When each Sandbox's last start failed (the backoff), and when it last exited by itself.
  const failedAt = new Map<SpaceId, number>();
  const crashes = new Map<SpaceId, Array<number>>();

  // What keeps each Sandbox from idling: its last use, and each thing that holds it open now.
  const lastUse = new Map<EnvironmentId, number>();
  const holds = new Map<EnvironmentId, Set<object>>();
  const touch = (environmentId: EnvironmentId) =>
    Effect.sync(() => {
      if (sandboxSpaceOf(environmentId) !== undefined) lastUse.set(environmentId, nowMs());
    });

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

  interface LimitColumns {
    readonly cpus: number | null;
    readonly memoryBytes: number | null;
    readonly pids: number | null;
    readonly diskBytes: number | null;
  }
  const toLimits = (row: LimitColumns): SandboxLimits => ({
    cpus: row.cpus,
    memoryBytes: row.memoryBytes,
    pids: row.pids,
    diskBytes: row.diskBytes,
  });
  /** The Installation's defaults (migration 104's row; the built-in ones if it is gone). */
  const readDefaults = sql<LimitColumns>`
    SELECT cpu_limit AS cpus, memory_limit_bytes AS "memoryBytes", pids_limit AS pids,
      disk_limit_bytes AS "diskBytes"
    FROM sandbox_limit_defaults WHERE id = 1
  `.pipe(
    Effect.map((rows) => (rows[0] === undefined ? BUILT_IN_DEFAULT_LIMITS : toLimits(rows[0]))),
  );
  const readOverrides = (spaceId: SpaceId) =>
    sql<LimitColumns>`
      SELECT cpu_limit AS cpus, memory_limit_bytes AS "memoryBytes", pids_limit AS pids,
        disk_limit_bytes AS "diskBytes"
      FROM sandboxes WHERE space_id = ${spaceId}
    `.pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : toLimits(rows[0]))));
  /** The limits the Space's Sandbox starts with: its override over the defaults. */
  const limitsOf = Effect.fn("Sandboxes.limitsOf")(function* (spaceId: SpaceId) {
    const defaults = yield* readDefaults;
    const overrides = yield* readOverrides(spaceId);
    return overrides === undefined ? defaults : effectiveLimits(defaults, overrides);
  });

  // Each home's size when last measured; whether `du` works here at all.
  const diskUse = new Map<SpaceId, { readonly bytes: number; readonly at: string }>();
  let diskMeasurable = true;
  /** Measures the Sandbox's home now; null when it has none or it cannot be measured. */
  const measureDisk = Effect.fn("Sandboxes.measureDisk")(function* (spaceId: SpaceId) {
    const inspected = yield* runtime.inspect(sandboxIdOf(spaceId));
    if (inspected.state._tag === "missing") return null;
    const bytes = yield* homeUsageBytes(inspected.homePath);
    diskMeasurable = bytes !== null;
    if (bytes === null) return null;
    diskUse.set(spaceId, { bytes, at: yield* nowIso });
    return bytes;
  });

  /** Threads on the Sandbox with a run in progress; one that cannot be read counts as busy. */
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
      Effect.orElseSucceed(() => 1),
    );

  const actorOf = (actorUserId: UserId | undefined): AuditLog.AuditActor =>
    actorUserId === undefined ? { source: "system" } : AuditLog.userActor(actorUserId);

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
            actor: actorOf(input.actorUserId),
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
      });
      return { environmentId, name, running: false };
    }
    return { environmentId, name, running: inspected.state._tag === "running" };
  });

  /**
   * One start, owned by the service: marked `starting` under the lock, booted outside it, and
   * always ended `running` or `failed`. A server that did not become ready is stopped first, so
   * nothing runs that the Hub does not track.
   */
  const runStart = Effect.fn("Sandboxes.runStart")(function* (
    input: {
      readonly spaceId: SpaceId;
      readonly actorUserId: UserId | undefined;
      readonly via: SandboxStartVia;
    },
    begun: Deferred.Deferred<void>,
  ) {
    const { spaceId } = input;
    const sandboxId = sandboxIdOf(spaceId);
    const environmentId = sandboxEnvironmentIdOf(spaceId);
    // An idle stop under way ends first; the start then begins from a stopped Sandbox.
    const stop = stopping.get(spaceId);
    if (stop !== undefined) yield* Deferred.await(stop);
    let launched = false;
    let name: string | undefined;
    const attempt = Effect.gen(function* () {
      const created = yield* locked(
        spaceId,
        Effect.gen(function* () {
          const made = yield* createLocked(input);
          if (!made.running) yield* setStatus(spaceId, "starting");
          return made;
        }),
      ).pipe(Effect.ensuring(Deferred.succeed(begun, undefined)));
      name = created.name;
      // Read at each start: a limit changed while it was stopped applies now.
      const limits = yield* limitsOf(spaceId);
      if (!created.running && limits.diskBytes !== null) {
        // A home over its disk limit does not start: it would be stopped again at once.
        const used = yield* measureDisk(spaceId);
        if (used !== null && used > limits.diskBytes) {
          return yield* Effect.fail(diskFullMessage(used, limits.diskBytes));
        }
      }
      launched = true;
      const started = yield* runtime.start(sandboxId, { limits });
      // Ready once welcomed with its executor serving; a server that ends first fails at once.
      const ready = yield* Effect.raceFirst(
        connections.awaitReady(environmentId).pipe(Effect.as("ready" as const)),
        started.exited.pipe(Effect.map((exitCode) => ({ exitCode }))),
      ).pipe(Effect.timeoutOption(startTimeout));
      if (Option.isNone(ready)) {
        return yield* Effect.fail("it did not connect to the Hub in time.");
      }
      if (ready.value !== "ready") {
        return yield* Effect.fail(
          `its server exited before connecting (exit code ${ready.value.exitCode ?? "unknown"}).`,
        );
      }
      yield* locked(
        spaceId,
        Effect.gen(function* () {
          yield* touch(environmentId);
          failedAt.delete(spaceId);
          if (created.running) return;
          yield* setStatus(spaceId, "running");
          yield* audit.record({
            actor: actorOf(input.actorUserId),
            action: "sandbox.start",
            spaceId,
            target: { kind: "environment", id: environmentId, name: created.name },
            detail: { via: input.via, outcome: "started" },
          });
        }),
      );
      return environmentId;
    });
    const fail = Effect.fn("Sandboxes.failStart")(function* (detail: string) {
      if (launched) {
        // Verified stop: the runtime waits for the server to end (killing it if it must).
        yield* runtime.stop(sandboxId).pipe(Effect.ignore);
        yield* connections.close(environmentId, "heartbeat-timeout");
      }
      failedAt.set(spaceId, nowMs());
      yield* setStatus(spaceId, "failed", detail).pipe(Effect.ignore);
      yield* audit
        .record({
          actor: actorOf(input.actorUserId),
          action: "sandbox.start",
          spaceId,
          target: {
            kind: "environment",
            id: environmentId,
            ...(name === undefined ? {} : { name }),
          },
          detail: { via: input.via, outcome: "failed", reason: detail.slice(0, 200) },
        })
        .pipe(Effect.ignore);
      return yield* new SandboxStartError({ spaceId, detail });
    });
    return yield* attempt.pipe(
      Effect.catchCause((cause) => fail(errorDetail(Cause.squash(cause)))),
      // The Hub shutting down mid-start still leaves no Sandbox `starting`.
      Effect.onInterrupt(() => fail("its start was interrupted.").pipe(Effect.ignore)),
    );
  });

  /** The start under way for the Space, or a new one: never two at once. */
  const startOnce = (input: {
    readonly spaceId: SpaceId;
    readonly actorUserId: UserId | undefined;
    readonly via: SandboxStartVia;
  }) =>
    Effect.suspend(() => {
      const current = inFlight.get(input.spaceId);
      if (current !== undefined) return Effect.succeed(current);
      const entry: InFlight = {
        done: Deferred.makeUnsafe<EnvironmentId, SandboxStartError>(),
        begun: Deferred.makeUnsafe<void>(),
      };
      inFlight.set(input.spaceId, entry);
      return runStart(input, entry.begun).pipe(
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(entry.done, exit)),
        Effect.ensuring(
          Effect.suspend(() => {
            if (inFlight.get(input.spaceId) === entry) inFlight.delete(input.spaceId);
            return Deferred.succeed(entry.begun, undefined);
          }),
        ),
        Effect.forkIn(serviceScope),
        Effect.as(entry),
      );
    });

  const awaitStart = (entry: InFlight, spaceId: SpaceId) =>
    Deferred.await(entry.done).pipe(
      Effect.timeoutOption(CALLER_WAIT),
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              new SandboxStartError({ spaceId, detail: "it is taking too long to start." }),
            ),
        }),
      ),
    );

  const ensureCreated: Sandboxes["Service"]["ensureCreated"] = (input) =>
    locked(input.spaceId, createLocked(input)).pipe(
      Effect.map((created) => created.environmentId),
      Effect.mapError(
        (cause) => new SandboxStartError({ spaceId: input.spaceId, detail: errorDetail(cause) }),
      ),
    );

  const ensureRunning: Sandboxes["Service"]["ensureRunning"] = (input) =>
    startOnce({ ...input, via: input.via ?? "demand" }).pipe(
      Effect.flatMap((entry) => awaitStart(entry, input.spaceId)),
    );

  const requestStart: Sandboxes["Service"]["requestStart"] = (input) =>
    startOnce(input).pipe(Effect.flatMap((entry) => Deferred.await(entry.begun)));

  const list: Sandboxes["Service"]["list"] = sql<SandboxStatusRow>`
    SELECT space_id AS "spaceId", environment_id AS "environmentId", status,
      last_error AS "lastError"
    FROM sandboxes ORDER BY created_at
  `.pipe(Effect.mapError((cause) => new SandboxStartError({ spaceId: "", detail: String(cause) })));

  const stopLocked = Effect.fn("Sandboxes.stopLocked")(function* (input: {
    readonly spaceId: SpaceId;
    readonly actor: AuditLog.AuditActor;
    readonly via: SandboxStopVia;
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
    lastUse.delete(row.environmentId);
    if (!wasRunning) return;
    yield* audit.record({
      actor: input.actor,
      action: "sandbox.stop",
      spaceId,
      target: { kind: "environment", id: row.environmentId },
      detail: { via: input.via },
    });
  });

  /** A start under way ends (either way) before the Sandbox is stopped or deleted. */
  const settleStart = (spaceId: SpaceId) =>
    Effect.suspend(() => {
      const current = inFlight.get(spaceId);
      return current === undefined ? Effect.void : Deferred.await(current.done).pipe(Effect.ignore);
    });

  const stopVia = (
    input: { readonly spaceId: SpaceId; readonly actor: AuditLog.AuditActor },
    via: SandboxStopVia,
  ) =>
    settleStart(input.spaceId).pipe(
      Effect.andThen(locked(input.spaceId, stopLocked({ ...input, via }))),
      Effect.mapError(
        (cause) => new SandboxStartError({ spaceId: input.spaceId, detail: String(cause) }),
      ),
      Effect.withSpan("Sandboxes.stop", { attributes: { via } }),
    );

  const stop: Sandboxes["Service"]["stop"] = (input) => stopVia(input, input.via ?? "archived");

  const restart: Sandboxes["Service"]["restart"] = ({ spaceId, actorUserId }) =>
    stopVia({ spaceId, actor: AuditLog.userActor(actorUserId) }, "restart").pipe(
      Effect.andThen(requestStart({ spaceId, actorUserId, via: "restart" })),
    );

  const overview: Sandboxes["Service"]["overview"] = Effect.fn("Sandboxes.overview")(
    function* (include) {
      const defaults = yield* readDefaults;
      const support = yield* runtime.limitSupport;
      const rows = yield* sql<
        LimitColumns & {
          readonly spaceId: SpaceId;
          readonly environmentId: EnvironmentId;
          readonly runtime: SandboxRuntimeKind;
          readonly status: SandboxStatusRow["status"];
          readonly imageVersion: string | null;
          readonly startedAt: string | null;
        }
      >`
        SELECT space_id AS "spaceId", environment_id AS "environmentId", runtime, status,
          image_version AS "imageVersion", started_at AS "startedAt", cpu_limit AS cpus,
          memory_limit_bytes AS "memoryBytes", pids_limit AS pids, disk_limit_bytes AS "diskBytes"
        FROM sandboxes ORDER BY created_at
      `;
      const sandboxes = yield* Effect.forEach(
        rows.filter((row) => include(row.spaceId)),
        Effect.fnUntraced(function* (row) {
          const overrides = toLimits(row);
          const running = row.status === "running";
          const use = running ? yield* runtime.resourceUse(sandboxIdOf(row.spaceId)) : null;
          // A home never measured is measured once; a running one again by each disk check.
          if (!diskUse.has(row.spaceId)) yield* measureDisk(row.spaceId).pipe(Effect.ignore);
          const disk = diskUse.get(row.spaceId);
          return {
            spaceId: row.spaceId,
            environmentId: row.environmentId,
            runtime: row.runtime,
            imageVersion: row.imageVersion,
            startedAt: running ? row.startedAt : null,
            overrides,
            limits: effectiveLimits(defaults, overrides),
            usage: {
              cpuPercent: use?.cpuPercent ?? null,
              memoryBytes: use?.memoryBytes ?? null,
              diskBytes: disk?.bytes ?? null,
              diskMeasuredAt: disk?.at ?? null,
            },
          } satisfies SandboxDetailRow;
        }),
        { concurrency: 4 },
      );
      const notes = [
        support.note,
        diskMeasurable
          ? null
          : "A Sandbox's disk use cannot be measured on this host (no `du`): the disk limit is not enforced.",
      ].filter((note) => note !== null);
      return {
        defaults,
        enforcement: {
          cpus: support.cpus,
          memory: support.memory,
          pids: support.pids,
          disk: diskMeasurable,
          note: notes.length === 0 ? null : notes.join(" "),
        },
        sandboxes,
      } satisfies SandboxOverview;
    },
    Effect.mapError((cause) => new SandboxStartError({ spaceId: "", detail: String(cause) })),
  );

  /**
   * Stops a running Sandbox whose home is over its disk limit, leaving it `failed` with why: its
   * Threads show it, and it starts again only once there is room (the Owner raises the limit).
   */
  const checkDiskOf = Effect.fn("Sandboxes.checkDiskOf")(
    function* (spaceId: SpaceId) {
      const current = yield* selectRow(spaceId);
      if (current?.status !== "running" || inFlight.has(spaceId)) return;
      const limits = yield* limitsOf(spaceId);
      const used = yield* measureDisk(spaceId);
      if (limits.diskBytes === null || used === null || used <= limits.diskBytes) return;
      const limit = limits.diskBytes;
      yield* locked(
        spaceId,
        Effect.gen(function* () {
          if ((yield* selectRow(spaceId))?.status !== "running") return;
          yield* Effect.logWarning("Stopping a Sandbox over its disk limit", {
            spaceId,
            usedBytes: used,
            limitBytes: limit,
          });
          yield* stopLocked({ spaceId, actor: { source: "system" }, via: "disk-full" });
          failedAt.set(spaceId, nowMs());
          yield* setStatus(spaceId, "failed", diskFullMessage(used, limit));
        }),
      );
    },
    (effect, spaceId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not check a Sandbox's disk", {
            spaceId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
  );

  const checkDisk: Sandboxes["Service"]["checkDisk"] = list.pipe(
    Effect.orElseSucceed(() => []),
    Effect.flatMap((rows) =>
      Effect.forEach(
        rows.filter((row) => row.status === "running"),
        (row) => checkDiskOf(row.spaceId),
        { concurrency: 4, discard: true },
      ),
    ),
    Effect.withSpan("Sandboxes.checkDisk"),
  );

  const setLimits: Sandboxes["Service"]["setLimits"] = Effect.fn("Sandboxes.setLimits")(
    function* ({ spaceId, limits, actor }) {
      const now = yield* nowIso;
      const environmentId = spaceId === undefined ? undefined : sandboxEnvironmentIdOf(spaceId);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (spaceId === undefined) {
            yield* sql`
              INSERT INTO sandbox_limit_defaults (
                id, cpu_limit, memory_limit_bytes, pids_limit, disk_limit_bytes, updated_at
              ) VALUES (
                1, ${limits.cpus}, ${limits.memoryBytes}, ${limits.pids}, ${limits.diskBytes},
                ${now}
              )
              ON CONFLICT (id) DO UPDATE SET cpu_limit = excluded.cpu_limit,
                memory_limit_bytes = excluded.memory_limit_bytes,
                pids_limit = excluded.pids_limit, disk_limit_bytes = excluded.disk_limit_bytes,
                updated_at = excluded.updated_at
            `;
          } else {
            if ((yield* selectRow(spaceId)) === undefined) {
              return yield* new SandboxNotFoundError({ spaceId });
            }
            yield* sql`
              UPDATE sandboxes SET cpu_limit = ${limits.cpus},
                memory_limit_bytes = ${limits.memoryBytes}, pids_limit = ${limits.pids},
                disk_limit_bytes = ${limits.diskBytes}, updated_at = ${now}
              WHERE space_id = ${spaceId}
            `;
          }
          yield* audit.record({
            actor,
            action: "sandbox.limits.change",
            spaceId: spaceId ?? null,
            target:
              environmentId === undefined
                ? { kind: "environment", id: "sandboxes", name: "Default Sandbox limits" }
                : { kind: "environment", id: environmentId },
            detail: {
              scope: spaceId === undefined ? "defaults" : "space",
              cpus: limits.cpus,
              memoryBytes: limits.memoryBytes,
              pids: limits.pids,
              diskBytes: limits.diskBytes,
            },
          });
        }),
      );
      // A lower disk limit counts at once; the others on the next start.
      yield* (spaceId === undefined ? checkDisk : checkDiskOf(spaceId)).pipe(
        Effect.forkIn(serviceScope),
      );
    },
    Effect.catchTags({
      SqlError: (cause) =>
        Effect.fail(new SandboxStartError({ spaceId: "", detail: String(cause) })),
      AuditLogWriteError: (cause) =>
        Effect.fail(new SandboxStartError({ spaceId: "", detail: String(cause) })),
    }),
  );

  const remove: Sandboxes["Service"]["delete"] = Effect.fn("Sandboxes.delete")(
    function* ({ spaceId, actor }) {
      const row = yield* selectRow(spaceId);
      const environmentId = sandboxEnvironmentIdOf(spaceId);
      yield* runtime.delete(sandboxIdOf(spaceId));
      lastUse.delete(environmentId);
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
    (effect, input) =>
      settleStart(input.spaceId).pipe(Effect.andThen(locked(input.spaceId, effect))),
    (effect, input) =>
      Effect.mapError(
        effect,
        (cause) => new SandboxStartError({ spaceId: input.spaceId, detail: String(cause) }),
      ),
  );

  /** No run in progress on it, nothing holding it, and no use for the idle timeout. */
  const isIdle = Effect.fn("Sandboxes.isIdle")(function* (environmentId: EnvironmentId) {
    if ((holds.get(environmentId)?.size ?? 0) > 0) return false;
    if ((yield* unfinishedRuns(environmentId)) > 0) {
      lastUse.set(environmentId, nowMs());
      return false;
    }
    const last = lastUse.get(environmentId);
    if (last === undefined) {
      lastUse.set(environmentId, nowMs());
      return false;
    }
    return nowMs() - last >= idleTimeoutMs;
  });

  /**
   * Stops one Sandbox if it is idle. Under its lock it is marked stopping before being checked
   * again, so work that arrives meanwhile waits for the stop and then starts it again.
   */
  const stopIfIdle = Effect.fn("Sandboxes.stopIfIdle")(
    function* (row: SandboxStatusRow) {
      if (row.status !== "running" || inFlight.has(row.spaceId)) return;
      if (!(yield* isIdle(row.environmentId))) return;
      const done = Deferred.makeUnsafe<void>();
      yield* locked(
        row.spaceId,
        Effect.gen(function* () {
          stopping.set(row.spaceId, done);
          const current = yield* selectRow(row.spaceId);
          if (current?.status !== "running" || !(yield* isIdle(row.environmentId))) return;
          yield* Effect.logInfo("Stopping an idle Sandbox", { spaceId: row.spaceId });
          yield* stopLocked({ spaceId: row.spaceId, actor: { source: "system" }, via: "idle" });
        }),
      ).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            if (stopping.get(row.spaceId) === done) stopping.delete(row.spaceId);
            return Deferred.succeed(done, undefined);
          }),
        ),
      );
    },
    (effect, row) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not stop an idle Sandbox", {
            spaceId: row.spaceId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
  );

  // Each Space on its own: one Sandbox slow to stop holds back no other.
  const stopIdle: Sandboxes["Service"]["stopIdle"] = list.pipe(
    Effect.orElseSucceed(() => []),
    Effect.flatMap((rows) =>
      Effect.forEach(rows, stopIfIdle, { concurrency: "unbounded", discard: true }),
    ),
    Effect.withSpan("Sandboxes.stopIdle"),
  );

  // What the runtime does not run is not running, whatever the last Hub recorded.
  const recorded = yield* list.pipe(Effect.orElseSucceed(() => []));
  for (const row of recorded) {
    if (row.status !== "starting" && row.status !== "running") continue;
    const inspected = yield* runtime.inspect(sandboxIdOf(row.spaceId)).pipe(Effect.option);
    if (Option.isSome(inspected) && inspected.value.state._tag === "running") continue;
    yield* setStatus(row.spaceId, "stopped").pipe(Effect.ignore);
  }
  // A running server that ended by itself counts as stopped, and every such exit counts toward
  // the crash limit; past it the Sandbox is `failed` until a User starts it. One that ended under
  // a turn starts again, so the turn resumes or ends interrupted (spec 2).
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
        // A container killed under an enforced memory limit ends with SIGKILL's code.
        const limits = yield* limitsOf(row.spaceId);
        const exitMessage =
          exit.exitCode === 137 &&
          limits.memoryBytes !== null &&
          (yield* runtime.limitSupport).memory
            ? `It was killed (exit code 137), most likely for going over its memory limit of ${(limits.memoryBytes / 1024 ** 3).toFixed(1)} GiB.`
            : `It exited with code ${exit.exitCode ?? "?"}.`;
        lastUse.delete(environmentId);
        // Its socket is gone with it: its Threads are away now, as on any machine that dropped.
        yield* connections.close(environmentId, "heartbeat-timeout");
        const now = nowMs();
        const recent = (crashes.get(row.spaceId) ?? []).filter(
          (at) => now - at < CRASH_RESTART_WINDOW_MS,
        );
        recent.push(now);
        crashes.set(row.spaceId, recent);
        if (recent.length > CRASH_RESTART_LIMIT) {
          failedAt.set(row.spaceId, now);
          yield* setStatus(row.spaceId, "failed", `It kept exiting. ${exitMessage}`);
          return;
        }
        yield* setStatus(row.spaceId, "stopped", exitMessage);
        if ((yield* unfinishedRuns(environmentId)) > 0) {
          yield* startOnce({ spaceId: row.spaceId, actorUserId: undefined, via: "demand" });
        }
      }).pipe(Effect.ignore),
    ),
    Effect.forkScoped,
  );
  // Only the wait between checks runs on the idle clock; stopping runs on the Hub's own.
  const checkEvery = Duration.millis(Math.min(60_000, Math.max(1_000, idleTimeoutMs / 4)));
  yield* clock.sleep(checkEvery).pipe(Effect.andThen(stopIdle), Effect.forever, Effect.forkScoped);
  yield* clock
    .sleep(diskCheckEvery)
    .pipe(Effect.andThen(checkDisk), Effect.forever, Effect.forkScoped);

  // What the runtime does not enforce here is said once in the log, and in Settings.
  const support = yield* runtime.limitSupport;
  if (support.note !== null) {
    yield* Effect.logWarning("Sandbox limits not enforced on this host", { note: support.note });
  }

  /** Running and not being stopped: work goes straight to it. */
  const readyNow = (spaceId: SpaceId, environmentId: EnvironmentId) =>
    stopping.has(spaceId) ? Effect.succeed(false) : connections.isReady(environmentId);

  const service = Sandboxes.of({
    ensureCreated,
    ensureRunning,
    requestStart,
    list,
    stop,
    delete: remove,
    stopIdle,
    restart,
    overview,
    setLimits,
    checkDisk,
  });

  const demand = EnvironmentDemand.EnvironmentDemand.of({
    ready: Effect.fn("Sandboxes.ready")(function* (environmentId) {
      const spaceId = sandboxSpaceOf(environmentId);
      if (spaceId === undefined) return true;
      return yield* readyNow(spaceId, environmentId);
    }),
    awaitStarted: Effect.fn("Sandboxes.awaitStarted")(function* (environmentId, options) {
      const spaceId = sandboxSpaceOf(environmentId);
      if (spaceId === undefined) return;
      const startError = (detail: string) =>
        new EnvironmentDemand.EnvironmentStartError({ environmentId, detail });
      if (yield* readyNow(spaceId, environmentId)) return yield* touch(environmentId);
      // Work that lands while it is being stopped starts it again once the stop ends.
      const stop = stopping.get(spaceId);
      if (stop !== undefined) yield* Deferred.await(stop);
      if (!inFlight.has(spaceId)) {
        const row = yield* selectRow(spaceId).pipe(Effect.orElseSucceed(() => undefined));
        if (row?.status === "failed") {
          const lastFailure = failedAt.get(spaceId);
          // Only a User's own action starts a failed Sandbox, and not again right away.
          if (
            !options.explicit ||
            (lastFailure !== undefined && nowMs() - lastFailure < RETRY_BACKOFF_MS)
          ) {
            return yield* startError(row.lastError ?? "its last start failed.");
          }
        }
      }
      const entry = yield* startOnce({
        spaceId,
        actorUserId: options.actorUserId,
        via: "demand",
      });
      yield* awaitStart(entry, spaceId).pipe(Effect.mapError((error) => startError(error.detail)));
    }),
    request: Effect.fn("Sandboxes.request")(function* (environmentIds) {
      for (const environmentId of environmentIds) {
        const spaceId = sandboxSpaceOf(environmentId);
        if (spaceId === undefined || inFlight.has(spaceId) || stopping.has(spaceId)) continue;
        const row = yield* selectRow(spaceId).pipe(Effect.orElseSucceed(() => undefined));
        // Waiting work never starts a failed Sandbox: a User does.
        if (row === undefined || row.status === "failed") continue;
        if (yield* connections.isReady(environmentId)) continue;
        yield* startOnce({ spaceId, actorUserId: undefined, via: "demand" });
      }
    }),
    touch,
    hold: Effect.fn("Sandboxes.hold")(function* (environmentId) {
      if (sandboxSpaceOf(environmentId) === undefined) return;
      // Each holder has its own key, so a late release never drops another's hold.
      const key = {};
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          let held = holds.get(environmentId);
          if (held === undefined) {
            held = new Set();
            holds.set(environmentId, held);
          }
          held.add(key);
          lastUse.set(environmentId, nowMs());
        }),
        () =>
          Effect.sync(() => {
            holds.get(environmentId)?.delete(key);
            lastUse.set(environmentId, nowMs());
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
