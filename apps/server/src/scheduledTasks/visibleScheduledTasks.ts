import type { ScheduledTask, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as SpaceVisibility from "../spaces/SpaceVisibility.ts";

/**
 * The scheduled tasks a User is shown, whichever transport lists them (WS, MCP): only those of
 * Projects they see and Threads not hidden from them, and the webhook address, which starts runs
 * as the task's creator, only on the creator's own tasks (or to the Owner).
 */
export const visibleScheduledTasks = Effect.fn("scheduledTasks.visible")(function* <
  Task extends Pick<ScheduledTask, "projectId" | "threadId" | "ownerUserId" | "webhook">,
>(
  viewer: {
    readonly visibility: SpaceVisibility.Visibility;
    readonly userId: UserId | undefined;
    readonly spaceVisibility: Effect.Effect<SpaceVisibility.SpaceVisibility["Service"]>;
  },
  tasks: ReadonlyArray<Task>,
) {
  if (viewer.visibility.all || tasks.length === 0) return tasks;
  const spaceVisibility = yield* viewer.spaceVisibility;
  const [projects, threads] = yield* Effect.all([
    spaceVisibility.visibleProjectIds(
      viewer.visibility,
      tasks.map((task) => task.projectId),
    ),
    spaceVisibility.hiddenThreadIds(
      viewer.visibility,
      tasks.flatMap((task) => (task.threadId === null ? [] : [task.threadId])),
    ),
  ]);
  return tasks
    .filter(
      (task) =>
        projects.has(task.projectId) && (task.threadId === null || !threads.has(task.threadId)),
    )
    .map((task) => {
      if (task.webhook === undefined || task.ownerUserId === viewer.userId) return task;
      const { webhook: _webhook, ...withoutWebhook } = task;
      return withoutWebhook as Task;
    });
});
