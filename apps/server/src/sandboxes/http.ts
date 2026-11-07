/**
 * The Sandbox base image over HTTP: its status (the image, the build under way or the last one,
 * each Sandbox's version), a build, and moving a running Sandbox to it. Only the Owner, or the
 * Hub's own shell (`t3 sandbox image build`), with the access scope.
 */
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  EnvironmentHttpApi,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as AuditLog from "../audit/AuditLog.ts";
import { SHELL_SESSION_SUBJECT } from "../auth/CommandActor.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as SandboxImage from "./SandboxImage.ts";
import * as Sandboxes from "./Sandboxes.ts";
import { sandboxSpaceOf } from "./sandboxSpace.ts";

const OWNER_ONLY = "Only the Owner manages the Sandbox image.";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "sandboxImage",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const builds = yield* SandboxImage.SandboxImageBuilds;
    const sandboxes = yield* Effect.serviceOption(Sandboxes.Sandboxes);

    /** The Owner (signed in, enabled), or the Hub's shell acting for nobody else. */
    const requireOwner = Effect.fn("environment.sandboxImage.requireOwner")(function* (
      scope: AuthEnvironmentScope,
    ) {
      const principal = yield* requireEnvironmentScope(scope);
      if (principal.subject === SHELL_SESSION_SUBJECT && principal.userId === undefined) {
        return { actor: AuditLog.cliActor, actorUserId: undefined, via: "cli" as const };
      }
      if (principal.userId === undefined) {
        return yield* new EnvironmentHttpForbiddenError({ message: OWNER_ONLY });
      }
      const [row] = yield* sql<{ readonly allowed: number }>`
        SELECT is_owner = 1 AND disabled_at IS NULL AND removed_at IS NULL AS allowed
        FROM users WHERE user_id = ${principal.userId}
      `.pipe(Effect.catch((cause) => failEnvironmentInternal("sandbox_image_failed", cause)));
      if (row?.allowed !== 1) {
        return yield* new EnvironmentHttpForbiddenError({ message: OWNER_ONLY });
      }
      const via =
        principal.subject === SHELL_SESSION_SUBJECT ? ("cli" as const) : ("settings" as const);
      return {
        actor:
          via === "cli"
            ? ({ source: "cli", userId: principal.userId } as const)
            : AuditLog.userActor(principal.userId),
        actorUserId: principal.userId,
        via,
      };
    });

    const status = Effect.gen(function* () {
      const [image, build, cannotBuildReason] = yield* Effect.all(
        [builds.current, builds.lastBuild, builds.builder.cannotBuildReason],
        { concurrency: "unbounded" },
      );
      const rows = Option.isNone(sandboxes)
        ? []
        : yield* sandboxes.value.listImages.pipe(
            Effect.catch((cause) => failEnvironmentInternal("sandbox_image_failed", cause)),
          );
      return {
        canBuild: cannotBuildReason === null,
        cannotBuildReason,
        runsPodmanSandboxes: Option.isSome(sandboxes) && sandboxes.value.runtimeKind === "podman",
        image,
        build,
        sandboxes: rows.map((row) => ({
          environmentId: row.environmentId,
          spaceId: row.spaceId,
          name: row.name,
          status: row.status,
          imageVersion: row.imageVersion,
          busy: row.busy,
        })),
      };
    });

    return handlers
      .handle(
        "status",
        Effect.fn("environment.sandboxImage.status")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireOwner(AuthAccessReadScope);
          return yield* status;
        }),
      )
      .handle(
        "build",
        Effect.fn("environment.sandboxImage.build")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const owner = yield* requireOwner(AuthAccessWriteScope);
          yield* builds.start({ actor: owner.actor, via: owner.via }).pipe(
            Effect.catchTags({
              SandboxImageBuildInProgressError: (error) =>
                Effect.fail(new EnvironmentHttpConflictError({ message: error.message })),
            }),
          );
          return yield* status;
        }),
      )
      .handle(
        "update",
        Effect.fn("environment.sandboxImage.update")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const owner = yield* requireOwner(AuthAccessWriteScope);
          const spaceId = sandboxSpaceOf(args.payload.environmentId);
          if (spaceId === undefined || Option.isNone(sandboxes)) {
            return yield* failEnvironmentNotFound("environment_not_found");
          }
          return yield* sandboxes.value
            .updateImage({ spaceId, actorUserId: owner.actorUserId, actor: owner.actor })
            .pipe(
              Effect.catchTags({
                SandboxImageUpdateRefusedError: (error) =>
                  error.kind === "missing"
                    ? failEnvironmentNotFound("environment_not_found")
                    : Effect.fail(new EnvironmentHttpConflictError({ message: error.detail })),
                SandboxStartError: (error) =>
                  Effect.fail(new EnvironmentHttpConflictError({ message: error.message })),
              }),
            );
        }),
      );
  }),
);
