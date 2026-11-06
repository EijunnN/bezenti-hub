import {
  type MemberList,
  type MemberSummary,
  type ProjectId,
  SpaceId,
  SpaceResourceNotFoundError,
  type ThreadId,
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
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";

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
  "guestLink.create": "create guest links",
  "admin.manage": "name or remove Admins",
  "membership.changeRole": "change this person's Role",
  "membership.remove": "remove this person",
  "membership.leave": "leave for someone else",
  "membership.resetLink": "give this person a reset link",
  "thread.continue": "continue this Thread",
  "thread.archive": "archive or restore this Thread",
  "thread.stop": "stop this Thread",
  "thread.delete": "permanently delete this Thread",
  "project.archive": "archive or restore this Project",
  "project.manage": "change this Project",
  "project.delete": "permanently delete this Project",
};

/** What to tell someone who can see the item but may not act on it. */
const deniedMessage = (action: string, reason: string): string | undefined => {
  if (action === "thread.continue" && reason === "not-yours") {
    return "Only the person who started this Thread can continue it. Start a new Thread to build on it.";
  }
  if (reason === "not-yours") {
    return `Only its creator or an Admin can ${DENIED_ACTION_LABELS[action] ?? "do that"}.`;
  }
  if (reason === "not-archived") return "Archive it before deleting it permanently.";
  if (reason === "no-such-member") return "That person is not in this Organization.";
  if (action.startsWith("membership.") && reason === "owner-only") {
    return "Only the Owner names, changes or removes Admins.";
  }
  if (reason === "no-user") return "This session belongs to no User. Sign in again.";
  if (
    (action === "thread.delete" || action === "project.delete") &&
    reason === "role-not-allowed"
  ) {
    return "Only an Admin can permanently delete.";
  }
  if (action === "guestLink.create") {
    return "Only an Admin can create guest links, and only in an Organization.";
  }
  return undefined;
};

