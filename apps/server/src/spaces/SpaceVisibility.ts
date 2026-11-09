/**
 * Which Projects and Threads a principal may see: every read of them asks this module. A User
 * sees the Spaces the policy lets them view (`space.view`); the Owner sees everything. A Thread
 * is in its own Space, else its Project's; with neither it is the Owner's Personal space.
 */
import {
  EnvironmentAuthenticatedPrincipal,
  HUB_MACHINE_ENVIRONMENT_ID,
  ProjectId,
  type SpaceId,
  ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as DirectoryRoots from "./directoryRoots.ts";
import * as SpaceDirectory from "./SpaceDirectory.ts";
import { SHELL_SESSION_SUBJECT } from "../auth/CommandActor.ts";

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export type Visibility =
  /** The Owner, and sessions from before an Owner existed. */
  { readonly all: true } | { readonly all: false; readonly spaceIds: ReadonlyArray<SpaceId> };

export const everything: Visibility = { all: true };

/** Sees no Space at all: a session that names no User once an Owner exists. */
export const nothing: Visibility = { all: false, spaceIds: [] };

/**
 * What the current request may see, for services that pick Projects themselves (a Pull Request
 * call routed by repository). Transports set it; work no transport started sees everything.
 */
export const RequestVisibility = Context.Reference<Visibility>(
  "t3/spaces/SpaceVisibility/RequestVisibility",
  { defaultValue: () => everything },
);

/** The `spaceIds` option the stores take; undefined reads every Space. */
export const spaceFilter = (visibility: Visibility): ReadonlyArray<SpaceId> | undefined =>
  visibility.all ? undefined : visibility.spaceIds;

export const seesProject = (
  visibility: Visibility,
  project: { readonly spaceId?: SpaceId | null | undefined },
): boolean =>
  visibility.all ||
  (project.spaceId !== undefined &&
    project.spaceId !== null &&
    visibility.spaceIds.includes(project.spaceId));

/**
 * SQL that keeps the thread row aliased `alias` when it is in one of `spaceIds` (all rows when
 * undefined). Stores put it in their WHERE clause so hidden threads are never read.
 */
export const threadInSpaces = (
  sql: SqlClient.SqlClient,
  alias: string,
  spaceIds: ReadonlyArray<string> | null | undefined,
) =>
  spaceIds === undefined || spaceIds === null
    ? sql`1 = 1`
    : sql`COALESCE(${sql.literal(alias)}.space_id, (
        SELECT visible_project.space_id FROM projection_projects visible_project
        WHERE visible_project.project_id = ${sql.literal(alias)}.project_id
      )) IN (SELECT value FROM json_each(${encodeIds(spaceIds)}))`;

/** A Thread's recorded worktree, when it runs on the Hub machine (or names no machine). */
const hubWorktree = (sql: SqlClient.SqlClient, alias: string) =>
  sql`CASE WHEN COALESCE(${sql.literal(alias)}.active_environment_id, ${HUB_MACHINE_ENVIRONMENT_ID})
      = ${HUB_MACHINE_ENVIRONMENT_ID}
    THEN json_extract(${sql.literal(alias)}.payload_json, '$.worktreePath') END`;

/**
 * Whose the Thread aliased `alias` is: its own owner, else its root's (a child the server made),
 * else the Owner's (from before Users).
 */
export const effectiveOwner = (sql: SqlClient.SqlClient, alias: string) =>
  sql`COALESCE(${sql.literal(alias)}.owner_user_id,
    (SELECT root_owner.owner_user_id FROM orchestration_v2_projection_threads root_owner
      WHERE root_owner.thread_id = json_extract(${sql.literal(alias)}.payload_json, '$.lineage.rootThreadId')),
    (SELECT user_id FROM users WHERE is_owner = 1), '')`;

/** Whether another User's Thread recorded the worktree of the Thread aliased `alias` before it. */
const claimedEarlier = (sql: SqlClient.SqlClient, alias: string) =>
  sql`EXISTS (SELECT 1 FROM orchestration_v2_projection_threads earlier
    WHERE earlier.thread_id <> ${sql.literal(alias)}.thread_id
      AND json_extract(earlier.payload_json, '$.worktreePath')
        = json_extract(${sql.literal(alias)}.payload_json, '$.worktreePath')
      AND ${effectiveOwner(sql, "earlier")} <> ${effectiveOwner(sql, alias)}
      AND (earlier.created_at < ${sql.literal(alias)}.created_at
        OR (earlier.created_at = ${sql.literal(alias)}.created_at
          AND earlier.thread_id < ${sql.literal(alias)}.thread_id)))`;

/** Whether the Project aliased `alias` was created by the Owner, or before Users existed. */
const byOwner = (sql: SqlClient.SqlClient, alias: string) =>
  sql`(${sql.literal(alias)}.owner_user_id IS NULL OR ${sql.literal(alias)}.owner_user_id IN
    (SELECT user_id FROM users WHERE is_owner = 1))`;

/** A recorded folder that may serve as a root, with what today's rule needs to trust it. */
interface RootRow {
  readonly root: string | null;
  readonly projectRoot: string | null;
  /** The Project was created by the Owner (or before Users). */
  readonly byOwner: number;
  /** A Thread's worktree, rather than a Project's root. */
  readonly worktree: number;
  /** Another User's Thread recorded the same folder first. */
  readonly claimedEarlier: number;
}

export class SpaceVisibility extends Context.Service<
  SpaceVisibility,
  {
    /** What the User may see now; no User is the Owner (MCP tools, the CLI, scheduled tasks). */
    readonly of: (userId: UserId | undefined) => Effect.Effect<Visibility>;
    /**
     * What a request's session may see: its User's view; with no User, everything only before an
     * Owner exists (or for the Hub's own shell), else nothing, whatever scopes it was issued.
     */
    readonly ofSession: (session: {
      readonly userId?: UserId | undefined;
      readonly subject: string;
    }) => Effect.Effect<Visibility>;
    /**
     * A view of `of` for one connection: resolved once, and again only after a Space or
     * Membership changed.
     */
    readonly viewer: (userId: UserId | undefined) => Effect.Effect<Effect.Effect<Visibility>>;
    /**
     * Subscribes now to changes of the User's access that may hide what an open stream already
     * sent; streams reload from scratch or close. Never emits for no User.
     */
    readonly subscribeAccessChanges: (
      userId: UserId | undefined,
    ) => Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
    /** The ids among `threadIds` the principal may see. Deleted threads keep their Space. */
    readonly visibleThreadIds: (
      visibility: Visibility,
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlySet<ThreadId>>;
    /**
     * The ids among `threadIds` that exist in a Space the principal may not see. For streams
     * that also carry draft Threads, which have no row yet and stay shown.
     */
    readonly hiddenThreadIds: (
      visibility: Visibility,
      threadIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlySet<string>>;
    /**
     * The ids among `projectIds` the User works in: in a Space where their Role creates Projects
     * (their Personal space, or as a Member or Admin; not a Guest's).
     */
    readonly workableProjectIds: (
      visibility: Visibility,
      userId: UserId | undefined,
      projectIds: ReadonlyArray<ProjectId>,
    ) => Effect.Effect<ReadonlySet<ProjectId>>;
    /** The ids among `projectIds` the principal may see. */
    readonly visibleProjectIds: (
      visibility: Visibility,
      projectIds: ReadonlyArray<ProjectId>,
    ) => Effect.Effect<ReadonlySet<ProjectId>>;
    /**
     * Whether the User may work a Thread's terminals, previews, devices, attachments and
     * worktree setup: an existing Thread only its creator works (not even the Owner works
     * someone else's); a draft, which has no row yet, belongs to the first User who works it
     * and is hidden from everyone else. `drafts: false` refuses ids with no Thread.
     */
    readonly claimWork: (
      visibility: Visibility,
      userId: UserId | undefined,
      threadId: string,
      options?: { readonly drafts?: boolean },
    ) => Effect.Effect<WorkAccess>;
    /** The ids among `threadIds` the User may work, by the same rule, without claiming drafts. */
    readonly workableThreadIds: (
      visibility: Visibility,
      userId: UserId | undefined,
      threadIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlySet<string>>;
    /**
     * Whether the User may run a terminal in `directory`: the working folder of a Thread they
     * created, or a Project in a Space where their Role creates Projects (not a Guest's).
     */
    readonly mayUseDirectory: (
      visibility: Visibility,
      userId: UserId | undefined,
      directory: string,
    ) => Effect.Effect<boolean>;
    /**
     * Whether the User may read `directory` with no Thread to place the call: inside a Project of
     * a Space they see, or the working folder of a Thread there.
     */
    readonly mayReadDirectory: (
      visibility: Visibility,
      directory: string,
    ) => Effect.Effect<boolean>;
    /**
     * Whether the User may root a new Project at `directory`: one who sees everything anywhere,
     * anyone else (a Space-limited agent included) only in a new folder right in one of
     * `sharedRoots` that no Project holds (`ProjectService`'s rule).
     */
    readonly mayRootProject: (
      visibility: Visibility,
      userId: UserId | undefined,
      directory: string,
      sharedRoots: ReadonlyArray<string>,
    ) => Effect.Effect<boolean>;
    /**
     * Whether the User may create `directory` (a clone's checkout): where `mayUseDirectory` lets
     * them work, or as a new folder right in one of `sharedRoots` (the Hub's Projects folder) that
     * no Project holds. Its parent must resolve where it is named. Ask again just before writing.
     */
    readonly mayCreateDirectory: (
      visibility: Visibility,
      userId: UserId | undefined,
      directory: string,
      sharedRoots: ReadonlyArray<string>,
    ) => Effect.Effect<boolean>;
    /**
     * The folder a Thread works in on the Hub's disk (its worktree, else its Project's root) when
     * it runs on the Hub machine (or names none), deleted or not, read as
     * `ActiveEnvironmentResolver` reads it; none for a Thread elsewhere or with no row.
     */
    readonly hubThreadFolder: (threadId: string) => Effect.Effect<Option.Option<string | null>>;
  }
>()("t3/spaces/SpaceVisibility") {}

export type WorkAccess = "allowed" | "hidden" | "not-yours";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const path = yield* Path.Path;
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);

  const directories = { path, fileSystem };
  const within = (roots: ReadonlyArray<string>, directory: string) =>
    DirectoryRoots.withinRoots(directories, roots, directory);
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const baseDir = Option.getOrUndefined(Option.map(config, (found) => found.baseDir));
  // The Hub's own folders as their links lead, resolved once (on first use, as they may not
  // exist yet when the layer is built).
  const hubReals =
    baseDir === undefined
      ? Effect.succeed(undefined)
      : yield* Effect.cached(DirectoryRoots.hubFolderReals(directories, baseDir));

  // Whether `directory` is inside a recorded root today's rule trusts (`directoryRoots`), so rows
  // from before the rule or another machine's paths count only if they pass. Only roots that
  // could hold `directory` are checked against the disk.
  const withinTrusted = Effect.fn("SpaceVisibility.withinTrusted")(function* (
    rows: ReadonlyArray<RootRow>,
    directory: string,
  ) {
    const hub = yield* hubReals;
    for (const row of rows) {
      if (row.root === null || row.projectRoot === null) continue;
      if (!(yield* within([row.root], directory))) continue;
      const trustedProject = yield* DirectoryRoots.isTrustedProjectRoot(
        directories,
        row.projectRoot,
        row.byOwner === 1,
        hub,
      );
      if (!trustedProject) continue;
      // The Scratch folder holds every User's Scratch Threads: only a Thread's own folder in it.
      if (row.worktree !== 1) {
        if (!(yield* DirectoryRoots.isScratchRoot(directories, row.root, hub))) return true;
        continue;
      }
      const own = yield* DirectoryRoots.projectWorktreeRoot(
        directories,
        row.projectRoot,
        row.root,
        hub === undefined ? undefined : [hub.data, hub.projects, hub.scratch],
      );
      if (Option.isNone(own)) continue;
      // In the Scratch folder a Thread gets only one folder right in it, and only if no other
      // User's Thread recorded that folder first; never the Scratch folder itself.
      const realOwn = yield* DirectoryRoots.realOf(directories, own.value);
      if (hub !== undefined && realOwn === hub.scratch) continue;
      if (
        (yield* DirectoryRoots.isScratchRoot(directories, row.projectRoot, hub)) &&
        (hub === undefined || path.dirname(realOwn) !== hub.scratch || row.claimedEarlier === 1)
      ) {
        continue;
      }
      if (yield* within([own.value], directory)) return true;
    }
    return false;
  });

  // A failed read must not widen what anyone sees, so it fails the request instead.
  const of = Effect.fn("SpaceVisibility.of")(function* (userId: UserId | undefined) {
    if (userId === undefined) return everything;
    const viewable = yield* spaces.viewableSpaces(userId).pipe(Effect.orDie);
    return viewable === "all" ? everything : ({ all: false, spaceIds: viewable } as const);
  });

  const ofSession = Effect.fn("SpaceVisibility.ofSession")(function* (session: {
    readonly userId?: UserId | undefined;
    readonly subject: string;
  }) {
    if (session.userId !== undefined) return yield* of(session.userId);
    if (session.subject === SHELL_SESSION_SUBJECT) return everything;
    const owners = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM users WHERE is_owner = 1
    `.pipe(Effect.orDie);
    return (owners[0]?.count ?? 0) === 0 ? everything : nothing;
  });

  const viewer = Effect.fn("SpaceVisibility.viewer")(function* (userId: UserId | undefined) {
    const cached = yield* Ref.make(
      Option.none<{ readonly revision: number; readonly visibility: Visibility }>(),
    );
    return Effect.gen(function* () {
      const revision = yield* spaces.revision;
      const current = yield* Ref.get(cached);
      // The Owner stays the Owner, so their answer never needs another read.
      if (
        Option.isSome(current) &&
        (current.value.visibility.all || current.value.revision === revision)
      ) {
        return current.value.visibility;
      }
      const visibility = yield* of(userId);
      yield* Ref.set(cached, Option.some({ revision, visibility }));
      return visibility;
    });
  });

  const subscribeAccessChanges = (userId: UserId | undefined) =>
    userId === undefined ? Effect.succeed(Stream.empty) : spaces.subscribeAccessChanges(userId);

  const visibleThreadIds = Effect.fn("SpaceVisibility.visibleThreadIds")(function* (
    visibility: Visibility,
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    if (visibility.all) return new Set(threadIds);
    if (threadIds.length === 0) return new Set<ThreadId>();
    const rows = yield* sql<{ readonly threadId: string }>`
      SELECT t.thread_id AS "threadId" FROM orchestration_v2_projection_threads t
      WHERE t.thread_id IN (SELECT value FROM json_each(${encodeIds(threadIds)}))
        AND ${threadInSpaces(sql, "t", visibility.spaceIds)}
    `.pipe(Effect.orDie);
    return new Set(rows.map((row) => ThreadId.make(row.threadId)));
  });

  const hiddenThreadIds = Effect.fn("SpaceVisibility.hiddenThreadIds")(function* (
    visibility: Visibility,
    threadIds: ReadonlyArray<string>,
  ) {
    if (visibility.all || threadIds.length === 0) return new Set<string>();
    const rows = yield* sql<{ readonly threadId: string }>`
      SELECT t.thread_id AS "threadId" FROM orchestration_v2_projection_threads t
      WHERE t.thread_id IN (SELECT value FROM json_each(${encodeIds(threadIds)}))
        AND NOT COALESCE((${threadInSpaces(sql, "t", visibility.spaceIds)}), 0)
    `.pipe(Effect.orDie);
    return new Set(rows.map((row) => row.threadId));
  });

  const visibleProjectIds = Effect.fn("SpaceVisibility.visibleProjectIds")(function* (
    visibility: Visibility,
    projectIds: ReadonlyArray<ProjectId>,
  ) {
    if (visibility.all) return new Set(projectIds);
    if (projectIds.length === 0) return new Set<ProjectId>();
    const rows = yield* sql<{ readonly projectId: string }>`
      SELECT project_id AS "projectId" FROM projection_projects
      WHERE project_id IN (SELECT value FROM json_each(${encodeIds(projectIds)}))
        AND space_id IN (SELECT value FROM json_each(${encodeIds(visibility.spaceIds)}))
    `.pipe(Effect.orDie);
    return new Set(rows.map((row) => ProjectId.make(row.projectId)));
  });

  // Drafts have no row to carry an owner, so the first User to work one holds it while the
  // server runs; their terminals and previews end with it. Bounded: the oldest claims go first.
  const draftOwners = new Map<string, UserId>();
  const MAX_CLAIMS = 20_000;
  // Terminal writes ask on every keystroke; a Thread's creator never changes, so an allowed
  // answer holds until a Space or Membership change could hide the Thread.
  const allowedWork = new Map<string, number>();

  const workOf = Effect.fn("SpaceVisibility.workOf")(function* (
    visibility: Visibility,
    userId: UserId,
    threadIds: ReadonlyArray<string>,
    options: { readonly claim: boolean; readonly drafts: boolean },
  ) {
    const revision = yield* spaces.revision;
    const result = new Map<string, WorkAccess>();
    const unknown = [...new Set(threadIds)].filter((threadId) => {
      if (allowedWork.get(`${userId}\n${threadId}`) !== revision) return true;
      result.set(threadId, "allowed");
      return false;
    });
    if (unknown.length === 0) return result;
    const rows = yield* sql<{
      readonly threadId: string;
      readonly ownerUserId: string | null;
      readonly visible: number;
    }>`
      SELECT t.thread_id AS "threadId",
        COALESCE(t.owner_user_id, root.owner_user_id,
          (SELECT user_id FROM users WHERE is_owner = 1)) AS "ownerUserId",
        COALESCE((${threadInSpaces(sql, "t", spaceFilter(visibility))}), 0) AS "visible"
      FROM orchestration_v2_projection_threads t
      LEFT JOIN orchestration_v2_projection_threads root
        ON root.thread_id = json_extract(t.payload_json, '$.lineage.rootThreadId')
      WHERE t.thread_id IN (SELECT value FROM json_each(${encodeIds(unknown)}))
    `.pipe(Effect.orDie);
    const existing = new Map(rows.map((row) => [row.threadId, row]));
    for (const threadId of unknown) {
      const row = existing.get(threadId);
      if (row !== undefined) {
        const access: WorkAccess =
          row.visible === 0 ? "hidden" : row.ownerUserId === userId ? "allowed" : "not-yours";
        if (access === "allowed") allowedWork.set(`${userId}\n${threadId}`, revision);
        result.set(threadId, access);
        continue;
      }
      const holder = draftOwners.get(threadId);
      if (!options.drafts) result.set(threadId, "hidden");
      else if (holder === userId) result.set(threadId, "allowed");
      else if (holder === undefined && options.claim) {
        if (draftOwners.size >= MAX_CLAIMS) {
          const oldest = draftOwners.keys().next();
          if (oldest.done !== true) draftOwners.delete(oldest.value);
        }
        draftOwners.set(threadId, userId);
        result.set(threadId, "allowed");
      } else {
        // Someone else's draft looks like one that does not exist.
        result.set(threadId, "hidden");
      }
    }
    if (allowedWork.size > MAX_CLAIMS) allowedWork.clear();
    return result;
  });

  const claimWork = Effect.fn("SpaceVisibility.claimWork")(function* (
    visibility: Visibility,
    userId: UserId | undefined,
    threadId: string,
    options?: { readonly drafts?: boolean },
  ) {
    if (userId === undefined) {
      // No User acts as the Owner, but a limited view (a Space-limited agent) still bounds it.
      if (visibility.all) return "allowed" as const;
      const hidden = yield* hiddenThreadIds(visibility, [threadId]);
      return hidden.has(threadId) ? ("hidden" as const) : ("allowed" as const);
    }
    const access = yield* workOf(visibility, userId, [threadId], {
      claim: true,
      drafts: options?.drafts ?? true,
    });
    return access.get(threadId) ?? "hidden";
  });

  const workableThreadIds = Effect.fn("SpaceVisibility.workableThreadIds")(function* (
    visibility: Visibility,
    userId: UserId | undefined,
    threadIds: ReadonlyArray<string>,
  ) {
    if (threadIds.length === 0) return new Set(threadIds);
    if (userId === undefined) {
      if (visibility.all) return new Set(threadIds);
      const hidden = yield* hiddenThreadIds(visibility, threadIds);
      return new Set(threadIds.filter((threadId) => !hidden.has(threadId)));
    }
    const access = yield* workOf(visibility, userId, threadIds, { claim: false, drafts: true });
    return new Set(threadIds.filter((threadId) => access.get(threadId) === "allowed"));
  });

  const writableSpaces = Effect.fn("SpaceVisibility.writableSpaces")(function* (
    visibility: { readonly spaceIds: ReadonlyArray<SpaceId> },
    userId: UserId,
  ) {
    const principal = yield* spaces.principalOf(userId).pipe(Effect.orDie);
    return visibility.spaceIds.filter((spaceId) => {
      const role = principal.roles.get(spaceId);
      // The Owner works every Space but another User's Personal space, also when a credential
      // limits them to one Space.
      if (principal.isOwner)
        return !spaceId.startsWith("personal:") || spaceId === `personal:${userId}`;
      return spaceId === `personal:${userId}` || role === "admin" || role === "member";
    });
  });

  const workableProjectIds = Effect.fn("SpaceVisibility.workableProjectIds")(function* (
    visibility: Visibility,
    userId: UserId | undefined,
    projectIds: ReadonlyArray<ProjectId>,
  ) {
    if (visibility.all) return new Set(projectIds);
    if (projectIds.length === 0) return new Set<ProjectId>();
    // No User (a Thread from before owners) acts as the Owner, within what it may see.
    if (userId === undefined) return yield* visibleProjectIds(visibility, projectIds);
    return yield* visibleProjectIds(
      { all: false, spaceIds: yield* writableSpaces(visibility, userId) },
      projectIds,
    );
  });

  const mayUseDirectory = Effect.fn("SpaceVisibility.mayUseDirectory")(function* (
    visibility: Visibility,
    userId: UserId | undefined,
    directory: string,
  ) {
    if (visibility.all) return true;
    // No User but a limited view (a Space-limited agent of a Thread from before owners) acts as
    // the Owner would, within that view.
    const writable =
      userId === undefined ? visibility.spaceIds : yield* writableSpaces(visibility, userId);
    const rows = yield* sql<RootRow>`
      SELECT COALESCE(${hubWorktree(sql, "t")}, p.workspace_root) AS root,
        p.workspace_root AS "projectRoot", ${byOwner(sql, "p")} AS "byOwner",
        ${hubWorktree(sql, "t")} IS NOT NULL AS worktree, ${claimedEarlier(sql, "t")} AS "claimedEarlier"
      FROM orchestration_v2_projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id
      WHERE (${userId ?? null} IS NULL OR t.owner_user_id = ${userId ?? null})
        AND t.deleted_at IS NULL
        AND ${threadInSpaces(sql, "t", visibility.spaceIds)}
      UNION
      SELECT workspace_root AS root, workspace_root AS "projectRoot",
        ${byOwner(sql, "projection_projects")} AS "byOwner", 0 AS worktree, 0 AS "claimedEarlier"
      FROM projection_projects
      WHERE deleted_at IS NULL
        AND space_id IN (SELECT value FROM json_each(${encodeIds(writable)}))
    `.pipe(Effect.orDie);
    return yield* withinTrusted(rows, directory);
  });

  const mayReadDirectory = Effect.fn("SpaceVisibility.mayReadDirectory")(function* (
    visibility: Visibility,
    directory: string,
  ) {
    if (visibility.all) return true;
    const rows = yield* sql<RootRow>`
      SELECT ${hubWorktree(sql, "t")} AS root, p.workspace_root AS "projectRoot",
        ${byOwner(sql, "p")} AS "byOwner", 1 AS worktree, ${claimedEarlier(sql, "t")} AS "claimedEarlier"
      FROM orchestration_v2_projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.deleted_at IS NULL AND ${threadInSpaces(sql, "t", visibility.spaceIds)}
      UNION
      SELECT workspace_root AS root, workspace_root AS "projectRoot",
        ${byOwner(sql, "projection_projects")} AS "byOwner", 0 AS worktree, 0 AS "claimedEarlier"
      FROM projection_projects
      WHERE deleted_at IS NULL
        AND space_id IN (SELECT value FROM json_each(${encodeIds(visibility.spaceIds)}))
    `.pipe(Effect.orDie);
    return yield* withinTrusted(rows, directory);
  });

  const hubThreadFolder = Effect.fn("SpaceVisibility.hubThreadFolder")(function* (
    threadId: string,
  ) {
    const [row] = yield* sql<{
      readonly environmentId: string | null;
      readonly folder: string | null;
    }>`
      SELECT t.active_environment_id AS "environmentId",
        COALESCE(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) AS folder
      FROM orchestration_v2_projection_threads t
      LEFT JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.thread_id = ${threadId}
    `.pipe(Effect.orDie);
    return row !== undefined &&
      (row.environmentId ?? HUB_MACHINE_ENVIRONMENT_ID) === HUB_MACHINE_ENVIRONMENT_ID
      ? Option.some(row.folder)
      : Option.none();
  });

  const mayRootProject = Effect.fn("SpaceVisibility.mayRootProject")(function* (
    visibility: Visibility,
    userId: UserId | undefined,
    directory: string,
    sharedRoots: ReadonlyArray<string>,
  ) {
    if (visibility.all) return true;
    return yield* DirectoryRoots.isNewFolderIn(directories, sql, directory, sharedRoots);
  });

  const mayCreateDirectory = Effect.fn("SpaceVisibility.mayCreateDirectory")(function* (
    visibility: Visibility,
    userId: UserId | undefined,
    directory: string,
    sharedRoots: ReadonlyArray<string>,
  ) {
    if (visibility.all) return true;
    if (!DirectoryRoots.isPlainAbsolute(path, directory)) return false;
    // Its parent, links resolved, must be where the path names it: a link swapped in on the way
    // would put the checkout elsewhere.
    const target = yield* DirectoryRoots.realOf(directories, directory);
    const realParent = yield* DirectoryRoots.realOf(
      directories,
      path.dirname(path.resolve(directory)),
    );
    if (path.dirname(target) !== realParent) return false;
    if (yield* mayUseDirectory(visibility, userId, directory)) return true;
    // In a shared root only a new folder right in it, which no Project holds.
    return yield* DirectoryRoots.isNewFolderIn(directories, sql, directory, sharedRoots);
  });

  return SpaceVisibility.of({
    of,
    ofSession,
    viewer,
    subscribeAccessChanges,
    visibleThreadIds,
    hiddenThreadIds,
    visibleProjectIds,
    workableProjectIds,
    claimWork,
    workableThreadIds,
    mayUseDirectory,
    mayReadDirectory,
    mayCreateDirectory,
    mayRootProject,
    hubThreadFolder,
  });
});

export const layer = Layer.effect(SpaceVisibility, make);

/** What the current connection or request may see. */
export class CurrentViewer extends Context.Service<
  CurrentViewer,
  {
    readonly visibility: Effect.Effect<Visibility>;
    /** `SpaceVisibility.subscribeAccessChanges` for this connection's User. */
    readonly subscribeAccessChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
    /**
     * Whether the viewer lost a Membership at or after event `sequence`, so a client resuming
     * from there may hold rows it can no longer see and needs a fresh snapshot instead.
     */
    readonly lostAccessSince: (sequence: number) => Effect.Effect<boolean>;
  }
>()("t3/spaces/SpaceVisibility/CurrentViewer") {}

/** One viewer per connection, for the principal of that connection. */
export const layerCurrentViewer = Layer.effect(
  CurrentViewer,
  Effect.gen(function* () {
    const principal = yield* EnvironmentAuthenticatedPrincipal;
    const visibility = yield* SpaceVisibility;
    const spaces = yield* SpaceDirectory.SpaceDirectory;
    const userId = principal.userId;
    // A session with no User sees nothing once an Owner exists, Installation RPCs included.
    const sessionView = userId === undefined ? yield* visibility.ofSession(principal) : undefined;
    return CurrentViewer.of({
      visibility:
        sessionView === undefined ? yield* visibility.viewer(userId) : Effect.succeed(sessionView),
      lostAccessSince: Effect.fn("CurrentViewer.lostAccessSince")(function* (sequence: number) {
        if (userId === undefined) return false;
        // A failed read must not let a stale client keep what it may no longer see.
        const through = yield* spaces
          .accessNarrowedThrough(userId)
          .pipe(Effect.orElseSucceed(() => Number.MAX_SAFE_INTEGER));
        return through > 0 && sequence <= through;
      }),
      subscribeAccessChanges: visibility.subscribeAccessChanges(userId),
    });
  }),
);

/** Sees everything: for tests and in-process callers that act as the Owner. */
export const layerCurrentViewerOwner = Layer.succeed(
  CurrentViewer,
  CurrentViewer.of({
    visibility: Effect.succeed(everything),
    subscribeAccessChanges: Effect.succeed(Stream.empty),
    lostAccessSince: Effect.fn("CurrentViewer.lostAccessSince")(() => Effect.succeed(false)),
  }),
);
