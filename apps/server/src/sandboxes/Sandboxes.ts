/**
 * Each Space's Sandbox, as the Hub keeps it: its row in `sandboxes`, its Environment (kind
 * `sandbox`, the Space's, with the credential the Hub issued itself) and its server through the
 * Sandbox runtime. The first Thread that needs it creates it. See docs/internals/sandboxes.md.
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
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AuditLog from "../audit/AuditLog.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentConnections from "../environments/EnvironmentConnections.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { SandboxRuntime, sandboxIdOf } from "./SandboxRuntime.ts";

/** How long a starting Sandbox has to connect before its start counts as failed. */
const START_TIMEOUT = "2 minutes";

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

export class Sandboxes extends Context.Service<
  Sandboxes,
  {
    /**
     * Creates the Space's Sandbox if it has none (its Environment, credential and home), starts
     * it and waits until it is connected. Who asks is checked before (`environment.use`); `actor`
     * is who the audit log names.
     */
    readonly ensureRunning: (input: {
      readonly spaceId: SpaceId;
      readonly actorUserId: UserId | undefined;
    }) => Effect.Effect<EnvironmentId, SandboxStartError>;
    /** The Sandboxes that exist, by Space. */
    readonly list: Effect.Effect<ReadonlyArray<SandboxStatusRow>, SandboxStartError>;
  }
>()("t3/sandboxes/Sandboxes") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runtime = yield* SandboxRuntime;
  const audit = yield* AuditLog.AuditLog;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const connections = yield* EnvironmentConnections.EnvironmentConnections;
  const random = yield* SecureRandom.SecureRandom;
  const digester = yield* Digest.Digest;
  const hubId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity).getEnvironmentId;
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

  const ensureLocked = Effect.fn("Sandboxes.ensureRunning")(function* (input: {
    readonly spaceId: SpaceId;
    readonly actorUserId: UserId | undefined;
  }) {
    const { spaceId } = input;
    const environmentId = sandboxEnvironmentIdOf(spaceId);
    const sandboxId = sandboxIdOf(spaceId);
    const space = yield* spaces.spaceById(spaceId);
    if (Option.isNone(space)) return yield* Effect.fail("its Space no longer exists.");
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
    }
    const wasRunning = inspected.state._tag === "running";
    if (!wasRunning) {
      yield* setStatus(spaceId, "starting");
      yield* runtime.start(sandboxId);
    }
    // Ready once welcomed with its executor serving, so a Thread can be placed on it at once.
    const ready = yield* connections
      .awaitReady(environmentId)
      .pipe(Effect.timeoutOption(START_TIMEOUT));
    if (Option.isNone(ready)) {
      return yield* Effect.fail("it did not connect to the Hub in time.");
    }
    if (!wasRunning) yield* setStatus(spaceId, "running");
    return environmentId;
  });

  const ensureRunning: Sandboxes["Service"]["ensureRunning"] = (input) =>
    lockOf(input.spaceId)
      .withPermits(1)(ensureLocked(input))
      .pipe(
        Effect.catch((cause) => {
          const detail =
            typeof cause === "string"
              ? cause
              : cause instanceof Error
                ? cause.message
                : String(cause);
          return setStatus(input.spaceId, "failed", detail).pipe(
            Effect.ignore,
            Effect.andThen(Effect.fail(new SandboxStartError({ spaceId: input.spaceId, detail }))),
          );
        }),
      );

  const list: Sandboxes["Service"]["list"] = sql<SandboxStatusRow>`
    SELECT space_id AS "spaceId", environment_id AS "environmentId", status,
      last_error AS "lastError"
    FROM sandboxes ORDER BY created_at
  `.pipe(Effect.mapError((cause) => new SandboxStartError({ spaceId: "", detail: String(cause) })));

  // What the runtime does not run is not running, whatever the last Hub recorded.
  const recorded = yield* list.pipe(Effect.orElseSucceed(() => []));
  for (const row of recorded) {
    if (row.status !== "starting" && row.status !== "running") continue;
    const inspected = yield* runtime.inspect(sandboxIdOf(row.spaceId)).pipe(Effect.option);
    if (Option.isSome(inspected) && inspected.value.state._tag === "running") continue;
    yield* setStatus(row.spaceId, "stopped").pipe(Effect.ignore);
  }
  // A server that ended by itself counts as stopped; the next work starts it again.
  yield* runtime.exits.pipe(
    Stream.runForEach((exit) =>
      sql<{ readonly spaceId: SpaceId }>`
        SELECT space_id AS "spaceId" FROM sandboxes
      `.pipe(
        Effect.flatMap((rows) => {
          const row = rows.find((candidate) => sandboxIdOf(candidate.spaceId) === exit.sandboxId);
          return row === undefined
            ? Effect.void
            : setStatus(row.spaceId, "stopped", `It exited with code ${exit.exitCode ?? "?"}.`);
        }),
        Effect.ignore,
      ),
    ),
    Effect.forkScoped,
  );

  return Sandboxes.of({ ensureRunning, list });
});

export const layer = Layer.effect(Sandboxes, make).pipe(Layer.provide(AuditLog.layer));
