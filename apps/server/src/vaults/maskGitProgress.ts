/**
 * Spec 5 ticket 05: what a client watches of a Git action (hook output, errors) is masked with the
 * Thread's values, or those of the Threads that run in the checkout. When they cannot be read, hook
 * output is not sent at all; progress phases still are.
 */
import type { GitActionProgressEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as GitManager from "../git/GitManager.ts";
import type * as SecretMasker from "./SecretMasker.ts";

export const maskGitProgress = Effect.fnUntraced(function* (
  masker: Option.Option<SecretMasker.SecretMasker["Service"]>,
  input: { readonly cwd: string; readonly threadId?: ThreadId | undefined },
  options: GitManager.GitRunStackedActionOptions | undefined,
) {
  const reporter = options?.progressReporter;
  if (reporter === undefined || Option.isNone(masker)) return options;
  const found = yield* (
    input.threadId === undefined
      ? masker.value.forCheckout(input.cwd)
      : masker.value.forThread(input.threadId)
  ).pipe(Effect.option);
  return {
    ...options,
    progressReporter: {
      publish: (event: GitActionProgressEvent) =>
        Option.isSome(found)
          ? reporter.publish(found.value.maskDeep(event))
          : event.kind === "hook_output"
            ? Effect.void
            : reporter.publish(event),
    },
  } satisfies GitManager.GitRunStackedActionOptions;
});
