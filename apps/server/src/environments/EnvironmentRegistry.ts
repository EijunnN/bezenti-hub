/**
 * The machines registered with this Hub (`environments`, migrations 094 and 100) and their
 * credentials, kept only as SHA-256. A removed machine's row stays revoked, so its credential
 * answers "revoked". Each Space's Sandbox is one of them, made when first chosen (`Sandboxes`).
 * See docs/internals/environment-auth.md#joined-environments and docs/internals/sandboxes.md.
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
  sandboxEnvironmentIdOf,
  sandboxEnvironmentName,
  SpaceId,
  type ThreadId,
  UserId,
} from "@t3tools/contracts";
import {
  environmentCredentialIssuer,
  REGISTER_OWN_REQUIRED_MESSAGE,
} from "@t3tools/shared/environmentJoin";
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
import type * as SandboxRuntime from "../sandboxes/SandboxRuntime.ts";
import * as Sandboxes from "../sandboxes/Sandboxes.ts";
import * as ProcessSandboxRuntime from "../sandboxes/ProcessSandboxRuntime.ts";
import { sandboxSpaceOf } from "../sandboxes/sandboxSpace.ts";
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
      case "sandbox":
        return "A Space's Sandbox is run by the Hub: it is not renamed or removed as a machine.";
      case "not-usable":
        return "You can't run Threads in this Sandbox's Space.";
      case "missing-installation-permission":
        return REGISTER_OWN_REQUIRED_MESSAGE;
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
    reason: Schema.Literals([
      "not-usable",
      "offline",
      "provider-missing",
      "worktree-unsupported",
      "sandbox-failed",
      "sandbox-unavailable",
    ]),
    providerInstanceId: Schema.optional(Schema.String),
    /** Why a Sandbox did not start. */
    detail: Schema.optional(Schema.String),
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
      case "sandbox-unavailable":
        return "Sandboxes need Podman on the Hub, which this Hub does not have yet. See «Run Threads in your Space's Sandbox» in the install guide.";
      case "sandbox-failed":
        return `${name} could not start${this.detail === undefined ? "." : `: ${this.detail}`}`;
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
      /** Null for a Sandbox, which belongs to its Space. */
      readonly ownerUserId: UserId | null;
      /** A Sandbox's Space: the only one its credential reaches. */
      readonly spaceId: SpaceId | null;
    }
  | { readonly _tag: "refused"; readonly reason: EnvironmentCloseReason };

interface EnvironmentRow {
  readonly environmentId: string;
  readonly name: string;
  readonly kind: "hub" | "external" | "sandbox";
  readonly ownerUserId: string | null;
  readonly spaceId: string | null;
  readonly registeredAt: string;
  readonly lastSeenAt: string | null;
  readonly lastOs: string | null;
  readonly lastHostname: string | null;
  readonly lastResourcesJson: string | null;
  readonly lastProvidersJson: string | null;
  readonly revokedAt: string | null;
  /** The owner was turned off or removed. */
  readonly ownerInactive: number;
  /** A Sandbox's lifecycle (`sandboxes.status`) and why its last start failed. */
  readonly sandboxStatus: "stopped" | "starting" | "running" | "failed" | null;
  readonly sandboxError: string | null;
}

type PolicyRow = Pick<EnvironmentRow, "kind" | "ownerUserId" | "spaceId">;

const decodeResources = Schema.decodeUnknownOption(Schema.fromJsonString(EnvironmentHostResources));
const decodeProviders = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(EnvironmentProviderSummary)),
);
const encodeResources = Schema.encodeSync(Schema.fromJsonString(EnvironmentHostResources));
const encodeProviders = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(EnvironmentProviderSummary)),
);

/**
 * The machine as the policy decides on it: a Sandbox with its Space (absent when the Space is
 * gone, which the policy refuses), and `workSpaceId` the Space of the Thread it would run.
 */
