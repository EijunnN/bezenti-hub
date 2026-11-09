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

import { scratchRootOf } from "../environment/ScratchWorkspace.ts";

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

/** The Hub's own folders: its data folder, its Projects folder and its Scratch folder. */
export const hubFoldersOf = (path: Path.Path, baseDir: string) => ({
  data: path.resolve(baseDir),
  projects: projectsRootOf(path, baseDir),
  scratch: scratchRootOf(path, baseDir),
});

/** The Hub's own folders as their links lead, resolved once per check. */
export interface HubFolderReals {
  readonly data: string;
  readonly projects: string;
  readonly scratch: string;
}

export const hubFolderReals = Effect.fn("directoryRoots.hubFolderReals")(function* (
  services: DirectoryServices,
  baseDir: string,
) {
  const folders = hubFoldersOf(services.path, baseDir);
  return {
    data: yield* realOf(services, folders.data),
    projects: yield* realOf(services, folders.projects),
    scratch: yield* realOf(services, folders.scratch),
  } satisfies HubFolderReals;
});

/**
 * Whether a recorded Project root is one today's rule lets a User other than the Owner trust: the
 * Owner's (or from before Users), the Hub-made Scratch root whoever made it, or a folder right in
 * the Hub's Projects or Scratch folder. Read at every check, old rows included.
 */
export const isTrustedProjectRoot = Effect.fn("directoryRoots.isTrustedProjectRoot")(function* (
  services: DirectoryServices,
  root: string,
  byOwner: boolean,
  hub: HubFolderReals | undefined,
) {
  if (byOwner) return true;
  if (hub === undefined || !isPlainAbsolute(services.path, root)) return false;
  const real = yield* realOf(services, root);
  if (real === hub.scratch) return true;
  const parent = services.path.dirname(real);
  return parent === hub.projects || parent === hub.scratch;
});

/** Whether `root` is the Hub's Scratch folder, which no Thread's caller gets whole. */
export const isScratchRoot = Effect.fn("directoryRoots.isScratchRoot")(function* (
  services: DirectoryServices,
  root: string,
  hub: HubFolderReals | undefined,
) {
  return hub !== undefined && (yield* realOf(services, root)) === hub.scratch;
});

/**
 * Whether a path a client names for something kept inside a folder (an icon, a Thread's file)
 * leaves it: absolute, a home (`~`), or climbing out with a `..` segment.
 */
export const leavesFolder = (relative: string) =>
  relative.startsWith("/") ||
  relative.startsWith("\\") ||
  /^[a-zA-Z]:/u.test(relative) ||
  climbsOrHome(relative);

/** Whether a path names a home (`~`) or has a `..` segment, so it is not the place it reads as. */
export const climbsOrHome = (candidate: string) =>
  candidate.startsWith("~") || candidate.split(/[\\/]/u).includes("..");

/**
 * The folder a Thread of the Project at `projectRoot` works in when it records `worktreePath`:
 * the path inside the Project, or the Project's own part of a linked worktree of its repository
 * (so monorepo Projects claim none of each other's). None otherwise, or for a repository holding
 * the Hub's own folders.
 */
export const projectWorktreeRoot = Effect.fn("directoryRoots.projectWorktreeRoot")(function* (
  services: DirectoryServices,
  projectRoot: string,
  worktreePath: string,
  /** The Hub's own folders; without them only a folder inside the Project qualifies. */
  hubFolders: ReadonlyArray<string> | undefined,
) {
  const { path } = services;
  const none = Option.none<string>();
  if (!isPlainAbsolute(path, worktreePath)) return none;
  if (yield* withinRoots(services, [projectRoot], worktreePath)) return Option.some(worktreePath);
  if (Option.isNone(services.fileSystem) || hubFolders === undefined) return none;
  const fileSystem = services.fileSystem.value;
  const read = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.map((text) => text.trim()),
      Effect.option,
    );
  const isDirectory = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
  const gitDirOf = Effect.fn(function* (directory: string) {
    const own = yield* read(path.join(directory, ".git"));
    if (Option.isNone(own) || !own.value.startsWith("gitdir:")) return Option.none<string>();
    return Option.some(path.resolve(directory, own.value.slice("gitdir:".length).trim()));
  });
  // The repository the Project's folder is in: the first `.git` up from its root (through
  // `commondir` when the Project is itself a linked worktree), and that repository's top.
  const realProject = yield* realOf(services, projectRoot);
  let common: string | undefined;
  let top: string | undefined;
  for (let directory = realProject; common === undefined;) {
    if (yield* isDirectory(path.join(directory, ".git"))) {
      common = path.join(directory, ".git");
      top = directory;
    } else {
      const gitDir = yield* gitDirOf(directory);
      if (Option.isSome(gitDir)) {
        const shared = yield* read(path.join(gitDir.value, "commondir"));
        common = Option.isSome(shared) ? path.resolve(gitDir.value, shared.value) : gitDir.value;
        top = directory;
      } else {
        const parent = path.dirname(directory);
        if (parent === directory) return none;
        directory = parent;
      }
    }
  }
  if (top === undefined) return none;
  for (const folder of hubFolders) {
    if (isWithin(path, top, yield* realOf(services, folder))) return none;
  }
  // The linked worktree `worktreePath` is in: the first `.git` file up from it.
  const realWorktree = yield* realOf(services, worktreePath);
  let worktreeTop: string | undefined;
  let entry: string | undefined;
  for (let directory = realWorktree; worktreeTop === undefined;) {
    const gitDir = yield* gitDirOf(directory);
    if (Option.isSome(gitDir)) {
      worktreeTop = directory;
      entry = yield* realOf(services, gitDir.value);
    } else {
      const parent = path.dirname(directory);
      if (parent === directory) return none;
      directory = parent;
    }
  }
  if (entry === undefined) return none;
  const entries = yield* realOf(services, path.join(common, "worktrees"));
  if (path.dirname(entry) !== entries) return none;
  const back = yield* read(path.join(entry, "gitdir"));
  if (Option.isNone(back)) return none;
  if (
    (yield* realOf(services, path.resolve(entry, back.value))) !== path.join(worktreeTop, ".git")
  ) {
    return none;
  }
  const own = path.join(worktreeTop, path.relative(top, realProject));
  // The worktree itself (or a folder above the Project's part) works in the Project's part; a
  // folder inside it, in that folder.
  if (isWithin(path, own, realWorktree)) return Option.some(realWorktree);
  if (isWithin(path, realWorktree, own)) return Option.some(own);
  return none;
});
