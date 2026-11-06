import type { AuthAccount } from "@t3tools/contracts";
import { appSignInCancelledUrl } from "@t3tools/shared/appSignIn";
import { readEnvironmentJoinPageRequest } from "@t3tools/shared/environmentJoin";
import { useEffect, useState } from "react";

import { usePrimarySessionState } from "~/environments/primary";
import { approveEnvironmentJoin } from "~/environments/primary/hubEnvironments";
import { fetchAccount } from "~/environments/primary/userAccounts";
import { errorMessageOf } from "~/lib/errorMessage";
import { emptyStepUp, StepUpFields, toStepUp } from "../settings/AccountSettingsSection";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { SignInSurface } from "./SignInSurface";

/**
 * The page `t3 join` opens on the Hub. The Owner checks the machine, may rename it, and confirms
 * with a passkey or password and code; the one-time code then goes back to `t3 join` on a port of
 * that machine, never anywhere else.
 */
export function RegisterEnvironmentSurface({ signedIn }: { readonly signedIn: boolean }) {
  const [request] = useState(() => readEnvironmentJoinPageRequest(window.location.href));
  const session = usePrimarySessionState();
  const isOwner = session.data?.authenticated === true && session.data.isOwner === true;
  const [account, setAccount] = useState<AuthAccount | null>(null);
  const [name, setName] = useState(request?.name ?? "");
  const [stepUp, setStepUp] = useState<ReturnType<typeof emptyStepUp> | null>(null);
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [cancelled, setCancelled] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the account's sign-in methods from the server for the step-up.
  useEffect(() => {
    if (!signedIn || !isOwner) return;
    let current = true;
    void fetchAccount().then(
      (loaded) => {
        if (!current) return;
        setAccount(loaded);
        setStepUp(emptyStepUp(loaded));
      },
      (cause: unknown) => {
        if (current) setErrorMessage(errorMessageOf(cause, "Could not load your account."));
      },
    );
    return () => {
      current = false;
    };
  }, [signedIn, isOwner]);

  if (request === null) {
    return (
      <StandalonePage>
        <StandalonePageHeader
          context="Register this machine"
          title="This registration cannot continue"
          description="The link is incomplete or does not come from `t3 join`. Run `t3 join` on the machine again."
        />
      </StandalonePage>
    );
  }

  if (!signedIn) {
    return (
      <SignInSurface
        // The page reloads with the same request, now signed in.
        onSignedIn={() => window.location.reload()}
        description={
          <>
            Sign in as the Owner to add{" "}
            <span className="font-medium text-foreground">{request.hostname}</span> to{" "}
            <span className="font-medium text-foreground">{window.location.host}</span>.
          </>
        }
      />
    );
  }

  if (cancelled) {
    return (
      <StandalonePage>
        <StandalonePageHeader
          context="Register this machine"
          title="Registration cancelled"
          description="The machine was not added. You can close this tab."
        />
      </StandalonePage>
    );
  }

  if (session.data !== undefined && !isOwner) {
    return (
      <StandalonePage>
        <StandalonePageHeader
          context="Register this machine"
          title="Only the Owner adds machines"
          description="Ask this Hub's Owner to run `t3 join` and approve the machine."
        />
      </StandalonePage>
    );
  }

  const approve = async () => {
    if (account === null || stepUp === null) return;
    setPending(true);
    setErrorMessage("");
    try {
      const redirectTo = await approveEnvironmentJoin({
        request,
        name: name.trim(),
        stepUp: toStepUp(account, stepUp),
      });
      window.location.replace(redirectTo);
    } catch (cause) {
      setPending(false);
      setErrorMessage(errorMessageOf(cause, "The machine could not be registered."));
    }
  };

  const requestedAt = new Date(request.requestedAt).toLocaleString();
  return (
    <StandalonePage>
      <StandalonePageHeader
        context={window.location.host}
        title="Register this machine"
        description="It becomes one of your personal Environments: only you run work on it. Only continue with a `t3 join` you just started."
      />
      <form
        className="mt-6 flex max-w-sm flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void approve();
        }}
      >
        <label className="text-xs font-medium" htmlFor="register-environment-name">
          Name
        </label>
        <Input
          id="register-environment-name"
          disabled={pending}
          maxLength={64}
          nativeInput
          onChange={(event) => setName(event.currentTarget.value)}
          value={name}
        />
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Operating system</dt>
          <dd>{request.os}</dd>
          <dt className="text-muted-foreground">Hostname</dt>
          <dd>{request.hostname}</dd>
          <dt className="text-muted-foreground">Requested</dt>
          <dd>{requestedAt}</dd>
        </dl>
        {account !== null && stepUp !== null ? (
          <StepUpFields account={account} disabled={pending} value={stepUp} onChange={setStepUp} />
        ) : null}
        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button disabled={pending || account === null || name.trim() === ""} type="submit">
            {pending ? "Registering…" : "Register this machine"}
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              setCancelled(true);
              // Tell `t3 join`, so it stops waiting; the redirect was validated with the request.
              window.location.replace(appSignInCancelledUrl(request.redirectUri, request.state));
            }}
            variant="outline"
          >
            Cancel
          </Button>
        </div>
      </form>
    </StandalonePage>
  );
}
