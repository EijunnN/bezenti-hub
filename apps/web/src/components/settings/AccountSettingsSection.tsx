import { useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import { signOut } from "../../environments/primary/userAccounts";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Shown only for sessions that belong to a User; pairing-link sessions have no account to leave. */
export function AccountSettingsSection() {
  const session = usePrimarySessionState();
  const [isSigningOut, setIsSigningOut] = useState(false);
  if (!session.data?.authenticated || session.data.userId === undefined) return null;

  const handleSignOut = async () => {
    setIsSigningOut(true);
    await signOut().catch(() => undefined);
    window.location.replace("/sign-in");
  };

  return (
    <SettingsSection title="Your account">
      <SettingsRow
        title="Sign out"
        description="Ends this browser's session. Sign in again with your passkey."
        control={
          <Button
            disabled={isSigningOut}
            size="xs"
            variant="outline"
            onClick={() => void handleSignOut()}
          >
            {isSigningOut ? "Signing out..." : "Sign out"}
          </Button>
        }
      />
    </SettingsSection>
  );
}
