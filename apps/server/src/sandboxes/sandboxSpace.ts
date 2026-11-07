import { type EnvironmentId, SpaceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** The Space a Sandbox's Environment id names, whether or not the Sandbox exists yet. */
export const sandboxSpaceOf = (environmentId: EnvironmentId) =>
  environmentId.startsWith("sandbox:")
    ? SpaceId.make(environmentId.slice("sandbox:".length))
    : undefined;

/** A Thread no longer in the Sandbox's Space (its Project moved): nothing new runs for it there. */
export class SandboxSpaceMismatchError extends Schema.TaggedError<SandboxSpaceMismatchError>()(
  "SandboxSpaceMismatchError",
  { environmentId: Schema.String, threadId: Schema.String },
) {
  override get message(): string {
    return "This Thread is no longer in its Sandbox's Space. Move it to another Environment.";
  }
}

/** The Hub could not read which Space an Environment serves: nothing runs there until it can. */
export class SpaceCheckUnavailableError extends Schema.TaggedError<SpaceCheckUnavailableError>()(
  "SpaceCheckUnavailableError",
  { environmentId: Schema.String, cause: Schema.Defect() },
) {
  readonly retryable = true;
  override get message(): string {
    return "The Hub could not check this Environment's Space. Try again.";
  }
}

/**
 * The Space an Environment serves alone: a Sandbox's, or a dedicated machine's; undefined for
 * one that serves its owner anywhere. A failed read fails, never reads as "no Space".
 */
export const boundSpaceOf = Effect.fn("boundSpaceOf")(function* (environmentId: EnvironmentId) {
  const sandboxSpace = sandboxSpaceOf(environmentId);
  if (sandboxSpace !== undefined) return sandboxSpace;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly spaceId: string }>`
    SELECT space_id AS "spaceId" FROM environments
    WHERE environment_id = ${environmentId} AND mode = 'dedicated' AND space_id IS NOT NULL
  `.pipe(Effect.mapError((cause) => new SpaceCheckUnavailableError({ environmentId, cause })));
  const spaceId = rows[0]?.spaceId;
  return spaceId === undefined ? undefined : SpaceId.make(spaceId);
});
