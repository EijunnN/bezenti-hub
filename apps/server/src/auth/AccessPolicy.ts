/**
 * Who may do what in which Space. Pure; each rule is one row in AccessPolicy.test.ts. The Owner
 * may do everything except create in an archived or frozen Space, change anything in another
 * User's Personal space (only read it) and share from a Personal space.
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

/** One User's Membership of an Organization, as someone acts on it. */
export interface MembershipResource {
  readonly kind: "membership";
  readonly space: SpaceResource;
  readonly userId: UserId;
  readonly role: SpaceRole;
  /** For `membership.changeRole`: the Role asked for. */
  readonly nextRole?: SpaceRole;
}

export type Resource = SpaceResource | InstallationResource | OwnedResource | MembershipResource;

export type Action =
  | "space.view"
  | "thread.create"
  | "project.create"
  | "organization.create"
  /** List Users and grant or revoke their Installation permissions. */
  | "installationPermission.manage"
  /** Create an Invitation into an Organization as a Member or Guest. */
  | "invitation.create"
  /** List and revoke an Organization's Invitations. */
  | "invitation.manage"
  /** Invite as an Admin or revoke such an Invitation; checked beside the Invitation action. */
  | "admin.manage"
  /** Give a Member another Role. */
  | "membership.changeRole"
  /** Remove someone from the Organization. */
  | "membership.remove"
  /** Leave the Organization oneself. */
  | "membership.leave"
  /** Issue a one-time link that resets the Member's sign-in. It takes the account over: Owner only. */
  | "membership.resetLink"
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
  // Checked beside `invitation.create`, which refuses archived Organizations.
  "admin.manage",
]);

const OWNER_ONLY: ReadonlySet<Action> = new Set([
  "organization.create",
  "admin.manage",
  "installationPermission.manage",
]);

const MEMBERSHIP_ACTIONS: ReadonlySet<Action> = new Set([
  "membership.changeRole",
  "membership.remove",
  "membership.leave",
  "membership.resetLink",
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
  /** The Owner reads another User's Personal space and changes nothing in it. */
  | "personal-space-read-only"
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
const isMembership = (resource: Resource): resource is MembershipResource =>
  resource.kind === "membership";

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
const othersPersonalSpace = (principal: Principal, space: SpaceResource) =>
  space.kind === "personal" && space.personalOwnerUserId !== principal.userId;

const decideOwned = (principal: Principal, action: Action, item: OwnedResource): Decision => {
  const { space } = item;
  if (principal.isOwner && othersPersonalSpace(principal, space)) {
    return deny("personal-space-read-only");
  }
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

/**
 * Rules on someone's Membership. Anyone leaves; Admins change and remove Members and Guests, but
 * never touch an Admin or make one, and issue no reset links: only the Owner does.
 */
const decideMembership = (
  principal: Principal,
  action: Action,
  target: MembershipResource,
): Decision => {
  const { space } = target;
  if (space.kind !== "organization") return deny("wrong-resource");
  if (action === "membership.leave") {
    if (target.userId !== principal.userId) return deny("not-yours");
    return principal.roles.has(space.id) ? allow : deny("not-a-member");
  }
  if (principal.isOwner) return allow;
  const role = principal.roles.get(space.id);
  if (role === undefined) return deny("not-a-member");
  if (role !== "admin") return deny("role-not-allowed");
  if (space.archived) return deny("space-archived");
  if (action === "membership.resetLink") return deny("owner-only");
  if (target.role === "admin" || target.nextRole === "admin") return deny("owner-only");
  return allow;
};

export const decide = (principal: Principal, action: Action, resource: Resource): Decision => {
  if (MEMBERSHIP_ACTIONS.has(action) || isMembership(resource)) {
    return MEMBERSHIP_ACTIONS.has(action) && isMembership(resource)
      ? decideMembership(principal, action, resource)
      : deny("wrong-resource");
  }
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
      action === "admin.manage" ||
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
    return creates && isSpace(resource) && othersPersonalSpace(principal, resource)
      ? deny("personal-space-read-only")
      : allow;
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
    case "invitation.create":
    case "invitation.manage":
      return inOrganization(principal, resource, ADMIN_ONLY);
    default:
      return deny("owner-only");
  }
};

export const isAllowed = (decision: Decision) => decision._tag === "Allow";
