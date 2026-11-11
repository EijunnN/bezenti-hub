/**
 * «Hub con Environments», spec 3 ticket 13: what the Owner reads on mobile (every machine with its
 * mode, Space or owner and status, from an endpoint only the Owner gets) and the limits row of a
 * Space whose only Sandbox is a dedicated machine, in Settings → Environments «Sandboxes».
 */
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type HubEnvironmentOverview,
  type HubSandboxList,
  sandboxEnvironmentIdOf,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as Sandboxes from "../sandboxes/Sandboxes.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { joinMachine } from "./environments.testkit.ts";
import { type Hub, makeHub } from "./HubWithEnvironments.testkit.ts";

const GIB = 1024 ** 3;

const ownerIdOf = Effect.fn(function* (hub: Hub) {
  const [row] = yield* hub.server.sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM users WHERE is_owner = 1
  `;
  assert.isDefined(row);
  return UserId.make(row.userId);
});

const createOrganization = Effect.fn(function* (hub: Hub, name: string) {
  const created = yield* hub
    .service(SpaceDirectory.SpaceDirectory)
    .createOrganization(yield* ownerIdOf(hub), name)
    .pipe(Effect.orDie);
  return created.id;
});

/** Acme with an Admin, a Member and a Guest, each with a session of their own. */
const acmeWithPeople = Effect.fn(function* (hub: Hub) {
  const acme = yield* createOrganization(hub, "Acme");
  const people = {
    admin: { id: UserId.make("admin-1"), displayName: "Ada" },
    member: { id: UserId.make("member-1"), displayName: "Grace" },
    guest: { id: UserId.make("guest-1"), displayName: "Linus" },
  } as const;
  const cookies = {} as Record<keyof typeof people, string>;
  for (const role of ["admin", "member", "guest"] as const) {
    cookies[role] = yield* addMember(hub.server, people[role]);
    yield* joinOrganization(hub.server, acme, people[role].id, role);
  }
  yield* hub.service(SpaceDirectory.SpaceDirectory).changed;
  return { acme, cookies };
});

describe("Hub con Environments: the Owner's overview of every machine", () => {
  it.live("names each machine's mode, Space or owner and status, for the Owner only", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const { acme, cookies } = yield* acmeWithPeople(hub);
      const owner = yield* ownerIdOf(hub);
      const vps = yield* joinMachine(hub.server, hub.authenticator, hub.owner, "Acme VPS", acme);
      const laptop = yield* joinMachine(hub.server, hub.authenticator, hub.owner, "Laptop");
      yield* hub
        .service(Sandboxes.Sandboxes)
        .ensureRunning({ spaceId: acme, actorUserId: owner })
        .pipe(Effect.orDie);

      const read = yield* hub.server.request("/api/environments/overview", { cookie: hub.owner });
      assert.equal(read.status, 200, JSON.stringify(read.body));
      const overview = read.body as unknown as HubEnvironmentOverview;
      const entry = (id: string) => {
        const found = overview.environments.find((environment) => environment.id === id);
        assert.isDefined(found, `no ${id} in ${JSON.stringify(overview.environments)}`);
        return found;
      };
      const dedicated = entry(vps.environmentId);
      assert.equal(dedicated.mode, "dedicated");
      assert.equal(dedicated.spaceId, acme);
      assert.equal(dedicated.spaceName, "Acme");
      assert.isNull(dedicated.ownerUserId);
      const personal = entry(laptop.environmentId);
      assert.equal(personal.mode, "personal");
      assert.equal(personal.ownerUserId, owner);
      assert.isString(personal.ownerName);
      assert.isNull(personal.spaceName);
      const sandbox = entry(sandboxEnvironmentIdOf(acme));
      assert.equal(sandbox.mode, "sandbox");
      assert.equal(sandbox.name, "Acme Sandbox");
      assert.equal(sandbox.spaceName, "Acme");
      assert.equal(sandbox.status, "online");

      // Nobody else gets it, an Admin of the Space included.
      for (const role of ["admin", "member", "guest"] as const) {
        const refused = yield* hub.server.request("/api/environments/overview", {
          cookie: cookies[role],
        });
        assert.equal(refused.status, 403, `${role}: ${JSON.stringify(refused.body)}`);
      }
    }).pipe(Effect.scoped),
  );
});

describe("Hub con Environments: limits of a Space whose only Sandbox is a dedicated machine", () => {
  it.live("show in «Sandboxes» for the Owner, with its own and effective values", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const { acme, cookies } = yield* acmeWithPeople(hub);
      const vps = yield* joinMachine(hub.server, hub.authenticator, hub.owner, "Acme VPS", acme);
      const set = yield* hub.server.request("/api/environments/sandboxes/limits", {
        cookie: hub.owner,
        body: { environmentId: vps.environmentId, limits: { memoryBytes: 8 * GIB } },
      });
      assert.equal(set.status, 200, JSON.stringify(set.body));

      const listed = yield* hub.server.request("/api/environments/sandboxes", {
        cookie: hub.owner,
      });
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      const list = listed.body as unknown as HubSandboxList;
      assert.deepEqual(list.dedicatedSpaces, [
        {
          spaceId: acme,
          spaceName: "Acme",
          machines: [
            {
              environmentId: EnvironmentId.make(vps.environmentId),
              name: "Acme VPS",
              status: list.dedicatedSpaces?.[0]?.machines[0]?.status ?? "offline",
            },
          ],
          own: { cpus: null, memoryBytes: 8 * GIB, pids: null, diskBytes: null },
          effective: { cpus: 2, memoryBytes: 8 * GIB, pids: 4096, diskBytes: 20 * GIB },
        },
      ]);
      // The answer to a change carries the row too.
      assert.equal((set.body as unknown as HubSandboxList).dedicatedSpaces?.length, 1);

      // Once the Hub also runs a Sandbox for the Space, that row is the Space's.
      yield* hub
        .service(Sandboxes.Sandboxes)
        .ensureRunning({ spaceId: acme, actorUserId: yield* ownerIdOf(hub) })
        .pipe(Effect.orDie);
      const both = yield* hub.server.request("/api/environments/sandboxes", { cookie: hub.owner });
      assert.deepEqual((both.body as unknown as HubSandboxList).dedicatedSpaces, []);

      // An Admin of the Space sees its Sandbox, never the Owner's dedicated rows.
      const admin = yield* hub.server.request("/api/environments/sandboxes", {
        cookie: cookies.admin,
      });
      assert.equal(admin.status, 200, JSON.stringify(admin.body));
      assert.isUndefined((admin.body as unknown as HubSandboxList).dedicatedSpaces);
    }).pipe(Effect.scoped),
  );
});
