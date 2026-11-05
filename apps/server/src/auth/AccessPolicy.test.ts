import { type InstallationPermission, SpaceId, type SpaceRole, UserId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import * as AccessPolicy from "./AccessPolicy.ts";

const ORG = SpaceId.make("org-acme");
const OTHER_ORG = SpaceId.make("org-other");

const organization: AccessPolicy.SpaceResource = {
  id: ORG,
  kind: "organization",
  personalOwnerUserId: null,
};
const personalOf = (userId: string): AccessPolicy.SpaceResource => ({
  id: SpaceId.make(`personal-${userId}`),
  kind: "personal",
  personalOwnerUserId: UserId.make(userId),
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
  ["Owner creates a Project anywhere", owner, "project.create", personalOf("grace"), allow],
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

  // Personal spaces: private to their User; creating in one is an Installation permission.
  ["a User views their own Personal space", member, "space.view", personalOf("grace"), allow],
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
];

describe("AccessPolicy.decide", () => {
  it.each(rows)("%s", (_name, who, action, resource, expected) => {
    expect(AccessPolicy.decide(who, action, resource)).toEqual(expected);
  });
});
