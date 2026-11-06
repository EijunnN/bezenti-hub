import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.PairingConnectionInput) => JSON.stringify(input),
  },
  execute: (input: ConnectionOnboarding.PairingConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: ConnectionOnboarding.SshConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerSsh(input)),
    ),
});

/** Saves a Hub the User signed in to in the system browser (the desktop app's "Add a Hub"). */
export const connectAppSignIn = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-app-sign-in",
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
  label: "web:connection:sign-out-and-remove",
  scheduler: onboardingScheduler,
  concurrency: { mode: "serial", key: (environmentId: EnvironmentId) => environmentId },
  execute: (environmentId: EnvironmentId) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.signOutAndRemove(environmentId)),
    ),
});
