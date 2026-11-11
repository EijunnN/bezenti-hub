import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import { useServerConfigs } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

/**
 * The Owner's separate, explicit way to clear every User's server browser profiles on the Hub.
 * Everyone else (and the Owner, by default) clears only their own, from each profile's menu.
 */
export function ServerBrowserAllProfilesSetting() {
  const session = usePrimarySessionState();
  const environmentId = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();
  const [confirming, setConfirming] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const runClearAll = useAtomCommand(previewEnvironment.clearAllProfiles, {
    reportFailure: false,
  });
  if (session.data?.authenticated !== true || session.data.isOwner !== true) return null;
  if (environmentId === null) return null;
  if (serverConfigs.get(environmentId)?.environment.capabilities.serverBrowser !== true) {
    return null;
  }

  const clearAll = async () => {
    setInFlight(true);
    const result = await runClearAll({ environmentId, input: undefined });
    setInFlight(false);
    setConfirming(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not clear every User's browser data",
        description: failure instanceof Error ? failure.message : undefined,
      });
      return;
    }
    toastManager.add({ type: "success", title: "Cleared every User's server browser data" });
  };

  return (
    <SettingsRow
      title="Every User's server browser data"
      description="Each User's previews in the Hub's browser keep their own cookies and sign-ins, per Space. Only you can clear everyone's at once."
      control={
        <Button size="xs" variant="outline" onClick={() => setConfirming(true)}>
          Clear for every User
        </Button>
      }
    >
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !inFlight) setConfirming(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear every User's server browser data?</AlertDialogTitle>
            <AlertDialogDescription>
              Every User is signed out of the sites they previewed in the Hub's browser, in every
              Space. Their open server browser tabs close now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={inFlight}
              render={<Button variant="outline" disabled={inFlight} />}
            >
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={inFlight} onClick={() => void clearAll()}>
              {inFlight ? "Clearing…" : "Clear for every User"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsRow>
  );
}
