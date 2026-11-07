import Storage from "expo-sqlite/kv-store";
import { useState } from "react";

import { Notice } from "../../components/ui/Notice";
import { useKeptSavedConnectionCount } from "../../connection/singleHub";

const DISMISSED_KEY = "t3code:single-hub-notice-dismissed";

function readDismissed(): boolean {
  try {
    return Storage.getItemSync(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** The notice's words for `kept` saved connections the phone no longer connects. */
export function keptSavedConnectionsMessage(kept: number): string {
  const saved = kept === 1 ? "1 saved connection is" : `${kept} saved connections are`;
  return `This app now connects to one Hub and sees every Thread there, whichever machine runs it. ${saved} kept on this phone but no longer connected. To use another one, remove this Hub; the app then connects to the next saved one when it starts, or add a Hub.`;
}

/**
 * Shown once on a phone that saved several connections before it connected to one Hub only: they
 * stay saved, unconnected, never deleted silently, and this says how to switch.
 */
export function KeptSavedConnectionsNotice() {
  const kept = useKeptSavedConnectionCount();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (kept === 0 || dismissed) return null;
  const dismiss = () => {
    try {
      Storage.setItemSync(DISMISSED_KEY, "1");
    } catch {
      // Without storage the notice returns next time.
    }
    setDismissed(true);
  };
  return (
    <Notice
      message={keptSavedConnectionsMessage(kept)}
      icon="info.circle"
      onDismiss={dismiss}
      dismissLabel="Got it"
    />
  );
}
