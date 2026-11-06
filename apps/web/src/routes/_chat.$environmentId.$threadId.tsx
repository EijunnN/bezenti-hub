import { createFileRoute, redirect } from "@tanstack/react-router";

// A link from before the client had one connection named it too; the Thread's id is enough now.
// Redirected before loading: the _chat layout renders the Thread itself, not this route.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/$threadId",
      params: { threadId: params.threadId },
      search,
      replace: true,
    });
  },
  component: () => null,
});
