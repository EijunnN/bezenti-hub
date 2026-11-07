import * as Dialog from "../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { useConnectionController } from "../features/connection/useConnectionController";
import { environmentPresentations } from "./presentation";
import { useWorkspaceConnectionState, useWorkspaceEnvironments } from "./workspace";
import type { SavedRemoteConnection } from "../lib/connection";
import { appAtomRegistry } from "./atom-registry";
import type { ConnectedEnvironmentSummary, EnvironmentRuntimeState } from "./remote-runtime-types";
import { environmentSession } from "./session";
import { environmentCatalog } from "../connection/catalog";
import { createRemoteEnvironmentProjectionAtoms } from "./remote-environment-projections";
import { serverEnvironment } from "./server";
import {
  connectAppSignIn as connectAppSignInCommand,
  connectPairingUrl as connectPairingUrlCommand,
} from "../connection/onboarding";
import { signInToHubInBrowser } from "../features/connection/hubSignIn";
import { hubState } from "../connection/singleHub";

const pendingConnectionErrorAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:pending-connection-error"),
);

export function setPendingConnectionError(message: string | null): void {
  appAtomRegistry.set(pendingConnectionErrorAtom, message);
}

export interface PairingOutcome {
  readonly ok: boolean;
  /** Shown beside the pairing form; null when the failure got its own dialog. */
  readonly error: string | null;
}

/**
 * Pairs with the Hub behind a pairing link and saves it. Only a development build's dev link and
 * the showcase capture pair; people sign in to their Hub in the browser.
 */
export async function pairEnvironment(
  pairingUrl: string,
  expectedEnvironmentId?: EnvironmentId,
): Promise<PairingOutcome> {
  const result = await runAtomCommand(
    appAtomRegistry,
    connectPairingUrlCommand,
    { pairingUrl, ...(expectedEnvironmentId === undefined ? {} : { expectedEnvironmentId }) },
    { reportFailure: false },
  );
  if (AsyncResult.isSuccess(result)) return { ok: true, error: null };
  return pairingFailure(Cause.squash(result.cause), "Failed to pair with the environment.");
}

function pairingFailure(error: unknown, fallback: string): PairingOutcome {
  const message = error instanceof Error ? error.message : fallback;
  if (
    error !== null &&
    typeof error === "object" &&
    "reason" in error &&
    error.reason === "unsupported"
  ) {
    Dialog.alert("Client not supported", message);
    return { ok: false, error: null };
  }
  return { ok: false, error: message };
}

/**
 * Adds a Hub by its address: signs in in the system browser, then saves the Hub with the session
 * the one-time code exchanges for. A cancelled sign-in is not an error.
 */
export async function signInToHub(
  hubAddress: string,
  expectedEnvironmentId?: EnvironmentId,
): Promise<PairingOutcome & { readonly cancelled?: boolean }> {
  let outcome: Awaited<ReturnType<typeof signInToHubInBrowser>>;
  try {
    outcome = await signInToHubInBrowser(hubAddress);
  } catch (error) {
    return pairingFailure(error, "Could not open the Hub's sign-in.");
  }
  if (outcome._tag === "cancelled") return { ok: false, error: null, cancelled: true };
  const result = await runAtomCommand(
    appAtomRegistry,
    connectAppSignInCommand,
    {
      hubUrl: outcome.hubUrl,
      code: outcome.code,
      codeVerifier: outcome.codeVerifier,
      redirectUri: outcome.redirectUri,
      ...(expectedEnvironmentId === undefined ? {} : { expectedEnvironmentId }),
    },
    { reportFailure: false },
  );
  return AsyncResult.isSuccess(result)
    ? { ok: true, error: null }
    : pairingFailure(Cause.squash(result.cause), "Could not add the Hub.");
}

const remoteEnvironmentProjections = createRemoteEnvironmentProjectionAtoms({
  presentationAtom: environmentPresentations.presentationAtom,
  preparedConnectionAtom: environmentSession.preparedConnectionValueAtom,
  serverConfigAtom: serverEnvironment.configValueAtom,
});

export const environmentConnectedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(remoteEnvironmentProjections.runtimeStateAtom(environmentId))?.connectionState ===
      "connected",
  ).pipe(Atom.withLabel(`mobile:environment-connected:${environmentId}`)),
);

const EMPTY_SAVED_CONNECTION_ATOM = Atom.make<SavedRemoteConnection | null>(null).pipe(
  Atom.withLabel("mobile:saved-connection:empty"),
);

