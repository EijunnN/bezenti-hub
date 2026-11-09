import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ScratchThreadPromotion from "./ScratchThreadPromotion.ts";

const scratch = "/hub/scratch";
const folder = `${scratch}/2026-11-09-notes`;
const shell = (id: string, ownerUserId: string | undefined, rootThreadId = id) =>
  ({
    id: ThreadId.make(id),
    projectId: ProjectId.make("scratch"),
    title: id,
    worktreePath: folder,
    deletedAt: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId },
    ...(ownerUserId === undefined ? {} : { ownerUserId: UserId.make(ownerUserId) }),
  }) as never;

const promote = (recording: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const created: Array<string> = [];
    const promotion = yield* ScratchThreadPromotion.ScratchThreadPromotion.pipe(
      Effect.provide(
        ScratchThreadPromotion.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/hub/projects",
                scratchRoot: Effect.succeedSome(scratch),
                isScratchProject: () => Effect.succeed(true),
              }),
              Layer.mock(ProjectService.ProjectService)({
                getById: () => Effect.succeedSome({ workspaceRoot: scratch } as never),
                bootstrap: () =>
                  Effect.sync(() => {
                    created.push(folder);
                    return { project: { id: ProjectId.make("promoted") }, created: true } as never;
                  }),
              }),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadShell: () => Effect.succeed(shell("grace-notes", "grace")),
                readShellSnapshot: () =>
                  Effect.succeed(
                    Effect.succeed({ threads: recording, archivedThreads: [] } as never),
                  ),
                getThreadRecords: () => Effect.succeed({ runs: [], runtimeRequests: [] } as never),
                dispatch: () => Effect.succeed({} as never),
              }),
              Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                moveThreadTasks: () => Effect.void,
              }),
            ),
          ),
        ),
      ),
    );
    const result = yield* promotion
      .promote({ threadId: ThreadId.make("grace-notes") })
      .pipe(Effect.result);
    return { refused: result._tag === "Failure", created };
  });

it.effect("makes no Project of a Scratch folder another User's Thread also records", () =>
  Effect.gen(function* () {
    // Another Member's Thread, and an owner-less Thread from before Users (the Owner's).
    for (const other of [shell("ada-notes", "ada"), shell("legacy-notes", undefined)]) {
      const outcome = yield* promote([shell("grace-notes", "grace"), other]);
      assert.deepEqual(outcome, { refused: true, created: [] });
    }
    // Her own Thread and a child the server made for it are hers alone.
    const own = yield* promote([
      shell("grace-notes", "grace"),
      shell("grace-child", undefined, "grace-notes"),
    ]);
    assert.deepEqual(own.created, [folder]);
  }),
);
