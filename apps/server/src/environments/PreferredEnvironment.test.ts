import { assert, describe, it } from "@effect/vitest";
import {
  HUB_MACHINE_ENVIRONMENT_ID,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { makeHub } from "./HubWithEnvironments.testkit.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");

/** A machine with the provider but no recorded turns: these tests run none. */
const idleAdapters = ProviderAdapterRegistry.layerFromAdapters([
  {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("no turns run here"),
  },
]);

describe("a Project's preferred Environment", () => {
  it.live("is one its setter may use, and new Threads start there when nobody chooses", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const { server } = hub;
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters });
      // Joined but never connected, so the Hub sees it offline.
      const desktop = yield* hub.join({ name: "Desktop", adapters: idleAdapters, connect: false });
      const memberId = UserId.make("member-1");
      const member = yield* addMember(server, { id: memberId, displayName: "Grace Hopper" });
      const acme = yield* server.request("/api/spaces/organizations", {
        body: { name: "Acme" },
        cookie: hub.owner,
      });
      const acmeId = acme.body.id as string;
      yield* joinOrganization(server, acmeId, memberId, "member");
      const projectId = ProjectId.make("api");
      const created = yield* server.request("/api/projects/mutate", {
        cookie: member,
        body: {
          type: "project.create",
          commandId: "create-api",
          projectId,
          title: "api",
          workspaceRoot: "/work/api",
          spaceId: acmeId,
        },
      });
      assert.equal(created.status, 200);

      let commands = 0;
      const prefer = (cookie: string, preferredEnvironmentId: string | null) =>
        server.request("/api/projects/mutate", {
          cookie,
          body: {
            type: "project.update",
            commandId: `prefer-${(commands += 1)}`,
            projectId,
            preferredEnvironmentId,
          },
        });
      const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
      const [owner] = yield* server.sql<{ readonly userId: string }>`
        SELECT user_id AS "userId" FROM users WHERE is_owner = 1
      `;
      assert.isDefined(owner);
      const ownerId = UserId.make(owner.userId);
      const placed = (userId: UserId) =>
        registry.chooseForThread({
          userId,
          requested: undefined,
          projectId,
          providerInstanceId: instanceId,
        });

      // The Laptop is the Owner's personal machine: a Member who manages the Project can't pick it.
      assert.equal((yield* prefer(member, laptop.environmentId)).status, 403);
      // Nor can anyone pick a machine the Hub doesn't know; the answer is the same.
      assert.equal((yield* prefer(hub.owner, "no-such-machine")).status, 403);
      assert.equal(yield* placed(ownerId), HUB_MACHINE_ENVIRONMENT_ID);

      const preferred = yield* prefer(hub.owner, laptop.environmentId);
      assert.equal(preferred.status, 200);
      assert.equal(preferred.body.preferredEnvironmentId, laptop.environmentId);
      assert.equal(yield* placed(ownerId), laptop.environmentId);
      // A Member who may not use the Owner's machine starts on the Hub machine instead.
      assert.equal(yield* placed(memberId), HUB_MACHINE_ENVIRONMENT_ID);
      // So does a Thread whose provider the machine lacks, as the composer previews it.
      assert.equal(
        yield* registry.chooseForThread({
          userId: ownerId,
          requested: undefined,
          projectId,
          providerInstanceId: ProviderInstanceId.make("codex"),
        }),
        HUB_MACHINE_ENVIRONMENT_ID,
      );
      // And one preferring a machine that is offline: the preference never fails a Thread.
      assert.equal((yield* prefer(hub.owner, desktop.environmentId)).status, 200);
      assert.equal(yield* placed(ownerId), HUB_MACHINE_ENVIRONMENT_ID);
      assert.equal((yield* prefer(hub.owner, laptop.environmentId)).status, 200);

      // The Hub machine is everyone's, and clearing the preference starts Threads there again.
      assert.equal((yield* prefer(member, HUB_MACHINE_ENVIRONMENT_ID)).status, 200);
      const cleared = yield* prefer(member, null);
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.preferredEnvironmentId, null);
      assert.equal(yield* placed(ownerId), HUB_MACHINE_ENVIRONMENT_ID);
    }).pipe(Effect.scoped),
  );
});
