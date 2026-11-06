/**
 * An Organization's lifecycle, which is the Owner's. Archiving hides it from its Members at once
 * and stops what runs in it; restoring brings it back; only an archived one is deleted, with
 * its Projects and Threads (through their own delete paths) and then, in one transaction, its
 * Memberships, Invitations and row.
 */
import {
  CommandId,
  type SpaceDirectoryView,
  type SpaceId,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  LIVE_WORK_FIELDS,
  LIVE_WORK_FILTER,
  threadHasLiveWork,
} from "../orchestration-v2/threadLiveWork.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SpaceDirectory from "./SpaceDirectory.ts";

/** Refused, or the Organization is missing or hidden from the actor (alike). */
export class OrganizationRefusedError extends Schema.TaggedError<OrganizationRefusedError>()(
  "OrganizationRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class OrganizationStorageError extends Schema.TaggedError<OrganizationStorageError>()(
  "OrganizationStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to change the Organization.";
  }
}

type OrganizationError = OrganizationRefusedError | OrganizationStorageError;

export class OrganizationLifecycle extends Context.Service<
  OrganizationLifecycle,
  {
    /** Hides it from its Members, stops its running Threads; scheduled tasks in it skip. */
    readonly archive: (
      actor: UserId,
      spaceId: SpaceId,
    ) => Effect.Effect<SpaceDirectoryView, OrganizationError>;
    readonly restore: (
      actor: UserId,
      spaceId: SpaceId,
    ) => Effect.Effect<SpaceDirectoryView, OrganizationError>;
    /** Only once archived. Retry-safe: a rerun deletes what is left. */
    readonly delete: (
      actor: UserId,
      spaceId: SpaceId,
    ) => Effect.Effect<SpaceDirectoryView, OrganizationError>;
  }
>()("t3/spaces/OrganizationLifecycle") {}

const NOT_FOUND = "That Organization does not exist.";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const storageError = (cause: unknown) => new OrganizationStorageError({ cause });
  const refusal = (error: {
    readonly _tag: string;
    readonly message: string;
  }): OrganizationError => {
    switch (error._tag) {
      case "SpaceAccessDeniedError":
        return new OrganizationRefusedError({ reason: error.message });
      case "SpaceNotFoundError":
      case "SpaceResourceNotFoundError":
        return new OrganizationRefusedError({ reason: NOT_FOUND });
      default:
        return storageError(error);
    }
  };
  const viewOf = (actor: UserId) => spaces.view(actor).pipe(Effect.mapError(storageError));

  // Its Threads, and those of its Projects that carry no Space of their own.
  const threadsIn = (spaceId: SpaceId) =>
    sql<{ readonly threadId: ThreadId }>`
      SELECT t.thread_id AS "threadId" FROM orchestration_v2_projection_threads t
      LEFT JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.deleted_at IS NULL AND COALESCE(t.space_id, p.space_id) = ${spaceId}
    `;

  /** Nothing runs in an archived Organization: what was running is stopped as the archiver. */
  const stopRunning = Effect.fn("OrganizationLifecycle.stopRunning")(function* (spaceId: SpaceId) {
    const at = DateTime.toEpochMillis(yield* DateTime.now);
    for (const { threadId } of yield* threadsIn(spaceId)) {
      // Background commands and delegated tasks outlive a completed turn; Stop ends them too.
      const records = yield* projections.getThreadRecords(
        threadId,
        LIVE_WORK_FIELDS,
        LIVE_WORK_FILTER,
      );
      if (!threadHasLiveWork(records)) continue;
      yield* threads
        .dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`organization-archive:${spaceId}:${at}:${threadId}`),
          threadId,
          reason: "The Organization was archived.",
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not stop a Thread of an archived Organization", {
              threadId,
              cause,
            }),
          ),
        );
    }
  });

  const archive: OrganizationLifecycle["Service"]["archive"] = Effect.fn(
    "OrganizationLifecycle.archive",
  )(function* (actor, spaceId) {
    yield* spaces
      .setOrganizationArchived({ actor, spaceId, archived: true })
      .pipe(Effect.mapError(refusal));
    // Audit (ticket 14): `organization.archive` by `actor` on `spaceId`.
    // Repeated on every archive, so a stop cut short finishes on the next try.
    yield* stopRunning(spaceId).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not stop what runs in an archived Organization", { cause }),
      ),
    );
    // Spec 3 (Sandboxes): stop the Organization's Sandbox here.
    return yield* viewOf(actor);
  });

  const restore: OrganizationLifecycle["Service"]["restore"] = Effect.fn(
    "OrganizationLifecycle.restore",
  )(function* (actor, spaceId) {
    yield* spaces
      .setOrganizationArchived({ actor, spaceId, archived: false })
      .pipe(Effect.mapError(refusal));
    // Audit (ticket 14): `organization.restore` by `actor` on `spaceId`.
    return yield* viewOf(actor);
  });

  const deleteOrganization: OrganizationLifecycle["Service"]["delete"] = Effect.fn(
    "OrganizationLifecycle.delete",
  )(function* (actor, spaceId) {
    // Marked first, in one transaction with the check: once deletion starts it is never restored.
    yield* spaces.beginOrganizationDeletion({ actor, spaceId }).pipe(Effect.mapError(refusal));
    // Event-sourced content first, each through its own delete path; ids are fixed per
    // Organization so a retry replays what already committed.
    yield* projects
      .deleteSpaceContent({ commandId: CommandId.make(`organization-delete:${spaceId}`), spaceId })
      .pipe(Effect.mapError(refusal));
    yield* spaces.removeArchivedOrganization(spaceId).pipe(Effect.mapError(refusal));
    // Audit (ticket 14): `organization.delete` by `actor` on `spaceId`.
    return yield* viewOf(actor);
  });

  return OrganizationLifecycle.of({ archive, restore, delete: deleteOrganization });
});

export const layer = Layer.effect(OrganizationLifecycle, make);
