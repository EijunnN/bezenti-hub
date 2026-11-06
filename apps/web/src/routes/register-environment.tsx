import { createFileRoute } from "@tanstack/react-router";

import { RegisterEnvironmentSurface } from "../components/auth/RegisterEnvironmentSurface";

// `t3 join` opens this page so the Owner can approve the machine joining this Hub.
export const Route = createFileRoute("/register-environment")({
  component: RegisterEnvironmentRouteView,
});

function RegisterEnvironmentRouteView() {
  const { authGateState } = Route.useRouteContext();
  return <RegisterEnvironmentSurface signedIn={authGateState.status === "authenticated"} />;
}
