import { Navigate, createFileRoute } from "@tanstack/react-router";

// A copied thread link. On the hosted app its chooser shows first; this opens the thread after it.
export const Route = createFileRoute("/threads/$environmentId/$threadId")({
  component: function ThreadLinkRedirect() {
    const { threadId } = Route.useParams();
    return <Navigate to="/$threadId" params={{ threadId }} search replace />;
  },
});
