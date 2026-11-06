/**
 * A Thread without a Project works in its own folder under the scratch Project's checkout, a git
 * repository of its own whose checkpoints go to the Thread's own Hub repository. See
 * docs/internals/overview.md, «Threads without a Project».
 */
import {
  CheckpointRef,
  type ProjectId,
  type ThreadId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import type { CheckpointStoreError } from "../checkpointing/Errors.ts";
import type { HubRepositoryKey } from "../checkpointing/HubRepository.ts";
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

export class ScratchThreadReadError extends Schema.TaggedError<ScratchThreadReadError>()(
  "ScratchThreadReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read whether the Thread has a Project; it is tried again later.";
  }
}

/** Where a Thread's checkpoints go, and, for a Thread without a Project, its folder. */
export interface ThreadRepository {
  readonly key: HubRepositoryKey;
  /** Set only for a Thread without a Project; `folder` is null when it has no folder of its own. */
  readonly scratch?: { readonly threadId: ThreadId; readonly folder: string | null };
}

/**
 * The one place that decides whether a Thread has no Project, which folder it works in and which
 * Hub repository it uses. A Project's being the scratch one is read once and kept: its workspace
 * root never changes (a promotion makes a new Project).
 */
export const makeScratchThreads = (deps: {
  readonly sql: SqlClient.SqlClient;
  readonly path: Path.Path;
  readonly baseDir: string;
}) => {
  const known = new Map<string, boolean>();
  const read = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new ScratchThreadReadError({ cause })));

  const isScratchProject = Effect.fn("ScratchThreads.isScratchProject")(function* (
    projectId: ProjectId,
  ) {
    const cached = known.get(projectId);
    if (cached !== undefined) return cached;
    const rows = yield* read(deps.sql<{ readonly workspaceRoot: string }>`
      SELECT workspace_root AS "workspaceRoot" FROM projection_projects
      WHERE project_id = ${projectId}
    `);
    const row = rows[0];
    // An unknown Project is not remembered: its row may arrive later.
    if (row === undefined) return false;
    const scratch = isScratchWorkspaceRoot(deps.path, deps.baseDir, row.workspaceRoot);
    known.set(projectId, scratch);
    return scratch;
  });

  /** A new Thread's folder is its scratch workspace: one folder directly in the scratch folder. */
  const isScratchFolder = Effect.fn("ScratchThreads.isScratchFolder")(function* (
    projectId: ProjectId,
    worktreePath: string,
  ) {
    return (
      (yield* isScratchProject(projectId)) &&
      deps.path.dirname(deps.path.resolve(worktreePath)) === scratchRootOf(deps.path, deps.baseDir)
    );
  });

  /** None for a Thread the Hub does not have. */
  const repositoryOfThread = Effect.fn("ScratchThreads.repositoryOfThread")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* read(deps.sql<{
      readonly projectId: string;
      readonly worktreePath: string | null;
    }>`
      SELECT project_id AS "projectId",
        json_extract(payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `);
    const row = rows[0];
    if (row === undefined) return Option.none<ThreadRepository>();
    const projectId = row.projectId as ProjectId;
    if (!(yield* isScratchProject(projectId))) {
      return Option.some<ThreadRepository>({ key: { projectId } });
    }
    return Option.some<ThreadRepository>({
      key: { projectId, scratchThreadId: threadId },
      scratch: {
        threadId,
        folder: row.worktreePath === null ? null : scratchFolderName(row.worktreePath),
      },
    });
  });

  /**
   * A Thread without a Project's own repository and folder name, kept on every machine; undefined
   * for a Thread in a Project. Fails when it cannot tell, or the Thread has no folder of its own
   * (it would otherwise work in, and upload, the folder every such Thread shares).
   */
  const scratchWorkspaceOf = Effect.fn("ScratchThreads.scratchWorkspaceOf")(function* (
    threadId: ThreadId,
  ) {
    const scratch = Option.getOrUndefined(yield* repositoryOfThread(threadId))?.scratch;
    if (scratch === undefined) return undefined;
    if (scratch.folder === null) return yield* new ScratchFolderMissingError({ threadId });
    return { threadId: scratch.threadId, folder: scratch.folder };
  });

  return { isScratchProject, isScratchFolder, repositoryOfThread, scratchWorkspaceOf };
};
export type ScratchThreads = ReturnType<typeof makeScratchThreads>;

export class ScratchFolderMissingError extends Schema.TaggedError<ScratchFolderMissingError>()(
  "ScratchFolderMissingError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return "This Thread without a Project has no folder of its own, so it cannot run elsewhere.";
  }
}

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
  const output = yield* deps.vcs
    .run({
      operation,
      command: "git",
      cwd: folder,
      args: ["init", "--quiet"],
      allowNonZeroExit: true,
      timeoutMs: 30_000,
    })
    .pipe(
      Effect.mapError((cause) =>
        failed(
          operation,
          folder,
          `This Thread's folder has no git repository and git could not make one: ${cause.message}`,
        ),
      ),
    );
  if (output.exitCode !== 0) {
    return yield* failed(
      operation,
      folder,
      `This Thread's folder has no git repository and git could not make one: ${
        output.stderr.trim().slice(0, 1_000) || "no output"
      }`,
      output.exitCode,
    );
  }
});

