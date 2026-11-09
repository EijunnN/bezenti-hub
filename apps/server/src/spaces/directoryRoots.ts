/**
 * The roots the directory checks trust (`SpaceVisibility.mayReadDirectory`): Project roots and
 * Hub-machine Thread worktrees, read from the server's records. Whatever the transport, a User
 * other than the Owner records only a new folder in the Hub's Projects folder (or one the Hub
 * made), and a worktree inside its Project or of its Project's repository.
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as SqlClient from "effect/sql/SqlClient";

export const PROJECT_FOLDER_REFUSED =
  "You can only create a Project in a new folder in the Hub's Projects folder. Only the Owner of this Hub can use another folder.";
export const PROJECT_FOLDER_CHANGE_REFUSED =
  "Only the Owner of this Hub can move a Project to another folder.";
export const THREAD_WORKTREE_REFUSED =
  "A Thread's folder must be inside its Project or a worktree of its Project's repository.";

export interface DirectoryServices {
  readonly path: Path.Path;
  readonly fileSystem: Option.Option<FileSystem.FileSystem>;
}

const isWithin = (path: Path.Path, root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

/** Only an absolute path without `..` or `~`: resolved lexically, it could name another place. */
export const isPlainAbsolute = (path: Path.Path, directory: string) =>
  path.isAbsolute(directory) &&
  !directory.startsWith("~") &&
  !directory.split(/[\\/]/u).includes("..");

/**
 * Where a path leads once its links resolve: its deepest existing ancestor's real path, with the
 * rest as named. Lexical where the server has no filesystem.
 */
export const realOf = Effect.fn("directoryRoots.realOf")(function* (
  { path, fileSystem }: DirectoryServices,
  candidate: string,
) {
  const resolved = path.resolve(candidate);
  if (Option.isNone(fileSystem)) return resolved;
  let existing = resolved;
  const rest: Array<string> = [];
  while (true) {
    const real = yield* fileSystem.value.realPath(existing).pipe(Effect.option);
    if (Option.isSome(real)) return path.join(real.value, ...rest);
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
});

/** Whether `directory` leads inside one of `roots`, links resolved on both sides. */
export const withinRoots = Effect.fn("directoryRoots.withinRoots")(function* (
  services: DirectoryServices,
  roots: ReadonlyArray<string>,
  directory: string,
) {
  if (!isPlainAbsolute(services.path, directory)) return false;
  const target = yield* realOf(services, directory);
  for (const root of roots) {
    if (isWithin(services.path, yield* realOf(services, root), target)) return true;
  }
  return false;
});

const exists = (services: DirectoryServices, target: string) =>
  Option.isSome(services.fileSystem)
    ? services.fileSystem.value.exists(target).pipe(Effect.orElseSucceed(() => true))
    : Effect.succeed(false);

/**
 * Whether `directory` is a new folder right in `sharedRoot` that no Project holds: its parent,
 * links resolved, is where the path names it and is the shared root itself.
 */
export const isNewFolderIn = Effect.fn("directoryRoots.isNewFolderIn")(function* (
  services: DirectoryServices,
  sql: SqlClient.SqlClient,
  directory: string,
  sharedRoots: ReadonlyArray<string>,
) {
  const { path } = services;
  if (!isPlainAbsolute(path, directory)) return false;
  const target = yield* realOf(services, directory);
  const realParent = yield* realOf(services, path.dirname(path.resolve(directory)));
  if (path.dirname(target) !== realParent) return false;
  if (yield* exists(services, target)) return false;
  let inSharedRoot = false;
  for (const root of sharedRoots) {
    if ((yield* realOf(services, root)) === realParent) inSharedRoot = true;
  }
  if (!inSharedRoot) return false;
  const projectRoots = yield* sql<{ readonly root: string }>`
    SELECT workspace_root AS root FROM projection_projects WHERE deleted_at IS NULL
  `.pipe(Effect.orDie);
  return !(yield* withinRoots(
    services,
    projectRoots.map((row) => row.root),
    directory,
  ));
});

/** The Hub's Projects folder, where Members create Projects and clone. */
export const projectsRootOf = (path: Path.Path, baseDir: string) =>
  path.resolve(baseDir, "projects");

/**
 * Whether a Thread of the Project at `projectRoot` may record `worktreePath` as its folder: inside
 * the Project, or a linked worktree of the repository the Project is in (its `.git` file names a
 * worktree entry of that repository, and the entry names it back).
 */
export const isProjectWorktree = Effect.fn("directoryRoots.isProjectWorktree")(function* (
  services: DirectoryServices,
  projectRoot: string,
  worktreePath: string,
) {
  const { path } = services;
  if (!isPlainAbsolute(path, worktreePath)) return false;
  if (yield* withinRoots(services, [projectRoot], worktreePath)) return true;
  if (Option.isNone(services.fileSystem)) return false;
  const fileSystem = services.fileSystem.value;
  const read = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.map((text) => text.trim()),
      Effect.option,
    );
  const worktree = yield* realOf(services, worktreePath);
  const pointer = yield* read(path.join(worktree, ".git"));
  if (Option.isNone(pointer) || !pointer.value.startsWith("gitdir:")) return false;
  const entry = yield* realOf(
    services,
    path.resolve(worktree, pointer.value.slice("gitdir:".length).trim()),
  );
  // The repository the Project's folder is in (a Project can be a folder inside it, or itself a
  // linked worktree): the first `.git` up from its root, through `commondir` for a worktree.
  let common: string | undefined;
  for (let directory = yield* realOf(services, projectRoot); common === undefined;) {
    const dotGit = path.join(directory, ".git");
    const info = yield* fileSystem.stat(dotGit).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "Directory") common = dotGit;
    else if (Option.isSome(info)) {
      const own = yield* read(dotGit);
      if (Option.isNone(own) || !own.value.startsWith("gitdir:")) return false;
      const gitDir = path.resolve(directory, own.value.slice("gitdir:".length).trim());
      const shared = yield* read(path.join(gitDir, "commondir"));
      common = Option.isSome(shared) ? path.resolve(gitDir, shared.value) : gitDir;
    } else {
      const parent = path.dirname(directory);
      if (parent === directory) return false;
      directory = parent;
    }
  }
  const entries = yield* realOf(services, path.join(common, "worktrees"));
  if (path.dirname(entry) !== entries) return false;
  const back = yield* read(path.join(entry, "gitdir"));
  if (Option.isNone(back)) return false;
  return (yield* realOf(services, path.resolve(entry, back.value))) === path.join(worktree, ".git");
});
