import {
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionOnboarding,
  CredentialStore,
  EnvironmentRegistry,
  ProfileStore,
} from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type KeptConnection, chooseKeptAsHub } from "./singleHub";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairingUrl = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:connect-pairing-url",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    // The same link used for another machine needs its own expected-machine check.
    key: (input: { readonly pairingUrl: string; readonly expectedEnvironmentId?: EnvironmentId }) =>
      JSON.stringify([input.pairingUrl, input.expectedEnvironmentId ?? null]),
  },
  execute: (input: {
    readonly pairingUrl: string;
    readonly expectedEnvironmentId?: EnvironmentId;
  }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

export const updateBearerConnection = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:update-bearer",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly environmentId: EnvironmentId }) => input.environmentId,
  },
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly httpBaseUrl: string;
  }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.updateBearer(input)),
    ),
});

/** Saves a Hub the User signed in to in the system browser. */
export const connectAppSignIn = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:connect-app-sign-in",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.AppSignInConnectionInput) => input.code,
  },
  execute: (input: ConnectionOnboarding.AppSignInConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerAppSignIn(input)),
    ),
});

/** Forgets an environment after ending its saved session there, so removing a Hub signs out of it. */
export const signOutAndRemoveEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:sign-out-and-remove",
  scheduler: onboardingScheduler,
  concurrency: { mode: "serial", key: (environmentId: EnvironmentId) => environmentId },
  execute: (environmentId: EnvironmentId) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.signOutAndRemove(environmentId)),
    ),
});

/** Forgets a kept connection: its saved address, profile and token leave the phone. */
export const removeKeptConnection = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:remove-kept",
  scheduler: onboardingScheduler,
  concurrency: { mode: "serial", key: (environmentId: EnvironmentId) => environmentId },
  execute: (environmentId: EnvironmentId) =>
    Persistence.ConnectionRegistrationStore.pipe(
      Effect.flatMap((store) => store.remove(environmentId)),
    ),
});

/** «Use as my Hub»: the User makes a kept connection their Hub, and the app connects it. */
export const chooseKeptConnectionAsHub = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:use-kept-as-hub",
  scheduler: onboardingScheduler,
  concurrency: { mode: "singleFlight", key: () => "use-kept-as-hub" },
  execute: Effect.fn("mobile.connection.chooseKeptConnectionAsHub")(function* (
    kept: KeptConnection,
  ) {
    const profile = yield* ProfileStore.ConnectionProfileStore.pipe(
      Effect.flatMap((store) => store.get(kept.connectionId)),
    );
    const credential = yield* CredentialStore.ConnectionCredentialStore.pipe(
      Effect.flatMap((store) => store.get(kept.connectionId)),
    );
    if (
      Option.isNone(profile) ||
      profile.value._tag !== "BearerConnectionProfile" ||
      Option.isNone(credential) ||
      credential.value._tag !== "BearerConnectionCredential"
    ) {
      return yield* new Persistence.ConnectionPersistenceError({
        operation: "register-connection",
        message: "This saved connection has no sign-in left. Remove it and add the Hub again.",
      });
    }
    chooseKeptAsHub(kept.environmentId);
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* registry.register(
      new BearerConnectionRegistration({
        target: new BearerConnectionTarget({
          environmentId: kept.environmentId,
          label: kept.label,
          connectionId: kept.connectionId,
        }),
        profile: profile.value,
        credential: credential.value,
      }),
    );
  }),
});
