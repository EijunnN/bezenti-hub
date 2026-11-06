import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { parseAttachmentFileExtension, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["terminal", "preview", "attachment", "scheduled-tasks"]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupScheduledTasks: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupPreviews: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupScheduledTasks: () => Effect.void,
    cleanupTerminals: () => Effect.void,
    cleanupPreviews: () => Effect.void,
    cleanupAttachments: () => Effect.void,
  }),
}) {}

/**
 * Runs `close` on the Thread's machine when it is a joined Environment. Offline, it fails, so the
 * effect stays pending until the machine is back instead of reporting the cleanup done.
 */
export const onThreadMachine = Effect.fn("ResourceCleanupService.onThreadMachine")(function* (
  registry: EnvironmentExecutor.EnvironmentExecutorRegistryShape,
  threadId: string,
  close: (forward: EnvironmentExecutor.EnvironmentWorkspaceForward) => Effect.Effect<void, unknown>,
) {
  const environmentId = yield* registry.activeEnvironment(ThreadId.make(threadId));
  // On the Hub machine the local close already ran; a removed machine has nothing left to close.
  if (
    environmentId === registry.hubMachineEnvironmentId ||
    environmentId === EnvironmentExecutor.NO_ENVIRONMENT_ID
  ) {
    return;
  }
  const executor = yield* registry.get(environmentId);
  if (Option.isSome(executor.workspace.forward)) yield* close(executor.workspace.forward.value);
});

export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const previews = yield* PreviewManager.PreviewManager;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const executors = yield* Effect.serviceOption(EnvironmentExecutor.EnvironmentExecutorRegistry);
    // A Thread on a joined Environment keeps its terminals and previews there; the effect runs
    // while it is online.
    const onRemote = (
      threadId: string,
      close: (
        forward: EnvironmentExecutor.EnvironmentWorkspaceForward,
      ) => Effect.Effect<void, unknown>,
    ) =>
      Option.match(executors, {
        onNone: () => Effect.void,
        onSome: (registry) => onThreadMachine(registry, threadId, close),
      });
    return {
      cleanupScheduledTasks: Effect.fn("ResourceCleanupService.cleanupScheduledTasks")(function (
        threadId: ThreadId,
      ) {
        return scheduledTasks
          .deleteForThread(threadId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ResourceCleanupError({ operation: "scheduled-tasks", threadId, cause }),
            ),
          );
      }),
      cleanupTerminals: Effect.fn("ResourceCleanupService.cleanupTerminals")(function (
        threadId: string,
      ) {
        return terminals.close({ threadId, deleteHistory: true }).pipe(
          Effect.andThen(
            onRemote(threadId, (forward) =>
              forward.call("terminal.close", { threadId, deleteHistory: true }),
            ),
          ),
          Effect.mapError(
            (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
          ),
        );
      }),
      cleanupPreviews: Effect.fn("ResourceCleanupService.cleanupPreviews")(function (
        threadId: string,
      ) {
        return previews.close({ threadId: ThreadId.make(threadId) }).pipe(
          Effect.andThen(
            onRemote(threadId, (forward) =>
              forward.call("preview.close", { threadId: ThreadId.make(threadId) }),
            ),
          ),
          Effect.mapError(
            (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
          ),
        );
      }),
      cleanupAttachments: Effect.fn("ResourceCleanupService.cleanupAttachments")(function (
        attachmentIds: ReadonlyArray<string>,
      ) {
        return Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const extension = parseAttachmentFileExtension(attachmentId);
            const path =
              resolveAttachmentPathById({
                attachmentsDir: config.attachmentsDir,
                attachmentId,
              }) ??
              (extension
                ? resolveAttachmentRelativePath({
                    attachmentsDir: config.attachmentsDir,
                    relativePath: `${attachmentId}.${extension}`,
                  })
                : null);
            return path === null
              ? Effect.void
              : fileSystem.remove(path, { force: true }).pipe(
                  Effect.andThen(fileSystem.remove(`${path}.txt`, { force: true })),
                  Effect.mapError(
                    (cause) =>
                      new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                  ),
                );
          },
          { discard: true, concurrency: 4 },
        );
      }),
    };
  }),
);