const EMPTY_RUNTIME_STATE_ATOM = Atom.make<EnvironmentRuntimeState | null>(null).pipe(
  Atom.withLabel("mobile:environment-runtime-state:empty"),
);

const savedConnectionsByIdAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  return Object.fromEntries(
    [...catalog.entries.keys()].flatMap((environmentId) => {
      const connection = get(remoteEnvironmentProjections.savedConnectionAtom(environmentId));
      return connection === null ? [] : [[environmentId, connection]];
    }),
  ) as Record<EnvironmentId, SavedRemoteConnection>;
}).pipe(Atom.withLabel("mobile:saved-connections-by-id"));

/**
 * The Hub this phone connects: its one connection. Older saved connections stay saved but are
 * not listed, so the catalog holds at most this one.
 */
const storedHubIdAtom = Atom.make((get) => {
  get.addFinalizer(hubState.subscribe(() => get.setSelf(hubState.get().hub)));
  return hubState.get().hub;
}).pipe(Atom.withLabel("mobile:stored-hub-id"));

export const hubConnectionAtom = Atom.make((get) => {
  const hub = get(storedHubIdAtom);
  return hub === null ? null : (get(savedConnectionsByIdAtom)[hub] ?? null);
}).pipe(Atom.withLabel("mobile:hub-connection"));

export function useHubConnection(): SavedRemoteConnection | null {
  return useAtomValue(hubConnectionAtom);
}

export function useSavedRemoteConnections() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const savedConnectionsById = useAtomValue(savedConnectionsByIdAtom);

  return {
    isLoadingSavedConnection: !catalog.isReady,
    savedConnectionsById,
  };
}

export function useSavedRemoteConnection(
  environmentId: EnvironmentId | null,
): SavedRemoteConnection | null {
  return useAtomValue(
    environmentId === null
      ? EMPTY_SAVED_CONNECTION_ATOM
      : remoteEnvironmentProjections.savedConnectionAtom(environmentId),
  );
}

export function useRemoteEnvironmentRuntime(
  environmentId: EnvironmentId | null,
): EnvironmentRuntimeState | null {
  return useAtomValue(
    environmentId === null
      ? EMPTY_RUNTIME_STATE_ATOM
      : remoteEnvironmentProjections.runtimeStateAtom(environmentId),
  );
}

export function useRemoteConnectionStatus() {
  const state = useWorkspaceConnectionState();
  const connectedEnvironments: ReadonlyArray<ConnectedEnvironmentSummary> =
    useWorkspaceEnvironments();
  const pendingConnectionError = useAtomValue(pendingConnectionErrorAtom);

  return {
    connectedEnvironments,
    connectionState: state.connectionState,
    connectionError: pendingConnectionError ?? state.connectionError,
  };
}

export function useRemoteConnections() {
  const controller = useConnectionController();
  const { connectedEnvironments, connectionError, connectionState } = useRemoteConnectionStatus();

  const onReconnectEnvironment = (environmentId: EnvironmentId) =>
    controller.retryEnvironment(environmentId);
  const onSetEnvironmentEnabled = (environmentId: EnvironmentId, enabled: boolean) =>
    controller.setEnvironmentEnabled(environmentId, enabled);
  const onUpdateEnvironment = (
    environmentId: EnvironmentId,
    updates: { readonly label: string; readonly displayUrl: string },
  ) => controller.updateEnvironment(environmentId, updates);

  const onRemoveEnvironmentPress = (environmentId: EnvironmentId) => {
    const environment = connectedEnvironments.find(
      (candidate) => candidate.environmentId === environmentId,
    );
    if (!environment) {
      return;
    }
    const remove = {
      text: "Remove",
      style: "destructive",
      onPress: () => {
        void controller.removeEnvironment(environmentId);
      },
    } as const;
    Dialog.alert(
      "Remove from this device?",
      `Sign out of ${environment.environmentLabel} and forget its cached threads on this device. Switch it off instead to keep it saved.`,
      [{ text: "Cancel", style: "cancel" }, remove],
    );
  };

  return {
    connectionState,
    connectionError,
    connectedEnvironments,
    connectedEnvironmentCount: connectedEnvironments.length,
    onReconnectEnvironment,
    onSetEnvironmentEnabled,
    onUpdateEnvironment,
    onRemoveEnvironmentPress,
  };
}
