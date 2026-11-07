/**
 * The refusal ProviderSessionManager gives a turn whose session is released while it starts, and
 * that RunExecutionService recognises. A leaf module: RunExecutionService is reached from
 * ProviderSessionManager's own imports, so it cannot import the error from there.
 */
import * as Schema from "effect/Schema";

/** The refusal when a turn's session is released while it starts (its machine lost it). */
export class ProviderSessionReleasedDuringStartError extends Schema.TaggedError<ProviderSessionReleasedDuringStartError>()(
  "ProviderSessionReleasedDuringStartError",
  {},
) {
  override get message(): string {
    return "The provider session was released while the turn started.";
  }
}
