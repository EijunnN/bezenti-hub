/**
 * The machines registered with this Hub (`environments`, migration 094) and their credentials,
 * kept only as SHA-256. A removed machine's row stays revoked, so its credential answers "revoked".
 * See docs/internals/environment-auth.md#joined-environments.
 */
import {
  type EnvironmentCloseReason,
  environmentConnectionStatus,
  EnvironmentHostResources,
  EnvironmentId,
  EnvironmentProviderSummary,
  type EnvironmentHeartbeatFrame,
  type EnvironmentHelloFrame,
  HUB_MACHINE_ENVIRONMENT_ID,
  type HubEnvironmentSummary,
  previewThreadPlacement,
  type ProjectId,
  type ProviderInstanceId,
  UserId,
} from "@t3tools/contracts";
import { environmentCredentialIssuer } from "@t3tools/shared/environmentJoin";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import { base64UrlEncode } from "../auth/utils.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EnvironmentConnections from "./EnvironmentConnections.ts";

export class EnvironmentStorageError extends Schema.TaggedError<EnvironmentStorageError>()(
  "EnvironmentStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read or write the Hub's Environments.";
  }
}

/** Missing, removed, or not one the User may see: all answer alike. */
export class EnvironmentNotFoundError extends Schema.TaggedError<EnvironmentNotFoundError>()(
  "EnvironmentNotFoundError",
  {},
) {
  override get message(): string {
    return "There is no such Environment.";
  }
}

export class EnvironmentAccessDeniedError extends Schema.TaggedError<EnvironmentAccessDeniedError>()(
  "EnvironmentAccessDeniedError",
  { reason: Schema.String },
) {
  override get message(): string {
    switch (this.reason) {
      case "hub-machine":
        return "The Hub machine runs the Hub itself and can't be removed.";
      case "user-inactive":
        return "This account is turned off.";
      default:
        return "Only the Owner manages this Hub's Environments.";
    }
  }
}

/** Why a new Thread cannot run on the Environment it asked for. */
export class ThreadEnvironmentUnavailableError extends Schema.TaggedError<ThreadEnvironmentUnavailableError>()(
  "ThreadEnvironmentUnavailableError",
  {
    environmentId: EnvironmentId,
    name: Schema.optional(Schema.String),
    reason: Schema.Literals(["not-usable", "offline", "provider-missing", "worktree-unsupported"]),
    providerInstanceId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const name = this.name ?? "This Environment";
    switch (this.reason) {
      case "not-usable":
        return "You can't run Threads on this Environment.";
      case "offline":
        return `${name} is offline. Start it, or choose another Environment.`;
      case "provider-missing":
        return `${name} can't run ${this.providerInstanceId ?? "this provider"}. Choose another provider or Environment.`;
      case "worktree-unsupported":
        return "New worktrees are made only on the Hub machine for now. Start this Thread in the Project's checkout.";
    }
  }
}

const isThreadEnvironmentUnavailable = Schema.is(ThreadEnvironmentUnavailableError);

/** The reason a launch was refused for its Environment, wherever it sits in the cause chain. */
export const environmentRefusalMessage = (cause: unknown): string | undefined => {
  let current = cause;
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    if (isThreadEnvironmentUnavailable(current)) return current.message;
    current =
      typeof current === "object" && current !== null
        ? (current as { readonly cause?: unknown }).cause
        : undefined;
  }
  return undefined;
};

/** Live facts about the Hub machine; the server provides them, tests leave them empty. */
export class HubMachineSnapshot extends Context.Reference<{
  readonly providers: Effect.Effect<ReadonlyArray<EnvironmentProviderSummary>>;
  readonly resources: Effect.Effect<EnvironmentHostResources | null>;
}>("t3/environments/HubMachineSnapshot", {
  defaultValue: () => ({ providers: Effect.succeed([]), resources: Effect.succeed(null) }),
}) {}

