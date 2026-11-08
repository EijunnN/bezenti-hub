import { useAtomValue } from "@effect/atom-react";
import { sessionActsForInstallation } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { fetchSessionState } from "./auth";

const primarySessionStateAtom = Atom.make(
  Effect.suspend(() =>
    isLocalEnvironmentDisabled() ? Effect.succeed(null) : Effect.promise(fetchSessionState),
  ),
).pipe(
  Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
  Atom.setIdleTTL(5 * 60_000),
  Atom.withLabel("primary-environment:session"),
);

function refreshPrimarySessionState(): void {
  appAtomRegistry.refresh(primarySessionStateAtom);
}

export function usePrimarySessionState() {
  const result = useAtomValue(primarySessionStateAtom);
  let error: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error = cause instanceof Error ? cause.message : "Could not read environment session.";
  }
  return {
    data: AsyncResult.getOrElse(result, () => null),
    error,
    isPending: result.waiting,
    refresh: refreshPrimarySessionState,
  };
}

/**
 * Whether this app's session may act on the Installation as a whole (its settings, providers,
 * processes and devices): the Owner's, or one with no accounts at all. Until the session is
 * read it answers yes; the server refuses a Member regardless.
 */
export function usePrimaryActsForInstallation(): boolean {
  const { data } = usePrimarySessionState();
  return data === null || !data.authenticated || sessionActsForInstallation(data);
}