export class SpaceAccessDeniedError extends Schema.TaggedError<SpaceAccessDeniedError>()(
  "SpaceAccessDeniedError",
  { action: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    const specific = deniedMessage(this.action, this.reason);
    if (specific !== undefined) return specific;
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

/** A Thread or Project a command acts on. */
export type ItemRef =
  | { readonly kind: "thread"; readonly id: ThreadId }
  | { readonly kind: "project"; readonly id: ProjectId };

export type ItemAccessError =
  | SpaceAccessDeniedError
  | SpaceResourceNotFoundError
  | SpaceDirectoryStorageError;

/** The Space a new Project or Thread belongs to and the User who owns it. */
export interface CreationStamp {
  readonly spaceId: SpaceId;
  readonly ownerUserId: UserId;
}

export interface CreationClaim {
  readonly action: "project.create" | "thread.create";
  /**
   * The User creating it, taken from their session or MCP scope, never from a client payload.
   * Only callers with no User (scheduled task runs, `t3 project`, before an Owner) leave it out
   * and act as the Owner.
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
    /**
     * Refuses the action on a Thread or Project the User may not take: not found when it is
     * missing or its Space is hidden from them (alike), a permission error when they can see it.
     */
    readonly authorizeItem: (
      userId: UserId,
      action: AccessPolicy.Action,
      item: ItemRef,
    ) => Effect.Effect<void, ItemAccessError>;
    /** The User who created the Thread (its root's for a child, the Owner's from before Spaces). */
    /**
     * The User the current command acts for (`CommandActor`), None for the server's own work.
     * A request whose session names no User is refused once an Owner exists; an agent in a
     * Thread from before owners were recorded acts as the Owner.
     */
    readonly actingUser: Effect.Effect<
      Option.Option<UserId>,
      SpaceAccessDeniedError | SpaceDirectoryStorageError
    >;
    readonly threadOwner: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<UserId>, SpaceDirectoryStorageError>;
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
     * The Organization's Members with what the viewer may do to each. An Organization the viewer
     * cannot see fails exactly like one that does not exist.
     */
    readonly members: (
      viewer: UserId,
      spaceId: SpaceId,
    ) => Effect.Effect<MemberList, SpaceNotFoundError | SpaceDirectoryStorageError>;
    /**
     * Refuses a Membership action the policy denies, and returns the target's current Role. A
     * hidden Organization answers like a missing one; a target who is not a Member is refused.
     */
    readonly authorizeMembership: (input: {
      readonly actor: UserId;
      readonly action: AccessPolicy.Action;
      readonly spaceId: SpaceId;
      readonly target: UserId;
      readonly nextRole?: SpaceRole;
    }) => Effect.Effect<SpaceRole, SpaceClaimError>;
    /** Gives a Member another Role; false when they are not one. Run it in the caller's transaction. */
    readonly setRole: (input: {
      readonly spaceId: SpaceId;
      readonly userId: UserId;
      readonly role: SpaceRole;
    }) => Effect.Effect<boolean, SpaceDirectoryStorageError>;
    /**
     * Ends a Membership (what they created stays in the Organization) and marks when the User lost
     * access; false when they were not a Member. Run it in the caller's transaction.
     */
    readonly removeMembership: (input: {
      readonly spaceId: SpaceId;
      readonly userId: UserId;
    }) => Effect.Effect<boolean, SpaceDirectoryStorageError>;
    /**
     * After a transaction that changed these Users' Memberships commits: bumps `revision` and
     * tells each User's open connections, which close so their client reloads what it may see.
     */
    readonly membershipsChanged: (userIds: ReadonlyArray<UserId>) => Effect.Effect<void>;
    /** Subscribes now; the returned effect completes at the User's next Membership change. */
    readonly nextMembershipChange: (
      userId: UserId,
    ) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;
    /** The event sequence when the User last lost a Membership; 0 when never. */
    readonly accessNarrowedThrough: (
      userId: UserId,
    ) => Effect.Effect<number, SpaceDirectoryStorageError>;
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
      isOwner: principal.isOwner,
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

  // One read per check: the item, its Space (its own, its Project's, else the Owner's Personal
  // space) and its owner (its own, its root's for a child the server made, else the Owner).
  const ItemRow = Schema.Struct({
    ownerUserId: Schema.NullOr(UserId),
    archived: Schema.BooleanFromBit,
    spaceId: Schema.NullOr(SpaceId),
    kind: Schema.NullOr(SpaceKind),
    personalOwnerUserId: Schema.NullOr(UserId),
    spaceArchived: Schema.BooleanFromBit,
    frozen: Schema.BooleanFromBit,
  });
  const OWNER_ID = "(SELECT user_id FROM users WHERE is_owner = 1)";
  const SPACE_OF_ITEM = `s.space_id AS "spaceId", s.kind AS "kind",
    s.personal_owner_user_id AS "personalOwnerUserId",
    COALESCE(s.archived_at IS NOT NULL, 0) AS "spaceArchived",
    COALESCE(s.frozen_at IS NOT NULL, 0) AS "frozen"`;
  const findThreadItem = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ItemRow,
    execute: (threadId) => sql`
      SELECT item.owner_user_id AS "ownerUserId", item.archived AS "archived",
        ${sql.literal(SPACE_OF_ITEM)}
      FROM (
        SELECT COALESCE(t.owner_user_id, root.owner_user_id, ${sql.literal(OWNER_ID)}) AS owner_user_id,
          t.archived_at IS NOT NULL AS archived,
          COALESCE(t.space_id, p.space_id, 'personal:' || ${sql.literal(OWNER_ID)}) AS space_id
        FROM orchestration_v2_projection_threads t
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        LEFT JOIN orchestration_v2_projection_threads root
          ON root.thread_id = json_extract(t.payload_json, '$.lineage.rootThreadId')
        WHERE t.thread_id = ${threadId}
      ) item LEFT JOIN spaces s ON s.space_id = item.space_id
    `,
  });
  const findProjectItem = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ItemRow,
    execute: (projectId) => sql`
      SELECT item.owner_user_id AS "ownerUserId", item.archived AS "archived",
        ${sql.literal(SPACE_OF_ITEM)}
      FROM (
        SELECT COALESCE(owner_user_id, ${sql.literal(OWNER_ID)}) AS owner_user_id,
          archived_at IS NOT NULL AS archived,
          COALESCE(space_id, 'personal:' || ${sql.literal(OWNER_ID)}) AS space_id
        FROM projection_projects WHERE project_id = ${projectId}
      ) item LEFT JOIN spaces s ON s.space_id = item.space_id
    `,
  });

  // Checks run on every command, so the principal is kept until a Space or Membership changes.
  const principals = new Map<
    UserId,
    { readonly revision: number; readonly principal: AccessPolicy.Principal }
  >();
  const currentPrincipal = Effect.fn("SpaceDirectory.currentPrincipal")(function* (userId: UserId) {
    const at = yield* Ref.get(revision);
    const cached = principals.get(userId);
    if (cached !== undefined && cached.revision === at) return cached.principal;
    const principal = yield* principalOf(userId);
    principals.set(userId, { revision: at, principal });
    return principal;
  });

  const actingUser = Effect.gen(function* () {
    const actor = yield* CommandActor.resolve;
    switch (actor._tag) {
      case "Server":
        return Option.none<UserId>();
      case "User":
        return Option.some(actor.userId);
      case "ThreadOwner":
        return yield* ownerId;
      case "NoUser": {
        if (Option.isNone(yield* ownerId)) return Option.none<UserId>();
        return yield* new SpaceAccessDeniedError({ action: "act", reason: "no-user" });
      }
    }
  });

  const threadOwner = Effect.fn("SpaceDirectory.threadOwner")(function* (threadId: ThreadId) {
    const row = yield* findThreadItem(threadId).pipe(Effect.mapError(storageError));
    return Option.flatMap(row, (found) => Option.fromNullishOr(found.ownerUserId));
  });

  // A hidden item and a missing one fail alike, so no answer says what exists elsewhere.
  const hiddenOrMissing = () =>
    new SpaceResourceNotFoundError({ message: "That Project or Thread does not exist." });

  const authorizeItem = Effect.fn("SpaceDirectory.authorizeItem")(function* (
    userId: UserId,
    action: AccessPolicy.Action,
    item: ItemRef,
  ) {
    const principal = yield* currentPrincipal(userId);
    // The Owner sees everything; only what even the Owner may not do needs the item read.
    if (principal.isOwner && action !== "thread.continue" && action !== "guestLink.create") return;
    const row = yield* (item.kind === "thread" ? findThreadItem : findProjectItem)(item.id).pipe(
      Effect.mapError(storageError),
    );
    if (Option.isNone(row) || row.value.spaceId === null || row.value.kind === null) {
      return yield* hiddenOrMissing();
    }
    const resource: AccessPolicy.SpaceResource = {
      id: row.value.spaceId,
      kind: row.value.kind,
      personalOwnerUserId: row.value.personalOwnerUserId,
      archived: row.value.spaceArchived,
      frozen: row.value.frozen,
    };
    if (!allows(principal, "space.view", resource)) return yield* hiddenOrMissing();
    // A Space-wide action (viewing, a guest link) is decided on the item's Space.
    if (!AccessPolicy.isItemAction(action)) {
      return yield* requireAllowed(principal, action, resource);
    }
    if (row.value.ownerUserId === null) return yield* hiddenOrMissing();
    yield* requireAllowed(principal, action, {
      kind: item.kind,
      space: resource,
      ownerUserId: row.value.ownerUserId,
      archived: row.value.archived,
    });
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

  const listMemberRows = SqlSchema.findAll({
    Request: SpaceId,
    Result: Schema.Struct({ userId: UserId, displayName: Schema.String, role: SpaceRole }),
    execute: (spaceId) => sql`
      SELECT m.user_id AS "userId", u.display_name AS "displayName", m.role AS role
      FROM space_memberships AS m JOIN users AS u ON u.user_id = m.user_id
      WHERE m.space_id = ${spaceId} AND u.removed_at IS NULL
      ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'member' THEN 1 ELSE 2 END,
        u.display_name COLLATE NOCASE, m.user_id
    `,
  });

  /** The Organization, when the User may see it; a hidden one is reported as missing. */
  const visibleOrganization = Effect.fn("SpaceDirectory.visibleOrganization")(function* (
    userId: UserId,
    spaceId: SpaceId,
  ) {
    const [space, principal] = yield* Effect.all(
      [findSpace(spaceId).pipe(Effect.mapError(storageError)), currentPrincipal(userId)],
      { concurrency: "unbounded" },
    );
    if (
      Option.isNone(space) ||
      space.value.kind !== "organization" ||
      !allows(principal, "space.view", toResource(space.value))
    ) {
      return yield* new SpaceNotFoundError({ spaceId });
    }
    return { principal, space: toResource(space.value) };
  });

  const ASSIGNABLE_ROLES: ReadonlyArray<SpaceRole> = ["admin", "member", "guest"];

  const members = Effect.fn("SpaceDirectory.members")(function* (viewer: UserId, spaceId: SpaceId) {
    const { principal, space } = yield* visibleOrganization(viewer, spaceId);
    const rows = yield* listMemberRows(spaceId).pipe(Effect.mapError(storageError));
    const may = (
      action: AccessPolicy.Action,
      userId: UserId,
      role: SpaceRole,
      nextRole?: SpaceRole,
    ) =>
      allows(principal, action, {
        kind: "membership",
        space,
        userId,
        role,
        ...(nextRole === undefined ? {} : { nextRole }),
      });
    return {
      members: rows.map((row): MemberSummary => ({
        userId: row.userId,
        displayName: row.displayName,
        role: row.role,
        isYou: row.userId === viewer,
        canChangeRole:
          row.userId !== viewer &&
          ASSIGNABLE_ROLES.some(
            (role) => role !== row.role && may("membership.changeRole", row.userId, row.role, role),
          ),
        canRemove: row.userId !== viewer && may("membership.remove", row.userId, row.role),
        canIssueResetLink:
          row.userId !== viewer && may("membership.resetLink", row.userId, row.role),
      })),
      // The Roles an Admin may give a Member, which are the ones they may invite as.
      assignableRoles: ASSIGNABLE_ROLES.filter((role) =>
        allows(principal, "membership.changeRole", {
          kind: "membership",
          space,
          userId: viewer,
          role: "guest",
          nextRole: role,
        }),
      ),
      canLeave: may("membership.leave", viewer, principal.roles.get(spaceId) ?? "guest"),
    } satisfies MemberList;
  });

  const authorizeMembership = Effect.fn("SpaceDirectory.authorizeMembership")(function* (input: {
    readonly actor: UserId;
    readonly action: AccessPolicy.Action;
    readonly spaceId: SpaceId;
    readonly target: UserId;
    readonly nextRole?: SpaceRole;
  }) {
    const { principal, space } = yield* visibleOrganization(input.actor, input.spaceId);
    const role = (yield* principalOf(input.target)).roles.get(input.spaceId);
    if (role === undefined) {
      return yield* new SpaceAccessDeniedError({ action: input.action, reason: "no-such-member" });
    }
    yield* requireAllowed(principal, input.action, {
      kind: "membership",
      space,
      userId: input.target,
      role,
      ...(input.nextRole === undefined ? {} : { nextRole: input.nextRole }),
    });
    return role;
  });

  const setRole = Effect.fn("SpaceDirectory.setRole")(function* (input: {
    readonly spaceId: SpaceId;
    readonly userId: UserId;
    readonly role: SpaceRole;
  }) {
    const updated = yield* sql<{ readonly userId: string }>`
      UPDATE space_memberships SET role = ${input.role}
      WHERE space_id = ${input.spaceId} AND user_id = ${input.userId}
      RETURNING user_id AS "userId"
    `.pipe(Effect.mapError(storageError));
    return updated.length > 0;
  });

  const removeMembership = Effect.fn("SpaceDirectory.removeMembership")(function* (input: {
    readonly spaceId: SpaceId;
    readonly userId: UserId;
  }) {
    const removed = yield* sql<{ readonly userId: string }>`
      DELETE FROM space_memberships
      WHERE space_id = ${input.spaceId} AND user_id = ${input.userId}
      RETURNING user_id AS "userId"
    `;
    if (removed.length === 0) return false;
    yield* sql`
      UPDATE users
      SET access_narrowed_through = (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events)
      WHERE user_id = ${input.userId}
    `;
    return true;
  }, Effect.mapError(storageError));

  const membershipChanges = yield* PubSub.unbounded<UserId>();
  const membershipsChanged = (userIds: ReadonlyArray<UserId>) =>
    changed.pipe(Effect.andThen(PubSub.publishAll(membershipChanges, userIds)), Effect.asVoid);

  const nextMembershipChange = Effect.fn("SpaceDirectory.nextMembershipChange")(function* (
    userId: UserId,
  ) {
    const subscription = yield* PubSub.subscribe(membershipChanges);
    const next: Effect.Effect<void> = PubSub.take(subscription).pipe(
      Effect.flatMap((changedUserId) => (changedUserId === userId ? Effect.void : next)),
    );
    return next;
  });

  const findAccessNarrowed = SqlSchema.findOneOption({
    Request: UserId,
    Result: Schema.Struct({ through: Schema.NullOr(Schema.Number) }),
    execute: (userId) => sql`
      SELECT access_narrowed_through AS "through" FROM users WHERE user_id = ${userId}
    `,
  });
  const accessNarrowedThrough = Effect.fn("SpaceDirectory.accessNarrowedThrough")(function* (
    userId: UserId,
  ) {
    const row = yield* findAccessNarrowed(userId).pipe(Effect.mapError(storageError));
    return Option.match(row, { onNone: () => 0, onSome: (found) => found.through ?? 0 });
  });

  return SpaceDirectory.of({
    members,
    authorizeMembership,
    setRole,
    removeMembership,
    membershipsChanged,
    nextMembershipChange,
    accessNarrowedThrough,
    principalOf,
    view,
    createOrganization,
    claimCreation,
    authorize,
    authorizeItem,
    actingUser,
    threadOwner,
    addMembership,
    viewableSpaces,
    revision: Ref.get(revision),
    changed,
  });
});

export const layer = Layer.effect(SpaceDirectory, make);
