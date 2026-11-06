/**
 * The Hub's git repository of each Project, where every Environment uploads its checkpoint refs.
 * Transfers name it by URL or path, never by a remote of the checkout, so nothing reaches
 * `origin`. See docs/internals/overview.md, «Hub repository».
 */
import {
  type CheckpointRef,
  type ProjectId,
  type VcsError,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export const HUB_REPOSITORY_ROUTE_PREFIX = "/api/git";
/** The user name the credential helper answers; the Hub reads only the password. */
const HUB_REPOSITORY_USERNAME = "t3-environment";
const CREDENTIAL_VARIABLE = "T3CODE_HUB_GIT_CREDENTIAL";
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

export const hubRepositoryUrl = (hubUrl: string, projectId: ProjectId) =>
  new URL(`${HUB_REPOSITORY_ROUTE_PREFIX}/${encodeURIComponent(projectId)}`, hubUrl).toString();

/** A repository to push to or fetch from, and what a git process needs in its environment. */
export interface HubRemote {
  readonly url: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The Hub repository over HTTP, with `t3`'s credential helper: it answers the Environment
 * credential from the process environment, never a command line. The empty helper before it drops
 * the user's own helpers, so none of them is asked for the Hub or stores the credential.
 */
export const withEnvironmentCredential = (url: string, credential: string): HubRemote => ({
  url,
  env: {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: `!f() { test "$1" = get && printf 'username=${HUB_REPOSITORY_USERNAME}\\npassword=%s\\n' "$${CREDENTIAL_VARIABLE}"; }; f`,
    [CREDENTIAL_VARIABLE]: credential,
  },
});

/** Git with git's own message on failure; it names the URL, never the credential. */
const gitIn = (
  vcs: VcsProcess.VcsProcess["Service"],
  input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly remote?: HubRemote;
  },
) =>
  vcs
    .run({
      operation: input.operation,
      command: "git",
      cwd: input.cwd,
      args: ["-c", "gc.auto=0", ...input.args],
      ...(input.remote?.env === undefined ? {} : { env: { ...input.remote.env } }),
      timeoutMs: TRANSFER_TIMEOUT_MS,
      allowNonZeroExit: true,
    })
    .pipe(
      Effect.filterOrFail(
        (output) => output.exitCode === 0,
        (output) =>
          new VcsProcessExitError({
            operation: input.operation,
            command: "git",
            cwd: input.cwd,
            exitCode: output.exitCode,
            detail: output.stderr.trim().slice(0, 2_000) || "git failed.",
          }),
      ),
    );

/** The refs among `refs` that the repository at `cwd` (or `gitDir`, a bare one) has. */
const existingRefs = Effect.fn("HubRepository.existingRefs")(function* (
  vcs: VcsProcess.VcsProcess["Service"],
  cwd: string,
  refs: ReadonlyArray<CheckpointRef>,
  gitDir?: string,
) {
  if (refs.length === 0) return new Set<string>();
  const listed = yield* gitIn(vcs, {
    operation: "HubRepository.existingRefs",
    cwd,
    args: [
      ...(gitDir === undefined ? [] : ["--git-dir", gitDir]),
      "for-each-ref",
      "--format=%(refname)",
      ...refs,
    ],
  });
  return new Set(listed.stdout.split("\n").filter((line) => line.length > 0));
});

/** Uploads the refs, replacing what the repository had under the same names. */
export const pushRefs = Effect.fn("HubRepository.pushRefs")(function* (input: {
  readonly cwd: string;
  readonly remote: HubRemote;
  readonly refs: ReadonlyArray<CheckpointRef>;
}) {
  if (input.refs.length === 0) return;
  const vcs = yield* VcsProcess.VcsProcess;
  yield* gitIn(vcs, {
    operation: "HubRepository.push",
    cwd: input.cwd,
    remote: input.remote,
    args: [
      "-c",
      "push.followTags=false",
      "push",
      "--no-verify",
      "--recurse-submodules=no",
      "--quiet",
      input.remote.url,
      ...input.refs.map((ref) => `+${ref}:${ref}`),
    ],
  });
});

/** Downloads the refs the repository at `cwd` lacks; the ones it has are left as they are. */
export const fetchMissingRefs = Effect.fn("HubRepository.fetchMissingRefs")(function* (input: {
  readonly cwd: string;
  readonly remote: HubRemote;
  readonly refs: ReadonlyArray<CheckpointRef>;
}) {
  const vcs = yield* VcsProcess.VcsProcess;
  const present = yield* existingRefs(vcs, input.cwd, input.refs);
  const missing = input.refs.filter((ref) => !present.has(ref));
  if (missing.length === 0) return;
  yield* gitIn(vcs, {
    operation: "HubRepository.fetch",
    cwd: input.cwd,
    remote: input.remote,
    args: [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      "--quiet",
      input.remote.url,
      ...missing.map((ref) => `+${ref}:${ref}`),
    ],
  });
});

/** A Project's repository folder: readable, and distinct for ids that read alike. */
const directoryNameOf = (projectId: ProjectId) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < projectId.length; index += 1) {
    hash = Math.imul(hash ^ projectId.charCodeAt(index), 0x01000193) >>> 0;
  }
  const readable = projectId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
  return `${readable}-${hash.toString(16).padStart(8, "0")}.git`;
};

