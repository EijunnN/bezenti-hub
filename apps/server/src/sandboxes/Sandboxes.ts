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
import * as PubSub from "effect/PubSub";
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
  DISK_MEASURE_FAILURES_ALLOWED,
  diskFullMessage,
  diskUnmeasurableMessage,
  effectiveLimits,
  fitLimitsToHost,
  formatBytes,
  hostCapacity,
  type HostSpace,
  hostSpaceLevel,
  hostSpaceShortage,
  invalidLimitsReason,
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
/** How long work a User sent keeps an image update off, until its turn reports in. */
const DISPATCH_GRACE_MS = 10_000;
/** Seconds between measurements of running Sandboxes' homes against their disk limit. */
const DISK_CHECK_SETTING = "T3CODE_SANDBOX_DISK_CHECK_SECONDS";
const DEFAULT_DISK_CHECK_SECONDS = 60;
/** How often running Sandboxes' CPU and memory are read for Settings. */
const USAGE_SAMPLE_EVERY = "10 seconds";
/** `du` runs at once on at most this many homes for the checks, and as many again for starts. */
const DISK_MEASURE_CONCURRENCY = 2;
/**
 * While the Hub's disk is below its floor, a Sandbox whose home grew more than this since it was
 * last measured is one writing to it, and stops.
 */
const HOST_LOW_GROWTH_BYTES = 16 * 1024 * 1024;
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
  /** Set while the Owner stopped it by hand: waiting work does not start it again. */
  readonly heldAt: string | null;
}

/** Why a start happened, as the audit log records it; `update`: moving it to a new image. */
export type SandboxStartVia = "demand" | "retry" | "settings" | "restart" | "update";

/** Why a Sandbox was stopped, as the audit log records it. */
export type SandboxStopVia =
  | "archived"
  | "idle"
  | "settings"
  | "restart"
  | "update"
  | "disk-full"
  | "host-disk-low";

/**
 * Why the Hub ended a Sandbox's provider sessions as it stopped it (its disk, or the Owner's
 * stop): its turns end interrupted.
 */
export interface SandboxSessionsEnded {
  readonly environmentId: EnvironmentId;
  readonly reason: "sandbox-disk-full" | "sandbox-stopped";
}

