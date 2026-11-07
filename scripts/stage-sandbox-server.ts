#!/usr/bin/env node
/**
 * Stages this checkout's server for the Sandbox image (apps/server/sandbox-image/Containerfile):
 * `server/dist` (the bundle), `modules` (its runtime node_modules for this Linux, patched as the
 * release installs them) and `extras` (the dev Replay agent). Run by `t3 sandbox image build`.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { stageRuntimeExternals } from "./build-cli-archive.ts";

export class SandboxServerStageError extends Schema.TaggedError<SandboxServerStageError>()(
  "SandboxServerStageError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

const stage = Effect.fn("stageSandboxServer")(function* (outputDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  if (platform !== "linux" || (arch !== "x64" && arch !== "arm64")) {
    return yield* new SandboxServerStageError({
      detail: `Sandbox images are built on Linux x64 or arm64, not ${platform}-${arch}.`,
    });
  }
  const repoRoot = yield* RepoRoot;
  const serverDir = path.join(repoRoot, "apps/server");
  const out = path.resolve(outputDir);
  yield* fs.remove(out, { recursive: true, force: true });
  for (const dir of ["server", "modules", "extras/scripts"]) {
    yield* fs.makeDirectory(path.join(out, dir), { recursive: true });
  }

  // The bundle, as `vp pack` builds it for npm, into the context rather than apps/server/dist.
  const dist = path.join(out, "server/dist");
  yield* Effect.log("[sandbox-image] Bundling the server...");
  const pack = yield* resolveSpawnCommand("vp", ["pack", "--out-dir", dist]);
  const packed = yield* spawner.spawn(
    ChildProcess.make(pack.command, pack.args, {
      cwd: serverDir,
      shell: pack.shell,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  const packExit = Number(yield* packed.exitCode);
  if (packExit !== 0) {
    return yield* new SandboxServerStageError({ detail: `vp pack exited with code ${packExit}.` });
  }
  for (const entry of yield* fs.readDirectory(dist)) {
    if (entry.endsWith(".map")) yield* fs.remove(path.join(dist, entry), { force: true });
  }

  yield* Effect.log("[sandbox-image] Installing its runtime modules...");
  const stageDir = path.join(out, ".stage");
  yield* fs.makeDirectory(stageDir, { recursive: true });
  yield* stageRuntimeExternals({
    repoRoot,
    stageDir,
    platform: "linux",
    arch,
    version: serverPackageJson.version,
  });
  yield* fs.remove(path.join(out, "modules"), { recursive: true, force: true });
  if (yield* fs.exists(path.join(stageDir, "node_modules"))) {
    yield* fs.rename(path.join(stageDir, "node_modules"), path.join(out, "modules"));
  } else {
    yield* fs.makeDirectory(path.join(out, "modules"));
  }
  yield* fs.remove(stageDir, { recursive: true, force: true });

  // Where the bundled server looks for it (`../../scripts` from /opt/t3/app/dist): only a server
  // given `--dev-url`, as a dev Hub's Sandboxes are, offers it.
  const scripts = path.join(serverDir, "scripts");
  yield* fs.copyFile(
    path.join(scripts, "dev-replay-agent.ts"),
    path.join(out, "extras/scripts/dev-replay-agent.ts"),
  );
  yield* fs.copy(path.join(scripts, "dev-replay"), path.join(out, "extras/scripts/dev-replay"));
  yield* Effect.log(`[sandbox-image] Staged the server ${serverPackageJson.version} in ${out}.`);
});

const command = Command.make(
  "stage-sandbox-server",
  {
    outputDir: Flag.String("output-dir").pipe(
      Flag.withDescription("Where to put server/, modules/ and extras/ (emptied first)."),
    ),
  },
  ({ outputDir }) => stage(outputDir).pipe(Effect.scoped),
).pipe(Command.withDescription("Stage this checkout's T3 server for the Sandbox image."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
