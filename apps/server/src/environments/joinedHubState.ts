// Kept apart from the connector so the CLI reads it without loading the server.
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The secret-store entry holding this machine's Environment credential. Never printed. */
export const ENVIRONMENT_CREDENTIAL_SECRET = "environment-credential";

/**
 * A dedicated machine's credential, kept under another name: the host's own server never presents
 * it (only its Sandbox container's does), and a personal-mode server cannot find it.
 */
export const DEDICATED_CREDENTIAL_SECRET = "dedicated-environment-credential";

export const JoinedHubState = Schema.Struct({
  hubUrl: Schema.String,
  /** The Hub that issued the credential; a Hub answering as another one is refused. */
  hubEnvironmentId: EnvironmentId,
  environmentId: EnvironmentId,
  name: Schema.String,
  joinedAt: Schema.String,
  /**
   * `dedicated`: the Owner gave this machine to `spaceId`, and its server runs no work itself but
   * one Sandbox container whose server does (see DedicatedHost). Absent means personal.
   */
  mode: Schema.optionalKey(Schema.Literals(["personal", "dedicated"])),
  spaceId: Schema.optionalKey(Schema.String),
  /**
   * This server runs inside a Sandbox (a Hub's, or a dedicated machine's container), whose host
   * wrote this file with the Space it serves: it says so in its hello and serves nothing else.
   */
  sandboxed: Schema.optionalKey(Schema.Boolean),
  sandboxRuntime: Schema.optionalKey(Schema.Literals(["podman", "process"])),
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
