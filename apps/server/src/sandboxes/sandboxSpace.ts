import { type EnvironmentId, SpaceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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