export type CredentialCheck =
  | {
      readonly _tag: "valid";
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly ownerUserId: UserId;
    }
  | { readonly _tag: "refused"; readonly reason: EnvironmentCloseReason };

interface EnvironmentRow {
  readonly environmentId: string;
  readonly name: string;
  readonly kind: "hub" | "external";
  readonly ownerUserId: string | null;
  readonly registeredAt: string;
  readonly lastSeenAt: string | null;
  readonly lastOs: string | null;
  readonly lastHostname: string | null;
  readonly lastResourcesJson: string | null;
  readonly lastProvidersJson: string | null;
  readonly revokedAt: string | null;
  /** The owner was turned off or removed. */
  readonly ownerInactive: number;
}

const decodeResources = Schema.decodeUnknownOption(Schema.fromJsonString(EnvironmentHostResources));
const decodeProviders = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(EnvironmentProviderSummary)),
);
const encodeResources = Schema.encodeSync(Schema.fromJsonString(EnvironmentHostResources));
const encodeProviders = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(EnvironmentProviderSummary)),
);

const resourceOf = (row: EnvironmentRow): AccessPolicy.EnvironmentResource => ({
  kind: "environment",
  environmentKind: row.kind,
  ownerUserId: row.ownerUserId === null ? null : UserId.make(row.ownerUserId),
});

/**
 * Whether the User may run Threads on the Environment, as a Project's preferred Environment must
 * be for whoever sets it. Unknown and removed machines answer false; without a User (the server's
 * own work, the Hub's shell) any machine the Hub knows will do. A plain function rather than a
 * registry method so Project services can ask it without the registry's connections.
 */
export const mayUseEnvironment = Effect.fn("EnvironmentRegistry.mayUseEnvironment")(function* (
  userId: UserId | undefined,
  environmentId: EnvironmentId,
) {
  if (environmentId === HUB_MACHINE_ENVIRONMENT_ID) return true;
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    readonly kind: "hub" | "external";
    readonly ownerUserId: string | null;
  }>`
    SELECT kind, owner_user_id AS "ownerUserId" FROM environments
    WHERE environment_id = ${environmentId} AND revoked_at IS NULL
  `.pipe(Effect.mapError((cause) => new EnvironmentStorageError({ cause })));
  if (row === undefined) return false;
  if (userId === undefined) return true;
  const principal = yield* (yield* SpaceDirectory.SpaceDirectory)
    .principalOf(userId)
    .pipe(Effect.mapError((cause) => new EnvironmentStorageError({ cause })));
  return (
    principal.inactive !== true &&
    AccessPolicy.isAllowed(
      AccessPolicy.decide(principal, "environment.use", {
        kind: "environment",
        environmentKind: row.kind,
        ownerUserId: row.ownerUserId === null ? null : UserId.make(row.ownerUserId),
      }),
    )
  );
});

