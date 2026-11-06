/**
 * Who may do what in which Space. Pure; each rule is one row in AccessPolicy.test.ts. The Owner
 * may do everything but create in archived or frozen Spaces, change another User's Personal space
 * (bar moving, stopping and deleting in a removed User's), share from one, or turn themselves off.
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
  /** Disabled or removed: every action is refused, though their Memberships may remain. */
  readonly inactive?: boolean;
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

/** A User of the Installation, as the Owner disables or removes them. */
export interface UserResource {
  readonly kind: "user";
  readonly userId: UserId;
  readonly isOwner: boolean;
}

/** A Project moving from one Space to another, decided on both. */
export interface MoveResource {
  readonly kind: "move";
  readonly from: SpaceResource;
  readonly to: SpaceResource;
}

/** A machine registered with the Hub: the Hub machine, or one joined with `t3 join`. */
export interface EnvironmentResource {
  readonly kind: "environment";
  readonly environmentKind: "hub" | "external";
  /** Null for the Hub machine, which belongs to the Installation. */
  readonly ownerUserId: UserId | null;
}

export type Resource =
  | SpaceResource
  | InstallationResource
  | OwnedResource
  | MembershipResource
  | UserResource
  | MoveResource
  | EnvironmentResource;

export type Action =
  | "space.view"
  | "thread.create"
  | "project.create"
  | "organization.create"
  /** List Users and grant or revoke their Installation permissions. */
  | "installationPermission.manage"
  /** Disable a User or turn them back on: their sessions end, their Memberships stay. */
  | "user.disable"
  /** Remove a User for good: their Memberships end and their Personal space freezes. */
  | "user.remove"
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
  | "project.delete"
  /** Move a Project, with its Threads, to another Space (`MoveResource`). */
  | "project.move"
  /** Hide an Organization from its Members and stop everything in it. */
  | "organization.archive"
  /** Bring an archived Organization back. */
  | "organization.restore"
  /** Permanently delete an archived Organization with everything in it. */
  | "organization.delete"
  /** Approve a machine joining the Hub (`t3 join`). */
  | "environment.register"
  /** See an Environment in Settings and where Threads may run. */
  | "environment.view"
  | "environment.rename"
  /** Remove a machine: its credential stops working at once. */
  | "environment.remove";

/** Actions that read or manage rather than add something to the Space. */
const NON_CREATING: ReadonlySet<Action> = new Set([
  "space.view",
  "organization.create",
  "installationPermission.manage",
  "invitation.manage",
  // Checked beside `invitation.create`, which refuses archived Organizations.
  "admin.manage",
  "environment.register",
]);

const OWNER_ONLY: ReadonlySet<Action> = new Set([
  "organization.create",
  "admin.manage",
  "installationPermission.manage",
  "environment.register",
]);

/** Actions on one registered Environment, decided against an `EnvironmentResource`. */
const ENVIRONMENT_ACTIONS: ReadonlySet<Action> = new Set([
  "environment.view",
  "environment.rename",
  "environment.remove",
]);

