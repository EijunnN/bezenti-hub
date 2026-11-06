/**
 * On a joined Environment, the Thread workspaces its Hub is using right now. The Hub names the
 * root with each workspace call; while a call runs, its root (symlinks resolved) is the only
 * workspace this machine knows, and every path the call touches must resolve inside it.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** As KnownWorkspaces' check, kept here so the two modules do not import each other. */
const isWithinRoot = (path: Path.Path, candidate: string, root: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

export class WorkspaceRootEscapeError extends Schema.TaggedError<WorkspaceRootEscapeError>()(
  "WorkspaceRootEscapeError",
  { root: Schema.String, path: Schema.String },
) {
  override get message(): string {
    return `'${this.path}' is outside the Thread's workspace.`;
  }
}

/** A held workspace root, and paths relative to it resolved to real paths inside it. */
export interface Workspace {
  readonly root: string;
  readonly inside: (relative: string) => Effect.Effect<string, WorkspaceRootEscapeError>;
}

export class JoinedWorkspaceRoots extends Context.Service<
  JoinedWorkspaceRoots,
  {
    /** Whether a symlink-resolved path is inside a root a running call holds. */
    readonly contains: (realPath: string) => boolean;
    /**
     * Runs `use` with the workspace root held: its real path, and a resolver that turns a path
     * relative to it into a real path inside it, or fails when it leaves the root.
     */
    readonly withRoot: <A, E, R>(
      root: string,
      use: (workspace: Workspace) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | WorkspaceRootEscapeError, R>;
  }
>()("t3/workspace/JoinedWorkspaceRoots") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const held = new Map<string, number>();

  /** The real path of `target`, or of its nearest existing ancestor with the rest appended. */
  const realPathOf = (target: string): Effect.Effect<string> =>
    fileSystem.realPath(target).pipe(
      Effect.catch(() => {
        const parent = path.dirname(target);
        return parent === target
          ? Effect.succeed(target)
          : Effect.map(realPathOf(parent), (real) => path.join(real, path.basename(target)));
      }),
    );

  return JoinedWorkspaceRoots.of({
    contains: (realPath) => [...held.keys()].some((root) => isWithinRoot(path, realPath, root)),
    withRoot: Effect.fn("JoinedWorkspaceRoots.withRoot")(function* <A, E, R>(
      root: string,
      use: (workspace: Workspace) => Effect.Effect<A, E, R>,
    ) {
      const escape = (target: string) => new WorkspaceRootEscapeError({ root, path: target });
      const realRoot = yield* fileSystem.realPath(root).pipe(Effect.mapError(() => escape(root)));
      const inside = Effect.fn("JoinedWorkspaceRoots.inside")(function* (relative: string) {
        if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
          return yield* escape(relative);
        }
        const real = yield* realPathOf(path.join(realRoot, relative));
        if (!isWithinRoot(path, real, realRoot)) return yield* escape(relative);
        return real;
      });
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => held.set(realRoot, (held.get(realRoot) ?? 0) + 1)),
        () => use({ root: realRoot, inside }),
        () =>
          Effect.sync(() => {
            const count = (held.get(realRoot) ?? 1) - 1;
            if (count <= 0) held.delete(realRoot);
            else held.set(realRoot, count);
          }),
      );
    }),
  });
});

export const layer = Layer.effect(JoinedWorkspaceRoots, make);
