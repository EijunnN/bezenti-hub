/**
 * The machine's half of moving a Thread to it (`docs/internals/overview.md`, «Moving a Thread»):
 * fetch what the Thread continues from out of the Hub repository, then make the Thread's branch
 * or worktree there, lay the checkpoint's files over it and run the Project's setup script. Both
 * the Hub machine's executor and a joined machine's agent run these, so there is one path.
 */
import { CheckpointRef, ProjectId, VcsProcessExitError } from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import type { CheckpointStoreError } from "../checkpointing/Errors.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";

const SETUP_SCRIPT_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_TAIL_CHARS = 1_500;

/** Downloads `refs` from the Hub repository into the Project's checkout on the machine. */
export const MoveFetchInput = Schema.Struct({
  projectId: ProjectId,
  refs: Schema.Array(CheckpointRef),
});
export type MoveFetchInput = typeof MoveFetchInput.Type;

export const MoveFetchResult = Schema.Struct({
  /** The Project's checkout on the machine, made (cloned) when it had none. */
  checkout: Schema.String,
});
export type MoveFetchResult = typeof MoveFetchResult.Type;

export const MovePrepareInput = Schema.Struct({
  /** The Project's checkout on the machine, as `move.fetch` answered it. */
  checkout: Schema.String,
  /** The checkpoint whose files the workspace takes; none keeps the checkout as it is. */
  ref: Schema.NullOr(CheckpointRef),
  /** The Thread's branch: made, or moved, to the commit the checkpoint was captured on. */
  branch: Schema.NullOr(Schema.String),
  /**
   * The Thread works in a worktree: at `path` when the machine already has it there (it ran
   * here before), else a new one named `name` in this machine's worktrees folder.
   */
  worktree: Schema.NullOr(
    Schema.Struct({ name: Schema.String, path: Schema.NullOr(Schema.String) }),
  ),
  /** Where state the workspace had is kept before it is replaced (`refs/t3/recovered/<id>/`). */
  setAsidePrefix: Schema.String,
  /** The Project's setup script, run in the workspace once it is ready. */
  setupScript: Schema.NullOr(Schema.Struct({ name: Schema.String, command: Schema.String })),
});
export type MovePrepareInput = typeof MovePrepareInput.Type;

export const MovePrepareResult = Schema.Struct({
  /** The Thread's workspace on the machine: its worktree, else the Project's checkout. */
  cwd: Schema.String,
  /** Refs holding what the workspace had before, so nothing there is lost. */
  setAsideRefs: Schema.Array(Schema.String),
  setupScript: Schema.Literals(["none", "succeeded"]),
});
export type MovePrepareResult = typeof MovePrepareResult.Type;

const failed = (operation: string, cwd: string, detail: string, exitCode = 1) =>
  new VcsProcessExitError({ operation, command: "git", cwd, exitCode, detail });

const tail = (text: string) =>
  text.length <= OUTPUT_TAIL_CHARS ? text : `…${text.slice(text.length - OUTPUT_TAIL_CHARS)}`;

/** A file-system- and git-ref-safe name for a worktree folder. */
const safeName = (name: string) =>
  name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "thread";

