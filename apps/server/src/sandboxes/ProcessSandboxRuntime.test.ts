// @effect-diagnostics nodeBuiltinImport:off -- reads the pid file and checks the processes it names.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, SpaceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as ProcessSandboxRuntime from "./ProcessSandboxRuntime.ts";
import { SandboxHubAddress, SandboxRuntime } from "./SandboxRuntime.ts";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the process runtime's Hub address", () => {
  it("is loopback, and none for a Hub bound only to another address", () => {
    assert.equal(ProcessSandboxRuntime.sandboxHubLoopbackUrl({ port: 7 }), "http://127.0.0.1:7");
    for (const host of ["0.0.0.0", "::", "localhost", "127.0.0.1"]) {
      assert.equal(
        ProcessSandboxRuntime.sandboxHubLoopbackUrl({ host, port: 7 }),
        "http://127.0.0.1:7",
      );
    }
    assert.equal(
      ProcessSandboxRuntime.sandboxHubLoopbackUrl({ host: "::1", port: 7 }),
      "http://[::1]:7",
    );
    assert.isUndefined(
      ProcessSandboxRuntime.sandboxHubLoopbackUrl({ host: "100.64.0.7", port: 7 }),
    );
    assert.isUndefined(
      ProcessSandboxRuntime.sandboxHubLoopbackUrl({ host: "192.168.1.2", port: 7 }),
    );
  });
});

it.live("a server an earlier Hub left running is stopped before another starts on its home", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const rootDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-process-sandboxes-" });
    // A long-lived stand-in for `t3 serve`, with the same command line shape.
    const launcher = ProcessSandboxRuntime.childProcessLauncher({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)", "--"],
    });
    const runtimeIn = (scope: Scope.Scope) =>
      Layer.build(
        ProcessSandboxRuntime.layer({ launcher, rootDir }).pipe(
          Layer.provide(
            Layer.succeed(
              SandboxHubAddress,
              SandboxHubAddress.of({ loopbackUrl: Effect.succeed("http://127.0.0.1:1") }),
            ),
          ),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-process-hub-" })),
          Layer.provide(NodeServices.layer),
        ),
      ).pipe(
        Effect.map((context) => Context.get(context, SandboxRuntime)),
        Effect.provideService(Scope.Scope, scope),
      );
    const readPid = Effect.promise(async () =>
      Number(
        (
          JSON.parse(await NodeFSP.readFile(`${rootDir}/sandbox-acme.pid`, "utf8")) as {
            pid: number;
          }
        ).pid,
      ),
    );

    // The first Hub "crashes": its runtime is never closed, so its child keeps running.
    const crashedHub = yield* Scope.make();
    const first = yield* runtimeIn(crashedHub);
    yield* first.create({
      sandboxId: "sandbox-acme",
      spaceId: SpaceId.make("acme"),
      environmentId: EnvironmentId.make("sandbox:acme"),
      name: "Acme Sandbox",
      hubEnvironmentId: EnvironmentId.make("hub"),
      credential: Redacted.make("t3env.x.y"),
    });
    yield* first.start("sandbox-acme");
    const leftover = yield* readPid;
    assert.isTrue(isAlive(leftover));

    const restartedHub = yield* Scope.make();
    const second = yield* runtimeIn(restartedHub);
    yield* second.start("sandbox-acme");
    const current = yield* readPid;
    assert.notEqual(current, leftover);
    assert.isFalse(isAlive(leftover));
    assert.isTrue(isAlive(current));

    yield* Scope.close(restartedHub, Exit.void);
    assert.isFalse(isAlive(current));
    yield* Scope.close(crashedHub, Exit.void);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
