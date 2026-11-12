import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { errorMessageOf } from "../../lib/errorMessage";

export const SELECT_CLASS = "h-8 w-full rounded-md border border-input bg-background px-2 text-sm";

/** The command's answer, or its error's own message (a Vault's errors name secrets, never values). */
export async function settle<A, E>(pending: Promise<AtomCommandResult<A, E>>): Promise<A> {
  const result = await pending;
  if (result._tag === "Success") return result.value;
  throw new Error(errorMessageOf(squashAtomCommandFailure(result), "That did not work."));
}