const USER_ACTIONS: ReadonlySet<Action> = new Set(["user.disable", "user.remove"]);
/** The Owner's, on an Organization in any state; it is deleted only once archived. */
const ORGANIZATION_LIFECYCLE: ReadonlySet<Action> = new Set([
  "organization.archive",
  "organization.restore",
  "organization.delete",
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
  /** The User was disabled or removed. */
  | "user-inactive"
  /** Nobody disables or removes the Owner. */
  | "owner-protected"
  /** Someone else's Thread or Project. */
  | "not-yours"
  /** Only archived items are deleted permanently. */
  | "not-archived"
  /** The Hub machine runs the Hub itself, so it is never removed. */
  | "hub-machine"
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
const isUser = (resource: Resource): resource is UserResource => resource.kind === "user";
const isMove = (resource: Resource): resource is MoveResource => resource.kind === "move";
const isEnvironment = (resource: Resource): resource is EnvironmentResource =>
  resource.kind === "environment";

/**
 * Everyone uses the Hub machine. A personal machine is its owner's: nobody else sees it but the
 * Owner, who sees, renames and removes every one, and never removes the Hub machine.
 */
const decideEnvironment = (
  principal: Principal,
  action: Action,
  environment: EnvironmentResource,
): Decision => {
  const own = environment.ownerUserId === principal.userId;
  if (action === "environment.view") {
    return environment.environmentKind === "hub" || own || principal.isOwner
      ? allow
      : deny("not-yours");
  }
  if (!principal.isOwner) return deny("owner-only");
  return environment.environmentKind === "hub" && action === "environment.remove"
    ? deny("hub-machine")
    : allow;
};

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
  const deletes = action === "thread.delete" || action === "project.delete";
  if (principal.isOwner && othersPersonalSpace(principal, space)) {
    // A removed User's work is the Owner's to stop, keep or delete, archived or not.
    return space.frozen && (deletes || action === "thread.stop")
      ? allow
      : deny("personal-space-read-only");
  }
  if (action === "thread.continue") {
    if (space.archived) return deny("space-archived");
    if (space.frozen) return deny("space-frozen");
    // Nobody speaks in someone else's Thread: a new Thread in the same Project builds on it.
    if (principal.isOwner) return item.ownerUserId === principal.userId ? allow : deny("not-yours");
  }
  if (principal.isOwner) return allow;
  if (space.archived) return deny("space-archived");
  if (space.frozen) return deny("space-frozen");
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

/**
 * Moving a Project takes running both Spaces (Admin of an Organization, User of a Personal space).
 * The Owner moves anything but into or out of another User's Personal space (out of a frozen one
 * is allowed). Nothing enters an archived or frozen Space; only the Owner leaves an archived one.
 */
const runsSpace = (principal: Principal, space: SpaceResource) =>
  space.kind === "personal"
    ? inPersonalSpace(principal, space)
    : inOrganization(principal, space, ADMIN_ONLY);

/** The origin half of `project.move`: whether a Project may leave `from`. */
export const mayMoveOut = (principal: Principal, from: SpaceResource): Decision => {
  if (principal.isOwner) {
    return othersPersonalSpace(principal, from) && !from.frozen
      ? deny("personal-space-read-only")
      : allow;
  }
  if (from.archived) return deny("space-archived");
  if (from.frozen) return deny("space-frozen");
  return runsSpace(principal, from);
};

/** The destination half of `project.move`: whether a Project may arrive in `to`. */
export const mayMoveIn = (principal: Principal, to: SpaceResource): Decision => {
  if (to.archived) return deny("space-archived");
  if (to.frozen) return deny("space-frozen");
  if (principal.isOwner) {
    return othersPersonalSpace(principal, to) ? deny("personal-space-read-only") : allow;
  }
  return runsSpace(principal, to);
};

const decideMove = (principal: Principal, { from, to }: MoveResource): Decision => {
  if (from.id === to.id) return deny("wrong-resource");
  const destination = mayMoveIn(principal, to);
  if (destination._tag === "Deny") return destination;
  return mayMoveOut(principal, from);
};

export const decide = (principal: Principal, action: Action, resource: Resource): Decision => {
  if (principal.inactive === true) return deny("user-inactive");
  if (USER_ACTIONS.has(action) || isUser(resource)) {
    if (!USER_ACTIONS.has(action) || !isUser(resource)) return deny("wrong-resource");
    if (!principal.isOwner) return deny("owner-only");
    return resource.isOwner ? deny("owner-protected") : allow;
  }
  if (ENVIRONMENT_ACTIONS.has(action) || isEnvironment(resource)) {
    return ENVIRONMENT_ACTIONS.has(action) && isEnvironment(resource)
      ? decideEnvironment(principal, action, resource)
      : deny("wrong-resource");
  }
  if (action === "project.move" || isMove(resource)) {
    return action === "project.move" && isMove(resource)
      ? decideMove(principal, resource)
      : deny("wrong-resource");
  }
  if (ORGANIZATION_LIFECYCLE.has(action)) {
    if (!isSpace(resource) || resource.kind !== "organization") return deny("wrong-resource");
    if (!principal.isOwner) return deny("owner-only");
    return action === "organization.delete" && !resource.archived ? deny("not-archived") : allow;
  }
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
