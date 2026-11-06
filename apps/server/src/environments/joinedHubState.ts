// Kept apart from the connector so the CLI reads it without loading the server.
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The secret-store entry holding this machine's Environment credential. Never printed. */
export const ENVIRONMENT_CREDENTIAL_SECRET = "environment-credential";

export const JoinedHubState = Schema.Struct({
  hubUrl: Schema.String,
  /** The Hub that issued the credential; a Hub answering as another one is refused. */
  hubEnvironmentId: EnvironmentId,
  environmentId: EnvironmentId,
  name: Schema.String,
  joinedAt: Schema.String,
});
export type JoinedHubState = typeof JoinedHubState.Type;
const JoinedHubStateJson = Schema.fromJsonString(JoinedHubState);
const decodeState = Schema.decodeEffect(JoinedHubStateJson);
const encodeState = Schema.encodeEffect(JoinedHubStateJson);

export const readJoinedHubState = Effect.fn("JoinedHub.readState")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) {
    return Option.none<JoinedHubState>();
  }
  const text = yield* fs.readFileString(path);
  return Option.some(yield* decodeState(text));
});

export const writeJoinedHubState = Effect.fn("JoinedHub.writeState")(function* (
  path: string,
  state: JoinedHubState,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(path, `${yield* encodeState(state)}\n`, {
    mode: 0o600,
  });
});

export const removeJoinedHubState = Effect.fn("JoinedHub.removeState")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(path, { force: true });
});
