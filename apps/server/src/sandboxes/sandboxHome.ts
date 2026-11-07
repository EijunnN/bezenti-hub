/**
 * A Sandbox's home as every runtime lays it out: the joined server's base dir, with its
 * Environment credential and its Hub, as `t3 join` leaves a machine. See
 * docs/internals/sandboxes.md.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

import * as ServerConfig from "../config.ts";
import {
  ENVIRONMENT_CREDENTIAL_SECRET,
  readJoinedHubState,
  writeJoinedHubState,
} from "../environments/joinedHubState.ts";
import type { SandboxSpec } from "./SandboxRuntime.ts";

/** Its server's paths, as `t3 serve --base-dir <home>` derives them. */
export const sandboxServerPaths = (homePath: string) =>
  ServerConfig.deriveServerPaths(homePath, undefined, { baseDirIsExplicit: true });

/**
 * Makes the home (only its owner may enter it) and puts the credential and Hub in it; an existing
 * home keeps its files and gets the new credential and Hub.
 */
export const writeSandboxHome = Effect.fn("writeSandboxHome")(function* (input: {
  readonly rootDir: string;
  readonly homePath: string;
  readonly spec: SandboxSpec;
  /** The Hub as the Sandbox's server reaches it. */
  readonly hubUrl: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* sandboxServerPaths(input.homePath);
  yield* fs.makeDirectory(input.rootDir, { recursive: true, mode: 0o700 });
  yield* fs.makeDirectory(paths.secretsDir, { recursive: true, mode: 0o700 });
  yield* fs.chmod(input.homePath, 0o700);
  const credentialPath = path.join(paths.secretsDir, `${ENVIRONMENT_CREDENTIAL_SECRET}.bin`);
  yield* fs.writeFileString(credentialPath, Redacted.value(input.spec.credential), {
    mode: 0o600,
  });
  yield* fs.chmod(credentialPath, 0o600);
  yield* writeJoinedHubState(paths.joinedHubPath, {
    hubUrl: input.hubUrl,
    hubEnvironmentId: input.spec.hubEnvironmentId,
    environmentId: input.spec.environmentId,
    name: input.spec.name,
    joinedAt: DateTime.formatIso(yield* DateTime.now),
    sandboxed: true,
  });
});

/**
 * Points the home's server at `hubUrl` before it starts (a dev Hub can come back on another port,
 * a home can move between runtimes). Fails when the home has no Hub: it was never created.
 */
export const pointSandboxHomeAt = Effect.fn("pointSandboxHomeAt")(function* (
  homePath: string,
  hubUrl: string,
) {
  const paths = yield* sandboxServerPaths(homePath);
  const joined = yield* readJoinedHubState(paths.joinedHubPath);
  if (Option.isNone(joined)) return yield* Effect.fail("its home has no Hub; create it first.");
  if (joined.value.hubUrl !== hubUrl) {
    yield* writeJoinedHubState(paths.joinedHubPath, { ...joined.value, hubUrl });
  }
});
