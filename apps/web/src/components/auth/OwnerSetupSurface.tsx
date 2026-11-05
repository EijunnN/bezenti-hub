import type { AuthOwnerBootstrapResult } from "@t3tools/contracts";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { createOwnerAccount } from "../../environments/primary/userAccounts";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

export function OwnerSetupSurface({
  credential,
  onFinished,
}: {
  credential: string;
  onFinished: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [created, setCreated] = useState<AuthOwnerBootstrapResult | null>(null);

  const handleSubmit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = displayName.trim();
    if (!name) {
      setErrorMessage("Enter your name to continue.");
      return;
    }
    setIsSubmitting(true);
    setErrorMessage("");
    const result = await createOwnerAccount({ credential, displayName: name }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : "Could not create the account.",
      }),
    );
    setIsSubmitting(false);
    if (result.ok) {
      setCreated(result.value);
    } else {
      setErrorMessage(result.message);
    }
  };

  if (created) {
    return <RecoveryCodesSurface codes={created.recoveryCodes} onFinished={onFinished} />;
  }

  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Create the Owner account"
        description="This Installation has no Owner yet. The Owner holds every permission and signs in with a passkey."
      />

      <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="owner-display-name">
            Your name
          </label>
          <Input
            id="owner-display-name"
            autoComplete="name"
            disabled={isSubmitting}
            maxLength={80}
            nativeInput
            onChange={(event) => setDisplayName(event.currentTarget.value)}
            value={displayName}
          />
        </div>

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <Button disabled={isSubmitting} size="sm" type="submit">
          {isSubmitting ? "Waiting for your passkey..." : "Create account with a passkey"}
        </Button>
      </form>
    </StandalonePage>
  );
}

function RecoveryCodesSurface({
  codes,
  onFinished,
}: {
  codes: ReadonlyArray<string>;
  onFinished: () => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "recovery codes" });
  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Save your recovery codes"
        description="Each code signs you in once if you lose your passkey. This is the only time they are shown."
      />
      <ul className="mt-6 grid grid-cols-2 gap-2 font-mono text-sm" aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code} className="rounded-md border border-border/70 px-3 py-2 text-center">
            {code}
          </li>
        ))}
      </ul>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => copyToClipboard(codes.join("\n"))}>
          {isCopied ? "Copied" : "Copy codes"}
        </Button>
        <Button size="sm" onClick={onFinished}>
          I saved them, open T3 Code
        </Button>
      </div>
    </StandalonePage>
  );
}

export function OwnerAlreadyClaimedSurface() {
  return (
    <StandalonePage>
      <StandalonePageHeader
        title="This setup link is no longer valid"
        description="This Installation already has an Owner. Sign in with your passkey or a recovery code."
      />
      <div className="mt-6">
        <Button size="sm" render={<Link to="/sign-in" replace />}>
          Sign in
        </Button>
      </div>
    </StandalonePage>
  );
}

/** Passkeys need a secure context and a domain name: an IP address is not a valid WebAuthn RP ID. */
export function canRegisterPasskeys(): boolean {
  const hostname = window.location.hostname;
  const isIpAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
  return window.isSecureContext && browserSupportsWebAuthn() && !isIpAddress;
}

export function OwnerSetupNeedsSecureAddressSurface({
  isPairing,
  errorMessage,
  onPairInstead,
}: {
  isPairing: boolean;
  errorMessage: string;
  onPairInstead: () => void;
}) {
  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Create the Owner account from a secure address"
        description="Passkeys need HTTPS with a domain name, or http://localhost on the server's machine. Open this link there to create the Owner account, or pair this browser without an account for now."
      />
      {errorMessage ? (
        <Alert variant="error" className="mt-6">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-6">
        <Button disabled={isPairing} size="sm" variant="outline" onClick={onPairInstead}>
          {isPairing ? "Pairing..." : "Pair without an account"}
        </Button>
      </div>
    </StandalonePage>
  );
}