const environmentResource = (
  row: PolicyRow,
  space: AccessPolicy.SpaceResource | undefined,
  workSpaceId?: SpaceId,
): AccessPolicy.EnvironmentResource => ({
  kind: "environment",
  environmentKind: row.kind,
  ownerUserId: row.ownerUserId === null ? null : UserId.make(row.ownerUserId),
  ...(space === undefined ? {} : { space }),
  ...(workSpaceId === undefined ? {} : { workSpaceId }),
});

/** `environmentResource` with a Sandbox's Space read for it. */
const resourceFor = Effect.fn("EnvironmentRegistry.resourceFor")(function* (
  row: PolicyRow,
  workSpaceId?: SpaceId,
) {
  const space =
    row.kind === "sandbox" && row.spaceId !== null
      ? yield* (yield* SpaceDirectory.SpaceDirectory)
          .spaceById(SpaceId.make(row.spaceId))
          .pipe(Effect.mapError((cause) => new EnvironmentStorageError({ cause })))
      : Option.none<{ readonly resource: AccessPolicy.SpaceResource }>();
  return environmentResource(
    row,
    Option.isSome(space) ? space.value.resource : undefined,
    workSpaceId,
  );
});

/**
 * Whether the User may run Threads on the Environment (a Sandbox: for `workSpaceId`'s Threads), as
 * a Project's preferred Environment must be for its setter. Unknown and removed machines answer
 * false; without a User any machine the Hub knows will do. A plain function, so Project services
 * can ask it without the registry's connections.
 */
