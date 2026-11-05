import { useState } from "react";

import { signInWithPasskey, signInWithRecoveryCode } from "../../environments/primary/userAccounts";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

export function SignInSurface({ onSignedIn }: { onSignedIn: () => void }) {
  const [recoveryCode, setRecoveryCode] = useState("");
  const [showRecovery, setShowRecovery] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const attempt = async (signIn: () => Promise<void>) => {
    setIsSubmitting(true);
    setErrorMessage("");
    const error = await signIn().then(
      () => null,
      (cause: unknown) => (cause instanceof Error ? cause.message : "Sign-in failed."),
    );
    setIsSubmitting(false);
    if (error) {
      setErrorMessage(error);
      return;
    }
    onSignedIn();
  };

  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Sign in"
        description="Use the passkey you registered for this Installation."
      />

      <div className="mt-6 space-y-4">
        <Button disabled={isSubmitting} size="sm" onClick={() => void attempt(signInWithPasskey)}>
          {isSubmitting && !showRecovery ? "Waiting for your passkey..." : "Sign in with a passkey"}
        </Button>

        {showRecovery ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void attempt(() => signInWithRecoveryCode(recoveryCode));
            }}
          >
            <label className="text-sm font-medium" htmlFor="recovery-code">
              Recovery code
            </label>
            <Input
              id="recovery-code"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              autoCorrect="off"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) => setRecoveryCode(event.currentTarget.value)}
              placeholder="XXXXX-XXXXX"
              spellCheck={false}
              value={recoveryCode}
            />
            <Button disabled={isSubmitting || !recoveryCode.trim()} size="sm" type="submit">
              Use recovery code
            </Button>
          </form>
        ) : (
          <Button
            disabled={isSubmitting}
            size="sm"
            variant="ghost"
            onClick={() => setShowRecovery(true)}
          >
            Lost your passkey? Use a recovery code
          </Button>
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
