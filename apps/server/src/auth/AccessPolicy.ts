/**
 * Who may do what in which Space. Pure: callers load the principal and the resource, this
 * decides. Each rule of the Role table is one case here and one row in AccessPolicy.test.ts.
 * The Owner is allowed everything except creating in an archived or frozen Space, creating in
 * someone else's Personal space (which the Owner only reads) and sharing from a Personal space.
 */
import type {
  InstallationPermission,
  SpaceId,
  SpaceKind,
  SpaceRole,
  UserId,
} from "@t3tools/contracts";

export interface Principal {
  readonly userId: UserId;
  readonly isOwner: boolean;
  readonly installationPermissions: ReadonlySet<InstallationPermission>;
  /** The User's Role in each Organization they are a Member of. */
  readonly roles: ReadonlyMap<SpaceId, SpaceRole>;
}

export interface SpaceResource {
  readonly id: SpaceId;
  readonly kind: SpaceKind;
  readonly personalOwnerUserId: UserId | null;
  readonly archived: boolean;
  /** A removed User's Personal space, handed to the Owner. */
  readonly frozen: boolean;
}

/** Actions that concern the Installation as a whole rather than one Space. */
export const installation = { kind: "installation" } as const;
export type InstallationResource = typeof installation;

/** A Thread or Project, with the Space it is in and the User who created it. */
export interface OwnedResource {
  readonly kind: "thread" | "project";
  readonly space: SpaceResource;
  /** Rows from before Spaces belong to the Owner. */
  readonly ownerUserId: UserId;
  readonly archived: boolean;
}

export type Resource = SpaceResource | InstallationResource | OwnedResource;

export type Action =
  | "space.view"
  | "thread.create"
  | "project.create"
  | "organization.create"
  /** List Users and grant or revoke their Installation permissions. */
  | "installationPermission.manage"
  /** Create an Invitation into an Organization. */
  | "invitation.create"
  /** List and revoke an Organization's Invitations. */
  | "invitation.manage"
  /** Create or close a guest link (read one Thread for 24h). */
  | "guestLink.create"
  /** Anything that speaks in or changes a Thread: messages, turns, settings, metadata. */
  | "thread.continue"
  /** Archive or restore a Thread. */
  | "thread.archive"
  /**
   * Pin, settle, snooze or tag a Thread. That state is stored on the Thread and shared by every
   * viewer, so it is its creator's or an Admin's, as archiving is.
   */
  | "thread.organize"
  /** Stop a running Thread. */
  | "thread.stop"
  /** Permanently delete an archived Thread. */
  | "thread.delete"
  /** Archive or restore a Project. */
  | "project.archive"
  /** Change a Project's settings. */
  | "project.manage"
  /** Permanently delete an archived Project. */
  | "project.delete";

/** Actions that read or manage rather than add something to the Space. */
const NON_CREATING: ReadonlySet<Action> = new Set([
  "space.view",
  "organization.create",
  "installationPermission.manage",
  "invitation.manage",
]);

/** Owner-only actions; ticket 09 lets Admins invite Members and Guests. */
const OWNER_ONLY: ReadonlySet<Action> = new Set([
  "organization.create",
  "installationPermission.manage",
  "invitation.create",
  "invitation.manage",
]);

/** Actions on one Thread or Project, decided against an `OwnedResource`. */
const OWNED_ACTIONS: ReadonlySet<Action> = new Set([
  "thread.continue",
  "thread.archive",
  "thread.organize",
  "thread.stop",
  "thread.delete",
  "project.archive",
  "project.manage",
  "project.delete",
]);

/** Whether `action` is decided on a Thread or Project rather than on its Space. */
export const isItemAction = (action: Action) => OWNED_ACTIONS.has(action);

export type DenyReason =
  | "owner-only"
  | "not-a-member"
  | "role-not-allowed"
  | "not-your-personal-space"
  | "missing-installation-permission"
  | "space-archived"
  | "space-frozen"
  /** Someone else's Thread or Project. */
  | "not-yours"
  /** Only archived items are deleted permanently. */
  | "not-archived"
  | "wrong-resource";

export type Decision =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Deny"; readonly reason: DenyReason };

export const allow: Decision = { _tag: "Allow" };
export const deny = (reason: DenyReason): Decision => ({ _tag: "Deny", reason });

const isSpace = (resource: Resource): resource is SpaceResource =>
  resource.kind === "organization" || resource.kind === "personal";
const isOwned = (resource: Resource): resource is OwnedResource =>
  resource.kind === "thread" || resource.kind === "project";

const ROLES_THAT_CREATE_PROJECTS: ReadonlySet<SpaceRole> = new Set(["admin", "member"]);
const ADMIN_ONLY: ReadonlySet<SpaceRole> = new Set(["admin"]);

