import { Navigate, createFileRoute } from "@tanstack/react-router";

// A link from before the client had one connection named it too; the Thread's id is enough now.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: function LegacyThreadRouteRedirect() {
    const { threadId } = Route.useParams();
    return <Navigate to="/$threadId" params={{ threadId }} search replace />;
  },
});
