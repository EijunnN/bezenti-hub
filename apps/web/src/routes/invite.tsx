import { currentSpaceStorageKey } from "@t3tools/client-runtime/spaces/space-directory";
import { UserId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { InvitationSurface } from "../components/auth/InvitationSurface";

export const Route = createFileRoute("/invite")({
  component: InviteRouteView,
});

function InviteRouteView() {
  const { authGateState } = Route.useRouteContext();
  return (
    <InvitationSurface
      signedIn={authGateState.status === "authenticated"}
      onAccepted={({ userId, spaceId }) => {
        // Start in the Organization just joined; the Space selector reads this choice on load.
        try {
          window.localStorage.setItem(currentSpaceStorageKey(UserId.make(userId)), spaceId);
        } catch {
          // Without storage the User starts in their first Space.
        }
        // Recreate the connection so WebSocket and cached scopes use the new session cookie.
        window.location.replace("/");
      }}
    />
  );
}
