import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";

it.effect("answers a rename of a Thread the caller cannot see exactly like a missing one", () =>
  Effect.gen(function* () {
    const hidden = ThreadId.make("thread-hidden");
    const dispatched: Array<unknown> = [];
    const layer = ThreadMetadataMcpService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed(
                threadId === hidden ? ({ id: hidden, deletedAt: null } as never) : null,
              ),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: 1, storedEvents: [] } as never;
              }),
          }),
        ),
      ),
    );
    const scope: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment-1"),
      requestNamespace: "client-1",
      thread: undefined,
      client: { sessionId: "client-1", label: "Claude Code", access: "full-access" },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
      userId: UserId.make("grace"),
    };
    const rename = (threadId: ThreadId) =>
      ThreadMetadataMcpService.ThreadMetadataMcpService.pipe(
        Effect.flatMap((service) =>
          service.update(scope, { threadId, action: "rename", title: "Renamed" }),
        ),
        Effect.flip,
        Effect.map((failure) => ({
          code: failure.code,
          message: failure.message.replaceAll(threadId, "<id>"),
        })),
        Effect.provide(layer),
        Effect.provide(
          Layer.succeed(
            SpaceVisibility.SpaceVisibility,
            SpaceVisibility.SpaceVisibility.of({
              of: () => Effect.succeed({ all: false, spaceIds: [] }),
              visibleThreadIds: () => Effect.succeed(new Set()),
            } as never),
          ),
        ),
      );
    assert.deepEqual(yield* rename(hidden), yield* rename(ThreadId.make("thread-missing")));
    assert.deepEqual(dispatched, []);
  }),
);