export class SandboxLimitsInvalidError extends Schema.TaggedError<SandboxLimitsInvalidError>()(
  "SandboxLimitsInvalidError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * Why a running Sandbox was not moved to the newest image: it has none (`missing`), a turn is in
 * progress on it (`busy`), or it is starting or stopping (`transition`).
 */
export class SandboxImageUpdateRefusedError extends Schema.TaggedError<SandboxImageUpdateRefusedError>()(
  "SandboxImageUpdateRefusedError",
  {
    spaceId: Schema.String,
    kind: Schema.Literals(["missing", "busy", "transition", "image-missing"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** A Sandbox and the image it runs, for the Owner's image view. */
export interface SandboxImageRow {
  readonly spaceId: SpaceId;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly status: SandboxStatusRow["status"];
  readonly imageVersion: string | null;
  /** A turn is in progress on it. */
  readonly busy: boolean;
}

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
    /** How often running Sandboxes' CPU and memory are sampled for Settings. */
    readonly usageSampleEvery?: Duration.Input;
    /** The Sandboxes' filesystem as a test fakes it, instead of the runtime's. */
    readonly hostSpace?: Effect.Effect<HostSpace | null>;
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
  /** What it starts with next. */
  readonly limits: SandboxLimits;
  /** What its running server was started with; null while it does not run. */
  readonly appliedLimits: SandboxLimits | null;
  /** The Owner stopped it by hand: only a User's or the Owner's start runs it again. */
  readonly heldByOwner: boolean;
  /** The background sampler's last reading; never measured on the way to Settings. */
  readonly usage: {
    readonly cpuPercent: number | null;
    readonly memoryBytes: number | null;
    readonly diskBytes: number | null;
    readonly diskMeasuredAt: string | null;
    /** Why its home's last measurement failed. */
    readonly diskError: string | null;
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
      /** `settings`: the Owner's, which holds it stopped until a User or the Owner starts it. */
      readonly via?: "archived" | "settings";
    }) => Effect.Effect<void, SandboxStartError>;
    /** Each time the Hub ended a Sandbox's sessions as it stopped it (its disk). */
    readonly sessionsEnded: Stream.Stream<SandboxSessionsEnded>;
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
    }) => Effect.Effect<void, SandboxNotFoundError | SandboxLimitsInvalidError | SandboxStartError>;
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
    readonly runtimeKind: SandboxRuntimeKind;
    /** Each Sandbox with the image version it last started with. */
    readonly listImages: Effect.Effect<ReadonlyArray<SandboxImageRow>, SandboxStartError>;
    /**
     * Moves a running Sandbox to the newest image by starting it again, at the Owner's request,
     * never with a turn in progress on it (refused, saying why). A stopped one is left as it is:
     * its next start runs the newest image anyway.
     */
    readonly updateImage: (input: {
      readonly spaceId: SpaceId;
      readonly actorUserId: UserId | undefined;
      readonly actor: AuditLog.AuditActor;
    }) => Effect.Effect<
      {
        readonly outcome: "updated" | "next-start" | "up-to-date";
        readonly imageVersion: string | null;
      },
      SandboxStartError | SandboxImageUpdateRefusedError
    >;
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
  const policyValue = <
    K extends
      | "idleTimeout"
      | "startTimeout"
      | "diskCheckEvery"
      | "usageSampleEvery"
      | "hostSpace"
      | "clock",
  >(
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
  const usageSampleEvery = Duration.fromInputUnsafe(
    Option.getOrElse(policyValue("usageSampleEvery"), (): Duration.Input => USAGE_SAMPLE_EVERY),
  );
  const readHostSpace = Option.getOrElse(policyValue("hostSpace"), () => runtime.hostSpace);
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
  // What an image update must not cut short: turns its connection reports running, and work a
  // User just sent to it whose run may not be recorded yet: each dispatch its own claim (when it
  // was made), which the next turn reporting in consumes, or which lapses after the grace.
  const liveTurns = new Map<EnvironmentId, Set<string>>();
  // Each dispatch's claim, by its own key: held (null) while the dispatch runs, then when it was
  // released, standing for the grace unless a turn reports in first.
  const claims = new Map<EnvironmentId, Map<object, number | null>>();
  /** How many claims stand on it now; lapsed ones are dropped. */
  const claimsOf = (environmentId: EnvironmentId) => {
    const of = claims.get(environmentId);
    if (of === undefined) return 0;
    const now = nowMs();
    for (const [key, releasedAt] of of) {
      if (releasedAt !== null && now - releasedAt >= DISPATCH_GRACE_MS) of.delete(key);
    }
    if (of.size === 0) claims.delete(environmentId);
    return of.size;
  };
  const touch = (environmentId: EnvironmentId) =>
    Effect.sync(() => {
      if (sandboxSpaceOf(environmentId) !== undefined) lastUse.set(environmentId, nowMs());
    });

  const selectRow = (spaceId: SpaceId) =>
    sql<SandboxStatusRow>`
      SELECT space_id AS "spaceId", environment_id AS "environmentId", status,
        last_error AS "lastError", held_at AS "heldAt"
      FROM sandboxes WHERE space_id = ${spaceId}
    `.pipe(Effect.map((rows) => rows[0]));

  const setStatus = Effect.fn("Sandboxes.setStatus")(function* (
    spaceId: SpaceId,
    status: SandboxStatusRow["status"],
    error?: string,
    /** Held by the Owner from now, in the same write. */
    hold?: boolean,
  ) {
    const now = yield* nowIso;
    const heldAt = hold === true ? now : null;
    yield* sql`
      UPDATE sandboxes SET status = ${status}, last_error = ${error ?? null},
        held_at = COALESCE(${heldAt}, held_at),
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

  /**
   * What the background samplers last read of each Sandbox; Settings reads only this. Its home's
   * size (with the failures in a row since the last good measurement), and its CPU and memory.
   */
  interface Sample {
    readonly diskBytes: number | null;
    readonly diskMeasuredAt: string | null;
    readonly diskError: string | null;
    readonly diskFailures: number;
    readonly cpuPercent: number | null;
    readonly memoryBytes: number | null;
  }
  const EMPTY_SAMPLE: Sample = {
    diskBytes: null,
    diskMeasuredAt: null,
    diskError: null,
    diskFailures: 0,
    cpuPercent: null,
    memoryBytes: null,
  };
  const samples = new Map<SpaceId, Sample>();
  const updateSample = (spaceId: SpaceId, change: Partial<Sample>) =>
    samples.set(spaceId, { ...(samples.get(spaceId) ?? EMPTY_SAMPLE), ...change });
  // Whether this host has `du` at all: without it no disk limit is enforced, and Settings says so.
  let diskMeasurable = true;
  // Few `du` at once: the checks and samplers share theirs, and starts have their own, so a slow
  // home measured by a check never holds back another Space's start.
  const checkPermits = Semaphore.makeUnsafe(DISK_MEASURE_CONCURRENCY);
  const startPermits = Semaphore.makeUnsafe(DISK_MEASURE_CONCURRENCY);
  // A Sandbox stopped for a home it could not measure, started again, runs until the checks fail
  // that many times again: its time to repair its files.
  const repairWindowSeconds = DISK_MEASURE_FAILURES_ALLOWED * Duration.toSeconds(diskCheckEvery);
  // The limits each running server was started with, and which start it is (a check that read
  // one start's state never stops the next).
  const applied = new Map<SpaceId, SandboxLimits>();
  const startEpochs = new Map<SpaceId, number>();

  /**
   * Measures the Sandbox's home now and records it. A failure counts toward
   * `DISK_MEASURE_FAILURES_ALLOWED`; null when it has no home or this host has no `du`.
   */
  const measureDisk = Effect.fn("Sandboxes.measureDisk")(function* (
    spaceId: SpaceId,
    permits: Semaphore.Semaphore = checkPermits,
  ) {
    const sandboxId = sandboxIdOf(spaceId);
    const inspected = yield* runtime.inspect(sandboxId);
    if (inspected.state._tag === "missing") return null;
    const measured = yield* permits.withPermits(1)(runtime.measureHome(sandboxId));
    const at = yield* nowIso;
    switch (measured._tag) {
      case "unavailable":
        diskMeasurable = false;
        return null;
      case "measured":
        diskMeasurable = true;
        updateSample(spaceId, {
          diskBytes: measured.bytes,
          diskMeasuredAt: at,
          diskError: null,
          diskFailures: 0,
        });
        return measured;
      case "failed": {
        diskMeasurable = true;
        const failures = (samples.get(spaceId)?.diskFailures ?? 0) + 1;
        updateSample(spaceId, {
          diskMeasuredAt: at,
          diskError: measured.reason,
          diskFailures: failures,
        });
        yield* Effect.logWarning("Could not measure a Sandbox's home", {
          spaceId,
          reason: measured.reason,
          failures,
        });
        return measured;
      }
    }
  });

  /**
   * Why a home over (or not measurably under) `limit` must stop, if it must: over it, or failed
   * `DISK_MEASURE_FAILURES_ALLOWED` times in a row (it fails closed).
   */
  const diskVerdict = (
    spaceId: SpaceId,
    measured: Effect.Success<ReturnType<typeof measureDisk>>,
    limit: number | null,
  ) => {
    if (limit === null || measured === null) return undefined;
    if (measured._tag === "measured") {
      return measured.bytes > limit ? diskFullMessage(measured.bytes, limit) : undefined;
    }
    return (samples.get(spaceId)?.diskFailures ?? 0) >= DISK_MEASURE_FAILURES_ALLOWED
      ? diskUnmeasurableMessage(measured.reason, repairWindowSeconds)
      : undefined;
  };

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
          // Whoever starts it (a User's work, the Owner) ends the Owner's hold.
          yield* sql`UPDATE sandboxes SET held_at = NULL WHERE space_id = ${spaceId}`;
          return made;
        }),
      ).pipe(Effect.ensuring(Deferred.succeed(begun, undefined)));
      name = created.name;
      // Read at each start: a limit changed while it was stopped applies now, at most what this
      // machine has (a Space's own may be set for a bigger dedicated machine).
      const limits = fitLimitsToHost(yield* limitsOf(spaceId), hostCapacity(null));
      if (!created.running) {
        // Nothing starts on a filesystem about to fill, which holds the Hub's database too.
        const shortage = hostSpaceShortage(yield* readHostSpace, "start");
        if (shortage !== undefined) return yield* Effect.fail(shortage);
        const measured = yield* measureDisk(spaceId, startPermits);
        // A home over its disk limit does not start: it would be stopped again at once.
        if (
          measured?._tag === "measured" &&
          limits.diskBytes !== null &&
          measured.bytes > limits.diskBytes
        ) {
          return yield* Effect.fail(diskFullMessage(measured.bytes, limits.diskBytes));
        }
        // One that cannot be measured starts, for its files to be repaired: the checks count its
        // failures from none again, and stop it once as many fail in a row.
        if (measured?._tag === "failed") updateSample(spaceId, { diskFailures: 0 });
      }
      launched = true;
      const started = yield* runtime.start(sandboxId, { limits });
      applied.set(spaceId, limits);
      startEpochs.set(spaceId, (startEpochs.get(spaceId) ?? 0) + 1);
      // Which image it runs, recorded once it is running.
      const imageVersion = started.imageVersion;
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
          yield* sql`
            UPDATE sandboxes SET image_version = ${imageVersion} WHERE space_id = ${spaceId}
          `;
          yield* sampleUsage.pipe(Effect.forkIn(serviceScope));
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
        applied.delete(spaceId);
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
      // One that already ended (its entry not yet dropped) is not joined: a new start begins.
      if (current !== undefined && !Deferred.isDoneUnsafe(current.done)) {
        return Effect.succeed(current);
      }
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
      last_error AS "lastError", held_at AS "heldAt"
    FROM sandboxes ORDER BY created_at
  `.pipe(Effect.mapError((cause) => new SandboxStartError({ spaceId: "", detail: String(cause) })));

  const sessionsEnded = yield* PubSub.unbounded<SandboxSessionsEnded>();

  /**
   * Marks it stopping while `effect` runs (unless something already did): work that arrives
   * meanwhile waits for the stop, and waiting work does not start it.
   */
  const markedStopping = <A, E, R>(spaceId: SpaceId, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      if (stopping.has(spaceId)) return effect;
      const done = Deferred.makeUnsafe<void>();
      stopping.set(spaceId, done);
      return effect.pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            if (stopping.get(spaceId) === done) stopping.delete(spaceId);
            return Deferred.succeed(done, undefined);
          }),
        ),
      );
    });

  /**
   * Stops it under its lock, marked stopping. Its server ends first (a failed stop leaves it
   * `running`, to be stopped again); then one write, `failed` with why or `stopped` with the
   * Owner's `hold`; then a failed or held one's turns end interrupted, and its socket closes.
   */
  const stopLocked = Effect.fn("Sandboxes.stopLocked")(
    function* (input: {
      readonly spaceId: SpaceId;
      readonly actor: AuditLog.AuditActor;
      readonly via: SandboxStopVia;
      readonly failed?: string;
      readonly hold?: boolean;
    }) {
      const { spaceId } = input;
      const row = yield* selectRow(spaceId);
      if (row === undefined) return;
      const sandboxId = sandboxIdOf(spaceId);
      const wasRunning = (yield* runtime.inspect(sandboxId)).state._tag === "running";
      yield* runtime.stop(sandboxId);
      applied.delete(spaceId);
      updateSample(spaceId, { cpuPercent: null, memoryBytes: null });
      lastUse.delete(row.environmentId);
      liveTurns.delete(row.environmentId);
      if (input.failed !== undefined) failedAt.set(spaceId, nowMs());
      yield* setStatus(
        spaceId,
        input.failed === undefined ? "stopped" : "failed",
        input.failed,
        input.hold === true,
      );
      const ended: SandboxSessionsEnded["reason"] | undefined =
        input.failed !== undefined
          ? "sandbox-disk-full"
          : input.hold === true
            ? "sandbox-stopped"
            : undefined;
      if (ended !== undefined) {
        yield* PubSub.publish(sessionsEnded, {
          environmentId: row.environmentId,
          reason: ended,
        } satisfies SandboxSessionsEnded);
      }
      // Its server is gone: its socket is not waited on to notice, so nothing takes it as ready.
      yield* connections.close(
        row.environmentId,
        input.failed === undefined ? "heartbeat-timeout" : "sandbox-disk-full",
      );
      if (!wasRunning) return;
      yield* audit.record({
        actor: input.actor,
        action: "sandbox.stop",
        spaceId,
        target: { kind: "environment", id: row.environmentId },
        detail: { via: input.via, ...(input.hold === true ? { hold: true } : {}) },
      });
    },
    (effect, input) => markedStopping(input.spaceId, effect),
  );

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
      Effect.andThen(
        locked(input.spaceId, stopLocked({ ...input, via, hold: via === "settings" })),
      ),
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

  /** Settings: the samplers' cache and the rows, nothing measured on the way. */
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
          readonly heldAt: string | null;
        }
      >`
        SELECT space_id AS "spaceId", environment_id AS "environmentId", runtime, status,
          image_version AS "imageVersion", started_at AS "startedAt", cpu_limit AS cpus,
          memory_limit_bytes AS "memoryBytes", pids_limit AS pids, disk_limit_bytes AS "diskBytes",
          held_at AS "heldAt"
        FROM sandboxes ORDER BY created_at
      `;
      const sandboxes = rows
        .filter((row) => include(row.spaceId))
        .map((row): SandboxDetailRow => {
          const overrides = toLimits(row);
          const running = row.status === "running";
          const sample = samples.get(row.spaceId) ?? EMPTY_SAMPLE;
          return {
            spaceId: row.spaceId,
            environmentId: row.environmentId,
            runtime: row.runtime,
            imageVersion: row.imageVersion,
            startedAt: running ? row.startedAt : null,
            overrides,
            limits: effectiveLimits(defaults, overrides),
            appliedLimits: running ? (applied.get(row.spaceId) ?? null) : null,
            heldByOwner: row.heldAt !== null,
            usage: {
              cpuPercent: running ? sample.cpuPercent : null,
              memoryBytes: running ? sample.memoryBytes : null,
              diskBytes: sample.diskBytes,
              diskMeasuredAt: sample.diskMeasuredAt,
              diskError: sample.diskError,
            },
          };
        });
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
   * Stops a running Sandbox whose home is over its disk limit (or could not be measured too many
   * times in a row), leaving it `failed` with why: its Threads show it, and it starts again only
   * once there is room. What the measurement was taken against is read again under the lock, so a
   * limit raised or a restart meanwhile is not stopped for a stale reading.
   */
  const checkDiskOf = Effect.fn("Sandboxes.checkDiskOf")(
    function* (spaceId: SpaceId) {
      const current = yield* selectRow(spaceId);
      if (current?.status !== "running") return;
      const limit = (yield* limitsOf(spaceId)).diskBytes;
      const epoch = startEpochs.get(spaceId);
      const measured = yield* measureDisk(spaceId);
      const why = diskVerdict(spaceId, measured, limit);
      if (why === undefined) return;
      yield* locked(
        spaceId,
        Effect.gen(function* () {
          if ((yield* selectRow(spaceId))?.status !== "running") return;
          if ((yield* limitsOf(spaceId)).diskBytes !== limit) return;
          if (startEpochs.get(spaceId) !== epoch) return;
          yield* Effect.logWarning("Stopping a Sandbox for its disk", { spaceId, why });
          yield* stopLocked({
            spaceId,
            actor: { source: "system" },
            via: "disk-full",
            failed: why,
          });
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

  /**
   * While the Sandboxes' filesystem is below its floor, the running Sandboxes writing to it stop,
   * failed with why: each whose home grew since it was last measured, or that cannot be measured
   * now (the cause may be no Sandbox at all, such as the Hub's logs). Below half the floor every
   * running one stops. Each on its own, at once, so none waits for another's stop.
   */
  const stopForHostSpace = Effect.fn("Sandboxes.stopForHostSpace")(function* (
    rows: ReadonlyArray<SandboxStatusRow>,
    level: "low" | "critical",
    why: string,
  ) {
    const running = rows.filter((row) => row.status === "running");
    const writing = yield* Effect.forEach(
      running,
      (row) =>
        level === "critical"
          ? Effect.succeed(true)
          : Effect.gen(function* () {
              const before = samples.get(row.spaceId)?.diskBytes ?? null;
              const measured = yield* measureDisk(row.spaceId);
              if (measured === null || measured._tag !== "measured" || before === null) {
                return true;
              }
              return measured.bytes - before > HOST_LOW_GROWTH_BYTES;
            }).pipe(Effect.orElseSucceed(() => true)),
      { concurrency: DISK_MEASURE_CONCURRENCY },
    );
    const toStop = running.filter((_, index) => writing[index] === true);
    yield* Effect.logWarning("Stopping Sandboxes: the Hub's disk is almost full", {
      why,
      level,
      stopping: toStop.map((row) => row.spaceId),
    });
    yield* Effect.forEach(
      toStop,
      (row) =>
        locked(
          row.spaceId,
          Effect.gen(function* () {
            if ((yield* selectRow(row.spaceId))?.status !== "running") return;
            yield* stopLocked({
              spaceId: row.spaceId,
              actor: { source: "system" },
              via: "host-disk-low",
              failed: why,
            });
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not stop a Sandbox for the Hub's disk", {
              spaceId: row.spaceId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

  /**
   * A server still running for a Sandbox recorded stopped or failed, with no start or stop under
   * way (a stop that ended half-way), is stopped again.
   */
  const stopStrays = (rows: ReadonlyArray<SandboxStatusRow>) =>
    Effect.forEach(
      rows.filter((row) => row.status === "stopped" || row.status === "failed"),
      (row) =>
        Effect.gen(function* () {
          if (inFlight.has(row.spaceId) || stopping.has(row.spaceId)) return;
          const sandboxId = sandboxIdOf(row.spaceId);
          if ((yield* runtime.inspect(sandboxId)).state._tag !== "running") return;
          yield* locked(
            row.spaceId,
            Effect.gen(function* () {
              const current = yield* selectRow(row.spaceId);
              if (current?.status !== "stopped" && current?.status !== "failed") return;
              if (inFlight.has(row.spaceId)) return;
              yield* Effect.logWarning("Stopping a Sandbox recorded as not running", {
                spaceId: row.spaceId,
              });
              yield* runtime.stop(sandboxId);
              applied.delete(row.spaceId);
              yield* connections.close(row.environmentId, "heartbeat-timeout");
            }),
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not stop a Sandbox recorded as not running", {
              spaceId: row.spaceId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { discard: true },
    );

  /**
   * The host's free space first (below its floor the Sandboxes writing to it stop), else each
   * running home against its limit, and once each home never measured.
   */
  const checkHomes = Effect.fn("Sandboxes.checkHomes")(function* (
    rows: ReadonlyArray<SandboxStatusRow>,
  ) {
    const space = yield* readHostSpace;
    const level = hostSpaceLevel(space);
    if (level !== "room") {
      return yield* stopForHostSpace(rows, level, hostSpaceShortage(space, "run") ?? "");
    }
    yield* Effect.forEach(
      rows,
      (row) =>
        row.status === "running"
          ? checkDiskOf(row.spaceId)
          : samples.get(row.spaceId)?.diskMeasuredAt == null
            ? measureDisk(row.spaceId).pipe(Effect.ignore)
            : Effect.void,
      { concurrency: DISK_MEASURE_CONCURRENCY, discard: true },
    );
  });

  /** The disk sampler: the homes, then any server left running for a Sandbox recorded stopped. */
  const checkDisk: Sandboxes["Service"]["checkDisk"] = Effect.gen(function* () {
    const rows = yield* list.pipe(Effect.orElseSucceed(() => []));
    yield* checkHomes(rows);
    yield* stopStrays(rows);
  }).pipe(Effect.withSpan("Sandboxes.checkDisk"));

  /** The usage sampler: each running Sandbox's CPU and memory, for Settings. */
  const sampleUsage = list.pipe(
    Effect.orElseSucceed(() => []),
    Effect.flatMap((rows) =>
      Effect.forEach(
        rows.filter((row) => row.status === "running"),
        (row) =>
          runtime.resourceUse(sandboxIdOf(row.spaceId)).pipe(
            Effect.tap((use) =>
              Effect.sync(() =>
                updateSample(row.spaceId, {
                  cpuPercent: use?.cpuPercent ?? null,
                  memoryBytes: use?.memoryBytes ?? null,
                }),
              ),
            ),
            Effect.ignore,
          ),
        { concurrency: 2, discard: true },
      ),
    ),
    Effect.withSpan("Sandboxes.sampleUsage"),
  );

  const setLimits: Sandboxes["Service"]["setLimits"] = Effect.fn("Sandboxes.setLimits")(
    function* ({ spaceId, limits, actor }) {
      const host = hostCapacity((yield* readHostSpace)?.totalBytes ?? null);
      // A Space with a machine of its own may be given more CPUs and memory than the Hub has: each
      // machine starts its Sandbox with at most what it has (`fitLimitsToHost`).
      const dedicated =
        spaceId !== undefined &&
        ((yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM environments
          WHERE mode = 'dedicated' AND space_id = ${spaceId} AND revoked_at IS NULL
        `)[0]?.count ?? 0) > 0;
      const invalid = invalidLimitsReason(
        limits,
        dedicated ? { ...host, cpus: Infinity, memoryBytes: Infinity } : host,
      );
      if (invalid !== undefined) return yield* new SandboxLimitsInvalidError({ reason: invalid });
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
      liveTurns.delete(environmentId);
      samples.delete(spaceId);
      applied.delete(spaceId);
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
        // A container killed under an enforced memory limit ends with SIGKILL's code: the limit
        // named is the one that container had.
        const memoryLimit = applied.get(row.spaceId)?.memoryBytes ?? null;
        applied.delete(row.spaceId);
        updateSample(row.spaceId, { cpuPercent: null, memoryBytes: null });
        const exitMessage =
          exit.exitCode === 137 && memoryLimit !== null && (yield* runtime.limitSupport).memory
            ? `It was killed (exit code 137), most likely for going over its memory limit of ${formatBytes(memoryLimit)}.`
            : `It exited with code ${exit.exitCode ?? "?"}.`;
        lastUse.delete(environmentId);
        liveTurns.delete(environmentId);
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
  yield* clock
    .sleep(usageSampleEvery)
    .pipe(Effect.andThen(sampleUsage), Effect.forever, Effect.forkScoped);

  // What the runtime does not enforce here is said once in the log, and in Settings.
  const support = yield* runtime.limitSupport;
  if (support.note !== null) {
    yield* Effect.logWarning("Sandbox limits not enforced on this host", { note: support.note });
  }

  /** Running and not being stopped: work goes straight to it. */
  const readyNow = (spaceId: SpaceId, environmentId: EnvironmentId) =>
    stopping.has(spaceId) ? Effect.succeed(false) : connections.isReady(environmentId);

  // One query for every Sandbox, a run in progress on it read with the rest.
  const listImages: Sandboxes["Service"]["listImages"] = Effect.gen(function* () {
    const rows = yield* sql<Omit<SandboxImageRow, "busy"> & { readonly runs: number }>`
      SELECT sandbox.space_id AS "spaceId", sandbox.environment_id AS "environmentId",
        environment.name AS name, sandbox.status, sandbox.image_version AS "imageVersion",
        EXISTS (
          SELECT 1 FROM orchestration_v2_projection_threads AS thread
          JOIN orchestration_v2_projection_runs AS run ON run.thread_id = thread.thread_id
          WHERE thread.active_environment_id = sandbox.environment_id
            AND thread.deleted_at IS NULL
            AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
        ) AS runs
      FROM sandboxes AS sandbox
      JOIN environments AS environment ON environment.environment_id = sandbox.environment_id
      ORDER BY sandbox.created_at
    `;
    return rows.map(({ runs, ...row }) => ({
      ...row,
      busy:
        runs > 0 ||
        (liveTurns.get(row.environmentId)?.size ?? 0) > 0 ||
        claimsOf(row.environmentId) > 0,
    }));
  }).pipe(
    Effect.mapError((cause) => new SandboxStartError({ spaceId: "", detail: String(cause) })),
  );

  const imageVersionOf = (spaceId: SpaceId) =>
    sql<{ readonly imageVersion: string | null }>`
      SELECT image_version AS "imageVersion" FROM sandboxes WHERE space_id = ${spaceId}
    `.pipe(Effect.map((rows) => rows[0]?.imageVersion ?? null));

  const updateImage: Sandboxes["Service"]["updateImage"] = Effect.fn("Sandboxes.updateImage")(
    function* (input) {
      const { spaceId } = input;
      const environmentId = sandboxEnvironmentIdOf(spaceId);
      const refuse = (kind: SandboxImageUpdateRefusedError["kind"], detail: string) =>
        new SandboxImageUpdateRefusedError({ spaceId, kind, detail });
      /** Why it is busy now, if it is: never stopped mid-turn, nor under work just sent to it. */
      const busyNow = Effect.gen(function* () {
        const turns = Math.max(
          liveTurns.get(environmentId)?.size ?? 0,
          yield* unfinishedRuns(environmentId),
        );
        if (turns > 0) {
          return `A turn is in progress on it (${turns} ${turns === 1 ? "Thread" : "Threads"}). Update it once its turns end.`;
        }
        if (claimsOf(environmentId) > 0) {
          return "Work was just sent to it. Update it once that work has ended.";
        }
        return undefined;
      });
      const row = yield* selectRow(spaceId).pipe(Effect.orDie);
      if (row === undefined) return yield* refuse("missing", "This Space has no Sandbox.");
      const newest = yield* runtime.imageVersion.pipe(
        Effect.mapError((error) => new SandboxStartError({ spaceId, detail: error.message })),
      );
      if (inFlight.has(spaceId) || stopping.has(spaceId)) {
        return yield* refuse("transition", "It is starting or stopping; try again in a moment.");
      }
      // A healthy Sandbox is never stopped into a start that cannot succeed.
      if (newest === null && row.status === "running") {
        return yield* refuse(
          "image-missing",
          "The newest image is missing: build it with t3 sandbox image build first.",
        );
      }
      // A stopped Sandbox runs the newest image from its next start: nothing to do now.
      if (row.status !== "running") return { outcome: "next-start" as const, imageVersion: newest };
      const from = yield* imageVersionOf(spaceId).pipe(Effect.orDie);
      if (from === newest) return { outcome: "up-to-date" as const, imageVersion: newest };
      const busy = yield* busyNow;
      if (busy !== undefined) return yield* refuse("busy", busy);
      // Stopped under its lock and marked stopping, as an idle stop: work that arrives meanwhile
      // waits for the stop, then starts it again, on the newest image.
      const done = Deferred.makeUnsafe<void>();
      yield* locked(
        spaceId,
        Effect.gen(function* () {
          stopping.set(spaceId, done);
          // Again under the lock, with it marked stopping: work arriving now waits for the restart.
          const busyLocked = yield* busyNow;
          if (busyLocked !== undefined) return yield* refuse("busy", busyLocked);
          yield* stopLocked({ spaceId, actor: input.actor, via: "update" }).pipe(
            Effect.mapError((cause) => new SandboxStartError({ spaceId, detail: String(cause) })),
          );
        }),
      ).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            if (stopping.get(spaceId) === done) stopping.delete(spaceId);
            return Deferred.succeed(done, undefined);
          }),
        ),
      );
      const record = (detail: {
        readonly outcome: string;
        readonly version?: string | null;
        readonly reason?: string;
      }) =>
        audit
          .record({
            actor: input.actor,
            action: "sandbox.image.update",
            spaceId,
            target: { kind: "environment", id: environmentId },
            detail: { via: "restart", from, ...detail },
          })
          .pipe(Effect.ignore);
      const entry = yield* startOnce({ spaceId, actorUserId: input.actorUserId, via: "update" });
      yield* awaitStart(entry, spaceId).pipe(
        Effect.tapError((error) =>
          record({ outcome: "failed", reason: error.detail.slice(0, 200) }),
        ),
      );
      const version = yield* imageVersionOf(spaceId).pipe(Effect.orDie);
      yield* record({ outcome: "updated", version });
      return { outcome: "updated" as const, imageVersion: version };
    },
  );

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
    sessionsEnded: Stream.fromPubSub(sessionsEnded),
    runtimeKind: runtime.kind,
    listImages,
    updateImage,
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
        // The Owner stopped it: only a User's own action starts it again.
        if (row?.heldAt != null && !options.explicit) {
          return yield* startError(
            "the Owner stopped it. Start it from Settings → Environments → Sandboxes, or send a message.",
          );
        }
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
        if (yield* connections.isReady(environmentId)) continue;
        // Read once it is not ready: a stop that took its socket is still marked, or has written
        // why (failed, or held by the Owner).
        if (stopping.has(spaceId)) continue;
        const row = yield* selectRow(spaceId).pipe(Effect.orElseSucceed(() => undefined));
        // Waiting work never starts a failed Sandbox, nor one the Owner stopped: a User does.
        if (row === undefined || row.status === "failed" || row.heldAt !== null) continue;
        yield* startOnce({ spaceId, actorUserId: undefined, via: "demand" });
      }
    }),
    touch,
    turnStarted: Effect.fn("Sandboxes.turnStarted")(function* (environmentId, key) {
      yield* Effect.sync(() => {
        if (sandboxSpaceOf(environmentId) === undefined) return;
        let turns = liveTurns.get(environmentId);
        if (turns === undefined) {
          turns = new Set();
          liveTurns.set(environmentId, turns);
        }
        turns.add(key);
        // A turn keeps it busy now: released claims (their runs are recorded) go, while a dispatch
        // still under way keeps its own, whichever work this turn is.
        const of = claims.get(environmentId);
        for (const [claim, releasedAt] of of ?? []) if (releasedAt !== null) of?.delete(claim);
        if (of?.size === 0) claims.delete(environmentId);
      });
    }),
    turnEnded: Effect.fn("Sandboxes.turnEnded")(function* (environmentId, key) {
      yield* Effect.sync(() => {
        liveTurns.get(environmentId)?.delete(key);
      });
    }),
    claim: Effect.fn("Sandboxes.claim")(function* (environmentId) {
      if (sandboxSpaceOf(environmentId) === undefined) return;
      const key = {};
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          claimsOf(environmentId);
          const of = claims.get(environmentId) ?? new Map<object, number | null>();
          of.set(key, null);
          claims.set(environmentId, of);
        }),
        () =>
          Effect.sync(() => {
            const of = claims.get(environmentId);
            if (of?.has(key) === true) of.set(key, nowMs());
          }),
      );
    }),
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
