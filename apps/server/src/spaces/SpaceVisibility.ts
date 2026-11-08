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

import * as SpaceDirectory from "./SpaceDirectory.ts";

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export type Visibility =
  /** The Owner, and sessions from before an Owner existed. */
  { readonly all: true } | { readonly all: false; readonly spaceIds: ReadonlyArray<SpaceId> };

export const everything: Visibility = { all: true };

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

const isWithin = (path: Path.Path, root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

export class SpaceVisibility extends Context.Service<
  SpaceVisibility,
  {
    /** What the User may see now; no User is the Owner (MCP tools, the CLI, scheduled tasks). */
    readonly of: (userId: UserId | undefined) => Effect.Effect<Visibility>;
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
     * Whether the Thread runs on the Hub machine (or names none), deleted or not, read as
     * `ActiveEnvironmentResolver` reads it: its workspace calls then run on the Hub's disk.
     */
    readonly threadOnHubMachine: (threadId: string) => Effect.Effect<boolean>;
  }
>()("t3/spaces/SpaceVisibility") {}

export type WorkAccess = "allowed" | "hidden" | "not-yours";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const path = yield* Path.Path;
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);

  /**
   * Where a path leads once its links resolve: its deepest existing ancestor's real path, with
   * the rest as named. Lexical where the server has no filesystem.
   */
  const realOf = Effect.fn("SpaceVisibility.realOf")(function* (candidate: string) {
    const resolved = path.resolve(candidate);
    if (Option.isNone(fileSystem)) return resolved;
    let existing = resolved;
    const rest: Array<string> = [];
    while (true) {
      const real = yield* fileSystem.value.realPath(existing).pipe(Effect.option);
      if (Option.isSome(real)) return path.join(real.value, ...rest);
      const parent = path.dirname(existing);
      if (parent === existing) return resolved;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  });

  /** Whether `directory` leads inside one of `roots`, links resolved on both sides. */
  const within = Effect.fn("SpaceVisibility.within")(function* (
    roots: ReadonlyArray<string>,
    directory: string,
  ) {
    // Only an absolute path without `..` or `~`: resolved lexically first, it could name
    // another place than the one opened through a link.
    if (
      !path.isAbsolute(directory) ||
      directory.startsWith("~") ||
      directory.split(/[\\/]/u).includes("..")
    ) {
      return false;
    }
    const target = yield* realOf(directory);
    for (const root of roots) {
      if (isWithin(path, yield* realOf(root), target)) return true;
    }
    return false;
  });

  // A failed read must not widen what anyone sees, so it fails the request instead.
  const of = Effect.fn("SpaceVisibility.of")(function* (userId: UserId | undefined) {
    if (userId === undefined) return everything;
    const viewable = yield* spaces.viewableSpaces(userId).pipe(Effect.orDie);
    return viewable === "all" ? everything : ({ all: false, spaceIds: viewable } as const);
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
    if (userId === undefined) return "allowed" as const;
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
    if (userId === undefined || threadIds.length === 0) return new Set(threadIds);
    const access = yield* workOf(visibility, userId, threadIds, { claim: false, drafts: true });
    return new Set(threadIds.filter((threadId) => access.get(threadId) === "allowed"));
  });

  const mayUseDirectory = Effect.fn("SpaceVisibility.mayUseDirectory")(function* (
    visibility: Visibility,
    userId: UserId | undefined,
    directory: string,
  ) {
    if (userId === undefined || visibility.all) return true;
    const principal = yield* spaces.principalOf(userId).pipe(Effect.orDie);
    const writable = visibility.spaceIds.filter((spaceId) => {
      const role = principal.roles.get(spaceId);
      return spaceId === `personal:${userId}` || role === "admin" || role === "member";
    });
    const roots = yield* sql<{ readonly root: string | null }>`
      SELECT COALESCE(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) AS root
      FROM orchestration_v2_projection_threads t
      LEFT JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.owner_user_id = ${userId} AND t.deleted_at IS NULL
        AND ${threadInSpaces(sql, "t", visibility.spaceIds)}
      UNION
      SELECT workspace_root AS root FROM projection_projects
      WHERE deleted_at IS NULL
        AND space_id IN (SELECT value FROM json_each(${encodeIds(writable)}))
    `.pipe(Effect.orDie);
    return yield* within(
      roots.flatMap((row) => (row.root === null ? [] : [row.root])),
      directory,
    );
  });

  const mayReadDirectory = Effect.fn("SpaceVisibility.mayReadDirectory")(function* (
    visibility: Visibility,
    directory: string,
  ) {
    if (visibility.all) return true;
    const roots = yield* sql<{ readonly root: string | null }>`
      SELECT json_extract(t.payload_json, '$.worktreePath') AS root
      FROM orchestration_v2_projection_threads t
      WHERE t.deleted_at IS NULL AND ${threadInSpaces(sql, "t", visibility.spaceIds)}
      UNION
      SELECT workspace_root AS root FROM projection_projects
      WHERE deleted_at IS NULL
        AND space_id IN (SELECT value FROM json_each(${encodeIds(visibility.spaceIds)}))
    `.pipe(Effect.orDie);
    return yield* within(
      roots.flatMap((row) => (row.root === null ? [] : [row.root])),
      directory,
    );
  });

  const threadOnHubMachine = Effect.fn("SpaceVisibility.threadOnHubMachine")(function* (
    threadId: string,
  ) {
    const [row] = yield* sql<{ readonly environmentId: string | null }>`
      SELECT active_environment_id AS "environmentId" FROM orchestration_v2_projection_threads
      WHERE thread_id = ${threadId}
    `.pipe(Effect.orDie);
    return (
      row !== undefined &&
      (row.environmentId ?? HUB_MACHINE_ENVIRONMENT_ID) === HUB_MACHINE_ENVIRONMENT_ID
    );
  });

  return SpaceVisibility.of({
    of,
    viewer,
    subscribeAccessChanges,
    visibleThreadIds,
    hiddenThreadIds,
    visibleProjectIds,
    claimWork,
    workableThreadIds,
    mayUseDirectory,
    mayReadDirectory,
    threadOnHubMachine,
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
    return CurrentViewer.of({
      visibility: yield* visibility.viewer(userId),
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
