import {
  clientRpcRequiredScopes,
  sessionGrantsScope,
  authScopeRequiredResponse,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type AuthSessionState,
  type AuthEnvironmentScope,
  INSTALLATION_OWNER_ONLY_MESSAGE,
  isInstallationRpcMethod,
  sessionActsForInstallation,
  SpaceActionDeniedError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

function makeCommandPermissions<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  method: string,
) {
  const sessions = createEnvironmentSessionAtoms(runtime);
  const requiredScopes = (input?: unknown) => clientRpcRequiredScopes(method, input);
  // The Installation as a whole is its Owner's, whatever the session's scopes (the server checks too).
  const ownerOnly = isInstallationRpcMethod(method);
  const atomsByEnvironment = Atom.family((environmentId: EnvironmentId | null) =>
    Atom.family((scopeKey: string) =>
      Atom.make((get) => {
        if (environmentId === null) return false;
        const scopes = scopeKey.split(",").filter(Boolean) as AuthEnvironmentScope[];
        if (scopes.length === 0 && !ownerOnly) return true;
        const result = get(sessions.sessionStateAtom(environmentId));
        const session = AsyncResult.getOrElse(result, () => null);
        return (
          result._tag !== "Failure" &&
          session !== null &&
          (!ownerOnly || sessionActsForInstallation(session)) &&
          scopes.every((scope) => sessionGrantsScope(session, scope))
        );
      }),
    ),
  );
  const permissionAtom = (environmentId: EnvironmentId | null, input?: unknown) =>
    atomsByEnvironment(environmentId)(requiredScopes(input).join(","));
  const authorize = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    input?: unknown,
  ) =>
    Effect.suspend(() => {
      const scopes = requiredScopes(input);
      if (scopes.length === 0 && !ownerOnly) return Effect.void;
      const atom = sessions.sessionStateAtom(environmentId);
      return Effect.scoped(
        Effect.gen(function* () {
          yield* AtomRegistry.mount(registry, atom);
          const session = yield* AtomRegistry.getResult(registry, atom, {
            suspendOnWaiting: false,
          }).pipe(
            Effect.timeoutOption(6_000),
            Effect.orElseSucceed(() => Option.none<AuthSessionState>()),
          );
          const missing = scopes.find(
            (scope) => Option.isNone(session) || !sessionGrantsScope(session.value, scope),
          );
          if (missing !== undefined)
            return yield* new EnvironmentAuthorizationError({
              ...authScopeRequiredResponse(missing),
              message: `This connection requires ${missing}.`,
            });
          if (ownerOnly && Option.isSome(session) && !sessionActsForInstallation(session.value))
            return yield* new SpaceActionDeniedError({ message: INSTALLATION_OWNER_ONLY_MESSAGE });
        }),
      );
    });
  return { requiredScopes, permissionAtom, authorize };
}

const permissionsByRuntime = new WeakMap<
  object,
  Map<string, ReturnType<typeof makeCommandPermissions>>
>();

export function createCommandPermissions<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  method: string,
) {
  let permissions = permissionsByRuntime.get(runtime);
  if (permissions === undefined) {
    permissions = new Map();
    permissionsByRuntime.set(runtime, permissions);
  }
  const existing = permissions.get(method);
  if (existing !== undefined) return existing;
  const created = makeCommandPermissions(runtime, method);
  permissions.set(method, created);
  return created;
}
