/**
 * What moving a Project asks of the orchestration, which is built on `ProjectService` and so is
 * registered late (`ProjectMoveThreads`). Without it a running Thread still blocks the move. See
 * docs/internals/sandboxes.md, «Moving a Project to another Space».
 */
import type { EnvironmentId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ProjectMoveWork {
  /**
   * Stops every turn, queue start and running move of these Threads (on their machines when
   * reachable, else ended on the Hub) and waits, bounded, for them to end. The caller checks
   * again under each Thread's lock.
   */
  readonly stopThreads: (input: {
    readonly threadIds: ReadonlyArray<ThreadId>;
    readonly reason: string;
  }) => Effect.Effect<void>;
  /**
   * The Thread no longer runs on `environmentId` (its Project moved to a Space that machine does
   * not serve): its sessions there end and lose their MCP credential, and its events, terminals
   * and previews from there are refused from now on.
   */
  readonly threadReleased: (input: {
    readonly threadId: ThreadId;
    readonly environmentId: EnvironmentId;
    /** Its sessions there, as they were before the move recorded them detached. */
    readonly providerSessionIds: ReadonlyArray<ProviderSessionId>;
  }) => Effect.Effect<void>;
}

export interface ProjectMoveHooksShape {
  /** The orchestration's work, once registered. */
  readonly current: Effect.Effect<ProjectMoveWork | undefined>;
  readonly register: (work: ProjectMoveWork) => Effect.Effect<void>;
}

export class ProjectMoveHooks extends Context.Service<ProjectMoveHooks, ProjectMoveHooksShape>()(
  "t3/project/ProjectMoveHooks",
) {}

/** One per server: the Project service and the orchestration must share this very layer. */
export const layer = Layer.sync(ProjectMoveHooks, () => {
  let registered: ProjectMoveWork | undefined;
  return ProjectMoveHooks.of({
    current: Effect.sync(() => registered),
    register: Effect.fn("ProjectMoveHooks.register")(function* (work: ProjectMoveWork) {
      yield* Effect.sync(() => {
        registered = work;
      });
    }),
  });
});
