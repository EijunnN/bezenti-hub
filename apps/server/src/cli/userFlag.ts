import type { UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Flag } from "effect/cli";

import * as UserDirectory from "../auth/UserDirectory.ts";

export class CliUnknownUserError extends Schema.TaggedError<CliUnknownUserError>()(
  "CliUnknownUserError",
  { user: Schema.String },
) {
  override get message(): string {
    return `No active User signs in as "${this.user}". Pass a User's sign-in name or id, or leave out --user to act as the Owner.`;
  }
}

/**
 * The User a token, pairing link or MCP session issued from the Hub's shell acts as. Only someone
 * with the Hub's shell runs these commands, so leaving it out means the Owner.
 */
export const userFlag = Flag.String("user").pipe(
  Flag.withDescription(
    "The User it acts as: their sign-in name or user id. Defaults to the Owner.",
  ),
  Flag.optional,
);

/** The chosen User's id, or undefined for the Owner. */
export const resolveCliUser = Effect.fn("cli.resolveCliUser")(function* (
  user: Option.Option<string>,
): Effect.fn.Return<
  UserId | undefined,
  CliUnknownUserError | UserDirectory.UserDirectoryStorageError,
  UserDirectory.UserDirectory
> {
  if (Option.isNone(user)) return undefined;
  const found = yield* (yield* UserDirectory.UserDirectory).findActiveUserByName(user.value);
  if (Option.isNone(found)) return yield* new CliUnknownUserError({ user: user.value });
  return found.value.id;
});
