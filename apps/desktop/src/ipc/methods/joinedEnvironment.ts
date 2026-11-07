import { DesktopJoinedEnvironmentStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopJoinedEnvironment from "../../joinedEnvironment/DesktopJoinedEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const Short = Schema.String.check(Schema.isMaxLength(2_048));
const service = DesktopJoinedEnvironment.DesktopJoinedEnvironment;

export const getJoinedEnvironmentState = makeIpcMethod({
  channel: IpcChannels.GET_JOINED_ENVIRONMENT_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopJoinedEnvironmentStateSchema,
  handler: () => service.pipe(Effect.flatMap((joined) => joined.state)),
});

export const joinAsEnvironment = makeIpcMethod({
  channel: IpcChannels.JOIN_AS_ENVIRONMENT_CHANNEL,
  payload: Schema.Struct({ hubUrl: Short, name: Schema.optionalKey(Short) }),
  result: DesktopJoinedEnvironmentStateSchema,
  handler: Effect.fn("desktop.ipc.joinedEnvironment.join")(function* (input) {
    return yield* service.pipe(Effect.flatMap((joined) => joined.join(input)));
  }),
});

export const confirmJoinAsEnvironment = makeIpcMethod({
  channel: IpcChannels.CONFIRM_JOIN_AS_ENVIRONMENT_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopJoinedEnvironmentStateSchema,
  handler: (accept) => service.pipe(Effect.flatMap((joined) => joined.confirmJoin(accept))),
});

export const cancelJoinAsEnvironment = makeIpcMethod({
  channel: IpcChannels.CANCEL_JOIN_AS_ENVIRONMENT_CHANNEL,
  payload: Schema.Void,
  result: DesktopJoinedEnvironmentStateSchema,
  handler: () => service.pipe(Effect.flatMap((joined) => joined.cancelJoin)),
});

export const setJoinedEnvironmentEnabled = makeIpcMethod({
  channel: IpcChannels.SET_JOINED_ENVIRONMENT_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopJoinedEnvironmentStateSchema,
  handler: (enabled) => service.pipe(Effect.flatMap((joined) => joined.setEnabled(enabled))),
});

export const setJoinedEnvironmentKeepRunning = makeIpcMethod({
  channel: IpcChannels.SET_JOINED_ENVIRONMENT_KEEP_RUNNING_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopJoinedEnvironmentStateSchema,
  handler: (keep) => service.pipe(Effect.flatMap((joined) => joined.setKeepRunning(keep))),
});

export const leaveJoinedEnvironment = makeIpcMethod({
  channel: IpcChannels.LEAVE_JOINED_ENVIRONMENT_CHANNEL,
  payload: Schema.Void,
  result: DesktopJoinedEnvironmentStateSchema,
  handler: () => service.pipe(Effect.flatMap((joined) => joined.leave)),
});
