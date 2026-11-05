import { createFileRoute } from "@tanstack/react-router";

import { ResetPasskeySurface } from "../components/auth/ResetPasskeySurface";

export const Route = createFileRoute("/reset")({
  component: ResetRouteView,
});

function ResetRouteView() {
  return (
    <ResetPasskeySurface
      onFinished={() => {
        // Recreate the connection so WebSocket and cached scopes use the new session cookie.
        window.location.replace("/");
      }}
    />
  );
}
