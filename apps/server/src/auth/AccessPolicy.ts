/**
 * Who may do what in which Space. Pure: callers load the principal and the
 * resource, this decides. Each rule of the Role table is one case here and one
 * row in AccessPolicy.test.ts.
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
}

/** Actions that concern the Installation as a whole rather than one Space. */
export const installation = { kind: "installation" } as const;
export type InstallationResource = typeof installation;

export type Resource = SpaceResource | InstallationResource;

export type Action = "space.view" | "thread.create" | "project.create" | "organization.create";

export type DenyReason =
  | "owner-only"
  | "not-a-member"
  | "role-not-allowed"
  | "not-your-personal-space"
  | "missing-installation-permission"
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
  if (principal.isOwner) return allow;
  if (action === "organization.create") return deny("owner-only");
  if (!isSpace(resource)) return deny("wrong-resource");
  const creates = action !== "space.view";
  if (resource.kind === "personal") return inPersonalSpace(principal, resource, creates);
  switch (action) {
    case "space.view":
    case "thread.create":
      return inOrganization(principal, resource);
    case "project.create":
      return inOrganization(principal, resource, ROLES_THAT_CREATE_PROJECTS);
  }
};

export const isAllowed = (decision: Decision) => decision._tag === "Allow";
