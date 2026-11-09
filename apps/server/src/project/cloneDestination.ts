import {
  SourceControlProviderKind,
  SourceControlRepositoryError,
  type UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { PROJECT_FOLDER_REFUSED } from "../spaces/directoryRoots.ts";
import type * as SpaceVisibility from "../spaces/SpaceVisibility.ts";

export const CLONE_DESTINATION_REFUSED =
  "You can only clone into a new folder in the Hub's Projects folder or into a folder of your team's Projects.";

/**
 * Where a User may clone, whichever transport asks (WS, MCP): the Owner anywhere; anyone else
 * into a folder of their team's Projects or a new folder right in the Hub's Projects folder
 * (`SpaceVisibility.mayCreateDirectory`). Asked when a clone is requested and again just before
 * git writes, a retry included, so a link swapped in meanwhile is caught.
 */
export const requireCloneDestination = Effect.fn("cloneDestination.require")(function* (
  caller: { readonly visibility: SpaceVisibility.Visibility; readonly userId: UserId | undefined },
  destinationPath: string,
  hub: {
    readonly spaceVisibility: Effect.Effect<SpaceVisibility.SpaceVisibility["Service"]>;
    readonly projectsRoot: Effect.Effect<string>;
  },
  /** The clone becomes a new Project there, so its folder must also be one a Project may take. */
  options?: { readonly asProject?: boolean },
) {
  if (caller.visibility.all || caller.userId === undefined) return;
  const spaceVisibility = yield* hub.spaceVisibility;
  const allowed = yield* spaceVisibility.mayCreateDirectory(
    caller.visibility,
    caller.userId,
    destinationPath,
    [yield* hub.projectsRoot],
  );
  if (!allowed) {
    return yield* new SourceControlRepositoryError({
      operation: "cloneRepository",
      provider: SourceControlProviderKind.make("unknown"),
      detail: CLONE_DESTINATION_REFUSED,
    });
  }
  if (
    options?.asProject === true &&
    !(yield* spaceVisibility.mayRootProject(caller.visibility, caller.userId, destinationPath, [
      yield* hub.projectsRoot,
    ]))
  ) {
    return yield* new SourceControlRepositoryError({
      operation: "cloneRepository",
      provider: SourceControlProviderKind.make("unknown"),
      detail: PROJECT_FOLDER_REFUSED,
    });
  }
});
