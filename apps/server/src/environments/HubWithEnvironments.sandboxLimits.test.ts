// @effect-diagnostics nodeBuiltinImport:off -- fills a Sandbox's home past its disk limit.
/**
 * «Hub con Environments», spec 3 ticket 05: each Sandbox's limits (the Installation's defaults
 * and a Space's override), passed to the runtime on its next start; the disk limit checked by the
 * Hub, stopping a full Sandbox with why on its Threads; Settings → Environments «Sandboxes» for
 * the Owner (every one, with actions) and an Admin (their Space's, read-only); all of it audited.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  type HubSandboxDetail,
  type HubSandboxList,
  sandboxEnvironmentIdOf,
  type SandboxLimits,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as SandboxRuntime from "../sandboxes/SandboxRuntime.ts";
import { sandboxIdOf } from "../sandboxes/SandboxRuntime.ts";
import * as Sandboxes from "../sandboxes/Sandboxes.ts";
import { memberWithPasskey } from "./environments.testkit.ts";
import { type Hub, makeHub } from "./HubWithEnvironments.testkit.ts";

const GIB = 1024 ** 3;

const ownerIdOf = Effect.fn(function* (hub: Hub) {
  const [row] = yield* hub.server.sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM users WHERE is_owner = 1
  `;
  assert.isDefined(row);
  return UserId.make(row.userId);
});

/** An Organization whose Admin and Member signed up by Invitation, with its Sandbox running. */
const acmeWithSandbox = Effect.fn(function* (hub: Hub) {
  const admin = yield* memberWithPasskey(hub.server, hub.owner, {
    displayName: "Ada Lovelace",
    role: "admin",
  });
  const member = yield* memberWithPasskey(hub.server, hub.owner, {
    displayName: "Grace Hopper",
    spaceId: admin.spaceId,
  });
  const spaceId = SpaceId.make(admin.spaceId);
  yield* hub
    .service(Sandboxes.Sandboxes)
    .ensureRunning({ spaceId, actorUserId: yield* ownerIdOf(hub) })
    .pipe(Effect.orDie);
  return { admin, member, spaceId, environmentId: sandboxEnvironmentIdOf(spaceId) };
});

const sandboxesAs = Effect.fn(function* (hub: Hub, cookie: string) {
  const listed = yield* hub.server.request("/api/environments/sandboxes", { cookie });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  return listed.body as unknown as HubSandboxList;
});

const sandboxOf = (list: HubSandboxList, environmentId: string): HubSandboxDetail => {
  const found = list.sandboxes.find((entry) => entry.environmentId === environmentId);
  assert.isDefined(found, `no Sandbox ${environmentId} in ${JSON.stringify(list.sandboxes)}`);
  return found;
};

const setLimits = (
  hub: Hub,
  cookie: string,
  body: { readonly environmentId?: string; readonly limits: SandboxLimits },
) => hub.server.request("/api/environments/sandboxes/limits", { cookie, body });

const act = (hub: Hub, cookie: string, environmentId: string, action: string) =>
  hub.server.request("/api/environments/sandboxes/action", {
    cookie,
    body: { environmentId, action },
  });

