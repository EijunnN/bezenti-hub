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
import { probeHubDescriptor } from "@t3tools/client-runtime/connection/single-hub";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as MobileSecureStorage from "../persistence/mobile-secure-storage";
import * as CatalogStore from "./catalog-store";
import {
  type KeptConnection,
  type StoredHub,
  decideHub,
  hubState,
  registrationRefusal,
  takeChosenHub,
} from "./singleHub";

/** The Hub this phone connects, decided once (see `decideHub`). */
export const HUB_CHOICE_KEY = "t3code.hub-choice.v1";
const StoredHubJson = Schema.fromJsonString(Schema.Struct({ hub: Schema.NullOr(EnvironmentId) }));
const decodeStoredHub = Schema.decodeUnknownOption(StoredHubJson);
const encodeStoredHub = Schema.encodeSync(StoredHubJson);
/** Probing several saved connections, once, never holds the app's start longer than this. */
const HUB_PROBE_TIMEOUT_MS = 4000;

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

    const secureStorage = yield* MobileSecureStorage.MobileSecureStorage;
    const readStoredHub = secureStorage.getItem(HUB_CHOICE_KEY).pipe(
      Effect.map((raw): StoredHub | undefined =>
        raw === null ? undefined : Option.getOrUndefined(decodeStoredHub(raw)),
      ),
      Effect.orElseSucceed((): StoredHub | undefined => undefined),
    );
    const storeHub = (hub: EnvironmentId | null) =>
      secureStorage
        .setItem(HUB_CHOICE_KEY, encodeStoredHub({ hub }))
        .pipe(Effect.catch((cause) => Effect.logWarning("Could not save the Hub choice.", cause)));
    const keptOf = (
      targets: ReadonlyArray<{
        readonly _tag: string;
        readonly environmentId: EnvironmentId;
        readonly label: string;
        readonly connectionId?: string;
      }>,
      hub: EnvironmentId | null,
    ): ReadonlyArray<KeptConnection> => {
      const kept = new Map<EnvironmentId, KeptConnection>();
      for (const target of targets) {
        if (target.environmentId === hub || kept.has(target.environmentId)) continue;
        if (target.connectionId === undefined) continue;
        kept.set(target.environmentId, {
          environmentId: target.environmentId,
          label: target.label,
          connectionId: target.connectionId,
        });
      }
      return [...kept.values()];
    };

    const targetStore = Persistence.ConnectionTargetStore.of({
      // Only the Hub is connected; other saved connections stay saved, unconnected.
      list: Effect.gen(function* () {
        const document = yield* catalog.read;
        const stored = yield* readStoredHub;
        const decision = yield* Effect.promise(() =>
          decideHub({
            targets: document.targets,
            profiles: document.profiles,
            stored,
            probe: probeHubDescriptor,
            timeoutMs: HUB_PROBE_TIMEOUT_MS,
          }),
        );
        if (decision.persist) yield* storeHub(decision.hub);
        hubState.set({ hub: decision.hub, kept: keptOf(document.targets, decision.hub) });
        return document.targets.filter((target) => target.environmentId === decision.hub);
      }).pipe(Effect.mapError((error) => targetPersistenceError("list-targets", error))),
      listDisabled: catalog.read.pipe(
        Effect.map((document) => document.disabledEnvironmentIds),
        Effect.mapError((error) => targetPersistenceError("list-disabled-targets", error)),
      ),
    });
    const registrationStore = Persistence.ConnectionRegistrationStore.of({
      register: Effect.fn("mobile.connectionStorage.register")(
        function* (registration, routes) {
          const environmentId = registration.target.environmentId;
          const current = hubState.get();
          // «Use as my Hub» names one kept connection; nothing else connects a kept one.
          const chosen = takeChosenHub(environmentId);
          const refusal = registrationRefusal({
            environmentId,
            hub: current.hub,
            kept: current.kept.map((entry) => entry.environmentId).filter((id) => id !== chosen),
          });
          if (refusal !== null) {
            return yield* new Persistence.ConnectionPersistenceError({
              operation: "register-connection",
              message: refusal,
            });
          }
          yield* catalog.update((document) =>
            registerConnectionInCatalog(document, registration, routes),
          );
          if (current.hub === null) {
            yield* storeHub(environmentId);
            hubState.set({
              hub: environmentId,
              kept: current.kept.filter((entry) => entry.environmentId !== environmentId),
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
            // Removing the Hub leaves none: the next one the User adds becomes the Hub, and
            // kept connections never connect on their own.
            Effect.tap(() => {
              const current = hubState.get();
              const kept = current.kept.filter((entry) => entry.environmentId !== environmentId);
              if (current.hub !== environmentId) {
                return Effect.sync(() => hubState.set({ ...current, kept }));
              }
              return storeHub(null).pipe(
                Effect.tap(() => Effect.sync(() => hubState.set({ hub: null, kept }))),
              );
            }),
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