// Without the permission a Personal space is hidden, not just closed to new work: what it holds
// from before a revoke is out of reach too.
const inPersonalSpace = (principal: Principal, space: SpaceResource) => {
  if (space.personalOwnerUserId !== principal.userId) return deny("not-your-personal-space");
  if (!principal.installationPermissions.has("personalSpace.create")) {
    return deny("missing-installation-permission");
  }
  return allow;
};

const inOrganization = (
  principal: Principal,
  space: SpaceResource,
  allowedRoles?: ReadonlySet<SpaceRole>,
) => {
  const role = principal.roles.get(space.id);
  if (role === undefined) return deny("not-a-member");
  if (allowedRoles !== undefined && !allowedRoles.has(role)) return deny("role-not-allowed");
  return allow;
};

/**
 * Rules on one Thread or Project. Only its creator continues a Thread, not even an Admin or the
 * Owner; each archives and stops their own; Admins also archive and stop others' and delete what
 * is archived. A Personal space's User runs their own space as an Admin runs an Organization.
 */
const decideOwned = (principal: Principal, action: Action, item: OwnedResource): Decision => {
  const { space } = item;
  if (action === "thread.continue") {
    if (space.archived) return deny("space-archived");
    if (space.frozen) return deny("space-frozen");
    // Nobody speaks in someone else's Thread: a new Thread in the same Project builds on it.
    if (principal.isOwner) return item.ownerUserId === principal.userId ? allow : deny("not-yours");
  }
  if (principal.isOwner) return allow;
  if (space.archived) return deny("space-archived");
  const deletes = action === "thread.delete" || action === "project.delete";
  if (space.kind === "personal") {
    const reach = inPersonalSpace(principal, space);
    if (reach._tag === "Deny") return reach;
    if (action === "thread.continue" && item.ownerUserId !== principal.userId) {
      return deny("not-yours");
    }
    return deletes && !item.archived ? deny("not-archived") : allow;
  }
  const role = principal.roles.get(space.id);
  if (role === undefined) return deny("not-a-member");
  const own = item.ownerUserId === principal.userId;
  switch (action) {
    case "thread.continue":
      return own ? allow : deny("not-yours");
    case "thread.archive":
    case "thread.organize":
    case "thread.stop":
      return own || role === "admin" ? allow : deny("not-yours");
    case "project.archive":
    case "project.manage":
      if (role === "admin") return allow;
      if (!own) return deny("not-yours");
      return ROLES_THAT_CREATE_PROJECTS.has(role) ? allow : deny("role-not-allowed");
    case "thread.delete":
    case "project.delete":
      if (role !== "admin") return deny("role-not-allowed");
      return item.archived ? allow : deny("not-archived");
    default:
      return deny("wrong-resource");
  }
};

export const decide = (principal: Principal, action: Action, resource: Resource): Decision => {
  if (OWNED_ACTIONS.has(action) || isOwned(resource)) {
    return OWNED_ACTIONS.has(action) && isOwned(resource)
      ? decideOwned(principal, action, resource)
      : deny("wrong-resource");
  }
  // Nothing is shared from a Personal space directly, so nobody is invited into one and no
  // guest link is made from one.
  if (
    (action === "invitation.create" ||
      action === "invitation.manage" ||
      action === "guestLink.create") &&
    (!isSpace(resource) || resource.kind !== "organization")
  ) {
    return deny("wrong-resource");
  }
  const creates = !NON_CREATING.has(action);
  if (creates && isSpace(resource)) {
    if (resource.archived) return deny("space-archived");
    if (resource.frozen) return deny("space-frozen");
  }
  if (principal.isOwner) {
    // The Owner reads every Personal space but adds nothing to another User's.
    const othersPersonal =
      creates &&
      isSpace(resource) &&
      resource.kind === "personal" &&
      resource.personalOwnerUserId !== principal.userId;
    return othersPersonal ? deny("not-your-personal-space") : allow;
  }
  if (OWNER_ONLY.has(action)) return deny("owner-only");
  if (!isSpace(resource)) return deny("wrong-resource");
  if (resource.archived) return deny("space-archived");
  if (resource.kind === "personal") return inPersonalSpace(principal, resource);
  switch (action) {
    case "space.view":
    case "thread.create":
      return inOrganization(principal, resource);
    case "project.create":
      return inOrganization(principal, resource, ROLES_THAT_CREATE_PROJECTS);
    case "guestLink.create":
      return inOrganization(principal, resource, ADMIN_ONLY);
    default:
      return deny("owner-only");
  }
};

export const isAllowed = (decision: Decision) => decision._tag === "Allow";
