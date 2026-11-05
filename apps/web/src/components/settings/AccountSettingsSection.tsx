import type { AuthAccount, AuthTotpEnrollment } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import {
  confirmTotpEnrollment,
  fetchAccount,
  setAccountPassword,
  signOut,
  startTotpEnrollment,
} from "../../environments/primary/userAccounts";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// Mirrors AuthLoginName in the contracts.
const LOGIN_NAME_PATTERN = /^[A-Za-z0-9][\w.-]{1,39}$/;

const errorMessageOf = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

/** Shown only for sessions that belong to a User; pairing-link sessions have no account to leave. */
export function AccountSettingsSection() {
  const session = usePrimarySessionState();
  const userId =
    session.data?.authenticated === true && session.data.userId !== undefined
      ? session.data.userId
      : null;
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [account, setAccount] = useState<AuthAccount | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the account from the server for the signed-in User.
  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    void fetchAccount().then(
      (loaded) => {
        if (!cancelled) setAccount(loaded);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (userId === null) return null;

  const handleSignOut = async () => {
    setIsSigningOut(true);
    await signOut().catch(() => undefined);
    window.location.replace("/sign-in");
  };

  return (
    <SettingsSection title="Your account">
      {account ? (
        <>
          <TotpRow account={account} onChanged={setAccount} />
          <PasswordRow account={account} onChanged={setAccount} />
        </>
      ) : null}
      <SettingsRow
        title="Sign out"
        description="Ends this browser's session. Sign in again with your passkey or password."
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

function TotpRow({
  account,
  onChanged,
}: {
  account: AuthAccount;
  onChanged: (account: AuthAccount) => void;
}) {
  const [enrollment, setEnrollment] = useState<AuthTotpEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const start = async () => {
    setIsBusy(true);
    setErrorMessage("");
    await startTotpEnrollment().then(setEnrollment, (cause: unknown) =>
      setErrorMessage(errorMessageOf(cause, "Could not start the setup.")),
    );
    setIsBusy(false);
  };

  const confirm = async () => {
    setIsBusy(true);
    setErrorMessage("");
    await confirmTotpEnrollment(code.replace(/\s/g, "")).then(
      (updated) => {
        setEnrollment(null);
        setCode("");
        onChanged(updated);
      },
      (cause: unknown) => setErrorMessage(errorMessageOf(cause, "That code did not match.")),
    );
    setIsBusy(false);
  };

  return (
    <SettingsRow
      title="Authenticator app"
      description={
        account.totpEnrolled
          ? "Set up. Password sign-in asks for a code from this app."
          : account.passwordRequiresTotp
            ? "Not set up. Your account needs it before you can add a password."
            : "Not set up. Adds a code from an app such as 1Password or Google Authenticator to password sign-in."
      }
      control={
        enrollment ? null : (
          <Button disabled={isBusy} size="xs" variant="outline" onClick={() => void start()}>
            {account.totpEnrolled ? "Replace" : "Set up"}
          </Button>
        )
      }
    >
      {enrollment ? (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <p className="text-xs text-muted-foreground">
            Scan this with your authenticator app, then enter the code it shows.
          </p>
          <div className="self-start rounded-lg bg-white p-1.5">
            <QRCodeSvg
              value={enrollment.otpauthUri}
              size={160}
              level="M"
              marginSize={1}
              title="Authenticator app setup code"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Can't scan? Enter this key: <code className="select-all">{enrollment.secret}</code>
          </p>
          <div className="flex gap-2">
            <Input
              aria-label="Code from your authenticator app"
              autoComplete="one-time-code"
              disabled={isBusy}
              inputMode="numeric"
              nativeInput
              onChange={(event) => setCode(event.currentTarget.value)}
              placeholder="123456"
              value={code}
            />
            <Button
              disabled={isBusy || code.replace(/\s/g, "").length !== 6}
              size="sm"
              type="submit"
            >
              Confirm
            </Button>
            <Button
              disabled={isBusy}
              size="sm"
              variant="ghost"
              onClick={() => {
                setEnrollment(null);
                setCode("");
                setErrorMessage("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {errorMessage ? (
        <div className="mt-3">
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        </div>
      ) : null}
    </SettingsRow>
  );
}

function PasswordRow({
  account,
  onChanged,
}: {
  account: AuthAccount;
  onChanged: (account: AuthAccount) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [loginName, setLoginName] = useState(account.loginName ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const blocked = account.passwordRequiresTotp && !account.totpEnrolled;

  const save = async () => {
    if (!LOGIN_NAME_PATTERN.test(loginName.trim())) {
      setErrorMessage(
        "Use 2 to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit.",
      );
      return;
    }
    setIsBusy(true);
    setErrorMessage("");
    await setAccountPassword({
      loginName,
      password,
      ...(account.hasPassword ? { currentPassword } : {}),
    }).then(
      (updated) => {
        setIsEditing(false);
        setCurrentPassword("");
        setPassword("");
        onChanged(updated);
      },
      (cause: unknown) => setErrorMessage(errorMessageOf(cause, "Could not save the password.")),
    );
    setIsBusy(false);
  };

  return (
    <SettingsRow
      title="Password"
      description={
        account.hasPassword
          ? `Set. Sign in as "${account.loginName ?? ""}".`
          : blocked
            ? "Set up an authenticator app first."
            : "Not set. A password lets you sign in where passkeys are not available."
      }
      control={
        isEditing ? null : (
          <Button disabled={blocked} size="xs" variant="outline" onClick={() => setIsEditing(true)}>
            {account.hasPassword ? "Change" : "Set password"}
          </Button>
        )
      }
    >
      {isEditing ? (
        <form
          className="mt-3 flex max-w-sm flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="text-xs font-medium" htmlFor="account-login-name">
            Sign-in name
          </label>
          <Input
            id="account-login-name"
            autoCapitalize="none"
            autoComplete="username"
            disabled={isBusy}
            nativeInput
            onChange={(event) => setLoginName(event.currentTarget.value)}
            spellCheck={false}
            value={loginName}
          />
          {account.hasPassword ? (
            <>
              <label className="text-xs font-medium" htmlFor="account-current-password">
                Current password
              </label>
              <Input
                id="account-current-password"
                autoComplete="current-password"
                disabled={isBusy}
                nativeInput
                onChange={(event) => setCurrentPassword(event.currentTarget.value)}
                type="password"
                value={currentPassword}
              />
            </>
          ) : null}
          <label className="text-xs font-medium" htmlFor="account-new-password">
            New password (8 characters or more)
          </label>
          <Input
            id="account-new-password"
            autoComplete="new-password"
            disabled={isBusy}
            nativeInput
            onChange={(event) => setPassword(event.currentTarget.value)}
            type="password"
            value={password}
          />
          <div className="flex gap-2">
            <Button
              disabled={isBusy || loginName.trim().length < 2 || password.length < 8}
              size="sm"
              type="submit"
            >
              Save
            </Button>
            <Button
              disabled={isBusy}
              size="sm"
              variant="ghost"
              onClick={() => {
                setIsEditing(false);
                setErrorMessage("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {errorMessage ? (
        <div className="mt-3">
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        </div>
      ) : null}
    </SettingsRow>
  );
}
