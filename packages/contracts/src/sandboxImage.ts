import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, NonNegativeInt, SpaceId } from "./baseSchemas.ts";

/**
 * The base image every Sandbox runs (docs/internals/sandboxes.md, «Base image»): the tag Sandboxes
 * start from and the version of the image it names now.
 */
export const SandboxImageInfo = Schema.Struct({
  /** `localhost/t3code-sandbox:<Hub version>` unless `T3CODE_SANDBOX_IMAGE` names another. */
  image: Schema.String,
  /** `<Hub version>-<UTC build time>`; null when it is not built, or not one the Hub built. */
  version: Schema.NullOr(Schema.String),
  builtAt: Schema.NullOr(IsoDateTime),
});
export type SandboxImageInfo = typeof SandboxImageInfo.Type;

export const SandboxImageBuildState = Schema.Literals(["idle", "building", "succeeded", "failed"]);
export type SandboxImageBuildState = typeof SandboxImageBuildState.Type;

/** The Hub's last (or current) build: one at a time. */
export const SandboxImageBuild = Schema.Struct({
  state: SandboxImageBuildState,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  /** Why it failed. */
  error: Schema.NullOr(Schema.String),
  /** Its output's lines after the `after` asked for (of the last ones the Hub keeps). */
  log: Schema.Array(Schema.String),
  /** How many lines it printed in all: the `after` to ask with next. */
  logLines: NonNegativeInt,
});
export type SandboxImageBuild = typeof SandboxImageBuild.Type;

/** A Sandbox and the image version it last started with. */
export const SandboxImageSandbox = Schema.Struct({
  environmentId: EnvironmentId,
  spaceId: SpaceId,
  name: Schema.String,
  status: Schema.Literals(["stopped", "starting", "running", "failed"]),
  /** Null before its first start, or when its runtime runs no image (the process runtime). */
  imageVersion: Schema.NullOr(Schema.String),
  /** A turn is in progress on it, or work was just sent to it: updating it now is refused. */
  busy: Schema.Boolean,
});
export type SandboxImageSandbox = typeof SandboxImageSandbox.Type;

/** What the Owner sees: the image, its build and each Sandbox's version. */
export const SandboxImageStatus = Schema.Struct({
  /** Whether rootless Podman is here to build it; why not otherwise. */
  canBuild: Schema.Boolean,
  cannotBuildReason: Schema.NullOr(Schema.String),
  /**
   * Whether this Hub runs its Sandboxes in Podman now. A Hub that started before the image was
   * built offers none until it restarts.
   */
  runsPodmanSandboxes: Schema.Boolean,
  image: SandboxImageInfo,
  build: SandboxImageBuild,
  sandboxes: Schema.Array(SandboxImageSandbox),
});
export type SandboxImageStatus = typeof SandboxImageStatus.Type;

/** `after`: the `logLines` a client already has, so only newer lines come back. */
export const SandboxImageStatusQuery = Schema.Struct({
  after: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
});
export type SandboxImageStatusQuery = typeof SandboxImageStatusQuery.Type;

/** A running Sandbox moves to the newest image, never mid-turn. */
export const UpdateSandboxImageRequest = Schema.Struct({ environmentId: EnvironmentId });
export type UpdateSandboxImageRequest = typeof UpdateSandboxImageRequest.Type;

export const UpdateSandboxImageResult = Schema.Struct({
  /**
   * `updated`: it restarted on the newest image. `next-start`: it is not running, and its next
   * start uses the newest image. `up-to-date`: it already runs it.
   */
  outcome: Schema.Literals(["updated", "next-start", "up-to-date"]),
  imageVersion: Schema.NullOr(Schema.String),
});
export type UpdateSandboxImageResult = typeof UpdateSandboxImageResult.Type;
