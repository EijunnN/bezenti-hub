// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll, assert, describe } from "vite-plus/test";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { readThreadWorkflowScript, readWorkflowScript } from "./workflowScriptQuery.ts";

const root = NodePath.join(NodeOS.homedir(), ".claude", "projects", "__wf_script_test__");
NodeFS.mkdirSync(root, { recursive: true });
const scriptPath = NodePath.join(root, "run.js");
NodeFS.writeFileSync(scriptPath, "export const meta = {};\n");
const outside = NodePath.join(NodeOS.tmpdir(), "wf-outside.js");
NodeFS.writeFileSync(outside, "evil\n");
const link = NodePath.join(root, "sneaky.js");
if (symlinksSupported) {
  NodeFS.rmSync(link, { force: true });
  NodeFS.symlinkSync(outside, link);
  if (!NodeFS.lstatSync(link).isSymbolicLink()) {
    throw new Error("test setup: sneaky.js must be a symlink");
  }
}

afterAll(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.rmSync(outside, { force: true });
});

describe("workflow script containment", () => {
  effectIt.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "rejects a FIFO without waiting for a writer",
    () =>
      Effect.gen(function* () {
        const fifo = NodePath.join(root, "pipe.js");
        NodeChildProcess.execFileSync("mkfifo", [fifo]);
        const error = yield* Effect.flip(readWorkflowScript({ scriptPath: fifo }));
        assert.equal(error.reason, "not-regular-file");
      }),
  );

  effectIt.effect(
    "serves a Thread a script its own workflows or those of Threads below it recorded, no other",
    () =>
      Effect.gen(function* () {
        const shell = (id: string, parent: string | null) =>
          ({ id, lineage: { parentThreadId: parent } }) as never;
        const ran: Record<string, string> = {};
        const child = NodePath.join(root, "child.js");
        const sibling = NodePath.join(root, "sibling.js");
        NodeFS.writeFileSync(child, "the child's script");
        NodeFS.writeFileSync(sibling, "a sibling's script");
        ran["parent"] = scriptPath;
        ran["grandchild"] = child;
        ran["sibling"] = sibling;
        const read = (threadId: string, path: string) =>
          readThreadWorkflowScript({
            threadId: threadId as never,
            scriptPath: path,
            threads: {
              // The family as the caller sees it: the parent, its child and grandchild, and a
              // Thread beside the parent.
              family: Effect.succeed([
                shell("parent", null),
                shell("child", "parent"),
                shell("grandchild", "child"),
                shell("sibling", null),
              ]),
              // The child's records cannot be read: skipped, not the whole answer.
              subagents: (id) =>
                id === "child"
                  ? Effect.fail("unreadable")
                  : Effect.succeed(
                      ran[id] === undefined
                        ? []
                        : ([{ workflow: { runHandles: { scriptPath: ran[id] } } }] as never),
                    ),
            },
          });
        assert.include((yield* read("parent", scriptPath)).contents, "export const meta");
        // A nested child's workflow, from its ancestor's view.
        assert.include((yield* read("parent", child)).contents, "the child's script");
        // Not one beside it, nor an ancestor's from a child.
        assert.equal((yield* Effect.flip(read("parent", sibling))).reason, "not-found");
        assert.equal((yield* Effect.flip(read("grandchild", scriptPath))).reason, "not-found");
      }),
  );

  effectIt.effect("serves a real script under the projects root", () =>
    Effect.gen(function* () {
      const result = yield* readWorkflowScript({ scriptPath });
      assert.include(result.contents, "export const meta");
      assert.equal(result.truncated, false);
    }),
  );

  effectIt.effect.skipIf(!symlinksSupported)(
    "rejects paths outside the root and symlink escapes",
    () =>
      Effect.gen(function* () {
        const escaped = yield* Effect.exit(readWorkflowScript({ scriptPath: outside }));
        assert.equal(escaped._tag, "Failure");
        const sneaky = yield* Effect.exit(
          readWorkflowScript({ scriptPath: link }).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          ),
        );
        assert.equal(sneaky._tag, "Success");
        if (sneaky._tag === "Success") {
          assert.equal(sneaky.value, "outside-root");
        }
      }),
  );
});
