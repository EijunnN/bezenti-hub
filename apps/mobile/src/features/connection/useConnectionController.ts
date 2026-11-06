import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "../../connection/catalog";
import {
  connectPairingUrl as connectPairingUrlAtom,
  signOutAndRemoveEnvironment,
  updateBearerConnection,
} from "../../connection/onboarding";
import { forgetSpaces } from "../../state/spaces";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useAtomCommand } from "../../state/use-atom-command";

export function useConnectionController() {
  const connectedEnvironments = useWorkspaceEnvironments();
  const connectPairingUrlMutation = useAtomCommand(connectPairingUrlAtom, {
    reportFailure: false,
  });
  const updateBearer = useAtomCommand(updateBearerConnection, { reportFailure: false });
  // Removing a Hub also ends this device's session on it.
  const removeEnvironmentMutation = useAtomCommand(
    signOutAndRemoveEnvironment,
    "environment remove",
  );
  const retryEnvironmentMutation = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const setEnvironmentEnabledMutation = useAtomCommand(
    environmentCatalog.setEnabled,
    "environment toggle",
  );

  const connectPairingUrl = (pairingUrl: string, expectedEnvironmentId?: EnvironmentId) =>
    connectPairingUrlMutation({
      pairingUrl,
      ...(expectedEnvironmentId === undefined ? {} : { expectedEnvironmentId }),
    });
  const removeEnvironment = (environmentId: EnvironmentId) => {
    forgetSpaces(environmentId);
    return removeEnvironmentMutation(environmentId);
  };
  const retryEnvironment = (environmentId: EnvironmentId) =>
    retryEnvironmentMutation(environmentId);
  const setEnvironmentEnabled = (environmentId: EnvironmentId, enabled: boolean) =>
    setEnvironmentEnabledMutation({ environmentId, enabled });
  const updateEnvironment = (
    environmentId: EnvironmentId,
    updates: { readonly label: string; readonly displayUrl: string },
  ) =>
    updateBearer({
      environmentId,
      label: updates.label,
      httpBaseUrl: updates.displayUrl,
    });

  return {
    connectedEnvironments,
    connectPairingUrl,
    removeEnvironment,
    retryEnvironment,
    setEnvironmentEnabled,
    updateEnvironment,
  };
}
