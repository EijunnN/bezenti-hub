import {
  type ProjectId,
  SpaceId,
  type SpaceDirectoryView,
  SpaceKind,
  SpaceRole,
  type SpaceSummary,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as AccessPolicy from "../auth/AccessPolicy.ts";

export class SpaceDirectoryStorageError extends Schema.TaggedError<SpaceDirectoryStorageError>()(
  "SpaceDirectoryStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read or write Spaces.";
  }
}

const DENIED_ACTION_LABELS: Record<string, string> = {
  "space.view": "see what is",
  "thread.create": "create Threads",
  "project.create": "create Projects",
  "organization.create": "create Organizations",
  "invitation.create": "invite people",
  "invitation.manage": "manage Invitations",
};

export class SpaceAccessDeniedError extends Schema.TaggedError<SpaceAccessDeniedError>()(
  "SpaceAccessDeniedError",
  { action: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    const what = DENIED_ACTION_LABELS[this.action] ?? "do that";
    return `You can't ${what} in this Space.`;
  }
}

export class SpaceNotFoundError extends Schema.TaggedError<SpaceNotFoundError>()(
  "SpaceNotFoundError",
  { spaceId: SpaceId },
) {
  override get message(): string {
    return `Space ${this.spaceId} does not exist.`;
  }
}

const isAccessDenied = Schema.is(SpaceAccessDeniedError);
const isNotFound = Schema.is(SpaceNotFoundError);

/** The refusal to show a user when a create failed because of its Space, however it was wrapped. */
export const spaceRefusalMessage = (cause: unknown): string | undefined => {
  let current = cause;
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    if (isAccessDenied(current) || isNotFound(current)) return current.message;
    current =
      typeof current === "object" && current !== null
        ? (current as { readonly cause?: unknown }).cause
        : undefined;
  }
  return undefined;
};

export type SpaceClaimError =
  | SpaceAccessDeniedError
  | SpaceNotFoundError
  | SpaceDirectoryStorageError;

/** The Space a new Project or Thread belongs to and the User who owns it. */
export interface CreationStamp {
  readonly spaceId: SpaceId;
  readonly ownerUserId: UserId;
}

export interface CreationClaim {
  readonly action: "project.create" | "thread.create";
  /**
   * The User creating it, taken from their session, never from a client payload. Callers with no
   * User of their own yet (MCP tools, scheduled tasks, the CLI) leave it out and act as the Owner.
   */
  readonly actorUserId?: UserId | undefined;
  /** The client's current Space. */
  readonly spaceId?: SpaceId | undefined;
  /** A Thread's Project, whose Space wins over the requested one. */
  readonly projectId?: ProjectId | undefined;
}

// Created with the User by a trigger (migration 085).
const personalSpaceIdOf = (userId: UserId) => SpaceId.make(`personal:${userId}`);

const SpaceRow = Schema.Struct({
  spaceId: SpaceId,
  kind: SpaceKind,
  name: Schema.String,
  personalOwnerUserId: Schema.NullOr(UserId),
  archived: Schema.BooleanFromBit,
  frozen: Schema.BooleanFromBit,
});
type SpaceRow = typeof SpaceRow.Type;

const toResource = (row: SpaceRow): AccessPolicy.SpaceResource => ({
  id: row.spaceId,
  kind: row.kind,
  personalOwnerUserId: row.personalOwnerUserId,
  archived: row.archived,
  frozen: row.frozen,
});

export class SpaceDirectory extends Context.Service<
  SpaceDirectory,
  {
    /** What the policy needs to know about a User: Owner or not, Roles, Installation permissions. */
    readonly principalOf: (
      userId: UserId,
    ) => Effect.Effect<AccessPolicy.Principal, SpaceDirectoryStorageError>;
    /** The Spaces a User can switch to, starting with their own Personal space. */
    readonly view: (
      userId: UserId,
    ) => Effect.Effect<SpaceDirectoryView, SpaceDirectoryStorageError>;
    readonly createOrganization: (
      userId: UserId,
      name: string,
    ) => Effect.Effect<SpaceSummary, SpaceAccessDeniedError | SpaceDirectoryStorageError>;
    /**
     * Where a new Project or Thread belongs, once the policy allows it. A Thread joins its
     * Project's Space (the Owner's Personal space for a Project from before Spaces); otherwise
     * the requested Space, or the creator's Personal space. None before the Owner exists.
     */
    readonly claimCreation: (
      claim: CreationClaim,
    ) => Effect.Effect<CreationStamp | undefined, SpaceClaimError>;
    /** The Space, once the policy allows the User the action there. */
    readonly authorize: (
      userId: UserId,
      action: AccessPolicy.Action,
      spaceId: SpaceId,
    ) => Effect.Effect<{ readonly id: SpaceId; readonly name: string }, SpaceClaimError>;
    /**
     * Makes the User a Member of the Organization with the Role; false when they already are one.
     * Run it in the caller's transaction (accepting an Invitation), then `changed` after it.
     */
    readonly addMembership: (input: {
      readonly spaceId: SpaceId;
      readonly userId: UserId;
      readonly role: SpaceRole;
    }) => Effect.Effect<boolean, SpaceDirectoryStorageError>;
    /**
     * The Spaces whose content the User may see (the policy's `space.view`), or "all" for the
     * Owner. Read on the writer connection, so a change committed before the call is seen.
     */
    readonly viewableSpaces: (
      userId: UserId,
    ) => Effect.Effect<"all" | ReadonlyArray<SpaceId>, SpaceDirectoryStorageError>;
    /**
     * Grows whenever a Space or a Membership changes, so a cached `viewableSpaces` answer can
     * tell it is stale. Every such write goes through this service.
     */
    readonly revision: Effect.Effect<number>;
    /**
     * Bumps `revision`. Callers that write Memberships inside their own transaction run it once
     * that transaction ends, so no viewer caches what it read before the commit.
     */
    readonly changed: Effect.Effect<void>;
  }