const git = (vcs: VcsProcess.VcsProcess["Service"], operation: string, cwd: string) =>
  Effect.fn("ScratchWorkspace.git")(function* (args: ReadonlyArray<string>) {
    const output = yield* vcs.run({
      operation,
      command: "git",
      cwd,
      args,
      allowNonZeroExit: true,
    });
    if (output.exitCode !== 0) {
      return yield* failed(
        operation,
        cwd,
        `git ${args[0]} failed: ${output.stderr.trim().slice(0, 1_000) || "no output"}`,
        output.exitCode,
      );
    }
    return output.stdout;
  });

/**
 * The source's half of moving a scratch workspace's own git history: each branch is copied to
 * `<prefix>heads/<branch>` and the branch HEAD is on to `<prefix>HEAD/<branch>`, for the caller
 * to push to the Thread's Hub repository. Repositories nested in the folder are named: their
 * contents are in no checkpoint, so they do not move.
 */
export const publishScratchHistory = Effect.fn("ScratchWorkspace.publish")(function* (
  deps: {
    readonly vcs: VcsProcess.VcsProcess["Service"];
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Pick<Path.Path, "join">;
  },
  input: { readonly cwd: string; readonly prefix: string },
) {
  const run = git(deps.vcs, "ScratchWorkspace.publish", input.cwd);
  const refs: Array<CheckpointRef> = [];
  const branches = (yield* run(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name = "", oid = ""] = line.split(" ");
      return { branch: name.slice("refs/heads/".length), oid };
    });
  for (const { branch, oid } of branches) {
    const ref = CheckpointRef.make(`${input.prefix}heads/${branch}`);
    yield* run(["update-ref", ref, oid]);
    refs.push(ref);
  }
  const head = yield* deps.vcs.run({
    operation: "ScratchWorkspace.publish",
    command: "git",
    cwd: input.cwd,
    args: ["symbolic-ref", "-q", "HEAD"],
    allowNonZeroExit: true,
  });
  const headBranch = head.stdout.trim().replace(/^refs\/heads\//, "");
  const headTip = branches.find((entry) => entry.branch === headBranch);
  if (head.exitCode === 0 && headTip !== undefined) {
    const ref = CheckpointRef.make(`${input.prefix}HEAD/${headBranch}`);
    yield* run(["update-ref", ref, headTip.oid]);
    refs.push(ref);
  }
  // Untracked folders that are repositories of their own, and gitlinks.
  const nested: Array<string> = [];
  const untracked = yield* run(["ls-files", "--others", "--directory", "-z"]);
  for (const entry of untracked.split("\0")) {
    if (!entry.endsWith("/")) continue;
    const folder = entry.slice(0, -1);
    if (
      yield* deps.fileSystem
        .exists(deps.path.join(input.cwd, folder, ".git"))
        .pipe(Effect.orElseSucceed(() => false))
    ) {
      nested.push(folder);
    }
  }
  for (const line of (yield* run(["ls-files", "--stage"])).split("\n")) {
    if (line.startsWith("160000 ")) nested.push(line.split("\t")[1] ?? "");
  }
  return { refs, nested: nested.filter((folder) => folder.length > 0) };
});

/**
 * A move's `preparing` step for a scratch folder (no worktree, no setup script). What it had here
 * is kept under `<setAsidePrefix><time>/` (`workspace`, `branch/<name>`), then the source's
 * branches and HEAD (fetched under `history`) and the checkpoint's files are laid over it.
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
    readonly history: string | undefined;
  },
): Effect.fn.Return<
  { readonly cwd: string; readonly setAsideRefs: ReadonlyArray<string> },
  CheckpointStoreError
> {
  const operation = "ScratchWorkspace.prepare";
  const cwd = input.workspace;
  const run = git(deps.vcs, operation, cwd);
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
  const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
  const setAsideRefs: Array<string> = [];
  if (status.stdout.trim().length > 0) {
    const ref = CheckpointRef.make(`${input.setAsidePrefix}${stamp}/workspace`);
    yield* deps.checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });
    setAsideRefs.push(ref);
  }
  if (input.history !== undefined) {
    const fetched = (yield* run([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      input.history,
    ]))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name = "", oid = ""] = line.split(" ");
        return { name: name.slice(input.history!.length), oid };
      });
    for (const { name, oid } of fetched) {
      if (!name.startsWith("heads/")) continue;
      const branch = name.slice("heads/".length);
      const tip = yield* deps.vcs.run({
        operation,
        command: "git",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
        allowNonZeroExit: true,
      });
      const current = tip.exitCode === 0 ? tip.stdout.trim() : null;
      if (current !== null && current !== oid) {
        const contained = yield* deps.vcs.run({
          operation,
          command: "git",
          cwd,
          args: ["merge-base", "--is-ancestor", current, oid],
          allowNonZeroExit: true,
        });
        if (contained.exitCode !== 0) {
          const ref = `${input.setAsidePrefix}${stamp}/branch/${branch}`;
          yield* run(["update-ref", ref, current]);
          setAsideRefs.push(ref);
        }
      }
      yield* run(["update-ref", `refs/heads/${branch}`, oid]);
    }
    const head = fetched.find((entry) => entry.name.startsWith("HEAD/"));
    if (head !== undefined) {
      yield* run(["symbolic-ref", "HEAD", `refs/heads/${head.name.slice("HEAD/".length)}`]);
    }
  }
  if (input.ref !== null) {
    const restored = yield* deps.checkpoints.restoreCheckpoint({ cwd, checkpointRef: input.ref });
    if (!restored) {
      return yield* failed(operation, cwd, `The checkpoint ${input.ref} is not in this folder.`);
    }
  }
  return { cwd, setAsideRefs };
});
