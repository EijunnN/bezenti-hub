import type { AuthResetLinkStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { peekPairingTokenFromUrl, stripPairingTokenFromUrl } from "../../environments/primary/auth";
import { fetchResetLinkStatus, resetPasskey } from "../../environments/primary/userAccounts";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { canRegisterPasskeys } from "./OwnerSetupSurface";

type LinkState = { readonly status: "checking" } | AuthResetLinkStatus;

export function ResetPasskeySurface({ onFinished }: { onFinished: () => void }) {
  // The fragment never reaches the server; read it once, then drop it from the address bar.
  const [token] = useState(peekPairingTokenFromUrl);
  const [link, setLink] = useState<LinkState>(
    token === null ? { status: "invalid" } : { status: "checking" },
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- strips the reset token from the URL and asks the server whether the link is still live
  useEffect(() => {
    if (token === null) return;
    stripPairingTokenFromUrl();
    let cancelled = false;
    void fetchResetLinkStatus(token).then(
      (status) => {
        if (!cancelled) setLink(status);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setLink({ status: "invalid" });
        setErrorMessage(cause instanceof Error ? cause.message : "Could not check this link.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleReset = async () => {
    if (token === null) return;
    setIsSubmitting(true);
    setErrorMessage("");
    const error = await resetPasskey(token).then(
      () => null,
      (cause: unknown) => (cause instanceof Error ? cause.message : "The reset failed."),
    );
    setIsSubmitting(false);
    if (error) {
      setErrorMessage(error);
      return;
    }
    onFinished();
  };

  if (link.status === "checking") {
    return (
      <StandalonePage>
        <StandalonePageHeader title="Checking reset link" description="One moment..." />
      </StandalonePage>
    );
  }

  if (link.status === "invalid") {
    return (
      <StandalonePage>
        <StandalonePageHeader
          title="This reset link no longer works"
          description="Reset links work once and expire after an hour. Run `t3 auth owner-reset` in the Hub's shell for a new one."
        />
        {errorMessage ? (
          <div className="mt-6">
            <Alert variant="error">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          </div>
        ) : null}
      </StandalonePage>
    );
  }

  return (
    <StandalonePage>
      <StandalonePageHeader
        title={`Register a new passkey for ${link.displayName}`}
        description="Your old passkeys stop working and every device signed in to this account is signed out. This link works once."
      />
      <div className="mt-6 space-y-4">
        {canRegisterPasskeys() ? (
          <Button disabled={isSubmitting} size="sm" onClick={() => void handleReset()}>
            {isSubmitting ? "Waiting for your passkey..." : "Register a new passkey"}
          </Button>
        ) : (
          <Alert variant="error">
            <AlertDescription>
              Passkeys need the Installation's own HTTPS address (or localhost). Open this link
              there.
            </AlertDescription>
          </Alert>
        )}
        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </StandalonePage>
  );
}