>()("t3/spaces/SpaceDirectory") {}

const SPACE_COLUMNS = `space_id AS "spaceId", kind, name, personal_owner_user_id AS "personalOwnerUserId",
  archived_at IS NOT NULL AS "archived", frozen_at IS NOT NULL AS "frozen"`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const storageError = (cause: unknown) => new SpaceDirectoryStorageError({ cause });
  const revision = yield* Ref.make(0);
  const changed = Ref.update(revision, (current) => current + 1);

  const findSpace = SqlSchema.findOneOption({
    Request: SpaceId,
    Result: SpaceRow,
    execute: (spaceId) =>
      sql`SELECT ${sql.literal(SPACE_COLUMNS)} FROM spaces WHERE space_id = ${spaceId}`,
  });
  const listSpaces = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SpaceRow,
    execute: () => sql`SELECT ${sql.literal(SPACE_COLUMNS)} FROM spaces`,
  });
  const listOrganizations = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SpaceRow,
    execute: () => sql`
      SELECT ${sql.literal(SPACE_COLUMNS)} FROM spaces WHERE kind = 'organization'
      ORDER BY created_at ASC, space_id ASC
    `,
  });
  // The User row and their memberships in one read.
  const findPrincipalRows = SqlSchema.findAll({
    Request: UserId,
    Result: Schema.Struct({
      isOwner: Schema.BooleanFromBit,
      spaceId: Schema.NullOr(SpaceId),
      role: Schema.NullOr(SpaceRole),
    }),
    execute: (userId) => sql`
      SELECT users.is_owner AS "isOwner", m.space_id AS "spaceId", m.role AS role
      FROM users LEFT JOIN space_memberships AS m ON m.user_id = users.user_id
      WHERE users.user_id = ${userId}
    `,
  });
  const findOwnerId = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ userId: UserId }),
    execute: () => sql`SELECT user_id AS "userId" FROM users WHERE is_owner = 1`,
  });
  const findProjectSpace = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ spaceId: Schema.NullOr(SpaceId) }),
    execute: (projectId) => sql`
      SELECT space_id AS "spaceId" FROM projection_projects WHERE project_id = ${projectId}
    `,
  });

  const principalOf = Effect.fn("SpaceDirectory.principalOf")(function* (userId: UserId) {
    const rows = yield* findPrincipalRows(userId);
    const roles = new Map<SpaceId, SpaceRole>();
    for (const row of rows)
      if (row.spaceId !== null && row.role !== null) roles.set(row.spaceId, row.role);
    return {
      userId,
      isOwner: rows[0]?.isOwner ?? false,
      // The Owner cannot grant Installation permissions yet, so non-Owners hold none.
      installationPermissions: new Set(),
      roles,
    } satisfies AccessPolicy.Principal;
  }, Effect.mapError(storageError));

  const allows = (
    principal: AccessPolicy.Principal,
    action: AccessPolicy.Action,
    resource: AccessPolicy.Resource,
  ) => AccessPolicy.isAllowed(AccessPolicy.decide(principal, action, resource));

  const view = Effect.fn("SpaceDirectory.view")(function* (userId: UserId) {
    const personalSpaceId = personalSpaceIdOf(userId);
    const [principal, organizations] = yield* Effect.all(
      [principalOf(userId), listOrganizations().pipe(Effect.mapError(storageError))],
      { concurrency: "unbounded" },
    );
    const personal: AccessPolicy.SpaceResource = {
      id: personalSpaceId,
      kind: "personal",
      personalOwnerUserId: userId,
      archived: false,
      frozen: false,
    };
    const spaces: Array<SpaceSummary> = [
      {
        id: personalSpaceId,
        kind: "personal",
        name: "Personal",
        role: null,
        isOwn: true,
        canCreateThreads: allows(principal, "thread.create", personal),
        canInvite: false,
      },
      ...organizations
        .filter((row) => allows(principal, "space.view", toResource(row)))
        .map((row) => ({
          id: row.spaceId,
          kind: row.kind,
          name: row.name,
          role: principal.roles.get(row.spaceId) ?? null,
          isOwn: false,
          canCreateThreads: allows(principal, "thread.create", toResource(row)),
          canInvite: allows(principal, "invitation.create", toResource(row)),
        })),
    ];
    return {
      userId,
      spaces,
      personalSpaceId,
      canCreateOrganization: allows(principal, "organization.create", AccessPolicy.installation),
    } satisfies SpaceDirectoryView;
  });

  const viewableSpaces = Effect.fn("SpaceDirectory.viewableSpaces")(function* (userId: UserId) {
    const principal = yield* principalOf(userId);
    if (principal.isOwner) return "all" as const;
    const spaces = yield* listSpaces().pipe(Effect.mapError(storageError));
    return spaces
      .filter((row) => allows(principal, "space.view", toResource(row)))
      .map((row) => row.spaceId);
  });

  const requireAllowed = (
    principal: AccessPolicy.Principal,
    action: AccessPolicy.Action,
    resource: AccessPolicy.Resource,
  ) => {
    const decision = AccessPolicy.decide(principal, action, resource);
    return decision._tag === "Allow"
      ? Effect.void
      : Effect.fail(new SpaceAccessDeniedError({ action, reason: decision.reason }));
  };

  const createOrganization = Effect.fn("SpaceDirectory.createOrganization")(function* (
    userId: UserId,
    name: string,
  ) {
    const principal = yield* principalOf(userId);
    yield* requireAllowed(principal, "organization.create", AccessPolicy.installation);
    const spaceId = SpaceId.make(yield* random.uuidV4().pipe(Effect.mapError(storageError)));
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO spaces (space_id, kind, name, created_at)
      VALUES (${spaceId}, 'organization', ${name}, ${now})
    `.pipe(Effect.mapError(storageError), Effect.ensuring(changed));
    return {
      id: spaceId,
      kind: "organization",
      name,
      role: null,
      isOwn: false,
      canCreateThreads: true,
      canInvite: true,
    } satisfies SpaceSummary;
  });

  const ownerId = findOwnerId().pipe(
    Effect.map(Option.map((row) => row.userId)),
    Effect.mapError(storageError),
  );

  const claimCreation = Effect.fn("SpaceDirectory.claimCreation")(function* (claim: CreationClaim) {
    const actor = claim.actorUserId ?? Option.getOrUndefined(yield* ownerId);
    if (actor === undefined) return undefined;
    const project =
      claim.projectId === undefined
        ? Option.none()
        : yield* findProjectSpace(claim.projectId).pipe(Effect.mapError(storageError));
    let spaceId: SpaceId | undefined;
    if (Option.isSome(project)) {
      // A Project from before Spaces belongs to the Owner's Personal space.
      const legacyOwner =
        project.value.spaceId === null ? Option.getOrUndefined(yield* ownerId) : undefined;
      spaceId =
        project.value.spaceId ??
        (legacyOwner === undefined ? undefined : personalSpaceIdOf(legacyOwner));
    }
    spaceId ??= claim.spaceId ?? personalSpaceIdOf(actor);
    const [space, principal] = yield* Effect.all(
      [findSpace(spaceId).pipe(Effect.mapError(storageError)), principalOf(actor)],
      { concurrency: "unbounded" },
    );
    if (Option.isNone(space)) return yield* new SpaceNotFoundError({ spaceId });
    yield* requireAllowed(principal, claim.action, toResource(space.value));
    return { spaceId, ownerUserId: actor } satisfies CreationStamp;
  });

  const authorize = Effect.fn("SpaceDirectory.authorize")(function* (
    userId: UserId,
    action: AccessPolicy.Action,
    spaceId: SpaceId,
  ) {
    const [space, principal] = yield* Effect.all(
      [findSpace(spaceId).pipe(Effect.mapError(storageError)), principalOf(userId)],
      { concurrency: "unbounded" },
    );
    if (Option.isNone(space)) return yield* new SpaceNotFoundError({ spaceId });
    yield* requireAllowed(principal, action, toResource(space.value));
    return { id: space.value.spaceId, name: space.value.name };
  });

  const addMembership = Effect.fn("SpaceDirectory.addMembership")(function* (input: {
    readonly spaceId: SpaceId;
    readonly userId: UserId;
    readonly role: SpaceRole;
  }) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const inserted = yield* sql<{ readonly userId: string }>`
      INSERT INTO space_memberships (space_id, user_id, role, created_at)
      VALUES (${input.spaceId}, ${input.userId}, ${input.role}, ${now})
      ON CONFLICT (space_id, user_id) DO NOTHING
      RETURNING user_id AS "userId"
    `.pipe(Effect.mapError(storageError));
    return inserted.length > 0;
  });

  return SpaceDirectory.of({
    principalOf,
    view,
    createOrganization,
    claimCreation,
    authorize,
    addMembership,
    viewableSpaces,
    revision: Ref.get(revision),
    changed,
  });
});

export const layer = Layer.effect(SpaceDirectory, make);
