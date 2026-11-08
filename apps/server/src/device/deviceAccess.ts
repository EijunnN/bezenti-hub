import type { DeviceServiceState, ThreadId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as SpaceVisibility from "../spaces/SpaceVisibility.ts";

interface Viewer {
  readonly visibility: SpaceVisibility.Visibility;
  readonly userId: UserId | undefined;
  readonly spaceVisibility: SpaceVisibility.SpaceVisibility["Service"];
}

/**
 * The Hub's devices as one User sees them: the Owner every session; anyone else only those (and
 * the devices booting) of Threads they see, so no other Space's Thread ids show.
 */
export const deviceStateFor = Effect.fn("deviceAccess.stateFor")(function* (
  viewer: Viewer,
  state: DeviceServiceState,
) {
  if (viewer.visibility.all) return state;
  const visible = yield* viewer.spaceVisibility.visibleThreadIds(viewer.visibility, [
    ...state.sessions.map((session) => session.threadId),
    ...(state.bootingDevices ?? []).map((device) => device.threadId),
  ]);
  return {
    ...state,
    sessions: state.sessions.filter((session) => visible.has(session.threadId)),
    ...(state.bootingDevices === undefined
      ? {}
      : { bootingDevices: state.bootingDevices.filter((device) => visible.has(device.threadId)) }),
  };
});

/**
 * Whether the User may watch a device (`control: false`) or drive it (`true`): the Owner any;
 * anyone else one open in a Thread they see, or work for control. `threadId` names that Thread
 * where the caller knows it (the device hub proxy); otherwise any session of the device counts.
 */
export const mayUseDevice = Effect.fn("deviceAccess.mayUseDevice")(function* (
  viewer: Viewer,
  state: DeviceServiceState,
  target: {
    readonly hostId: string | undefined;
    readonly deviceId: string | undefined;
    readonly threadId: string | undefined;
    readonly control: boolean;
  },
) {
  if (viewer.visibility.all) return true;
  const sessions = state.sessions.filter(
    (session) =>
      (target.hostId === undefined || session.hostId === target.hostId) &&
      (target.deviceId === undefined || session.deviceId === target.deviceId) &&
      (target.threadId === undefined || session.threadId === target.threadId),
  );
  if (sessions.length === 0) return false;
  const threadIds = sessions.map((session) => session.threadId as ThreadId);
  const allowed = target.control
    ? yield* viewer.spaceVisibility.workableThreadIds(viewer.visibility, viewer.userId, threadIds)
    : yield* viewer.spaceVisibility.visibleThreadIds(viewer.visibility, threadIds);
  return threadIds.some((threadId) => allowed.has(threadId));
});
