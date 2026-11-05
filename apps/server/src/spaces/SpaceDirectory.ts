import {
  type ProjectId,
  type OrchestrationV2Command,
  type ProjectMutation,
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

/** The Space a new Project or Thread belongs to and the User who owns it. */
export interface CreationStamp {
  readonly spaceId: SpaceId;
  readonly ownerUserId: UserId;
}

const SpaceRow = Schema.Struct({
  spaceId: SpaceId,
  kind: SpaceKind,
  name: Schema.String,
  personalOwnerUserId: Schema.NullOr(UserId),
});
type SpaceRow = typeof SpaceRow.Type;

const PERSONAL_SPACE_NAME = "Personal";

const toResource = (row: SpaceRow): AccessPolicy.SpaceResource => ({
  id: row.spaceId,
  kind: row.kind,
  personalOwnerUserId: row.personalOwnerUserId,
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
     * Where a new Project or Thread created by `userId` belongs. A Thread joins its
     * Project's Space; otherwise the requested Space, or the User's Personal space.
     */
    readonly claimCreation: (
      userId: UserId,
      input: {
        readonly action: "project.create" | "thread.create";
        readonly spaceId?: SpaceId | undefined;
        readonly projectId?: ProjectId | undefined;
      },
    ) => Effect.Effect<
      CreationStamp,
      SpaceAccessDeniedError | SpaceNotFoundError | SpaceDirectoryStorageError
    >;
  }
>()("t3/spaces/SpaceDirectory") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const storageError = (cause: unknown) => new SpaceDirectoryStorageError({ cause });

  const findSpace = SqlSchema.findOneOption({
    Request: SpaceId,
    Result: SpaceRow,
    execute: (spaceId) => sql`
      SELECT space_id AS "spaceId", kind, name, personal_owner_user_id AS "personalOwnerUserId"
      FROM spaces WHERE space_id = ${spaceId}
    `,
  });
  const listOrganizations = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SpaceRow,
    execute: () => sql`
      SELECT space_id AS "spaceId", kind, name, personal_owner_user_id AS "personalOwnerUserId"
      FROM spaces WHERE kind = 'organization' AND archived_at IS NULL
      ORDER BY created_at ASC, space_id ASC
    `,
  });
  const listMemberships = SqlSchema.findAll({
    Request: UserId,
    Result: Schema.Struct({ spaceId: SpaceId, role: SpaceRole }),
    execute: (userId) => sql`
      SELECT space_id AS "spaceId", role FROM space_memberships WHERE user_id = ${userId}
    `,
  });
  const findIsOwner = SqlSchema.findOneOption({
    Request: UserId,
    Result: Schema.Struct({ isOwner: Schema.BooleanFromBit }),
    execute: (userId) => sql`SELECT is_owner AS "isOwner" FROM users WHERE user_id = ${userId}`,
  });
  const findProjectSpace = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ spaceId: Schema.NullOr(SpaceId) }),
    execute: (projectId) => sql`
      SELECT space_id AS "spaceId" FROM projection_projects WHERE project_id = ${projectId}
    `,
  });

  // Created on first use, so every User has one without UserDirectory knowing about Spaces.
  const ensurePersonalSpace = Effect.fn("SpaceDirectory.ensurePersonalSpace")(function* (
    userId: UserId,
  ) {
    const spaceId = SpaceId.make(`personal:${userId}`);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO spaces (space_id, kind, name, personal_owner_user_id, created_at)
      VALUES (${spaceId}, 'personal', ${PERSONAL_SPACE_NAME}, ${userId}, ${now})
      ON CONFLICT DO NOTHING
    `.pipe(Effect.mapError(storageError));
    return spaceId;
  });

  const principalOf = Effect.fn("SpaceDirectory.principalOf")(function* (userId: UserId) {
    const owner = yield* findIsOwner(userId);
    const memberships = yield* listMemberships(userId);
    return {
      userId,
      isOwner: owner._tag === "Some" && owner.value.isOwner,
      // The Owner cannot grant Installation permissions yet, so non-Owners hold none.
      installationPermissions: new Set(),
      roles: new Map(memberships.map((row) => [row.spaceId, row.role])),
    } satisfies AccessPolicy.Principal;
  }, Effect.mapError(storageError));

  const view = Effect.fn("SpaceDirectory.view")(function* (userId: UserId) {
    const personalSpaceId = yield* ensurePersonalSpace(userId);
    const principal = yield* principalOf(userId);
    const organizations = (yield* listOrganizations().pipe(Effect.mapError(storageError))).filter(
      (row) =>
        AccessPolicy.isAllowed(AccessPolicy.decide(principal, "space.view", toResource(row))),
    );
    const spaces: Array<SpaceSummary> = [
      {
        id: personalSpaceId,
        kind: "personal",
        name: PERSONAL_SPACE_NAME,
        role: null,
        isOwn: true,
      },
      ...organizations.map((row) => ({
        id: row.spaceId,
        kind: row.kind,
        name: row.name,
        role: principal.roles.get(row.spaceId) ?? null,
        isOwn: false,
      })),
    ];
    return {
      spaces,
      personalSpaceId,
      canCreateOrganization: AccessPolicy.isAllowed(
        AccessPolicy.decide(principal, "organization.create", AccessPolicy.installation),
      ),
    } satisfies SpaceDirectoryView;
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
    `.pipe(Effect.mapError(storageError));
    return {
      id: spaceId,
      kind: "organization",
      name,
      role: null,
      isOwn: false,
    } satisfies SpaceSummary;
  });

  const claimCreation = Effect.fn("SpaceDirectory.claimCreation")(function* (
    userId: UserId,
    input: {
      readonly action: "project.create" | "thread.create";
      readonly spaceId?: SpaceId | undefined;
      readonly projectId?: ProjectId | undefined;
    },
  ) {
    const project =
      input.projectId === undefined
        ? Option.none()
        : yield* findProjectSpace(input.projectId).pipe(Effect.mapError(storageError));
    const projectSpace = Option.getOrUndefined(project)?.spaceId ?? undefined;
    const spaceId = projectSpace ?? input.spaceId ?? (yield* ensurePersonalSpace(userId));
    const space = yield* findSpace(spaceId).pipe(Effect.mapError(storageError));
    if (space._tag === "None") return yield* new SpaceNotFoundError({ spaceId });
    const principal = yield* principalOf(userId);
    yield* requireAllowed(principal, input.action, toResource(space.value));
    return { spaceId, ownerUserId: userId } satisfies CreationStamp;
  });

  return SpaceDirectory.of({ principalOf, view, createOrganization, claimCreation });
});

