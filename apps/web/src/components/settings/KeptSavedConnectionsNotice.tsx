import { InfoIcon } from "lucide-react";
import { useState } from "react";

import { savedConnectionSlots, useKeptSavedConnectionCount } from "~/connection/singleHub";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";

const DISMISSED_KEY = "t3code:single-hub-notice-dismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Shown once to a desktop that had saved connections from before it connected to one Hub only:
 * they stay saved on this computer, unconnected, and this says how to use another Hub.
 */
export function KeptSavedConnectionsNotice() {
  const kept = useKeptSavedConnectionCount();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (kept === 0 || dismissed) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Without storage the notice returns next time.
    }
    setDismissed(true);
  };
  const saved = kept === 1 ? "1 saved connection is" : `${kept} saved connections are`;
  return (
    <Alert variant="info">
      <InfoIcon aria-hidden />
      <AlertDescription>
        <p>
          This app now connects to one Hub and sees every Thread there, whichever machine runs it.{" "}
          {saved} kept on this computer but no longer connected.{" "}
          {savedConnectionSlots() === 0
            ? "While Local environment is on, this computer is your Hub. To use a Hub elsewhere, turn it off under This app; the app then connects to your saved Hub."
            : "To use another saved Hub, remove the one under Hub; the app then connects to the next saved Hub, or add one."}
        </p>
        <Button size="xs" variant="outline" className="mt-2" onClick={dismiss}>
          Got it
        </Button>
      </AlertDescription>
    </Alert>
  );
}
