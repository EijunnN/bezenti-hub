import { createFileRoute } from "@tanstack/react-router";

import { AppSignInSurface } from "../components/auth/AppSignInSurface";

// The desktop and mobile apps open this page in the system browser to sign in to this Hub.
export const Route = createFileRoute("/app-sign-in")({
  component: AppSignInRouteView,
});

function AppSignInRouteView() {
  const { authGateState } = Route.useRouteContext();
  return <AppSignInSurface signedIn={authGateState.status === "authenticated"} />;
}