export const prepareMovedWorkspace = Effect.fn("MovedWorkspace.prepare")(function* (
  deps: {
    readonly vcs: VcsProcess.VcsProcess["Service"];
    readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    /** Where this machine keeps the worktrees it makes. */
    readonly worktreesDir: string;
    readonly platform: string;
  },
  input: MovePrepareInput,
): Effect.fn.Return<MovePrepareResult, CheckpointStoreError> {
  const operation = "MovedWorkspace.prepare";
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    deps.vcs.run({ operation, command: "git", cwd, args, allowNonZeroExit: true });
  const gitOk = Effect.fn("MovedWorkspace.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    const output = yield* git(cwd, args);
    if (output.exitCode !== 0) {
      return yield* failed(
        operation,
        cwd,
        `git ${args[0]} failed: ${output.stderr.trim().slice(0, 1_000) || "no output"}`,
        output.exitCode,
      );
    }
    return output.stdout.trim();
  });
  const exists = (target: string) =>
    deps.fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));

  if (!(yield* exists(input.checkout))) {
    return yield* failed(
      operation,
      input.checkout,
      "The Project's checkout is not on this machine.",
    );
  }
  // The commit the checkpoint was captured on (its parent): the Thread's branch points there.
  const base =
    input.ref === null
      ? null
      : yield* git(input.checkout, ["rev-parse", "--verify", "--quiet", `${input.ref}^1`]).pipe(
          Effect.map((output) => (output.exitCode === 0 ? output.stdout.trim() : null)),
        );
  const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
  const setAsideRefs: Array<string> = [];

  let cwd = input.checkout;
  let fresh = false;
  if (input.worktree !== null) {
    const known = input.worktree.path;
    if (known !== null && (yield* exists(known))) {
      cwd = known;
    } else {
      const repository = deps.path.basename(input.checkout);
      cwd = deps.path.join(deps.worktreesDir, safeName(repository), safeName(input.worktree.name));
      if (yield* exists(cwd)) {
        // A folder of that name from before: use it if it is a worktree of this checkout.
        const inside = yield* git(cwd, ["rev-parse", "--is-inside-work-tree"]);
        if (inside.exitCode !== 0) {
          return yield* failed(operation, cwd, `${cwd} already exists and is not a git worktree.`);
        }
      } else {
        yield* deps.fileSystem
          .makeDirectory(deps.path.dirname(cwd), { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              failed(
                operation,
                cwd,
                `Could not create ${deps.path.dirname(cwd)}: ${cause.message}`,
              ),
            ),
          );
        const start = base ?? "HEAD";
        const added = yield* git(input.checkout, [
          "worktree",
          "add",
          ...(input.branch === null ? ["--detach", cwd, start] : ["-B", input.branch, cwd, start]),
        ]);
        if (added.exitCode !== 0) {
          // The branch may be checked out elsewhere on this machine: the worktree goes detached.
          yield* gitOk(input.checkout, ["worktree", "add", "--detach", cwd, start]);
        }
        fresh = true;
      }
    }
  }

  if (!fresh) {
    // Whatever the workspace holds that HEAD does not is kept in a ref before it is replaced.
    const status = yield* gitOk(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
    if (status.length > 0) {
      const ref = CheckpointRef.make(`${input.setAsidePrefix}${stamp}`);
      yield* deps.checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });
      setAsideRefs.push(ref);
    }
    if (input.branch !== null && base !== null) {
      const tip = yield* git(cwd, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${input.branch}`,
      ]).pipe(Effect.map((output) => (output.exitCode === 0 ? output.stdout.trim() : null)));
      if (tip !== null && tip !== base) {
        const contained = yield* git(cwd, ["merge-base", "--is-ancestor", tip, base]);
        if (contained.exitCode !== 0) {
          // The branch has commits here the source never had: keep them before moving it.
          const ref = `${input.setAsidePrefix}${stamp}-branch`;
          yield* gitOk(cwd, ["update-ref", ref, tip]);
          setAsideRefs.push(ref);
        }
      }
      yield* gitOk(cwd, ["checkout", "--force", "-B", input.branch, base]);
    }
  }

  if (input.ref !== null) {
    const restored = yield* deps.checkpoints.restoreCheckpoint({ cwd, checkpointRef: input.ref });
    if (!restored) {
      return yield* failed(operation, cwd, `The checkpoint ${input.ref} is not in this checkout.`);
    }
  }

  if (input.setupScript === null) return { cwd, setAsideRefs, setupScript: "none" as const };
  const shell =
    deps.platform === "win32"
      ? { command: "cmd.exe", args: ["/d", "/s", "/c", input.setupScript.command] }
      : { command: "sh", args: ["-c", input.setupScript.command] };
  const ran = yield* deps.vcs.run({
    operation: "MovedWorkspace.setupScript",
    command: shell.command,
    args: shell.args,
    cwd,
    env: {
      ...process.env,
      ...projectScriptRuntimeEnv({
        project: { cwd: input.checkout },
        worktreePath: cwd === input.checkout ? null : cwd,
      }),
    },
    allowNonZeroExit: true,
    timeoutMs: SETUP_SCRIPT_TIMEOUT_MS,
  });
  if (ran.exitCode !== 0) {
    const output = `${ran.stdout}\n${ran.stderr}`.trim();
    return yield* new VcsProcessExitError({
      operation: "MovedWorkspace.setupScript",
      command: input.setupScript.name,
      cwd,
      exitCode: ran.exitCode,
      detail: `The setup script "${input.setupScript.name}" failed with exit code ${ran.exitCode}${
        output.length === 0 ? "." : `:\n${tail(output)}`
      }`,
    });
  }
  return { cwd, setAsideRefs, setupScript: "succeeded" as const };
});
