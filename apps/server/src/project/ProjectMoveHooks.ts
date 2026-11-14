/**
 * What moving a Project asks of the orchestration, which is built on `ProjectService` and so is
 * registered late (`ProjectMoveThreads`). Without it a running Thread still blocks the move. See
 * docs/internals/sandboxes.md, «Moving a Project to another Space».
 */
import type { ThreadId } from "@t3tools/contracts";
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
   * Cuts each machine a move released one of these Threads from (`thread_environment_releases`):
   * its sessions there are detached and lose their MCP credential, and its events, terminals and
   * previews from there are refused. Idempotent: a release is deleted once done, so a rerun or the
   * Hub's start finishes one cut short. `all` drains every recorded release.
   */
  readonly drainReleases: (threadIds: ReadonlyArray<ThreadId> | "all") => Effect.Effect<void>;
  /**
   * Spec 5 ticket 07: tells each connected machine every Thread's Space now and the removed Users,
   * and each closes its shells started for another Space or a removed User (`terminal.reconcile`).
   * Fire and forget: it returns at once, logs failures, and runs again as each machine connects.
   */
  readonly reconcileTerminals: Effect.Effect<void>;
  /**
   * Spec 4 ticket 11: closes every live provider session whose AI facts no longer hold (its
   * Thread in another Space, another turn owner, a removed User, an account no longer allowed),
   * so no process keeps a direct credential or a key past its reach (`AiSessionReach`). Fire and
   * forget, coalesced; it also runs as each machine connects.
   */
  readonly reconcileAiSessions: Effect.Effect<void>;
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
