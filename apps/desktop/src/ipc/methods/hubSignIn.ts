import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { cancelHubSignIn, receiveHubSignIn } from "../../app/HubSignInCallback.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

class HubSignInError extends Schema.TaggedError<HubSignInError>()("HubSignInError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

const Short = Schema.String.check(Schema.isMaxLength(2_048));

/** Opens the Hub's sign-in page in the system browser and waits for its one-time code. */
export const signInToHub = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SIGN_IN_TO_HUB_CHANNEL,
  payload: Schema.Struct({
    hubUrl: Short,
    codeChallenge: Short,
    state: Short,
    clientLabel: Schema.optionalKey(Short),
  }),
  result: Schema.Struct({ code: Schema.String, redirectUri: Schema.String }),
  handler: Effect.fn("desktop.ipc.hubSignIn.receive")(function* (request) {
    const shell = yield* ElectronShell.ElectronShell;
    const windows = yield* ElectronWindow.ElectronWindow;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<ElectronShell.ElectronShell>());
    const received = yield* Effect.tryPromise({
      try: () => receiveHubSignIn(request, (url) => runPromise(shell.openExternal(url))),
      catch: (cause) =>
        new HubSignInError({
          detail: cause instanceof Error ? cause.message : "Could not sign in to the Hub.",
        }),
    });
    const window = yield* windows.currentMainOrFirst;
    if (Option.isSome(window)) yield* windows.reveal(window.value);
    return received;
  }),
});

export const cancelSignInToHub = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CANCEL_SIGN_IN_TO_HUB_CHANNEL,
  payload: Short,
  result: Schema.Void,
  handler: (state) => Effect.sync(() => cancelHubSignIn(state)),
});