export class EnvironmentRegistry extends Context.Service<
  EnvironmentRegistry,
  {
    /**
     * This Hub's own identity (the server's persisted EnvironmentId), which its credentials and
     * `welcome` name. Not the Hub machine's row id, which is the same constant on every Hub.
     */
    readonly hubId: EnvironmentId;
    /** What the User may see, the Hub machine first. */
    readonly list: (
      viewer: UserId,
    ) => Effect.Effect<
      ReadonlyArray<HubEnvironmentSummary>,
      EnvironmentAccessDeniedError | EnvironmentStorageError
    >;
    readonly rename: (input: {
      readonly actorUserId: UserId;
      readonly environmentId: EnvironmentId;
      readonly name: string;
    }) => Effect.Effect<
      HubEnvironmentSummary,
      EnvironmentNotFoundError | EnvironmentAccessDeniedError | EnvironmentStorageError
    >;
    /** Revokes the credential and closes the machine's socket at once. */
    readonly remove: (input: {
      readonly actorUserId: UserId;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<
      void,
      EnvironmentNotFoundError | EnvironmentAccessDeniedError | EnvironmentStorageError
    >;
    /** Whether the User may approve a machine joining; checked before the strong factor. */
    readonly mayRegister: (userId: UserId) => Effect.Effect<boolean, EnvironmentStorageError>;
    /** Stores a newly joined machine by its credential's hash, recording who approved it. */
    readonly register: (input: {
      readonly approvedBy: UserId;
      readonly name: string;
      readonly os: string;
      readonly hostname: string;
      readonly credentialHash: string;
    }) => Effect.Effect<EnvironmentId, EnvironmentAccessDeniedError | EnvironmentStorageError>;
    /**
     * Revokes every machine the User owns, as their account is turned off or removed; run it in
     * that transaction. Answers what to disconnect once it commits.
     */
    readonly revokeOwnedBy: (input: {
      readonly userId: UserId;
      readonly actor: AuditLog.AuditActor;
    }) => Effect.Effect<Effect.Effect<void>, EnvironmentStorageError>;
    readonly checkCredential: (
      credential: string | undefined,
    ) => Effect.Effect<CredentialCheck, EnvironmentStorageError>;
    readonly recordHello: (
      environmentId: EnvironmentId,
      hello: EnvironmentHelloFrame,
    ) => Effect.Effect<void, EnvironmentStorageError>;
    readonly recordHeartbeat: (
      environmentId: EnvironmentId,
      heartbeat: EnvironmentHeartbeatFrame,
    ) => Effect.Effect<void, EnvironmentStorageError>;
    /** `t3 leave`: the machine removes itself with its own credential. */
    readonly leave: (
      credential: string | undefined,
    ) => Effect.Effect<boolean, EnvironmentStorageError>;
    /**
     * Where a new Thread runs: the User's choice, else its Project's preferred Environment, else
     * the Hub machine. Another Environment must be one the User may use, online, and have the
     * provider enabled. A preferred Environment that is not (the Owner's own machine, for a
     * Member, or one offline) leaves the Thread on the Hub machine: `previewThreadPlacement`.
     */
    readonly chooseForThread: (input: {
      readonly userId: UserId | undefined;
      readonly requested: EnvironmentId | undefined;
      readonly projectId: ProjectId;
      readonly providerInstanceId: ProviderInstanceId;
    }) => Effect.Effect<EnvironmentId, ThreadEnvironmentUnavailableError | EnvironmentStorageError>;
    /**
     * The Environment's name when the User may use it (`environment.use`: a personal machine is its
     * owner's alone), whether or not it is online; None otherwise. Calls forwarded to a machine
     * check it, so a Thread is never a way onto a machine its User may not use.
     */
    readonly usableBy: (input: {
      readonly userId: UserId | undefined;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<Option.Option<{ readonly name: string }>, EnvironmentStorageError>;
    /**
     * Each Environment once its removal committed (from Settings, `t3 leave`, or its owner turned
     * off): its Threads then need an environment.
     */
    readonly removed: Stream.Stream<EnvironmentId>;
  }
>()("t3/environments/EnvironmentRegistry") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const audit = yield* AuditLog.AuditLog;
  const connections = yield* EnvironmentConnections.EnvironmentConnections;
  const random = yield* SecureRandom.SecureRandom;
  const digester = yield* Digest.Digest;
  const hubId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity).getEnvironmentId;
  const storageError = (cause: unknown) => new EnvironmentStorageError({ cause });
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const platform = yield* HostProcess.Platform;
  const removals = yield* PubSub.unbounded<EnvironmentId>();

  const sha256 = (value: string) =>
    digester.digest(Digest.sha256, new TextEncoder().encode(value)).pipe(
      Effect.orDie,
      Effect.map((digest) => base64UrlEncode(digest)),
    );

  const selectRows = (conditions: Parameters<typeof sql.and>[0]) => sql<EnvironmentRow>`
    SELECT environment_id AS "environmentId", name, kind, owner_user_id AS "ownerUserId",
      registered_at AS "registeredAt", last_seen_at AS "lastSeenAt", last_os AS "lastOs",
      last_hostname AS "lastHostname", last_resources_json AS "lastResourcesJson",
      last_providers_json AS "lastProvidersJson", revoked_at AS "revokedAt",
      EXISTS (
        SELECT 1 FROM users AS owner WHERE owner.user_id = environments.owner_user_id
          AND (owner.disabled_at IS NOT NULL OR owner.removed_at IS NOT NULL)
      ) AS "ownerInactive"
    FROM environments WHERE ${sql.and(conditions)}
    ORDER BY kind = 'hub' DESC, registered_at, environment_id
  `;

  /** Threads on the Environment with a run in progress. */
  const runningThreadCount = (environmentId: EnvironmentId) =>
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

  const summaryOf = Effect.fn("EnvironmentRegistry.summaryOf")(function* (row: EnvironmentRow) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (row.kind === "hub") {
      const snapshot = yield* HubMachineSnapshot;
      return {
        id: EnvironmentId.make(row.environmentId),
        name: row.name,
        kind: row.kind,
        mode: "personal",
        ownerUserId: null,
        status: "online",
        registeredAt: row.registeredAt,
        lastSeenAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        os: platform,
        hostname: null,
        providers: yield* snapshot.providers,
        resources: yield* snapshot.resources,
        runningThreadCount: yield* runningThreadCount(HUB_MACHINE_ENVIRONMENT_ID),
      } satisfies HubEnvironmentSummary;
    }
    const environmentId = EnvironmentId.make(row.environmentId);
    return {
      id: environmentId,
      name: row.name,
      kind: row.kind,
      mode: "personal",
      ownerUserId: row.ownerUserId === null ? null : UserId.make(row.ownerUserId),
      status: environmentConnectionStatus({
        connected: yield* connections.isConnected(environmentId),
        lastSeenAtMs: row.lastSeenAt === null ? null : Date.parse(row.lastSeenAt),
        nowMs,
      }),
      registeredAt: row.registeredAt,
      lastSeenAt: row.lastSeenAt,
      os: row.lastOs,
      hostname: row.lastHostname,
      providers: Option.getOrElse(decodeProviders(row.lastProvidersJson), () => []),
      resources: Option.getOrNull(decodeResources(row.lastResourcesJson)),
      runningThreadCount: yield* runningThreadCount(environmentId),
    } satisfies HubEnvironmentSummary;
  });

  const decide = (
    principal: AccessPolicy.Principal,
    action: AccessPolicy.Action,
    resource: AccessPolicy.Resource,
  ) => AccessPolicy.decide(principal, action, resource);

  const principalOf = (userId: UserId) =>
    spaces.principalOf(userId).pipe(Effect.mapError(storageError));

  const list: EnvironmentRegistry["Service"]["list"] = Effect.fn("EnvironmentRegistry.list")(
    function* (viewer) {
      const principal = yield* principalOf(viewer);
      if (principal.inactive === true) {
        return yield* new EnvironmentAccessDeniedError({ reason: "user-inactive" });
      }
      const rows = yield* selectRows([sql`revoked_at IS NULL`]).pipe(Effect.mapError(storageError));
      const visible = rows.filter((row) =>
        AccessPolicy.isAllowed(decide(principal, "environment.view", resourceOf(row))),
      );
      return yield* Effect.forEach(visible, summaryOf);
    },
  );

  /** A live row the User may see and act on; a hidden one answers like a missing one. */
  const authorize = Effect.fn("EnvironmentRegistry.authorize")(function* (
    actorUserId: UserId,
    environmentId: EnvironmentId,
    action: "environment.rename" | "environment.remove",
  ) {
    const principal = yield* principalOf(actorUserId);
    const [row] = yield* selectRows([
      sql`environment_id = ${environmentId}`,
      sql`revoked_at IS NULL`,
    ]).pipe(Effect.mapError(storageError));
    if (
      row === undefined ||
      !AccessPolicy.isAllowed(decide(principal, "environment.view", resourceOf(row)))
    ) {
      return yield* new EnvironmentNotFoundError({});
    }
    const decision = decide(principal, action, resourceOf(row));
    if (decision._tag === "Deny") {
      return yield* new EnvironmentAccessDeniedError({ reason: decision.reason });
    }
    return row;
  });

  const rename: EnvironmentRegistry["Service"]["rename"] = Effect.fn("EnvironmentRegistry.rename")(
    function* ({ actorUserId, environmentId, name }) {
      const renamed = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* authorize(actorUserId, environmentId, "environment.rename");
            if (row.name === name) return row;
            yield* sql`UPDATE environments SET name = ${name} WHERE environment_id = ${environmentId}`;
            yield* audit
              .record({
                actor: AuditLog.userActor(actorUserId),
                action: "environment.rename",
                target: { kind: "environment", id: environmentId, name },
                detail: { from: row.name, to: name },
              })
              .pipe(Effect.mapError(storageError));
            return { ...row, name };
          }),
        )
        .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
      return yield* summaryOf(renamed);
    },
  );

  const revoke = Effect.fn("EnvironmentRegistry.revoke")(function* (input: {
    readonly row: EnvironmentRow;
    readonly actor: AuditLog.AuditActor;
    readonly via: "settings" | "leave" | "userTurnedOff";
  }) {
    yield* sql`
        UPDATE environments SET revoked_at = ${yield* nowIso}
        WHERE environment_id = ${input.row.environmentId} AND revoked_at IS NULL
      `;
    yield* audit
      .record({
        actor: input.actor,
        action: "environment.remove",
        target: { kind: "environment", id: input.row.environmentId, name: input.row.name },
        detail: { via: input.via },
      })
      .pipe(Effect.mapError(storageError));
  });

  const remove: EnvironmentRegistry["Service"]["remove"] = Effect.fn("EnvironmentRegistry.remove")(
    function* ({ actorUserId, environmentId }) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* authorize(actorUserId, environmentId, "environment.remove");
            yield* revoke({ row, actor: AuditLog.userActor(actorUserId), via: "settings" });
          }),
        )
        .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
      // After the commit: a socket closed first could reconnect before the revocation lands.
      yield* connections.close(environmentId, "environment-removed");
      yield* PubSub.publish(removals, environmentId);
    },
  );

  const mayRegister: EnvironmentRegistry["Service"]["mayRegister"] = (userId) =>
    principalOf(userId).pipe(
      Effect.map((principal) =>
        AccessPolicy.isAllowed(
          decide(principal, "environment.register", AccessPolicy.installation),
        ),
      ),
    );

  const register: EnvironmentRegistry["Service"]["register"] = Effect.fn(
    "EnvironmentRegistry.register",
  )(function* ({ approvedBy, name, os, hostname, credentialHash }) {
    const environmentId = EnvironmentId.make(yield* random.uuidV4());
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Asked again in the transaction: the approver may have lost the right since approving.
          if (!(yield* mayRegister(approvedBy))) {
            return yield* new EnvironmentAccessDeniedError({ reason: "owner-only" });
          }
          const now = yield* nowIso;
          yield* sql`
          INSERT INTO environments (
            environment_id, name, kind, mode, owner_user_id, credential_hash,
            credential_issued_at, credential_issued_by, registered_at, last_os, last_hostname
          ) VALUES (
            ${environmentId}, ${name}, 'external', 'personal', ${approvedBy}, ${credentialHash},
            ${now}, ${approvedBy}, ${now}, ${os}, ${hostname}
          )
        `;
          yield* audit
            .record({
              actor: AuditLog.userActor(approvedBy),
              action: "environment.register",
              target: { kind: "environment", id: environmentId, name },
              detail: { kind: "external", os },
            })
            .pipe(Effect.mapError(storageError));
        }),
      )
      .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
    return environmentId;
  });

  const revokeOwnedBy: EnvironmentRegistry["Service"]["revokeOwnedBy"] = Effect.fn(
    "EnvironmentRegistry.revokeOwnedBy",
  )(
    function* ({ userId, actor }) {
      const rows = yield* selectRows([
        sql`owner_user_id = ${userId}`,
        sql`revoked_at IS NULL`,
      ]).pipe(Effect.mapError(storageError));
      for (const row of rows) yield* revoke({ row, actor, via: "userTurnedOff" });
      return Effect.forEach(
        rows,
        (row) =>
          connections
            .close(EnvironmentId.make(row.environmentId), "owner-inactive")
            .pipe(Effect.andThen(PubSub.publish(removals, EnvironmentId.make(row.environmentId)))),
        { discard: true },
      );
    },
    Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }),
  );

  const findByCredential = Effect.fn("EnvironmentRegistry.findByCredential")(function* (
    credential: string,
  ) {
    const credentialHash = yield* sha256(credential);
    const [row] = yield* selectRows([sql`credential_hash = ${credentialHash}`]).pipe(
      Effect.mapError(storageError),
    );
    return row;
  });

  const checkCredential: EnvironmentRegistry["Service"]["checkCredential"] = Effect.fn(
    "EnvironmentRegistry.checkCredential",
  )(function* (credential) {
    if (credential === undefined || credential.length === 0) {
      return { _tag: "refused", reason: "credential-missing" } as const;
    }
    const issuer = environmentCredentialIssuer(credential);
    if (issuer === undefined) return { _tag: "refused", reason: "credential-unknown" } as const;
    if (issuer !== hubId) {
      return { _tag: "refused", reason: "credential-other-hub" } as const;
    }
    const row = yield* findByCredential(credential);
    if (row === undefined || row.ownerUserId === null) {
      return { _tag: "refused", reason: "credential-unknown" } as const;
    }
    if (row.revokedAt !== null) return { _tag: "refused", reason: "credential-revoked" } as const;
    if (row.ownerInactive === 1) return { _tag: "refused", reason: "owner-inactive" } as const;
    return {
      _tag: "valid",
      environmentId: EnvironmentId.make(row.environmentId),
      name: row.name,
      ownerUserId: UserId.make(row.ownerUserId),
    } as const;
  });

  const recordHello: EnvironmentRegistry["Service"]["recordHello"] = Effect.fn(
    "EnvironmentRegistry.recordHello",
  )(function* (environmentId, hello) {
    yield* sql`
        UPDATE environments SET last_seen_at = ${yield* nowIso}, last_os = ${hello.os},
          last_hostname = ${hello.hostname}, last_protocol_version = ${hello.protocolVersion},
          last_resources_json = ${encodeResources({ hostResources: hello.hostResources, disk: hello.disk })},
          last_providers_json = ${encodeProviders(hello.providers)}
        WHERE environment_id = ${environmentId} AND revoked_at IS NULL
      `;
  }, Effect.mapError(storageError));

  // One write per heartbeat per machine, every ten seconds: too frequent for a span each.
  const recordHeartbeat: EnvironmentRegistry["Service"]["recordHeartbeat"] = Effect.fnUntraced(
    function* (environmentId, heartbeat) {
      const providers =
        heartbeat.providers === undefined ? null : encodeProviders(heartbeat.providers);
      yield* sql`
        UPDATE environments SET last_seen_at = ${yield* nowIso},
          last_resources_json = ${encodeResources({ hostResources: heartbeat.hostResources, disk: heartbeat.disk })},
          last_providers_json = COALESCE(${providers}, last_providers_json)
        WHERE environment_id = ${environmentId} AND revoked_at IS NULL
      `;
    },
    Effect.mapError(storageError),
  );

  const leave: EnvironmentRegistry["Service"]["leave"] = Effect.fn("EnvironmentRegistry.leave")(
    function* (credential) {
      const check = yield* checkCredential(credential);
      if (check._tag === "refused") return false;
      const left = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const [row] = yield* selectRows([
              sql`environment_id = ${check.environmentId}`,
              sql`revoked_at IS NULL`,
            ]).pipe(Effect.mapError(storageError));
            if (row === undefined) return false;
            // Run on the machine by its owner, through the credential the Owner approved.
            yield* revoke({
              row,
              actor: { source: "cli", userId: check.ownerUserId },
              via: "leave",
            });
            return true;
          }),
        )
        .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }));
      if (left) {
        yield* connections.close(check.environmentId, "environment-removed");
        yield* PubSub.publish(removals, check.environmentId);
      }
      return left;
    },
  );

  const chooseForThread: EnvironmentRegistry["Service"]["chooseForThread"] = Effect.fn(
    "EnvironmentRegistry.chooseForThread",
  )(function* ({ userId, requested, projectId, providerInstanceId }) {
    const preferred =
      requested === undefined
        ? ((yield* sql<{ readonly environmentId: string | null }>`
            SELECT preferred_environment_id AS "environmentId"
            FROM projection_projects WHERE project_id = ${projectId}
          `.pipe(Effect.mapError(storageError)))[0]?.environmentId ?? null)
        : null;
    const environmentId =
      requested ??
      (preferred === null ? HUB_MACHINE_ENVIRONMENT_ID : EnvironmentId.make(preferred));
    if (environmentId === HUB_MACHINE_ENVIRONMENT_ID) return environmentId;
    const [row] = yield* selectRows([
      sql`environment_id = ${environmentId}`,
      sql`revoked_at IS NULL`,
    ]).pipe(Effect.mapError(storageError));
    const principal = userId === undefined ? undefined : yield* principalOf(userId);
    if (
      row === undefined ||
      principal === undefined ||
      principal.inactive === true ||
      !AccessPolicy.isAllowed(decide(principal, "environment.use", resourceOf(row)))
    ) {
      // Only a choice of the User's own is refused; a preference set by someone else falls back.
      if (requested === undefined) return HUB_MACHINE_ENVIRONMENT_ID;
      return yield* new ThreadEnvironmentUnavailableError({ environmentId, reason: "not-usable" });
    }
    const summary = yield* summaryOf(row);
    // An unavailable preference starts the Thread on the Hub machine, as the composer previews.
    if (requested === undefined) {
      return previewThreadPlacement({
        preferred: { ...summary, usable: true },
        providerInstanceId,
      });
    }
    if (summary.status !== "online") {
      return yield* new ThreadEnvironmentUnavailableError({
        environmentId,
        name: row.name,
        reason: "offline",
      });
    }
    const provider = summary.providers.find((entry) => entry.instanceId === providerInstanceId);
    if (provider === undefined || !provider.enabled || !provider.installed) {
      return yield* new ThreadEnvironmentUnavailableError({
        environmentId,
        name: row.name,
        reason: "provider-missing",
        providerInstanceId,
      });
    }
    return environmentId;
  });

  const usableBy: EnvironmentRegistry["Service"]["usableBy"] = Effect.fn(
    "EnvironmentRegistry.usableBy",
  )(function* ({ userId, environmentId }) {
    const [row] = yield* selectRows([
      sql`environment_id = ${environmentId}`,
      sql`revoked_at IS NULL`,
    ]).pipe(Effect.mapError(storageError));
    if (row === undefined || userId === undefined) return Option.none();
    const principal = yield* principalOf(userId);
    if (
      principal === undefined ||
      principal.inactive === true ||
      !AccessPolicy.isAllowed(decide(principal, "environment.use", resourceOf(row)))
    ) {
      return Option.none();
    }
    return Option.some({ name: row.name });
  });

  return EnvironmentRegistry.of({
    hubId,
    chooseForThread,
    usableBy,
    list,
    rename,
    remove,
    mayRegister,
    register,
    revokeOwnedBy,
    checkCredential,
    recordHello,
    recordHeartbeat,
    leave,
    removed: Stream.fromPubSub(removals),
  });
});

export const layer = Layer.effect(EnvironmentRegistry, make).pipe(
  Layer.provide(AuditLog.layer),
  Layer.provideMerge(EnvironmentConnections.layer),
);
