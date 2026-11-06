/**
 * The machine's half of moving a Thread to it (`docs/internals/overview.md`, «Moving a Thread»):
 * fetch what the Thread continues from, then give the Thread its own worktree there, never the
 * Project's shared checkout. Both the Hub machine's executor and a joined machine's agent run it.
 */
import { CheckpointRef, ProjectId, ThreadId, VcsProcessExitError } from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import type { CheckpointStoreError } from "../checkpointing/Errors.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ScratchWorkspace from "./ScratchWorkspace.ts";

const SETUP_SCRIPT_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_TAIL_CHARS = 4_000;

/** Downloads `refs` from the Hub repository into the Project's checkout on the machine. */
export const MoveFetchInput = Schema.Struct({
  projectId: ProjectId,
  refs: Schema.Array(CheckpointRef),
  /**
   * A Thread without a Project: its scratch workspace, `folder` under the scratch Project's
   * checkout, is made (with git) instead of the checkout, and fetches from the Thread's own
   * repository. `move.fetch` answers that folder as the checkout.
   */
  scratch: Schema.optionalKey(Schema.Struct({ threadId: ThreadId, folder: Schema.String })),
});
export type MoveFetchInput = typeof MoveFetchInput.Type;

export const MoveFetchResult = Schema.Struct({
  /** The Project's checkout on the machine, made (cloned) when it had none. */
  checkout: Schema.String,
});
export type MoveFetchResult = typeof MoveFetchResult.Type;

export const MovePrepareInput = Schema.Struct({
  /** The Project's checkout on the machine, as `move.fetch` answered it. It is never changed. */
  checkout: Schema.String,
  projectId: ProjectId,
  threadId: ThreadId,
  /** The checkpoint whose files the worktree takes; none starts it at the checkout's HEAD. */
  ref: Schema.NullOr(CheckpointRef),
  /** The Thread's branch, made or moved to the commit the checkpoint was captured on. */
  branch: Schema.NullOr(Schema.String),
  /** A worktree the Thread had on this machine before; reused only if this checkout lists it. */
  knownWorktree: Schema.NullOr(Schema.String),
  /** Where state the machine had is kept before it is replaced (`refs/t3/recovered/<id>/`). */
  setAsidePrefix: Schema.String,
  /** The Project's setup script, run in a new worktree once it is ready. */
  setupScript: Schema.NullOr(Schema.Struct({ name: Schema.String, command: Schema.String })),
  /** `checkout` is a Thread's scratch workspace: the Thread works in it, never in a worktree. */
  scratch: Schema.optionalKey(Schema.Boolean),
});
export type MovePrepareInput = typeof MovePrepareInput.Type;

export const MovePrepareResult = Schema.Struct({
  /** The Thread's worktree on the machine. */
  cwd: Schema.String,
  /** Refs holding what the machine had before (a branch, a reused worktree's changes). */
  setAsideRefs: Schema.Array(Schema.String),
  /** The Thread's branch is checked out elsewhere on the machine, so its worktree is detached. */
  detached: Schema.Boolean,
  setupScript: Schema.Struct({
    status: Schema.Literals(["none", "skipped", "succeeded"]),
    name: Schema.optionalKey(Schema.String),
    output: Schema.optionalKey(Schema.String),
  }),
});
export type MovePrepareResult = typeof MovePrepareResult.Type;

const failed = (operation: string, cwd: string, detail: string, exitCode = 1) =>
  new VcsProcessExitError({ operation, command: "git", cwd, exitCode, detail });

const tail = (text: string) =>
  text.length <= OUTPUT_TAIL_CHARS ? text : `…${text.slice(text.length - OUTPUT_TAIL_CHARS)}`;

/** A file-system- and git-ref-safe name. */
const safeName = (name: string) =>
  name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "x";

/** Distinct for ids that read alike once made safe. */
const shortHash = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/** `<worktrees>/<project>/<thread>`, from ids, so two Projects in folders alike never collide. */
export const movedWorktreePath = (
  path: Path.Path,
  worktreesDir: string,
  projectId: string,
  threadId: string,
) =>
  path.join(
    worktreesDir,
    `${safeName(projectId).slice(0, 48)}-${shortHash(projectId)}`,
    `${safeName(threadId).slice(-24)}-${shortHash(threadId)}`,
  );

interface ListedWorktree {
  readonly path: string;
  readonly branch: string | null;
}

const parseWorktrees = (porcelain: string): ReadonlyArray<ListedWorktree> =>
  porcelain
    .split("\n\n")
    .map((block) => block.split("\n"))
    .flatMap((lines) => {
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      if (path === undefined) return [];
      const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
      return [{ path, branch: branch ?? null }];
    });

