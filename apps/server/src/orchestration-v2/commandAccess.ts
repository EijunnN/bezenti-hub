import type { OrchestrationV2ServerCommand, ThreadId } from "@t3tools/contracts";

import type * as AccessPolicy from "../auth/AccessPolicy.ts";

export interface ThreadAccess {
  readonly threadId: ThreadId;
  readonly action: AccessPolicy.Action;
}

/**
 * What a command does to which existing Thread, for the Role rules. Anything not named here
 * speaks in or changes the Thread, so only its owner sends it (`thread.continue`). A new
 * Thread's Space and owner are claimed on `thread.create`, not here.
 */
export function threadAccessOf(command: OrchestrationV2ServerCommand): ReadonlyArray<ThreadAccess> {
  const on = (threadId: ThreadId, action: AccessPolicy.Action = "thread.continue") => [
    { threadId, action },
  ];
  switch (command.type) {
    case "thread.create":
    // A guest's own link requests carry no User.
    case "thread.guest-share.redeem":
    case "thread.guest-message.submit":
      return [];
    case "thread.stop":
    case "run.interrupt":
    case "subagent.stop":
    case "thread.interrupt.unresponsive":
    case "thread.background-work.settle":
      return on(command.threadId, "thread.stop");
    case "thread.archive":
    case "thread.unarchive":
      return on(command.threadId, "thread.archive");
    case "thread.delete":
      // Discarding a Thread that never got a message is its owner's cleanup, not a deletion.
      return on(
        command.threadId,
        command.onlyIfUnused === true ? "thread.continue" : "thread.delete",
      );
    case "thread.guest-share.open":
    case "thread.guest-share.close":
    case "thread.guest-message.dismiss":
      return on(command.threadId, "guestLink.create");
    // A fork copies the source's owner, so it is the source owner's to make.
    case "thread.fork":
      return on(command.sourceThreadId);
    case "thread.merge_back":
      return [...on(command.sourceThreadId), ...on(command.targetThreadId)];
    case "delegated_task.request":
    case "delegated_task.wake-policy":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
    case "delegated_task.remote.request":
    case "delegated_task.remote.complete":
    case "delegated_task.remote.stop":
    case "thread.created.record":
      return on(command.parentThreadId);
    default:
      return on(command.threadId);
  }
}