export class HubRepositories extends Context.Service<
  HubRepositories,
  {
    /** The folder holding every Project's repository, as git http-backend's project root. */
    readonly root: string;
    /** The Project's repository folder, relative to `root`. */
    readonly directoryOf: (projectId: ProjectId) => string;
    /** Creates the Project's bare repository when it has none; its absolute path. */
    readonly ensure: (projectId: ProjectId) => Effect.Effect<string, VcsError>;
    /** Whether the Project's repository has every one of the refs. */
    readonly hasRefs: (
      projectId: ProjectId,
      refs: ReadonlyArray<CheckpointRef>,
    ) => Effect.Effect<boolean>;
    /** Checkpoint reads (diffs, authored paths) run in a repository folder from `ensure`. */
    readonly checkpoints: VcsCheckpointOps;
  }
>()("t3/checkpointing/HubRepository/HubRepositories") {}

export const layer = Layer.effect(
  HubRepositories,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess.VcsProcess;
    // Git refuses to find a bare repository from its cwd where `safe.bareRepository` is
    // `explicit`, so every command in one names it.
    const inBareRepository = VcsProcess.VcsProcess.of({
      run: Effect.fn("HubRepositories.inBareRepository")((input) =>
        vcs.run({ ...input, env: { ...input.env, GIT_DIR: input.cwd } }),
      ),
    });
    const driver = yield* GitVcsDriver.makeVcsDriver.pipe(
      Effect.provideService(VcsProcess.VcsProcess, inBareRepository),
    );
    const root = path.join(config.stateDir, "hub-repositories");
    const pathOf = (projectId: ProjectId) => path.join(root, directoryNameOf(projectId));
    const initialized = (repository: string) =>
      fileSystem.exists(path.join(repository, "HEAD")).pipe(Effect.orElseSucceed(() => false));

    const ensure = Effect.fn("HubRepositories.ensure")(function* (projectId: ProjectId) {
      const repository = pathOf(projectId);
      if (yield* initialized(repository)) return repository;
      yield* fileSystem.makeDirectory(root, { recursive: true }).pipe(Effect.ignore);
      // Initializing twice is harmless, so concurrent first uploads need no lock.
      yield* gitIn(vcs, {
        operation: "HubRepositories.init",
        cwd: root,
        args: ["init", "--bare", "--quiet", repository],
      });
      return repository;
    });

    return HubRepositories.of({
      root,
      directoryOf: directoryNameOf,
      ensure,
      hasRefs: Effect.fn("HubRepositories.hasRefs")(function* (projectId, refs) {
        const repository = pathOf(projectId);
        if (!(yield* initialized(repository))) return false;
        const present = yield* existingRefs(vcs, root, refs, repository).pipe(
          Effect.orElseSucceed(() => new Set<string>()),
        );
        return refs.every((ref) => present.has(ref));
      }),
      checkpoints: driver.checkpoints,
    });
  }),
);
