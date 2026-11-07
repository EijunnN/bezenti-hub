// @effect-diagnostics nodeBuiltinImport:off - checks the staging directory's identity and mode on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { stageSandboxServer } from "./stage-sandbox-server.ts";

it.live("stages into the private directory it is given, never replacing it with another", () =>
  Effect.gen(function* () {
    const context = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-stage-test-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(context, { recursive: true, force: true })),
    );
    const before = NodeFS.statSync(context);
    assert.equal(before.mode & 0o777, 0o700);
    yield* stageSandboxServer(context);
    const after = NodeFS.statSync(context);
    // The same directory (not one made again at its path, which anyone could have raced), still
    // the Hub's alone.
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o777, 0o700);
    assert.isTrue(NodeFS.existsSync(NodePath.join(context, "server/dist/bin.mjs")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(context, "modules/node-pty")));
    // A directory it was not given is never made.
    const missing = NodePath.join(context, "not-made");
    const refused = yield* stageSandboxServer(missing).pipe(Effect.flip);
    assert.include(refused.message, "does not exist");
    assert.isFalse(NodeFS.existsSync(missing));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
