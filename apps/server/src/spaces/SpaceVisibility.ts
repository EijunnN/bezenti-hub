/**
 * Which Projects and Threads a principal may see: every read of them asks this module. A User
 * sees the Spaces the policy lets them view (`space.view`); the Owner sees everything. A Thread
 * is in its own Space, else its Project's; with neither it is the Owner's Personal space.
 */
import {
  EnvironmentAuthenticatedPrincipal,
  ProjectId,
  type SpaceId,
  ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SpaceDirectory from "./SpaceDirectory.ts";

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export type Visibility =
  /** The Owner, and sessions from before an Owner existed. */
  { readonly all: true } | { readonly all: false; readonly spaceIds: ReadonlyArray<SpaceId> };

export const everything: Visibility = { all: true };

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
  }
>()("t3/spaces/SpaceVisibility") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;

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

  return SpaceVisibility.of({
    of,
    viewer,
    visibleThreadIds,
    hiddenThreadIds,
    visibleProjectIds,
  });
});

export const layer = Layer.effect(SpaceVisibility, make);

/** What the current connection or request may see. */
export class CurrentViewer extends Context.Service<
  CurrentViewer,
  { readonly visibility: Effect.Effect<Visibility> }
>()("t3/spaces/SpaceVisibility/CurrentViewer") {}

/** One viewer per connection, for the principal of that connection. */
export const layerCurrentViewer = Layer.effect(
  CurrentViewer,
  Effect.gen(function* () {
    const principal = yield* EnvironmentAuthenticatedPrincipal;
    const visibility = yield* SpaceVisibility;
    return CurrentViewer.of({ visibility: yield* visibility.viewer(principal.userId) });
  }),
);

/** Sees everything: for tests and in-process callers that act as the Owner. */
export const layerCurrentViewerOwner = Layer.succeed(
  CurrentViewer,
  CurrentViewer.of({ visibility: Effect.succeed(everything) }),
);
