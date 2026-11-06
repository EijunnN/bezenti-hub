// What the signed-in User's Role lets them do with one Thread, so clients hide or disable what
// the server would refuse. The server's AccessPolicy stays authoritative; this mirrors its rules.
import type { SpaceDirectoryView, SpaceId, UserId } from "@t3tools/contracts";

export interface ThreadRoleSubject {
  /** Absent on Threads from before Spaces, and on drafts. */
  readonly spaceId?: SpaceId | null | undefined;
  /** Absent on Threads from before Spaces, which are the Owner's. */
  readonly ownerUserId?: UserId | null | undefined;
}

export interface ThreadRolePermissions {
  /** Send messages, answer questions and change the Thread's settings. */
  readonly canContinue: boolean;
  readonly canArchive: boolean;
  readonly canStop: boolean;
  /** Permanently delete; the server also wants it archived first unless the viewer is the Owner. */
  readonly canDelete: boolean;
  /** Share it with a guest link: an Admin's (or the Owner's), only in an Organization. */
  readonly canCreateGuestLink: boolean;
  /** Why the composer is disabled, or null when the viewer may continue. */
  readonly continueBlockedReason: string | null;
}

export const NOT_YOUR_THREAD_REASON =
  "Only the person who started this Thread can continue it. Start a new Thread to build on it.";

const EVERYTHING: ThreadRolePermissions = {
  canContinue: true,
  canArchive: true,
  canStop: true,
  canDelete: true,
  canCreateGuestLink: true,
  continueBlockedReason: null,
};

/**
 * `view` is the viewer's Space directory; null where there are no Users (before the Owner exists)
 * or for a draft that has no Thread yet, which leaves everything allowed.
 */
export function threadRolePermissions(
  view: SpaceDirectoryView | null,
  thread: ThreadRoleSubject | null,
): ThreadRolePermissions {
  if (view === null || thread === null) return EVERYTHING;
  const space = view.spaces.find((candidate) => candidate.id === thread.spaceId);
  // Nothing in a Personal space is shared directly, not even by the Owner.
  const inOrganization = space?.kind === "organization";
  if (view.isOwner === true) return { ...EVERYTHING, canCreateGuestLink: inOrganization };
  const own = thread.ownerUserId != null && thread.ownerUserId === view.userId;
  // A User runs their own Personal space as an Admin runs an Organization.
  const admin = space?.isOwn === true || space?.role === "admin";
  return {
    canContinue: own,
    canArchive: own || admin,
    canStop: own || admin,
    canDelete: admin,
    canCreateGuestLink: inOrganization && space?.role === "admin",
    continueBlockedReason: own ? null : NOT_YOUR_THREAD_REASON,
  };
}
