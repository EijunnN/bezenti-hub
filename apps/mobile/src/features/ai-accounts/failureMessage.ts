import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { Cause } from "effect/Cause";

/** The Hub's own words for a refused or failed command, else the fallback. */
export function commandFailureMessage(
  result: { readonly cause: Cause<unknown> },
  fallback: string,
): string {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
