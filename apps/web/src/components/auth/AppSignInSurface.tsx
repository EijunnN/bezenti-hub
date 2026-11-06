import { readAppSignInPageRequest, appSignInRedirectKind } from "@t3tools/shared/appSignIn";
import * as Effect from "effect/Effect";
import { useState } from "react";

import { PrimaryEnvironmentHttpClient } from "~/environments/primary/httpClient";
import { runPrimaryHttp } from "~/lib/runtime";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { SignInSurface } from "./SignInSurface";

/**
 * The page the desktop and mobile apps open in the system browser. Signed in here, the User
 * approves, and the Hub sends a one-time code back to the app that asked (a port on this
 * computer, or the T3 Code mobile app), never anywhere else.
 */
export function AppSignInSurface({ signedIn }: { readonly signedIn: boolean }) {
  const [request] = useState(() => readAppSignInPageRequest(window.location.href));
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const host = window.location.host;

  if (request === null) {
    return (
      <StandalonePage>
        <StandalonePageHeader
          context="App sign-in"
          title="This sign-in cannot continue"
          description="The link is incomplete or does not come from a T3 Code app. Start the sign-in again from the app."
        />
      </StandalonePage>
    );
  }

  const appName = request.clientLabel ?? "T3 Code";
  const destination =
    appSignInRedirectKind(request.redirectUri) === "mobile-app"
      ? "the T3 Code app on this device"
      : "the T3 Code app on this computer";

  if (!signedIn) {
    return (
      <SignInSurface
        // The page reloads with the same request, now signed in.
        onSignedIn={() => window.location.reload()}
        description={
          <>
            Sign in to connect {appName} to{" "}
            <span className="font-medium text-foreground">{host}</span>. It will act as you, with
            your access.
          </>
        }
      />
    );
  }

  if (cancelled) {
    return (
      <StandalonePage>
        <StandalonePageHeader
          context="App sign-in"
          title="Sign-in cancelled"
          description="Nothing was shared with the app. You can close this tab."
        />
      </StandalonePage>
    );
  }

  const approve = async () => {
    setPending(true);
    setErrorMessage("");
    const outcome = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.appSignIn.approve({
            payload: {
              redirectUri: request.redirectUri,
              codeChallenge: request.codeChallenge,
              codeChallengeMethod: "S256",
              state: request.state,
              ...(request.clientLabel ? { clientLabel: request.clientLabel } : {}),
            },
          }),
        ),
      ),
    ).then(
      (result) => ({ ok: true as const, redirectTo: result.redirectTo }),
      () => ({ ok: false as const }),
    );
    if (outcome.ok) {
      window.location.replace(outcome.redirectTo);
      return;
    }
    setPending(false);
    setErrorMessage(
      "The sign-in could not be approved. Sign in again, or restart it from the app.",
    );
  };

  return (
    <StandalonePage>
      <StandalonePageHeader
        context="App sign-in"
        title={`Connect ${appName}`}
        description={
          <>
            {appName} will use the projects and threads you can reach on{" "}
            <span className="font-medium text-foreground">{host}</span>, acting as you.
          </>
        }
      />
      <p className="mt-2 text-xs text-muted-foreground">
        Approving returns to {destination}. The name is chosen by the app. Only continue with a
        sign-in you just started.
      </p>
      {errorMessage ? (
        <Alert className="mt-4" variant="error">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button disabled={pending} onClick={() => void approve()}>
          {pending ? "Connecting…" : "Continue"}
        </Button>
        <Button disabled={pending} onClick={() => setCancelled(true)} variant="outline">
          Cancel
        </Button>
      </div>
    </StandalonePage>
  );
}
