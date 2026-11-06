import { type InstallationPermission, SpaceId, type SpaceRole, UserId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import * as AccessPolicy from "./AccessPolicy.ts";

const ORG = SpaceId.make("org-acme");
const OTHER_ORG = SpaceId.make("org-other");

const organization: AccessPolicy.SpaceResource = {
  id: ORG,
  kind: "organization",
  personalOwnerUserId: null,
  archived: false,
  frozen: false,
};
const archivedOrganization = { ...organization, archived: true };
const personalOf = (userId: string): AccessPolicy.SpaceResource => ({
  id: SpaceId.make(`personal-${userId}`),
  kind: "personal",
  personalOwnerUserId: UserId.make(userId),
  archived: false,
  frozen: false,
});

const principal = (
  userId: string,
  options: {
    readonly isOwner?: boolean;
    readonly roles?: ReadonlyArray<readonly [SpaceId, SpaceRole]>;
    readonly permissions?: ReadonlyArray<InstallationPermission>;
  } = {},
): AccessPolicy.Principal => ({
  userId: UserId.make(userId),
  isOwner: options.isOwner ?? false,
  installationPermissions: new Set(options.permissions ?? []),
  roles: new Map(options.roles ?? []),
});

const owner = principal("owner", { isOwner: true });
const admin = principal("ada", { roles: [[ORG, "admin"]] });
const member = principal("grace", { roles: [[ORG, "member"]] });
const guest = principal("linus", { roles: [[ORG, "guest"]] });
const outsider = principal("eve", { roles: [[OTHER_ORG, "admin"]] });
const personalCreator = principal("grace", { permissions: ["personalSpace.create"] });

const owned = (
  kind: "thread" | "project",
  ownerUserId: string,
  options: { readonly archived?: boolean; readonly space?: AccessPolicy.SpaceResource } = {},
): AccessPolicy.OwnedResource => ({
  kind,
  space: options.space ?? organization,
  ownerUserId: UserId.make(ownerUserId),
  archived: options.archived ?? false,
});
// Ada is the Admin, Grace the Member, Linus the Guest.
const adasThread = owned("thread", "ada");
const gracesThread = owned("thread", "grace");
const linusThread = owned("thread", "linus");
const gracesProject = owned("project", "grace");
const adasProject = owned("project", "ada");
const archivedGracesThread = owned("thread", "grace", { archived: true });
const archivedGracesProject = owned("project", "grace", { archived: true });

const membership = (
  userId: string,
  role: SpaceRole,
  options: { readonly nextRole?: SpaceRole; readonly space?: AccessPolicy.SpaceResource } = {},
): AccessPolicy.MembershipResource => ({
  kind: "membership",
  space: options.space ?? organization,
  userId: UserId.make(userId),
  role,
  ...(options.nextRole === undefined ? {} : { nextRole: options.nextRole }),
});
// Grace the Member, Linus the Guest and Hedy, a second Admin, as targets.
const grace = (nextRole?: SpaceRole | { readonly space: AccessPolicy.SpaceResource }) =>
  typeof nextRole === "object"
    ? membership("grace", "member", nextRole)
    : membership("grace", "member", nextRole === undefined ? {} : { nextRole });
const linusAs = (nextRole?: SpaceRole) =>
  membership("linus", "guest", nextRole === undefined ? {} : { nextRole });
const otherAdmin = (nextRole?: SpaceRole) =>
  membership("hedy", "admin", nextRole === undefined ? {} : { nextRole });

const userTarget = (userId: string, isOwner = false): AccessPolicy.UserResource => ({
  kind: "user",
  userId: UserId.make(userId),
  isOwner,
});
const disabledMember: AccessPolicy.Principal = { ...member, inactive: true };
const frozenPersonal: AccessPolicy.SpaceResource = { ...personalOf("grace"), frozen: true };
const otherOrganization: AccessPolicy.SpaceResource = { ...organization, id: OTHER_ORG };
const move = (
  from: AccessPolicy.SpaceResource,
  to: AccessPolicy.SpaceResource,
): AccessPolicy.MoveResource => ({ kind: "move", from, to });
const adminOfBoth = principal("ada", {
  roles: [
    [ORG, "admin"],
    [OTHER_ORG, "admin"],
  ],
});
const adminHereMemberThere = principal("ada", {
  roles: [
    [ORG, "admin"],
    [OTHER_ORG, "member"],
  ],
});
const personalAdmin = principal("grace", {
  roles: [[ORG, "admin"]],
  permissions: ["personalSpace.create"],
});

const allow = AccessPolicy.allow;
const deny = AccessPolicy.deny;

// One row per rule. Later tickets add rows (and actions), never a new suite.
const rows: ReadonlyArray<
  readonly [
    string,
    AccessPolicy.Principal,
    AccessPolicy.Action,
    AccessPolicy.Resource,
    AccessPolicy.Decision,
  ]
> = [
  // The Owner holds every permission.
  ["Owner views an Organization", owner, "space.view", organization, allow],
  ["Owner views another User's Personal space", owner, "space.view", personalOf("grace"), allow],
  ["Owner creates a Thread anywhere", owner, "thread.create", organization, allow],
  ["Owner creates a Project in an Organization", owner, "project.create", organization, allow],
  [
    "Owner creates in their own Personal space",
    owner,
    "project.create",
    personalOf("owner"),
    allow,
  ],
  ["Owner creates an Organization", owner, "organization.create", AccessPolicy.installation, allow],

  // Organizations, by Role.
  ["Admin views", admin, "space.view", organization, allow],
  ["Member views", member, "space.view", organization, allow],
  ["Guest views", guest, "space.view", organization, allow],
  ["non-Member cannot view", outsider, "space.view", organization, deny("not-a-member")],
  ["Admin creates Threads", admin, "thread.create", organization, allow],
  ["Member creates Threads", member, "thread.create", organization, allow],
  ["Guest creates Threads", guest, "thread.create", organization, allow],
  [
    "non-Member cannot create Threads",
    outsider,
    "thread.create",
    organization,
    deny("not-a-member"),
  ],
  ["Admin creates Projects", admin, "project.create", organization, allow],
  ["Member creates Projects", member, "project.create", organization, allow],
  ["Guest cannot create Projects", guest, "project.create", organization, deny("role-not-allowed")],
  [
    "non-Member cannot create Projects",
    outsider,
    "project.create",
    organization,
    deny("not-a-member"),
  ],

  // Only the Owner creates Organizations.
  [
    "Admin cannot create Organizations",
    admin,
    "organization.create",
    AccessPolicy.installation,
    deny("owner-only"),
  ],
  [
    "Member cannot create Organizations",
    member,
    "organization.create",
    AccessPolicy.installation,
    deny("owner-only"),
  ],

  // Personal spaces: private to their User; using one at all is an Installation permission.
  [
    "with the permission a User views their own Personal space",
    personalCreator,
    "space.view",
    personalOf("grace"),
    allow,
  ],
  [
    "without the permission a User's Personal space is hidden",
    member,
    "space.view",
    personalOf("grace"),
    deny("missing-installation-permission"),
  ],
  [
    "a User's permission does not reach someone else's Personal space",
    principal("ada", { permissions: ["personalSpace.create"] }),
    "space.view",
    personalOf("grace"),
    deny("not-your-personal-space"),
  ],
  [
    "the Owner reads another User's Personal space but starts no Thread there",
    owner,
    "thread.create",
    personalOf("grace"),
    deny("personal-space-read-only"),
  ],
  [
    "the Owner creates no Project in another User's Personal space",
    owner,
    "project.create",
    personalOf("grace"),
    deny("personal-space-read-only"),
  ],
  [
    "a User cannot view someone else's Personal space",
    admin,
    "space.view",
    personalOf("grace"),
    deny("not-your-personal-space"),
  ],
  [
    "creating in a Personal space needs the permission",
    member,
    "thread.create",
    personalOf("grace"),
    deny("missing-installation-permission"),
  ],
  [
    "with the permission a User creates Threads there",
    personalCreator,
    "thread.create",
    personalOf("grace"),
    allow,
  ],
  [
    "with the permission a User creates Projects there",
    personalCreator,
    "project.create",
    personalOf("grace"),
    allow,
  ],
  [
    "the permission does not reach another Personal space",
    personalCreator,
    "thread.create",
    personalOf("ada"),
    deny("not-your-personal-space"),
  ],

  // Archived Organizations and frozen Personal spaces take nothing new, not even from the Owner.
  [
    "Members no longer see an archived Organization",
    member,
    "space.view",
    archivedOrganization,
    deny("space-archived"),
  ],
  [
    "the Owner still sees an archived Organization",
    owner,
    "space.view",
    archivedOrganization,
    allow,
  ],
  [
    "nobody creates Threads in an archived Organization",
    owner,
    "thread.create",
    archivedOrganization,
    deny("space-archived"),
  ],
  [
    "nobody creates Projects in an archived Organization",
    admin,
    "project.create",
    archivedOrganization,
    deny("space-archived"),
  ],
  [
    "nobody creates in a frozen Personal space",
    owner,
    "thread.create",
    { ...personalOf("grace"), frozen: true },
    deny("space-frozen"),
  ],

  // Invitations: Admins invite Members and Guests; only the Owner invites Admins.
  ["Owner invites to an Organization", owner, "invitation.create", organization, allow],
  ["Admin invites Members and Guests", admin, "invitation.create", organization, allow],
  ["Member cannot invite", member, "invitation.create", organization, deny("role-not-allowed")],
  ["Guest cannot invite", guest, "invitation.create", organization, deny("role-not-allowed")],
  ["non-Member cannot invite", outsider, "invitation.create", organization, deny("not-a-member")],
  ["Owner names Admins", owner, "admin.manage", organization, allow],
  ["Admin cannot name Admins", admin, "admin.manage", organization, deny("owner-only")],
  [
    "nobody invites into a Personal space, not even the Owner",
    owner,
    "invitation.create",
    personalOf("grace"),
    deny("wrong-resource"),
  ],
  [
    "nobody invites into an archived Organization",
    owner,
    "invitation.create",
    archivedOrganization,
    deny("space-archived"),
  ],
  [
    "the Owner lists and revokes Invitations, even of an archived Organization",
    owner,
    "invitation.manage",
    archivedOrganization,
    allow,
  ],
  ["Admin lists and revokes Invitations", admin, "invitation.manage", organization, allow],
  [
    "Member cannot list or revoke Invitations",
    member,
    "invitation.manage",
    organization,
    deny("role-not-allowed"),
  ],

  // Memberships: Admins manage Members and Guests, never Admins; only the Owner names Admins.
  ["Admin makes a Member a Guest", admin, "membership.changeRole", grace("guest"), allow],
  ["Admin makes a Guest a Member", admin, "membership.changeRole", linusAs("member"), allow],
  [
    "Admin cannot make anyone an Admin",
    admin,
    "membership.changeRole",
    grace("admin"),
    deny("owner-only"),
  ],
  [
    "Admin cannot demote another Admin",
    admin,
    "membership.changeRole",
    otherAdmin("member"),
    deny("owner-only"),
  ],
  ["Owner names an Admin", owner, "membership.changeRole", grace("admin"), allow],
  ["Owner demotes an Admin", owner, "membership.changeRole", otherAdmin("member"), allow],
  [
    "Member cannot change Roles",
    member,
    "membership.changeRole",
    linusAs("member"),
    deny("role-not-allowed"),
  ],
  ["Admin removes a Member", admin, "membership.remove", grace(), allow],
  [
    "Admin cannot remove another Admin",
    admin,
    "membership.remove",
    otherAdmin(),
    deny("owner-only"),
  ],
  ["Owner removes an Admin", owner, "membership.remove", otherAdmin(), allow],
  ["Guest cannot remove anyone", guest, "membership.remove", grace(), deny("role-not-allowed")],
  ["non-Member cannot remove anyone", outsider, "membership.remove", grace(), deny("not-a-member")],
  [
    "nobody changes Roles in an archived Organization but the Owner",
    admin,
    "membership.remove",
    grace({ space: archivedOrganization }),
    deny("space-archived"),
  ],
  ["a Member leaves", member, "membership.leave", grace(), allow],
  ["an Admin leaves", admin, "membership.leave", membership("ada", "admin"), allow],
  [
    "a Member leaves even an archived Organization",
    member,
    "membership.leave",
    grace({ space: archivedOrganization }),
    allow,
  ],
  ["nobody leaves for someone else", admin, "membership.leave", grace(), deny("not-yours")],
  // A reset link takes the account over, so only the Owner issues one.
  [
    "Admin cannot issue a Member's reset link",
    admin,
    "membership.resetLink",
    grace(),
    deny("owner-only"),
  ],
  [
    "Admin cannot issue a Guest's reset link",
    admin,
    "membership.resetLink",
    linusAs(),
    deny("owner-only"),
  ],
  [
    "Admin cannot issue another Admin's reset link",
    admin,
    "membership.resetLink",
    otherAdmin(),
    deny("owner-only"),
  ],
  ["Owner issues anyone's reset link", owner, "membership.resetLink", otherAdmin(), allow],
  [
    "Member cannot issue reset links",
    member,
    "membership.resetLink",
    linusAs(),
    deny("role-not-allowed"),
  ],
  [
    "Memberships exist only in Organizations",
    owner,
    "membership.remove",
    grace({ space: personalOf("grace") }),
    deny("wrong-resource"),
  ],

  // Role table, Threads: only the creator continues one, not even an Admin.
  ["Admin continues their own Thread", admin, "thread.continue", adasThread, allow],
  ["Member continues their own Thread", member, "thread.continue", gracesThread, allow],
  ["Guest continues their own Thread", guest, "thread.continue", linusThread, allow],
  [
    "Admin cannot continue another's Thread",
    admin,
    "thread.continue",
    gracesThread,
    deny("not-yours"),
  ],
  [
    "Member cannot continue another's Thread",
    member,
    "thread.continue",
    adasThread,
    deny("not-yours"),
  ],
  [
    "Guest cannot continue another's Thread",
    guest,
    "thread.continue",
    gracesThread,
    deny("not-yours"),
  ],
  [
    "not even the Owner continues another's Thread",
    owner,
    "thread.continue",
    gracesThread,
    deny("not-yours"),
  ],
  [
    "the Owner continues their own Thread",
    owner,
    "thread.continue",
    owned("thread", "owner"),
    allow,
  ],
  ["the Owner archives anyone's Thread", owner, "thread.archive", gracesThread, allow],
  // Pins, settling, snoozes and tags are shared Thread state: the creator's or an Admin's.
  ["Member organizes their own Thread", member, "thread.organize", gracesThread, allow],
  ["Admin organizes another's Thread", admin, "thread.organize", gracesThread, allow],
  [
    "Member cannot organize another's Thread",
    member,
    "thread.organize",
    adasThread,
    deny("not-yours"),
  ],
  [
    "Guest cannot organize another's Thread",
    guest,
    "thread.organize",
    gracesThread,
    deny("not-yours"),
  ],
  ["non-Member cannot continue", outsider, "thread.continue", gracesThread, deny("not-a-member")],
  [
    "nobody continues a Thread in an archived Organization",
    owner,
    "thread.continue",
    owned("thread", "grace", { space: archivedOrganization }),
    deny("space-archived"),
  ],

  // Archiving (and restoring): one's own; Admins also others'. Guests own no Projects.
  ["Admin archives their own Thread", admin, "thread.archive", adasThread, allow],
  ["Member archives their own Thread", member, "thread.archive", gracesThread, allow],
  ["Guest archives their own Thread", guest, "thread.archive", linusThread, allow],
  ["Admin archives another's Thread", admin, "thread.archive", gracesThread, allow],
  [
    "Member cannot archive another's Thread",
    member,
    "thread.archive",
    adasThread,
    deny("not-yours"),
  ],
  [
    "Guest cannot archive another's Thread",
    guest,
    "thread.archive",
    gracesThread,
    deny("not-yours"),
  ],
  ["Admin archives their own Project", admin, "project.archive", adasProject, allow],
  ["Member archives their own Project", member, "project.archive", gracesProject, allow],
  [
    "Guest cannot archive a Project, even one they created",
    guest,
    "project.archive",
    owned("project", "linus"),
    deny("role-not-allowed"),
  ],
  ["Admin archives another's Project", admin, "project.archive", gracesProject, allow],
  [
    "Member cannot archive another's Project",
    member,
    "project.archive",
    adasProject,
    deny("not-yours"),
  ],
  [
    "Guest cannot archive another's Project",
    guest,
    "project.archive",
    gracesProject,
    deny("not-yours"),
  ],
  ["Member changes their own Project", member, "project.manage", gracesProject, allow],
  [
    "Member cannot change another's Project",
    member,
    "project.manage",
    adasProject,
    deny("not-yours"),
  ],
  ["Admin changes another's Project", admin, "project.manage", gracesProject, allow],
  ["the Owner archives anything", owner, "project.archive", gracesProject, allow],

  // Stopping a running Thread: one's own; Admins also others'.
  ["Member stops their own Thread", member, "thread.stop", gracesThread, allow],
  ["Guest stops their own Thread", guest, "thread.stop", linusThread, allow],
  ["Admin stops another's Thread", admin, "thread.stop", gracesThread, allow],
  ["Member cannot stop another's Thread", member, "thread.stop", adasThread, deny("not-yours")],
  ["Guest cannot stop another's Thread", guest, "thread.stop", gracesThread, deny("not-yours")],

  // Permanent deletion: Admins, and only what is archived.
  ["Admin deletes an archived Thread", admin, "thread.delete", archivedGracesThread, allow],
  ["Admin deletes an archived Project", admin, "project.delete", archivedGracesProject, allow],
  [
    "Admin cannot delete a Thread that is not archived",
    admin,
    "thread.delete",
    gracesThread,
    deny("not-archived"),
  ],
  [
    "Member cannot delete, even their own archived Thread",
    member,
    "thread.delete",
    archivedGracesThread,
    deny("role-not-allowed"),
  ],
  [
    "Guest cannot delete",
    guest,
    "thread.delete",
    owned("thread", "linus", { archived: true }),
    deny("role-not-allowed"),
  ],
  [
    "Member cannot delete their own archived Project",
    member,
    "project.delete",
    archivedGracesProject,
    deny("role-not-allowed"),
  ],
  ["the Owner deletes anything", owner, "thread.delete", gracesThread, allow],

  // A Personal space's User runs it; others (but the Owner) do not reach it.
  [
    "a User continues their Thread in their Personal space",
    personalCreator,
    "thread.continue",
    owned("thread", "grace", { space: personalOf("grace") }),
    allow,
  ],
  [
    "a User archives in their Personal space",
    personalCreator,
    "project.archive",
    owned("project", "grace", { space: personalOf("grace") }),
    allow,
  ],
  [
    "a User deletes what is archived in their Personal space",
    personalCreator,
    "thread.delete",
    owned("thread", "grace", { space: personalOf("grace"), archived: true }),
    allow,
  ],
  [
    "nobody else acts in a Personal space",
    admin,
    "thread.stop",
    owned("thread", "grace", { space: personalOf("grace") }),
    deny("not-your-personal-space"),
  ],
  [
    "once the permission is revoked, what is in the Personal space is out of reach",
    member,
    "thread.continue",
    owned("thread", "grace", { space: personalOf("grace") }),
    deny("missing-installation-permission"),
  ],
  // The Owner only reads another User's Personal space: nothing there is theirs to change.
  ...(
    [
      ["thread.continue", owned("thread", "grace", { space: personalOf("grace") })],
      ["thread.archive", owned("thread", "grace", { space: personalOf("grace") })],
      ["thread.organize", owned("thread", "grace", { space: personalOf("grace") })],
      ["thread.stop", owned("thread", "grace", { space: personalOf("grace") })],
      ["thread.delete", owned("thread", "grace", { space: personalOf("grace"), archived: true })],
      ["project.archive", owned("project", "grace", { space: personalOf("grace") })],
      ["project.manage", owned("project", "grace", { space: personalOf("grace") })],
      ["project.delete", owned("project", "grace", { space: personalOf("grace"), archived: true })],
    ] as const
  ).map(
    ([action, item]) =>
      [
        `the Owner cannot ${action} in another User's Personal space`,
        owner,
        action,
        item,
        deny("personal-space-read-only"),
      ] as const,
  ),
  [
    "the Owner archives in their own Personal space",
    owner,
    "thread.archive",
    owned("thread", "grace", { space: personalOf("owner") }),
    allow,
  ],
  [
    "the Owner deletes in their own Personal space",
    owner,
    "project.delete",
    owned("project", "owner", { space: personalOf("owner") }),
    allow,
  ],
  ["Thread rules need a Thread", member, "thread.continue", organization, deny("wrong-resource")],

  // Guest links: Admins, only in Organizations; never from a Personal space.
  ["Admin creates a guest link", admin, "guestLink.create", organization, allow],
  [
    "Member cannot create a guest link",
    member,
    "guestLink.create",
    organization,
    deny("role-not-allowed"),
  ],
  [
    "Guest cannot create a guest link",
    guest,
    "guestLink.create",
    organization,
    deny("role-not-allowed"),
  ],
  [
    "the Owner creates a guest link in an Organization",
    owner,
    "guestLink.create",
    organization,
    allow,
  ],
  [
    "no guest link from a Personal space, not even the Owner's",
    owner,
    "guestLink.create",
    personalOf("owner"),
    deny("wrong-resource"),
  ],
  [
    "no guest link from a Personal space by its own User",
    personalCreator,
    "guestLink.create",
    personalOf("grace"),
    deny("wrong-resource"),
  ],
  [
    "no Invitation into a Personal space by its own User",
    personalCreator,
    "invitation.create",
    personalOf("grace"),
    deny("wrong-resource"),
  ],
  [
    "no Invitations to manage in a Personal space, not even the Owner's",
    owner,
    "invitation.manage",
    personalOf("grace"),
    deny("wrong-resource"),
  ],
  [
    "no guest link from an archived Organization",
    admin,
    "guestLink.create",
    archivedOrganization,
    deny("space-archived"),
  ],

  // Installation permissions: only the Owner lists Users and grants or revokes them.
  [
    "the Owner grants and revokes Installation permissions",
    owner,
    "installationPermission.manage",
    AccessPolicy.installation,
    allow,
  ],
  [
    "an Admin cannot grant Installation permissions",
    admin,
    "installationPermission.manage",
    AccessPolicy.installation,
    deny("owner-only"),
  ],
  [
    "a User holding a permission cannot grant it",
    personalCreator,
    "installationPermission.manage",
    AccessPolicy.installation,
    deny("owner-only"),
  ],

  // Disabling and removing Users: only the Owner, never the Owner themselves.
  ["the Owner disables a User", owner, "user.disable", userTarget("grace"), allow],
  ["the Owner removes a User", owner, "user.remove", userTarget("grace"), allow],
  [
    "nobody disables the Owner",
    owner,
    "user.disable",
    userTarget("owner", true),
    deny("owner-protected"),
  ],
  [
    "nobody removes the Owner",
    owner,
    "user.remove",
    userTarget("owner", true),
    deny("owner-protected"),
  ],
  [
    "an Admin cannot disable a User",
    admin,
    "user.disable",
    userTarget("grace"),
    deny("owner-only"),
  ],
  ["a Member cannot remove a User", member, "user.remove", userTarget("ada"), deny("owner-only")],
  ["User rules need a User", owner, "user.remove", organization, deny("wrong-resource")],

  // A disabled or removed User may do nothing, though their Memberships remain.
  [
    "a disabled Member no longer views",
    disabledMember,
    "space.view",
    organization,
    deny("user-inactive"),
  ],
  [
    "a disabled Member continues not even their own Thread",
    disabledMember,
    "thread.continue",
    gracesThread,
    deny("user-inactive"),
  ],
  [
    "a disabled Admin's guest link stops",
    { ...admin, inactive: true },
    "guestLink.create",
    organization,
    deny("user-inactive"),
  ],

  // A removed User's Personal space: frozen, read by the Owner, who may only delete from it.
  ["the Owner reads a frozen Personal space", owner, "space.view", frozenPersonal, allow],
  [
    "the Owner deletes a Thread from a frozen Personal space without archiving it",
    owner,
    "thread.delete",
    owned("thread", "grace", { space: frozenPersonal }),
    allow,
  ],
  [
    "the Owner deletes a Project from a frozen Personal space",
    owner,
    "project.delete",
    owned("project", "grace", { space: frozenPersonal }),
    allow,
  ],
  [
    "the Owner stops a running Thread in a frozen Personal space",
    owner,
    "thread.stop",
    owned("thread", "grace", { space: frozenPersonal }),
    allow,
  ],
  [
    "the Owner archives nothing in a frozen Personal space",
    owner,
    "project.archive",
    owned("project", "grace", { space: frozenPersonal }),
    deny("personal-space-read-only"),
  ],
  [
    "the Owner continues nothing in a frozen Personal space",
    owner,
    "thread.continue",
    owned("thread", "grace", { space: frozenPersonal }),
    deny("personal-space-read-only"),
  ],
  [
    "the Owner starts no Thread in a frozen Personal space",
    owner,
    "thread.create",
    frozenPersonal,
    deny("space-frozen"),
  ],
  // An Organization's lifecycle is the Owner's: archive, restore, and delete once archived.
  ["the Owner archives an Organization", owner, "organization.archive", organization, allow],
  [
    "the Owner restores an archived Organization",
    owner,
    "organization.restore",
    archivedOrganization,
    allow,
  ],
  [
    "the Owner deletes an archived Organization",
    owner,
    "organization.delete",
    archivedOrganization,
    allow,
  ],
  [
    "not even the Owner deletes an Organization that is not archived",
    owner,
    "organization.delete",
    organization,
    deny("not-archived"),
  ],
  ["an Admin cannot archive", admin, "organization.archive", organization, deny("owner-only")],
  [
    "an Admin cannot restore",
    admin,
    "organization.restore",
    archivedOrganization,
    deny("owner-only"),
  ],
  [
    "an Admin cannot delete",
    admin,
    "organization.delete",
    archivedOrganization,
    deny("owner-only"),
  ],
  [
    "a Personal space is not archived like an Organization",
    owner,
    "organization.archive",
    personalOf("grace"),
    deny("wrong-resource"),
  ],

  // Moving a Project: Admin (or its Personal space's User) in the origin and in the destination.
  [
    "an Admin of both moves between them",
    adminOfBoth,
    "project.move",
    move(organization, otherOrganization),
    allow,
  ],
  [
    "an Admin of the origin who is a Member of the destination cannot",
    adminHereMemberThere,
    "project.move",
    move(organization, otherOrganization),
    deny("role-not-allowed"),
  ],
  [
    "a Member of the origin cannot, even as Admin of the destination",
    adminHereMemberThere,
    "project.move",
    move(otherOrganization, organization),
    deny("role-not-allowed"),
  ],
  [
    "nobody moves into an Organization they are not in",
    admin,
    "project.move",
    move(organization, otherOrganization),
    deny("not-a-member"),
  ],
  [
    "a User moves their Project from their Personal space into an Organization they run",
    personalAdmin,
    "project.move",
    move(personalOf("grace"), organization),
    allow,
  ],
  ["and back", personalAdmin, "project.move", move(organization, personalOf("grace")), allow],
  [
    "not from a Personal space they may not use",
    principal("grace", { roles: [[ORG, "admin"]] }),
    "project.move",
    move(personalOf("grace"), organization),
    deny("missing-installation-permission"),
  ],
  [
    "not out of someone else's Personal space",
    admin,
    "project.move",
    move(personalOf("grace"), organization),
    deny("not-your-personal-space"),
  ],
  [
    "the Owner moves between Organizations",
    owner,
    "project.move",
    move(organization, otherOrganization),
    allow,
  ],
  [
    "the Owner moves out of their own Personal space",
    owner,
    "project.move",
    move(personalOf("owner"), organization),
    allow,
  ],
  [
    "not even the Owner moves into another User's Personal space",
    owner,
    "project.move",
    move(organization, personalOf("grace")),
    deny("personal-space-read-only"),
  ],
  [
    "not even the Owner moves out of another User's Personal space",
    owner,
    "project.move",
    move(personalOf("grace"), organization),
    deny("personal-space-read-only"),
  ],
  [
    "the Owner moves out of a removed User's frozen Personal space, which was handed to them",
    owner,
    "project.move",
    move({ ...personalOf("grace"), frozen: true }, organization),
    allow,
  ],
  [
    "nobody moves into a frozen Personal space",
    owner,
    "project.move",
    move(organization, { ...personalOf("owner"), frozen: true }),
    deny("space-frozen"),
  ],
  [
    "nobody moves into an archived Organization",
    owner,
    "project.move",
    move(otherOrganization, archivedOrganization),
    deny("space-archived"),
  ],
  [
    "the Owner rescues a Project from an archived Organization",
    owner,
    "project.move",
    move(archivedOrganization, otherOrganization),
    allow,
  ],
  [
    "an Admin cannot move out of an archived Organization",
    adminOfBoth,
    "project.move",
    move(archivedOrganization, otherOrganization),
    deny("space-archived"),
  ],
  [
    "a move to the same Space is no move",
    owner,
    "project.move",
    move(organization, organization),
    deny("wrong-resource"),
  ],
  [
    "a move is decided on its origin and destination",
    owner,
    "project.move",
    organization,
    deny("wrong-resource"),
  ],
];

describe("AccessPolicy.decide", () => {
  it.each(rows)("%s", (_name, who, action, resource, expected) => {
    expect(AccessPolicy.decide(who, action, resource)).toEqual(expected);
  });
});