const audited = (hub: Hub, actions: ReadonlyArray<string>) =>
  hub.server.sql<{ readonly action: string; readonly detail: string | null }>`
    SELECT action, detail_json AS detail FROM audit_log
    WHERE action IN ${hub.server.sql.in(actions)} ORDER BY rowid
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({ action: row.action, ...JSON.parse(row.detail ?? "{}") })),
    ),
  );

/**
 * Waits for the start under way (the Owner's, from Settings) to end, then reads the Sandbox:
 * `ensureRunning` joins that start rather than beginning another.
 */
const awaitStarted = Effect.fn(function* (hub: Hub, spaceId: SpaceId) {
  yield* hub
    .service(Sandboxes.Sandboxes)
    .ensureRunning({ spaceId, actorUserId: undefined })
    .pipe(Effect.orDie);
  return sandboxOf(yield* sandboxesAs(hub, hub.owner), sandboxEnvironmentIdOf(spaceId));
});

const NO_OVERRIDE: SandboxLimits = { cpus: null, memoryBytes: null, pids: null, diskBytes: null };

describe("Hub con Environments: a Sandbox's limits", () => {
  it.live(
    "start with the Installation's defaults; a Space's memory limit applies on its next start, audited",
    () =>
      Effect.gen(function* () {
        const starts: Array<{ sandboxId: string; options: SandboxRuntime.SandboxStartOptions }> =
          [];
        const hub = yield* makeHub({
          onSandboxStart: (sandboxId, options) =>
            Effect.sync(() => void starts.push({ sandboxId, options })),
        });
        const { spaceId, environmentId } = yield* acmeWithSandbox(hub);
        const defaults = { cpus: 2, memoryBytes: 4 * GIB, pids: 4096, diskBytes: 20 * GIB };
        assert.deepEqual(starts.at(-1), {
          sandboxId: sandboxIdOf(spaceId),
          options: { limits: defaults },
        });

        const listed = yield* sandboxesAs(hub, hub.owner);
        assert.deepEqual(listed.defaults, defaults);
        const sandbox = sandboxOf(listed, environmentId);
        assert.equal(sandbox.status, "online");
        assert.deepEqual(sandbox.limits, defaults);
        assert.deepEqual(sandbox.overrides, NO_OVERRIDE);
        assert.equal(sandbox.runtime, "process");
        assert.isTrue(sandbox.manageable);
        assert.isNotNull(sandbox.startedAt);
        assert.isAbove(sandbox.usage.diskBytes ?? 0, 0);

        const changed = yield* setLimits(hub, hub.owner, {
          environmentId,
          limits: { ...NO_OVERRIDE, memoryBytes: 1 * GIB },
        });
        assert.equal(changed.status, 200, JSON.stringify(changed.body));
        const after = sandboxOf(changed.body as unknown as HubSandboxList, environmentId);
        assert.deepEqual(after.limits, { ...defaults, memoryBytes: 1 * GIB });
        assert.deepEqual(after.overrides, { ...NO_OVERRIDE, memoryBytes: 1 * GIB });
        // Running Sandboxes keep what they started with: the change applies on the next start.
        assert.equal(starts.length, 1);
        const restarted = yield* act(hub, hub.owner, environmentId, "restart");
        assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
        assert.equal((yield* awaitStarted(hub, spaceId)).status, "online");
        assert.deepEqual(starts.at(-1)?.options.limits, { ...defaults, memoryBytes: 1 * GIB });

        // The defaults change for every Sandbox without its own value.
        const defaultsChanged = yield* setLimits(hub, hub.owner, {
          limits: { ...defaults, cpus: 4 },
        });
        assert.equal(defaultsChanged.status, 200);
        assert.deepEqual(
          sandboxOf(defaultsChanged.body as unknown as HubSandboxList, environmentId).limits,
          { ...defaults, cpus: 4, memoryBytes: 1 * GIB },
        );
        assert.deepEqual(yield* audited(hub, ["sandbox.limits.change"]), [
          {
            action: "sandbox.limits.change",
            scope: "space",
            cpus: null,
            memoryBytes: 1 * GIB,
            pids: null,
            diskBytes: null,
          },
          {
            action: "sandbox.limits.change",
            scope: "defaults",
            cpus: 4,
            memoryBytes: 4 * GIB,
            pids: 4096,
            diskBytes: 20 * GIB,
          },
        ]);
      }).pipe(Effect.scoped),
  );

  it.live("the process runtime says CPU, memory and PIDs are not enforced on this host", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const listed = yield* sandboxesAs(hub, hub.owner);
      assert.deepInclude(listed.enforcement, { cpus: false, memory: false, pids: false });
      assert.include(listed.enforcement.note ?? "", "not enforced on this host");
    }).pipe(Effect.scoped),
  );

  it.live(
    "a Sandbox over its disk limit stops, failed with why for its Threads, and starts only once there is room",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ sandboxLifecycle: { diskCheckEvery: "1 hour" } });
        const { spaceId, environmentId } = yield* acmeWithSandbox(hub);
        NodeFS.writeFileSync(
          NodePath.join(hub.sandboxRoot, sandboxIdOf(spaceId), "big.bin"),
          Buffer.alloc(2 * 1024 * 1024),
        );
        // A limit below what its home holds counts at once, not at the next hourly check.
        const limited = yield* setLimits(hub, hub.owner, {
          environmentId,
          limits: { ...NO_OVERRIDE, diskBytes: 1024 * 1024 },
        });
        assert.equal(limited.status, 200);
        // The check it starts may still run: this one, under the same lock, settles it either way.
        yield* hub.service(Sandboxes.Sandboxes).checkDisk;
        const failed = sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId);
        assert.equal(failed.status, "failed");
        assert.include(failed.error ?? "", "disk is full");
        const environments = yield* hub.server.request("/api/environments", { cookie: hub.owner });
        const listed = (
          environments.body.environments as ReadonlyArray<{
            id: string;
            startError?: string | null;
          }>
        ).find((entry) => entry.id === environmentId);
        // What the Thread's banner shows.
        assert.include(listed?.startError ?? "", "disk is full");
        assert.isAbove(failed.usage.diskBytes ?? 0, 1024 * 1024);

        // Starting it again is refused while its home is still over the limit.
        const refused = yield* hub
          .service(Sandboxes.Sandboxes)
          .ensureRunning({ spaceId, actorUserId: undefined })
          .pipe(Effect.flip);
        assert.include(refused.detail, "disk is full");

        // With room again (the Owner raised the limit back to the default), it starts.
        yield* setLimits(hub, hub.owner, { environmentId, limits: NO_OVERRIDE });
        yield* hub
          .service(Sandboxes.Sandboxes)
          .ensureRunning({ spaceId, actorUserId: undefined })
          .pipe(Effect.orDie);
        assert.equal(sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId).status, "online");
        assert.deepInclude(
          (yield* audited(hub, ["sandbox.stop"])).map((entry) => entry.via),
          "disk-full",
        );
      }).pipe(Effect.scoped),
  );
});

describe("Hub con Environments: Settings → Environments «Sandboxes»", () => {
  it.live("the Owner stops, starts and restarts a Sandbox by hand, each audited", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const { spaceId, environmentId } = yield* acmeWithSandbox(hub);

      const stopped = yield* act(hub, hub.owner, environmentId, "stop");
      assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
      assert.equal((stopped.body as unknown as HubSandboxDetail).status, "stopped");
      assert.isNull((stopped.body as unknown as HubSandboxDetail).startedAt);

      const started = yield* act(hub, hub.owner, environmentId, "start");
      assert.equal(started.status, 200);
      assert.equal((yield* awaitStarted(hub, spaceId)).status, "online");

      assert.equal((yield* act(hub, hub.owner, environmentId, "restart")).status, 200);
      assert.equal((yield* awaitStarted(hub, spaceId)).status, "online");

      const entries = yield* audited(hub, ["sandbox.start", "sandbox.stop"]);
      assert.deepEqual(
        entries.map((entry) => [entry.action, entry.via]),
        [
          ["sandbox.start", "demand"],
          ["sandbox.stop", "settings"],
          ["sandbox.start", "settings"],
          ["sandbox.stop", "restart"],
          ["sandbox.start", "restart"],
        ],
      );
      const actors = yield* hub.server.sql<{ readonly actor: string | null }>`
        SELECT actor_user_id AS actor FROM audit_log
        WHERE action IN ('sandbox.start', 'sandbox.stop') ORDER BY rowid
      `;
      const owner = yield* ownerIdOf(hub);
      assert.deepEqual(
        actors.map((row) => row.actor),
        [owner, owner, owner, owner, owner],
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "an Admin sees their Space's Sandbox read-only, a Member not at all, and neither acts nor limits",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const { admin, member, environmentId } = yield* acmeWithSandbox(hub);

        const adminView = yield* sandboxesAs(hub, admin.cookie);
        assert.isFalse(adminView.manageable);
        const seen = sandboxOf(adminView, environmentId);
        assert.isFalse(seen.manageable);
        assert.equal(seen.status, "online");
        const memberView = yield* sandboxesAs(hub, member.cookie);
        assert.deepEqual(memberView.sandboxes, []);

        for (const action of ["start", "stop", "restart"]) {
          assert.equal((yield* act(hub, admin.cookie, environmentId, action)).status, 403, action);
          // One the User may not even see answers like a missing one.
          assert.equal((yield* act(hub, member.cookie, environmentId, action)).status, 404, action);
        }
        const limits = { ...NO_OVERRIDE, memoryBytes: 64 * GIB };
        assert.equal((yield* setLimits(hub, admin.cookie, { environmentId, limits })).status, 403);
        assert.equal((yield* setLimits(hub, admin.cookie, { limits })).status, 403);
        assert.equal((yield* setLimits(hub, member.cookie, { limits })).status, 403);
        // Nothing changed, nothing was recorded.
        assert.deepEqual(
          sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId).overrides,
          NO_OVERRIDE,
        );
        assert.equal(sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId).status, "online");
        assert.deepEqual(yield* audited(hub, ["sandbox.limits.change", "sandbox.stop"]), []);
      }).pipe(Effect.scoped),
  );
});