export const layer = Layer.effect(SpaceDirectory, make);

/**
 * A client's thread.create with the server's stamp in place of any Space or owner it
 * sent. Sessions without a User exist only before the Owner does; their Threads stay unstamped.
 */
export const stampThreadCommand = Effect.fn("SpaceDirectory.stampThreadCommand")(function* (
  spaces: SpaceDirectory["Service"],
  userId: UserId | undefined,
  command: OrchestrationV2Command,
) {
  if (command.type !== "thread.create") return command;
  const { spaceId, ownerUserId: _forged, ...rest } = command;
  if (userId === undefined) return rest;
  const stamp = yield* spaces.claimCreation(userId, {
    action: "thread.create",
    spaceId,
    projectId: command.projectId,
  });
  return { ...rest, ...stamp };
});

/** The stamp a Project mutation carries; only creation by a signed-in User has one. */
export const stampProjectMutation = Effect.fn("SpaceDirectory.stampProjectMutation")(function* (
  spaces: SpaceDirectory["Service"],
  userId: UserId | undefined,
  mutation: ProjectMutation,
) {
  if (mutation.type !== "project.create" || userId === undefined) return undefined;
  return yield* spaces.claimCreation(userId, {
    action: "project.create",
    spaceId: mutation.spaceId,
  });
});

/** The stamp a launched Thread carries; reusing an existing Thread keeps its own. */
export const stampThreadLaunch = Effect.fn("SpaceDirectory.stampThreadLaunch")(function* (
  spaces: SpaceDirectory["Service"],
  userId: UserId | undefined,
  input: {
    readonly reuseExistingThread?: boolean | undefined;
    readonly spaceId?: SpaceId | undefined;
    readonly projectId: ProjectId;
  },
) {
  if (input.reuseExistingThread === true || userId === undefined) return undefined;
  return yield* spaces.claimCreation(userId, {
    action: "thread.create",
    spaceId: input.spaceId,
    projectId: input.projectId,
  });
});
