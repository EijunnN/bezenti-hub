/**
 * Who may do what in which Space. Pure: callers load the principal and the
 * resource, this decides. Each rule of the Role table is one case here and one
 * row in AccessPolicy.test.ts. The Owner is allowed everything except creating
 * in an archived or frozen Space.
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

export type Resource = SpaceResource | InstallationResource;

export type Action =
  | "space.view"
  | "thread.create"
  | "project.create"
  | "organization.create"
  /** Create an Invitation into an Organization. */
  | "invitation.create"
  /** List and revoke an Organization's Invitations. */
  | "invitation.manage";

/** Actions that read or manage rather than add something to the Space. */
const NON_CREATING: ReadonlySet<Action> = new Set([
  "space.view",
  "organization.create",
  "invitation.manage",
]);

/** Owner-only actions; ticket 09 lets Admins invite Members and Guests. */
const OWNER_ONLY: ReadonlySet<Action> = new Set([
  "organization.create",
  "invitation.create",
  "invitation.manage",
]);

export type DenyReason =
  | "owner-only"
  | "not-a-member"
  | "role-not-allowed"
  | "not-your-personal-space"
  | "missing-installation-permission"
  | "space-archived"
  | "space-frozen"
  | "wrong-resource";

export type Decision =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Deny"; readonly reason: DenyReason };

export const allow: Decision = { _tag: "Allow" };
export const deny = (reason: DenyReason): Decision => ({ _tag: "Deny", reason });

const isSpace = (resource: Resource): resource is SpaceResource =>
  resource.kind === "organization" || resource.kind === "personal";

const ROLES_THAT_CREATE_PROJECTS: ReadonlySet<SpaceRole> = new Set(["admin", "member"]);

const inPersonalSpace = (principal: Principal, space: SpaceResource, creates: boolean) => {
  if (space.personalOwnerUserId !== principal.userId) return deny("not-your-personal-space");
  if (creates && !principal.installationPermissions.has("personalSpace.create")) {
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

export const decide = (principal: Principal, action: Action, resource: Resource): Decision => {
  const creates = !NON_CREATING.has(action);
  // Nothing is shared from a Personal space directly, so nobody is invited into one.
  if (
    (action === "invitation.create" || action === "invitation.manage") &&
    (!isSpace(resource) || resource.kind !== "organization")
  ) {
    return deny("wrong-resource");
  }
  if (creates && isSpace(resource)) {
    if (resource.archived) return deny("space-archived");
    if (resource.frozen) return deny("space-frozen");
  }
  if (principal.isOwner) return allow;
  if (OWNER_ONLY.has(action)) return deny("owner-only");
  if (!isSpace(resource)) return deny("wrong-resource");
  if (resource.archived) return deny("space-archived");
  if (resource.kind === "personal") return inPersonalSpace(principal, resource, creates);
  switch (action) {
    case "space.view":
    case "thread.create":
      return inOrganization(principal, resource);
    case "project.create":
      return inOrganization(principal, resource, ROLES_THAT_CREATE_PROJECTS);
    case "organization.create":
    case "invitation.create":
    case "invitation.manage":
      return deny("owner-only");
  }
};

export const isAllowed = (decision: Decision) => decision._tag === "Allow";