export const mayUseEnvironment = Effect.fn("EnvironmentRegistry.mayUseEnvironment")(function* (
  userId: UserId | undefined,
  environmentId: EnvironmentId,
  workSpaceId?: SpaceId,
) {
  if (environmentId === HUB_MACHINE_ENVIRONMENT_ID) return true;
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<PolicyRow>`
    SELECT kind, owner_user_id AS "ownerUserId", space_id AS "spaceId" FROM environments
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
      AccessPolicy.decide(principal, "environment.use", yield* resourceFor(row, workSpaceId)),
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
    /**
     * What the User may see, the Hub machine first. A Space the User works in whose Sandbox was
     * never made lists it too, offline, so it can be chosen and made.
     */
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
    /**
     * Whether the User may approve their own machine joining (the Owner, or `registerOwn`);
     * checked before the strong factor. Refuses with the reason.
     */
    readonly authorizeRegister: (
      userId: UserId,
    ) => Effect.Effect<void, EnvironmentAccessDeniedError | EnvironmentStorageError>;
    /**
     * Stores a newly joined machine by its credential's hash as a personal machine of the User who
     * approved it, recording them.
     */
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
    /** `t3 leave`: the machine removes itself with its own credential. A Sandbox never does. */
    readonly leave: (
      credential: string | undefined,
    ) => Effect.Effect<boolean, EnvironmentStorageError>;
    /**
     * Where a new Thread runs: the User's choice, else the Project's preference, else the Hub
     * machine. Usable by the User for the Thread's Space, online with the provider; a Sandbox is
     * made if missing and counts while stopped (its work starts it), never started here.
     */
    readonly chooseForThread: (input: {
      readonly userId: UserId | undefined;
      readonly requested: EnvironmentId | undefined;
      readonly projectId: ProjectId;
      readonly providerInstanceId: ProviderInstanceId;
      /** The new Thread's Space, once claimed; else its Project's. */
      readonly spaceId?: SpaceId | undefined;
      /** A Thread that moves: its own Space is the one that counts. */
      readonly threadId?: ThreadId | undefined;
    }) => Effect.Effect<EnvironmentId, ThreadEnvironmentUnavailableError | EnvironmentStorageError>;
    /**
     * The Environment's name when the User may use it for the Thread (`environment.use`: a
     * personal machine is its owner's alone, a Sandbox its Space's), whether or not it is
     * online; None otherwise. Calls forwarded to a machine check it, so a Thread is never a way
     * onto a machine its User may not use.
     */
    readonly usableBy: (input: {
      readonly userId: UserId | undefined;
      readonly environmentId: EnvironmentId;
      /** The Thread the call is for; a Sandbox serves only its own Space's. */
      readonly threadId?: ThreadId | undefined;
    }) => Effect.Effect<Option.Option<{ readonly name: string }>, EnvironmentStorageError>;
    /**
     * Each Environment once its removal committed (from Settings, `t3 leave`, or its owner turned
     * off): its Threads then need an environment.
     */
    readonly removed: Stream.Stream<EnvironmentId>;
    /**
     * «Try again» on a Sandbox that failed to start: a User who may run Threads in its Space starts
     * it. Answers at once with it `starting`; how the start ends shows in the list.
     */
    readonly startSandbox: (input: {
      readonly actorUserId: UserId;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<
      HubEnvironmentSummary,
      EnvironmentNotFoundError | EnvironmentAccessDeniedError | EnvironmentStorageError
    >;
    /** Its Organization was archived: its Sandbox stops, and starts no more while archived. */
    readonly stopSandbox: (input: {
      readonly spaceId: SpaceId;
      readonly actor: AuditLog.AuditActor;
    }) => Effect.Effect<void, EnvironmentStorageError>;
    /**
     * Its Space is deleted: its Sandbox stops, its credential is revoked, its row and home go.
     * Its Threads then need an environment, as for a removed machine.
     */
    readonly deleteSandbox: (input: {
      readonly spaceId: SpaceId;
      readonly actor: AuditLog.AuditActor;
    }) => Effect.Effect<void, EnvironmentStorageError>;
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
  // Without a Sandbox runtime (the join flow's tests) Sandboxes are listed but never made.
  const sandboxes = yield* Effect.serviceOption(Sandboxes.Sandboxes);
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
      space_id AS "spaceId",
      registered_at AS "registeredAt", last_seen_at AS "lastSeenAt", last_os AS "lastOs",
      last_hostname AS "lastHostname", last_resources_json AS "lastResourcesJson",
      last_providers_json AS "lastProvidersJson", revoked_at AS "revokedAt",
      EXISTS (
        SELECT 1 FROM users AS owner WHERE owner.user_id = environments.owner_user_id
          AND (owner.disabled_at IS NOT NULL OR owner.removed_at IS NOT NULL)
      ) AS "ownerInactive",
      (
        SELECT sandbox.status FROM sandboxes AS sandbox
        WHERE sandbox.environment_id = environments.environment_id
      ) AS "sandboxStatus",
      (
        SELECT sandbox.last_error FROM sandboxes AS sandbox
        WHERE sandbox.environment_id = environments.environment_id
      ) AS "sandboxError"
    FROM environments WHERE ${sql.and(conditions)}
    ORDER BY kind = 'hub' DESC, registered_at, environment_id
  `;

  const liveRow = (environmentId: EnvironmentId) =>
    selectRows([sql`environment_id = ${environmentId}`, sql`revoked_at IS NULL`]).pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError(storageError),
    );

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

  /**
   * One machine as a viewer sees it. The Hub machine's load, providers and running Threads are the
   * whole Installation's, so only the Owner (`ownerView`) gets them. `name` replaces the stored
   * one: a Sandbox is named after its Space as the viewer calls it.
   */
  const summaryOf = Effect.fn("EnvironmentRegistry.summaryOf")(function* (
    row: EnvironmentRow,
    ownerView = true,
    name?: string,
  ) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (row.kind === "hub" && !ownerView) {
      return {
        id: EnvironmentId.make(row.environmentId),
        name: row.name,
        kind: row.kind,
        mode: "personal",
        ownerUserId: null,
        spaceId: null,
        status: "online",
        registeredAt: row.registeredAt,
        lastSeenAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        os: platform,
        hostname: null,
        providers: [],
        resources: null,
        runningThreadCount: 0,
      } satisfies HubEnvironmentSummary;
    }
    if (row.kind === "hub") {
      const snapshot = yield* HubMachineSnapshot;
      return {
        id: EnvironmentId.make(row.environmentId),
        name: row.name,
        kind: row.kind,
        mode: "personal",
        ownerUserId: null,
        spaceId: null,
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
    const connected = yield* connections.isConnected(environmentId);
    const connection = environmentConnectionStatus({
      connected,
      lastSeenAtMs: row.lastSeenAt === null ? null : Date.parse(row.lastSeenAt),
      nowMs,
    });
    const status: HubEnvironmentSummary["status"] =
      row.kind !== "sandbox"
        ? connection
        : // A Sandbox is online once started; until then the Hub starts it when work needs it.
          row.sandboxStatus === "starting"
          ? "starting"
          : connected
            ? connection
            : row.sandboxStatus === "failed"
              ? "failed"
              : row.sandboxStatus === "running"
                ? connection
                : "stopped";
    return {
      id: environmentId,
      name: name ?? row.name,
      kind: row.kind,
      mode: row.kind === "sandbox" ? "sandbox" : "personal",
      ownerUserId: row.ownerUserId === null ? null : UserId.make(row.ownerUserId),
      spaceId: row.spaceId === null ? null : SpaceId.make(row.spaceId),
      status,
      ...(row.kind === "sandbox"
        ? { startError: status === "failed" ? row.sandboxError : null }
        : {}),
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

  const resourceOf = (row: PolicyRow, workSpaceId?: SpaceId) =>
    resourceFor(row, workSpaceId).pipe(
      Effect.provideService(SpaceDirectory.SpaceDirectory, spaces),
    );

  const list: EnvironmentRegistry["Service"]["list"] = Effect.fn("EnvironmentRegistry.list")(
    function* (viewer) {
      const principal = yield* principalOf(viewer);
      if (principal.inactive === true) {
        return yield* new EnvironmentAccessDeniedError({ reason: "user-inactive" });
      }
      const rows = yield* selectRows([sql`revoked_at IS NULL`]).pipe(Effect.mapError(storageError));
      // Each Space by the name this viewer knows it by (another User's Personal space included).
      const viewed = (yield* spaces.view(viewer).pipe(Effect.mapError(storageError))).spaces;
      const spaceNames = new Map<string, string>(viewed.map((space) => [space.id, space.name]));
      // One read for every Sandbox's Space and every Space that may get one.
      const spaceResources = yield* spaces
        .spacesById([
          ...rows.flatMap((row) =>
            row.kind === "sandbox" && row.spaceId !== null ? [SpaceId.make(row.spaceId)] : [],
          ),
          ...viewed.map((space) => space.id),
        ])
        .pipe(Effect.mapError(storageError));
      const spaceOf = (spaceId: string | null) =>
        spaceId === null ? undefined : spaceResources.get(SpaceId.make(spaceId))?.resource;
      const summaries: Array<HubEnvironmentSummary> = [];
      for (const row of rows) {
        const resource = environmentResource(
          row,
          row.kind === "sandbox" ? spaceOf(row.spaceId) : undefined,
        );
        if (!AccessPolicy.isAllowed(decide(principal, "environment.view", resource))) continue;
        const spaceName =
          row.kind === "sandbox" && row.spaceId !== null ? spaceNames.get(row.spaceId) : undefined;
        summaries.push(
          yield* summaryOf(
            row,
            principal.isOwner,
            spaceName === undefined ? undefined : sandboxEnvironmentName(spaceName),
          ),
        );
      }
      const made = new Set(rows.flatMap((row) => (row.kind === "sandbox" ? [row.spaceId] : [])));
      // Without a runtime that can run them, Sandboxes not made yet are not offered.
      if (Option.isNone(sandboxes)) return summaries;
      const now = yield* nowIso;
      for (const space of viewed) {
        if (made.has(space.id)) continue;
        const resource = environmentResource(
          { kind: "sandbox", ownerUserId: null, spaceId: space.id },
          spaceOf(space.id),
          space.id,
        );
        if (!AccessPolicy.isAllowed(decide(principal, "environment.use", resource))) continue;
        summaries.push({
          id: sandboxEnvironmentIdOf(space.id),
          name: sandboxEnvironmentName(space.name),
          kind: "sandbox",
          mode: "sandbox",
          ownerUserId: null,
          spaceId: space.id,
          status: "stopped",
          registeredAt: now,
          lastSeenAt: null,
          os: null,
          hostname: null,
          providers: [],
          resources: null,
          runningThreadCount: 0,
        });
      }
      return summaries;
    },
  );

  /** A live row the User may see and act on; a hidden one answers like a missing one. */
  const authorize = Effect.fn("EnvironmentRegistry.authorize")(function* (
    actorUserId: UserId,
    environmentId: EnvironmentId,
    action: "environment.rename" | "environment.remove",
  ) {
    const principal = yield* principalOf(actorUserId);
    const row = yield* liveRow(environmentId);
    if (row === undefined) return yield* new EnvironmentNotFoundError({});
    const resource = yield* resourceOf(row);
    if (!AccessPolicy.isAllowed(decide(principal, "environment.view", resource))) {
      return yield* new EnvironmentNotFoundError({});
    }
    const decision = decide(principal, action, resource);
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

  const authorizeRegister: EnvironmentRegistry["Service"]["authorizeRegister"] = Effect.fn(
    "EnvironmentRegistry.authorizeRegister",
  )(function* (userId) {
    const decision = decide(
      yield* principalOf(userId),
      "environment.register",
      AccessPolicy.installation,
    );
    if (decision._tag === "Deny") {
      return yield* new EnvironmentAccessDeniedError({ reason: decision.reason });
    }
  });

  const register: EnvironmentRegistry["Service"]["register"] = Effect.fn(
    "EnvironmentRegistry.register",
  )(function* ({ approvedBy, name, os, hostname, credentialHash }) {
    const environmentId = EnvironmentId.make(yield* random.uuidV4());
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Asked again in the transaction: the approver may have lost the right since approving.
          yield* authorizeRegister(approvedBy);
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
    // A machine has its owner; a Sandbox, its Space.
    if (
      row === undefined ||
      (row.kind === "sandbox" ? row.spaceId === null : row.ownerUserId === null)
    ) {
      return { _tag: "refused", reason: "credential-unknown" } as const;
    }
    if (row.revokedAt !== null) return { _tag: "refused", reason: "credential-revoked" } as const;
    if (row.ownerInactive === 1) return { _tag: "refused", reason: "owner-inactive" } as const;
    return {
      _tag: "valid",
      environmentId: EnvironmentId.make(row.environmentId),
      name: row.name,
      ownerUserId: row.ownerUserId === null ? null : UserId.make(row.ownerUserId),
      spaceId: row.kind === "sandbox" && row.spaceId !== null ? SpaceId.make(row.spaceId) : null,
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
      // A Sandbox is the Hub's own: it does not remove itself.
      if (check._tag === "refused" || check.ownerUserId === null) return false;
      const ownerUserId = check.ownerUserId;
      const left = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* liveRow(check.environmentId);
            if (row === undefined) return false;
            // Run on the machine by its owner, through the credential the Owner approved.
            yield* revoke({ row, actor: { source: "cli", userId: ownerUserId }, via: "leave" });
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

  /** The Space a new or moving Thread works in: its own, else the claimed one, else its Project's. */
  const workSpaceOf = Effect.fn("EnvironmentRegistry.workSpaceOf")(function* (input: {
    readonly projectId: ProjectId;
    readonly spaceId?: SpaceId | undefined;
    readonly threadId?: ThreadId | undefined;
  }) {
    if (input.threadId !== undefined) {
      const space = yield* spaces.spaceOf({ kind: "thread", id: input.threadId });
      if (Option.isSome(space)) return space.value.id;
    }
    if (input.spaceId !== undefined) return input.spaceId;
    const space = yield* spaces.spaceOf({ kind: "project", id: input.projectId });
    return Option.getOrUndefined(Option.map(space, (found) => found.id));
  }, Effect.mapError(storageError));

  const chooseForThread: EnvironmentRegistry["Service"]["chooseForThread"] = Effect.fn(
    "EnvironmentRegistry.chooseForThread",
  )(function* ({ userId, requested, projectId, providerInstanceId, spaceId, threadId }) {
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
    const existing = yield* liveRow(environmentId);
    // A Space's Sandbox can be chosen before it exists: choosing it makes it.
    const sandboxSpace = sandboxSpaceOf(environmentId);
    const row: PolicyRow | undefined =
      existing ??
      (requested !== undefined && sandboxSpace !== undefined
        ? { kind: "sandbox", ownerUserId: null, spaceId: sandboxSpace }
        : undefined);
    const principal = userId === undefined ? undefined : yield* principalOf(userId);
    const workSpaceId =
      row?.kind === "sandbox" ? yield* workSpaceOf({ projectId, spaceId, threadId }) : undefined;
    const usable =
      row !== undefined &&
      principal !== undefined &&
      principal.inactive !== true &&
      AccessPolicy.isAllowed(
        decide(principal, "environment.use", yield* resourceOf(row, workSpaceId)),
      );
    if (row === undefined || !usable) {
      // Only a choice of the User's own is refused; a preference set by someone else falls back.
      if (requested === undefined) return HUB_MACHINE_ENVIRONMENT_ID;
      return yield* new ThreadEnvironmentUnavailableError({ environmentId, reason: "not-usable" });
    }
    if (requested !== undefined && row.kind === "sandbox" && row.spaceId !== null) {
      if (Option.isNone(sandboxes)) {
        return yield* new ThreadEnvironmentUnavailableError({
          environmentId,
          reason: "sandbox-unavailable",
        });
      }
      // Made here, started by the Thread's first work: placing never waits for it to boot.
      yield* sandboxes.value
        .ensureCreated({ spaceId: SpaceId.make(row.spaceId), actorUserId: userId })
        .pipe(
          Effect.mapError(
            (error) =>
              new ThreadEnvironmentUnavailableError({
                environmentId,
                reason: "sandbox-failed",
                detail: error.detail,
              }),
          ),
        );
    }
    const current = existing ?? (yield* liveRow(environmentId));
    if (current === undefined) {
      if (requested === undefined) return HUB_MACHINE_ENVIRONMENT_ID;
      return yield* new ThreadEnvironmentUnavailableError({ environmentId, reason: "not-usable" });
    }
    const summary = yield* summaryOf(current);
    // An unavailable preference starts the Thread on the Hub machine, as the composer previews.
    if (requested === undefined) {
      return previewThreadPlacement({
        preferred: { ...summary, usable: true },
        providerInstanceId,
      });
    }
    // A Sandbox not running starts for the work; its providers are known once it ran.
    const startsForWork = current.kind === "sandbox" && summary.status !== "online";
    if (summary.status !== "online" && !startsForWork) {
      return yield* new ThreadEnvironmentUnavailableError({
        environmentId,
        name: current.name,
        reason: "offline",
      });
    }
    if (startsForWork && summary.providers.length === 0) return environmentId;
    const provider = summary.providers.find((entry) => entry.instanceId === providerInstanceId);
    if (provider === undefined || !provider.enabled || !provider.installed) {
      return yield* new ThreadEnvironmentUnavailableError({
        environmentId,
        name: current.name,
        reason: "provider-missing",
        providerInstanceId,
      });
    }
    return environmentId;
  });

  const usableBy: EnvironmentRegistry["Service"]["usableBy"] = Effect.fn(
    "EnvironmentRegistry.usableBy",
  )(function* ({ userId, environmentId, threadId }) {
    const row = yield* liveRow(environmentId);
    if (row === undefined || userId === undefined) return Option.none();
    const principal = yield* principalOf(userId);
    const workSpace =
      row.kind === "sandbox" && threadId !== undefined
        ? yield* spaces
            .spaceOf({ kind: "thread", id: threadId })
            .pipe(Effect.mapError(storageError))
        : Option.none<AccessPolicy.SpaceResource>();
    if (
      principal.inactive === true ||
      !AccessPolicy.isAllowed(
        decide(
          principal,
          "environment.use",
          yield* resourceOf(row, Option.isSome(workSpace) ? workSpace.value.id : undefined),
        ),
      )
    ) {
      return Option.none();
    }
    return Option.some({ name: row.name });
  });

  const startSandbox: EnvironmentRegistry["Service"]["startSandbox"] = Effect.fn(
    "EnvironmentRegistry.startSandbox",
  )(function* ({ actorUserId, environmentId }) {
    const row = yield* liveRow(environmentId);
    if (row === undefined || row.kind !== "sandbox" || row.spaceId === null) {
      return yield* new EnvironmentNotFoundError({});
    }
    const spaceId = SpaceId.make(row.spaceId);
    const principal = yield* principalOf(actorUserId);
    const resource = yield* resourceOf(row, spaceId);
    if (!AccessPolicy.isAllowed(decide(principal, "environment.view", resource))) {
      return yield* new EnvironmentNotFoundError({});
    }
    if (
      principal.inactive === true ||
      !AccessPolicy.isAllowed(decide(principal, "environment.use", resource))
    ) {
      return yield* new EnvironmentAccessDeniedError({ reason: "not-usable" });
    }
    if (Option.isSome(sandboxes)) {
      // The Hub's own start (joined if one is under way); answers once it is `starting`.
      yield* sandboxes.value.requestStart({ spaceId, actorUserId, via: "retry" });
    }
    const current = yield* liveRow(environmentId);
    return yield* summaryOf(current ?? row, principal.isOwner);
  });

  return EnvironmentRegistry.of({
    hubId,
    startSandbox,
    chooseForThread,
    usableBy,
    list,
    rename,
    remove,
    authorizeRegister,
    register,
    revokeOwnedBy,
    checkCredential,
    recordHello,
    recordHeartbeat,
    leave,
    removed: Stream.fromPubSub(removals),
    stopSandbox: Effect.fn("EnvironmentRegistry.stopSandbox")(function* (input) {
      if (Option.isNone(sandboxes)) return;
      yield* sandboxes.value.stop(input).pipe(Effect.mapError(storageError));
    }),
    deleteSandbox: Effect.fn("EnvironmentRegistry.deleteSandbox")(function* (input) {
      const environmentId = sandboxEnvironmentIdOf(input.spaceId);
      if (Option.isSome(sandboxes)) {
        yield* sandboxes.value.delete(input).pipe(Effect.mapError(storageError));
      } else {
        // Made by a runtime this Hub no longer runs: its rows still go.
        yield* sql`
          UPDATE environments SET revoked_at = ${yield* nowIso}
          WHERE environment_id = ${environmentId} AND revoked_at IS NULL
        `.pipe(Effect.mapError(storageError));
        yield* sql`DELETE FROM sandboxes WHERE space_id = ${input.spaceId}`.pipe(
          Effect.mapError(storageError),
        );
      }
      yield* PubSub.publish(removals, environmentId);
    }),
  });
});

export const layer = Layer.effect(EnvironmentRegistry, make).pipe(
  Layer.provide(AuditLog.layer),
  Layer.provideMerge(EnvironmentConnections.layer),
);

/**
 * The registry with each Space's Sandbox run by `runtime`. The Sandboxes share the registry's
 * connections, so a Sandbox counts as started once its socket is the registry's.
 */
/** The registry as the server runs it: with Sandboxes only when a runtime that runs them is on. */
export const layerFromConfig = Layer.unwrap(
  Effect.map(ProcessSandboxRuntime.fromConfig, (runtime) =>
    Option.isNone(runtime) ? layer : layerWithSandboxes(runtime.value),
  ),
);

export const layerWithSandboxes = <E, R>(
  runtime: Layer.Layer<SandboxRuntime.SandboxRuntime, E, R>,
) =>
  Layer.effect(EnvironmentRegistry, make).pipe(
    // Sandboxes start for work and stop when idle: the orchestration and the workspace RPCs ask
    // through `EnvironmentDemand`, which they see beside the registry.
    Layer.provideMerge(Sandboxes.layer.pipe(Layer.provide(runtime))),
    Layer.provide(AuditLog.layer),
    Layer.provideMerge(EnvironmentConnections.layer),
  );
