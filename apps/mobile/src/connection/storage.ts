import {
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
  setRoutesInCatalog,
  removeCatalogValue,
  replaceCatalogValue,
  Persistence,
} from "@t3tools/client-runtime/platform";
import {
  ConnectionTransientError,
  CredentialStore,
  ProfileStore,
  PullRequestRoutingPermissions,
  makePullRequestRoutingPermissions,
} from "@t3tools/client-runtime/connection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { chooseSavedHub, probeHubDescriptor } from "@t3tools/client-runtime/connection/single-hub";

import * as CatalogStore from "./catalog-store";
import { SINGLE_HUB_REFUSAL, keptSavedConnections } from "./singleHub";

function targetPersistenceError(
  operation:
    | "list-targets"
    | "list-disabled-targets"
    | "register-connection"
    | "set-connection-routes"
    | "remove-connection"
    | "set-connection-enabled",
  error: ConnectionTransientError,
) {
  return new Persistence.ConnectionPersistenceError({
    operation,
    message: error.message,
  });
}

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const catalog = yield* CatalogStore.make();
    const githubRoutingPermissions = yield* makePullRequestRoutingPermissions({
      read: catalog.read.pipe(Effect.map((document) => document.githubRoutingPermissions ?? [])),
      write: (githubRoutingPermissions) =>
        catalog.update((document) => ({ ...document, githubRoutingPermissions })),
    });

    const targetStore = Persistence.ConnectionTargetStore.of({
      // Saved connections past the one Hub this app uses stay saved but are not connected.
      list: catalog.read.pipe(
        Effect.flatMap((document) =>
          Effect.promise(() =>
            chooseSavedHub({
              targets: document.targets,
              profiles: document.profiles,
              slots: 1,
              probe: probeHubDescriptor,
            }),
          ).pipe(
            Effect.tap((chosen) =>
              Effect.sync(() =>
                keptSavedConnections.record({
                  saved: document.targets.length,
                  connected: chosen[0]?.environmentId ?? null,
                }),
              ),
            ),
          ),
        ),
        Effect.mapError((error) => targetPersistenceError("list-targets", error)),
      ),
      listDisabled: catalog.read.pipe(
        Effect.map((document) => document.disabledEnvironmentIds),
        Effect.mapError((error) => targetPersistenceError("list-disabled-targets", error)),
      ),
    });
    const registrationStore = Persistence.ConnectionRegistrationStore.of({
      register: Effect.fn("mobile.connectionStorage.register")(
        function* (registration, routes) {
          const environmentId = registration.target.environmentId;
          const document = yield* catalog.read;
          const alreadySaved = document.targets.some(
            (target) => target.environmentId === environmentId,
          );
          const connected = keptSavedConnections.connected();
          // A route or credential for the one Hub may change; a second Hub may not join it.
          if (!alreadySaved && connected !== null && connected !== environmentId) {
            return yield* new Persistence.ConnectionPersistenceError({
              operation: "register-connection",
              message: SINGLE_HUB_REFUSAL,
            });
          }
          yield* catalog.update((current) =>
            registerConnectionInCatalog(current, registration, routes),
          );
          // The next listing connects it; until then no other Hub may take its place.
          if (connected === null) {
            keptSavedConnections.record({
              saved: document.targets.length + (alreadySaved ? 0 : 1),
              connected: environmentId,
            });
          }
        },
        (effect) =>
          effect.pipe(
            Effect.catchTags({
              ConnectionTransientError: (error) =>
                Effect.fail(targetPersistenceError("register-connection", error)),
            }),
          ),
      ),
      setRoutes: (environmentId, routes) =>
        catalog
          .update((document) => setRoutesInCatalog(document, environmentId, routes))
          .pipe(Effect.mapError((error) => targetPersistenceError("set-connection-routes", error))),
      remove: (environmentId) =>
        catalog
          .update((document) => removeConnectionFromCatalog(document, environmentId))
          .pipe(
            Effect.tap(() => Effect.sync(() => keptSavedConnections.forget(environmentId))),
            Effect.mapError((error) => targetPersistenceError("remove-connection", error)),
          ),
      setEnabled: (environmentId, enabled) =>
        catalog
          .update((document) => setConnectionEnabledInCatalog(document, environmentId, enabled))
          .pipe(
            Effect.mapError((error) => targetPersistenceError("set-connection-enabled", error)),
          ),
    });
    const profileStore = ProfileStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.profiles.find((candidate) => candidate.connectionId === connectionId),
            ),
          ),
        ),
      put: (profile) =>
        catalog.update((document) => ({
          ...document,
          profiles: replaceCatalogValue(document.profiles, (value) => value.connectionId, profile),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          profiles: removeCatalogValue(
            document.profiles,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const credentialStore = CredentialStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.credentials.find((entry) => entry.connectionId === connectionId)?.credential,
            ),
          ),
        ),
      put: (connectionId, credential) =>
        catalog.update((document) => ({
          ...document,
          credentials: replaceCatalogValue(document.credentials, (value) => value.connectionId, {
            connectionId,
            credential,
          }),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          credentials: removeCatalogValue(
            document.credentials,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    return Context.make(Persistence.ConnectionTargetStore, targetStore).pipe(
      Context.add(PullRequestRoutingPermissions, githubRoutingPermissions),
      Context.add(Persistence.ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
    );
  }),
);
