import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SpaceVisibility from "./SpaceVisibility.ts";

/** A viewer that sees every Project and Thread, as the Owner does: for tests not about Spaces. */
export const layerSeesEverything = Layer.merge(
  Layer.succeed(
    SpaceVisibility.SpaceVisibility,
    SpaceVisibility.SpaceVisibility.of({
      of: () => Effect.succeed(SpaceVisibility.everything),
      viewer: () => Effect.succeed(Effect.succeed(SpaceVisibility.everything)),
      visibleThreadIds: (_visibility, threadIds) => Effect.succeed(new Set(threadIds)),
      hiddenThreadIds: () => Effect.succeed(new Set<string>()),
      visibleProjectIds: (_visibility, projectIds) => Effect.succeed(new Set(projectIds)),
      claimWork: () => Effect.succeed("allowed" as const),
      workableThreadIds: (_visibility, _userId, threadIds) => Effect.succeed(new Set(threadIds)),
    }),
  ),
  SpaceVisibility.layerCurrentViewerOwner,
);
