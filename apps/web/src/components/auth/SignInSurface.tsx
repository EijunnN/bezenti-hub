import { type ReactNode, useState } from "react";

import {
  signInWithPasskey,
  signInWithPassword,
  signInWithRecoveryCode,
  signInWithTotp,
  type TotpStep,
} from "../../environments/primary/userAccounts";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

type Method = "passkey" | "password" | "recovery";

export function SignInSurface({
  onSignedIn,
  description = "Use your passkey, or your sign-in name and password.",
  footer,
}: {
  onSignedIn: () => void;
  description?: ReactNode;
  /** Shown under the sign-in methods, such as another way to continue. */
  footer?: ReactNode;
}) {
  const [method, setMethod] = useState<Method>("passkey");
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [totpStep, setTotpStep] = useState<TotpStep | null>(null);
  const totpChallengeId = totpStep?.totpChallengeId ?? null;
  const needsTotp = totpStep !== null;
  const setup = totpStep?.setup;
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const attempt = async (signIn: () => Promise<TotpStep | "signed-in" | void>) => {
    setIsSubmitting(true);
    setErrorMessage("");
    const outcome = await signIn().then(
      (result) => ({ ok: true as const, result }),
      (cause: unknown) => ({
        ok: false as const,
        message: cause instanceof Error ? cause.message : "Sign-in failed.",
      }),
    );
    setIsSubmitting(false);
    if (!outcome.ok) {
      setErrorMessage(outcome.message);
      // A code step that failed may be spent; the password step starts a new one.
      setTotpStep(null);
      setTotpCode("");
      return;
    }
    if (typeof outcome.result === "object") {
      setTotpStep(outcome.result);
      return;
    }
    onSignedIn();
  };

  const choose = (next: Method) => {
    setMethod(next);
    setTotpStep(null);
    setTotpCode("");
    setErrorMessage("");
  };

  return (
    <StandalonePage>
      <StandalonePageHeader title="Sign in" description={description} />

      <div className="mt-6 space-y-4">
        {method === "passkey" ? (
          <Button disabled={isSubmitting} size="sm" onClick={() => void attempt(signInWithPasskey)}>
            {isSubmitting ? "Waiting for your passkey..." : "Sign in with a passkey"}
          </Button>
        ) : null}

        {method === "password" ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void attempt(() =>
                totpChallengeId === null
                  ? signInWithPassword({ loginName, password })
                  : signInWithTotp({
                      challengeId: totpChallengeId,
                      code: totpCode.replace(/\s/g, ""),
                    }),
              );
            }}
          >
            <label className="block text-sm font-medium" htmlFor="sign-in-name">
              Sign-in name
            </label>
            <Input
              id="sign-in-name"
              autoCapitalize="none"
              autoComplete="username"
              autoCorrect="off"
              disabled={isSubmitting || needsTotp}
              nativeInput
              onChange={(event) => setLoginName(event.currentTarget.value)}
              spellCheck={false}
              value={loginName}
            />
            <label className="block text-sm font-medium" htmlFor="sign-in-password">
              Password
            </label>
            <Input
              id="sign-in-password"
              autoComplete="current-password"
              disabled={isSubmitting || needsTotp}
              nativeInput
              onChange={(event) => setPassword(event.currentTarget.value)}
              type="password"
              value={password}
            />
            {setup !== undefined ? (
              <div className="flex flex-col gap-2 pt-2">
                <p className="text-sm font-medium">Set up an authenticator app</p>
                <p className="text-sm text-muted-foreground">
                  You're now an Admin, so your password needs a code from an authenticator app. Scan
                  this with the app, then enter the code it shows. You can add a passkey in Settings
                  → Access afterwards.
                </p>
                <div className="self-start rounded-lg bg-white p-1.5">
                  <QRCodeSvg
                    value={setup.otpauthUri}
                    size={160}
                    level="M"
                    marginSize={1}
                    title="Authenticator app setup code"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Can't scan? Enter this key: <code className="select-all">{setup.secret}</code>
                </p>
              </div>
            ) : null}
            {needsTotp ? (
              <>
                <label className="block text-sm font-medium" htmlFor="sign-in-totp">
                  Code from your authenticator app
                </label>
                <Input
                  id="sign-in-totp"
                  autoComplete="one-time-code"
                  autoFocus
                  disabled={isSubmitting}
                  inputMode="numeric"
                  nativeInput
                  onChange={(event) => setTotpCode(event.currentTarget.value)}
                  placeholder="123456"
                  value={totpCode}
                />
              </>
            ) : null}
            <Button
              disabled={
                isSubmitting ||
                !loginName.trim() ||
                !password ||
                (needsTotp && totpCode.replace(/\s/g, "").length !== 6)
              }
              size="sm"
              type="submit"
            >
              {setup !== undefined ? "Finish setup" : needsTotp ? "Verify code" : "Sign in"}
            </Button>
          </form>
        ) : null}

        {method === "recovery" ? (
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
        ) : null}

        <div className="flex flex-wrap gap-2">
          {method !== "passkey" ? (
            <Button
              disabled={isSubmitting}
              size="sm"
              variant="ghost"
              onClick={() => choose("passkey")}
            >
              Use a passkey instead
            </Button>
          ) : null}
          {method !== "password" ? (
            <Button
              disabled={isSubmitting}
              size="sm"
              variant="ghost"
              onClick={() => choose("password")}
            >
              Sign in with a password
            </Button>
          ) : null}
          {method !== "recovery" ? (
            <Button
              disabled={isSubmitting}
              size="sm"
              variant="ghost"
              onClick={() => choose("recovery")}
            >
              Lost your passkey? Use a recovery code
            </Button>
          ) : null}
        </div>

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
        {footer}
      </div>
    </StandalonePage>
  );
}
