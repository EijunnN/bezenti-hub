/**
 * A Thread without a Project works in its own folder under the scratch Project's checkout, a git
 * repository of its own whose checkpoints go to the Thread's own Hub repository. See
 * docs/internals/overview.md, «Threads without a Project».
 */
import { CheckpointRef, VcsProcessExitError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import type { CheckpointStoreError } from "../checkpointing/Errors.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";

/** The folder under the base dir where Threads without a Project keep their workspaces. */
const SCRATCH_FOLDER = "scratch";

export const scratchRootOf = (path: Path.Path, baseDir: string) =>
  path.resolve(baseDir, SCRATCH_FOLDER);

/** Whether a Project's workspace root is the scratch folder, so its Threads have no Project. */
export const isScratchWorkspaceRoot = (path: Path.Path, baseDir: string, workspaceRoot: string) =>
  path.resolve(workspaceRoot) === scratchRootOf(path, baseDir);

/**
 * The folder name of a Thread's scratch workspace, from its worktree path on any machine (a
 * moved Thread's path is the machine it left's, which may use the other separator).
 */
export const scratchFolderName = (worktreePath: string) =>
  worktreePath.split(/[\\/]+/).findLast((part) => part.length > 0) ?? null;

/**
 * A Thread's scratch workspace under the scratch folder `root`: `folder` is one plain folder name
 * (the Thread's, as its worktree path ends), never a path that leaves `root`. Null otherwise.
 */
export const scratchFolderIn = (path: Pick<Path.Path, "join">, root: string, folder: string) =>
  folder.length === 0 ||
  folder === "." ||
  folder === ".." ||
  folder.includes("/") ||
  folder.includes("\\") ||
  folder.includes("\0")
    ? null
    : path.join(root, folder);

const failed = (operation: string, cwd: string, detail: string, exitCode = 1) =>
  new VcsProcessExitError({ operation, command: "git", cwd, exitCode, detail });

/**
 * Makes the folder, and a git repository in it when it is not one already: a scratch workspace's
 * checkpoints are hidden refs there. Nothing else in it is changed.
 */
export const ensureScratchRepository = Effect.fn("ScratchWorkspace.ensureRepository")(function* (
  deps: {
    readonly vcs: VcsProcess.VcsProcess["Service"];
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Pick<Path.Path, "join">;
  },
  folder: string,
) {
  const operation = "ScratchWorkspace.ensureRepository";
  yield* deps.fileSystem
    .makeDirectory(folder, { recursive: true })
    .pipe(
      Effect.mapError((cause) =>
        failed(operation, folder, `Could not create ${folder}: ${cause.message}`),
      ),
    );
  const hasGit = yield* deps.fileSystem
    .exists(deps.path.join(folder, ".git"))
    .pipe(Effect.orElseSucceed(() => false));
  if (hasGit) return;
  const output = yield* deps.vcs.run({
    operation,
    command: "git",
    cwd: folder,
    args: ["init", "--quiet"],
    allowNonZeroExit: true,
    timeoutMs: 30_000,
  });
  if (output.exitCode !== 0) {
    return yield* failed(
      operation,
      folder,
      `git init failed: ${output.stderr.trim().slice(0, 1_000) || "no output"}`,
      output.exitCode,
    );
  }
});

/**
 * A move's `preparing` step for a scratch workspace: the Thread keeps working in its own folder
 * (made by `move.fetch`), never a worktree, and there is no setup script. What a folder it had
 * here before holds is kept under `<setAsidePrefix><time>/workspace` before the checkpoint's
 * files are laid over it.
 */
export const prepareScratchWorkspace = Effect.fn("ScratchWorkspace.prepare")(function* (
  deps: {
    readonly vcs: VcsProcess.VcsProcess["Service"];
    readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
  },
  input: {
    readonly workspace: string;
    readonly ref: CheckpointRef | null;
    readonly setAsidePrefix: string;
  },
): Effect.fn.Return<
  { readonly cwd: string; readonly setAsideRefs: ReadonlyArray<string> },
  CheckpointStoreError
> {
  const operation = "ScratchWorkspace.prepare";
  const cwd = input.workspace;
  const status = yield* deps.vcs.run({
    operation,
    command: "git",
    cwd,
    args: ["status", "--porcelain", "--untracked-files=normal"],
    allowNonZeroExit: true,
  });
  if (status.exitCode !== 0) {
    return yield* failed(
      operation,
      cwd,
      `The Thread's folder is not a git repository: ${status.stderr.trim().slice(0, 1_000)}`,
      status.exitCode,
    );
  }
  const setAsideRefs: Array<string> = [];
  if (status.stdout.trim().length > 0) {
    const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
    const ref = CheckpointRef.make(`${input.setAsidePrefix}${stamp}/workspace`);
    yield* deps.checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });
    setAsideRefs.push(ref);
  }
  if (input.ref !== null) {
    const restored = yield* deps.checkpoints.restoreCheckpoint({ cwd, checkpointRef: input.ref });
    if (!restored) {
      return yield* failed(operation, cwd, `The checkpoint ${input.ref} is not in this folder.`);
    }
  }
  return { cwd, setAsideRefs };
});
