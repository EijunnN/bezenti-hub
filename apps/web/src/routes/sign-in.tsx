import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";

import { SignInSurface } from "../components/auth/SignInSurface";

export const Route = createFileRoute("/sign-in")({
  beforeLoad: ({ context }) => {
    if (context.authGateState.status !== "requires-auth") {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: SignInRouteView,
});

function SignInRouteView() {
  const router = useRouter();
  return (
    <SignInSurface
      onSignedIn={() => {
        // Recreate the connection so WebSocket and cached scopes use the new session cookie.
        router.history.replace("/");
        router.history.flush();
        window.location.reload();
      }}
    />
  );
}