export const prepareMovedWorkspace = Effect.fn("MovedWorkspace.prepare")(function* (
  deps: {
    readonly vcs: VcsProcess.VcsProcess["Service"];
    readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    /** Where this machine keeps the worktrees it makes. */
    readonly worktreesDir: string;
    readonly platform: string;
    /** The environment the setup script gets, as a terminal's (normal setup runs in one). */
    readonly scriptEnv: (runtimeEnv: Record<string, string>) => NodeJS.ProcessEnv;
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
  const revision = (cwd: string, name: string) =>
    git(cwd, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]).pipe(
      Effect.map((output) => (output.exitCode === 0 ? output.stdout.trim() : null)),
    );
  const exists = (target: string) =>
    deps.fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  const normalize = (target: string) => deps.path.resolve(target);

  const checkout = input.checkout;
  if (!(yield* exists(checkout))) {
    return yield* failed(operation, checkout, "The Project's checkout is not on this machine.");
  }
  if (input.scratch === true) {
    const prepared = yield* ScratchWorkspace.prepareScratchWorkspace(deps, {
      workspace: checkout,
      ref: input.ref,
      setAsidePrefix: input.setAsidePrefix,
    });
    return {
      cwd: prepared.cwd,
      setAsideRefs: [...prepared.setAsideRefs],
      detached: false,
      setupScript: { status: "none" as const },
    };
  }
  // The commit the checkpoint was captured on (its parent), else the checkout's HEAD.
  const base =
    (input.ref === null ? null : yield* revision(checkout, `${input.ref}^1`)) ??
    (yield* revision(checkout, "HEAD"));
  if (base === null) {
    return yield* failed(
      operation,
      checkout,
      "The Project's checkout has no commit to start from.",
    );
  }
  const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
  const setAsideRefs: Array<string> = [];

  // Only a worktree this checkout itself lists is ever reused.
  const listed = parseWorktrees(yield* gitOk(checkout, ["worktree", "list", "--porcelain"]));
  const isListed = (target: string) =>
    listed.some((worktree) => normalize(worktree.path) === normalize(target));
  const planned = movedWorktreePath(deps.path, deps.worktreesDir, input.projectId, input.threadId);
  const reuse =
    input.knownWorktree !== null && isListed(input.knownWorktree)
      ? input.knownWorktree
      : isListed(planned)
        ? planned
        : null;
  const cwd = reuse ?? planned;
  if (reuse === null && (yield* exists(planned))) {
    return yield* failed(
      operation,
      planned,
      `${planned} already exists and is not a worktree of this Project's checkout.`,
    );
  }

  // A branch the machine had that the source's commit does not contain is kept first.
  let detached = false;
  if (input.branch !== null) {
    const tip = yield* revision(checkout, `refs/heads/${input.branch}`);
    if (tip !== null && tip !== base) {
      const contained = yield* git(checkout, ["merge-base", "--is-ancestor", tip, base]);
      if (contained.exitCode !== 0) {
        const ref = `${input.setAsidePrefix}${stamp}/branch/${input.branch}`;
        yield* gitOk(checkout, ["update-ref", ref, tip]);
        setAsideRefs.push(ref);
      }
    }
    // A branch checked out in another worktree (the shared checkout's own) cannot move here.
    detached = listed.some(
      (worktree) =>
        worktree.branch === `refs/heads/${input.branch}` &&
        normalize(worktree.path) !== normalize(cwd),
    );
  }
  const branchArgs = input.branch === null || detached ? ["--detach"] : ["-B", input.branch];

  const created = reuse === null;
  const work = Effect.gen(function* () {
    if (created) {
      yield* deps.fileSystem
        .makeDirectory(deps.path.dirname(cwd), { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            failed(operation, cwd, `Could not create ${deps.path.dirname(cwd)}: ${cause.message}`),
          ),
        );
      yield* gitOk(checkout, ["worktree", "add", "--quiet", ...branchArgs, cwd, base]);
    } else {
      // What the reused worktree holds that its HEAD does not is kept before it is replaced.
      const status = yield* gitOk(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
      if (status.length > 0) {
        const ref = CheckpointRef.make(`${input.setAsidePrefix}${stamp}/workspace`);
        yield* deps.checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });
        setAsideRefs.push(ref);
      }
      yield* gitOk(cwd, [
        "checkout",
        "--force",
        "--quiet",
        ...(branchArgs[0] === "-B" ? branchArgs : ["--detach"]),
        base,
      ]);
    }
    if (input.ref !== null) {
      const restored = yield* deps.checkpoints.restoreCheckpoint({ cwd, checkpointRef: input.ref });
      if (!restored) {
        return yield* failed(
          operation,
          cwd,
          `The checkpoint ${input.ref} is not in this checkout.`,
        );
      }
    }
    // A worktree the Thread already had here was set up when it was made.
    if (input.setupScript === null) return { status: "none" as const };
    if (!created) return { status: "skipped" as const, name: input.setupScript.name };
    const shell =
      deps.platform === "win32"
        ? { command: "cmd.exe", args: ["/d", "/s", "/c", input.setupScript.command] }
        : { command: "sh", args: ["-c", input.setupScript.command] };
    const ran = yield* deps.vcs.run({
      operation: "MovedWorkspace.setupScript",
      command: shell.command,
      args: shell.args,
      cwd,
      env: deps.scriptEnv(
        projectScriptRuntimeEnv({ project: { cwd: checkout }, worktreePath: cwd }),
      ),
      allowNonZeroExit: true,
      timeoutMs: SETUP_SCRIPT_TIMEOUT_MS,
    });
    const output = tail(`${ran.stdout}\n${ran.stderr}`.trim());
    if (ran.exitCode !== 0) {
      return yield* new VcsProcessExitError({
        operation: "MovedWorkspace.setupScript",
        command: input.setupScript.name,
        cwd,
        exitCode: ran.exitCode,
        detail: `The setup script "${input.setupScript.name}" failed with exit code ${ran.exitCode}${
          output.length === 0 ? "." : `:\n${output}`
        }`,
      });
    }
    return { status: "succeeded" as const, name: input.setupScript.name, output };
  });
  // A worktree this move made goes again if anything after it fails.
  const setupScript = yield* work.pipe(
    Effect.tapError(() =>
      created
        ? git(checkout, ["worktree", "remove", "--force", cwd]).pipe(Effect.ignore)
        : Effect.void,
    ),
  );
  return { cwd, setAsideRefs, detached, setupScript };
});
