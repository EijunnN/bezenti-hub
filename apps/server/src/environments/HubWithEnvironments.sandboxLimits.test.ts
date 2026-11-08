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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as EnvironmentDemand from "../environment/EnvironmentDemand.ts";
import type * as SandboxRuntime from "../sandboxes/SandboxRuntime.ts";
import { sandboxIdOf, SandboxRuntimeError } from "../sandboxes/SandboxRuntime.ts";
import * as Sandboxes from "../sandboxes/Sandboxes.ts";
import * as OrganizationLifecycle from "../spaces/OrganizationLifecycle.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EnvironmentConnections from "./EnvironmentConnections.ts";
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

/** Another Organization, made by the Owner, with its Sandbox running. */
const organizationWithSandbox = Effect.fn(function* (hub: Hub, name: string) {
  const owner = yield* ownerIdOf(hub);
  const created = yield* hub
    .service(SpaceDirectory.SpaceDirectory)
    .createOrganization(owner, name)
    .pipe(Effect.orDie);
  const spaceId = created.id;
  yield* hub
    .service(Sandboxes.Sandboxes)
    .ensureRunning({ spaceId, actorUserId: owner })
    .pipe(Effect.orDie);
  return { spaceId, environmentId: sandboxEnvironmentIdOf(spaceId) };
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
        // Running Sandboxes keep what they started with: the change applies on the next start,
        // and Settings shows both.
        assert.equal(starts.length, 1);
        assert.deepEqual(after.appliedLimits, defaults);
        const restarted = yield* act(hub, hub.owner, environmentId, "restart");
        assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
        assert.equal((yield* awaitStarted(hub, spaceId)).status, "online");
        assert.deepEqual(starts.at(-1)?.options.limits, { ...defaults, memoryBytes: 1 * GIB });
        assert.deepEqual(
          sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId).appliedLimits,
          { ...defaults, memoryBytes: 1 * GIB },
        );

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
        // Below the floors only to keep the test small: written to its row, then checked.
        yield* overrideDisk(hub, spaceId, 1024 * 1024);
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

      // Archiving its Organization stops it, and not even the Owner starts it until restored.
      const lifecycle = hub.service(OrganizationLifecycle.OrganizationLifecycle);
      yield* lifecycle.archive(owner, spaceId).pipe(Effect.orDie);
      assert.equal(sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId).status, "stopped");
      for (const action of ["start", "restart"]) {
        const refused = yield* act(hub, hub.owner, environmentId, action);
        assert.equal(refused.status, 403, action);
        assert.include(JSON.stringify(refused.body), "archived");
      }
      yield* lifecycle.restore(owner, spaceId).pipe(Effect.orDie);
      assert.equal((yield* act(hub, hub.owner, environmentId, "start")).status, 200);
      assert.equal((yield* awaitStarted(hub, spaceId)).status, "online");
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

/** Its home holds `bytes` more, in a file the Sandbox wrote. */
const fillHome = (hub: Hub, spaceId: SpaceId, bytes: number, at = "big.bin") =>
  Effect.sync(() => {
    const file = NodePath.join(hub.sandboxRoot, sandboxIdOf(spaceId), at);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, Buffer.alloc(bytes));
  });

/** The Space's own disk limit, written straight to its row: no check starts with it. */
const overrideDisk = (hub: Hub, spaceId: SpaceId, diskBytes: number | null) =>
  hub.server.sql`
    INSERT INTO space_sandbox_limits (space_id, disk_limit_bytes, updated_at)
    VALUES (${spaceId}, ${diskBytes}, '2026-11-01T00:00:00.000Z')
    ON CONFLICT (space_id) DO UPDATE SET disk_limit_bytes = excluded.disk_limit_bytes
  `;

describe("Hub con Environments: a Sandbox cannot get past its disk limit", () => {
  it.live(
    "a home it made unreadable to the Hub's measurement counts as over its limit, not as small",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ sandboxLifecycle: { diskCheckEvery: "1 hour" } });
        const { spaceId, environmentId } = yield* acmeWithSandbox(hub);
        yield* fillHome(hub, spaceId, 3 * 1024 * 1024, "hidden/big.bin");
        const hidden = NodePath.join(hub.sandboxRoot, sandboxIdOf(spaceId), "hidden");
        NodeFS.chmodSync(hidden, 0o000);
        yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.chmodSync(hidden, 0o700)));
        yield* overrideDisk(hub, spaceId, 1024 * 1024);
        for (let check = 0; check < 3; check += 1) {
          yield* hub.service(Sandboxes.Sandboxes).checkDisk;
        }
        const sandbox = sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId);
        assert.equal(sandbox.status, "failed");
        assert.include(sandbox.error ?? "", "could not be measured");
        assert.include(sandbox.error ?? "", "Start it again to repair its home");

        // Started again, it runs while its files are repaired; if they are not, it stops again.
        assert.equal((yield* act(hub, hub.owner, environmentId, "start")).status, 200);
        assert.equal((yield* awaitStarted(hub, spaceId)).status, "online");
        for (let check = 0; check < 3; check += 1) {
          yield* hub.service(Sandboxes.Sandboxes).checkDisk;
        }
        assert.equal(sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId).status, "failed");
        assert.equal((yield* act(hub, hub.owner, environmentId, "start")).status, 200);
        assert.equal((yield* awaitStarted(hub, spaceId)).status, "online");
        // Repaired (readable, and under its limit), it keeps running.
        NodeFS.chmodSync(hidden, 0o700);
        NodeFS.rmSync(NodePath.join(hidden, "big.bin"));
        for (let check = 0; check < 3; check += 1) {
          yield* hub.service(Sandboxes.Sandboxes).checkDisk;
        }
        assert.equal(sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId).status, "online");
      }).pipe(Effect.scoped),
  );

  it.live(
    "a stop that fails leaves it running for the next check, never failed while it runs",
    () =>
      Effect.gen(function* () {
        let failNextStop = false;
        const hub = yield* makeHub({
          sandboxLifecycle: { diskCheckEvery: "1 hour" },
          beforeSandboxStop: (sandboxId) =>
            Effect.suspend(() => {
              if (!failNextStop) return Effect.void;
              failNextStop = false;
              return Effect.fail(
                new SandboxRuntimeError({ operation: "stop", sandboxId, detail: "it timed out" }),
              );
            }),
        });
        const { spaceId, environmentId } = yield* acmeWithSandbox(hub);
        yield* fillHome(hub, spaceId, 2 * 1024 * 1024);
        yield* overrideDisk(hub, spaceId, 1024 * 1024);
        failNextStop = true;
        yield* hub.service(Sandboxes.Sandboxes).checkDisk;
        // Its server still runs: it is not recorded failed, and the next check stops it.
        assert.equal(sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId).status, "online");
        const [row] = yield* hub.server.sql<{ readonly status: string }>`
        SELECT status FROM sandboxes WHERE space_id = ${spaceId}
      `;
        assert.equal(row?.status, "running");
        yield* hub.service(Sandboxes.Sandboxes).checkDisk;
        const stopped = sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId);
        assert.equal(stopped.status, "failed");
        assert.include(stopped.error ?? "", "disk is full");
      }).pipe(Effect.scoped),
  );

  it.live("slow measurements of other Sandboxes' homes do not hold back a start", () =>
    Effect.gen(function* () {
      const slow = new Set<string>();
      const bothSlow = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let slowNow = 0;
      const hub = yield* makeHub({
        sandboxLifecycle: { diskCheckEvery: "1 hour" },
        beforeSandboxMeasure: (sandboxId) =>
          Effect.suspend(() => {
            if (!slow.has(sandboxId)) return Effect.void;
            slowNow += 1;
            return (slowNow === 2 ? Deferred.succeed(bothSlow, undefined) : Effect.void).pipe(
              Effect.andThen(Deferred.await(release)),
            );
          }),
      });
      const acme = yield* organizationWithSandbox(hub, "Acme");
      const globex = yield* organizationWithSandbox(hub, "Globex");
      slow.add(sandboxIdOf(acme.spaceId));
      slow.add(sandboxIdOf(globex.spaceId));
      const checking = yield* hub.service(Sandboxes.Sandboxes).checkDisk.pipe(Effect.forkScoped);
      yield* Deferred.await(bothSlow);
      // Both checks measure for minutes; another Space's Sandbox starts meanwhile.
      const owner = yield* ownerIdOf(hub);
      const third = yield* hub
        .service(SpaceDirectory.SpaceDirectory)
        .createOrganization(owner, "Umbrella")
        .pipe(Effect.orDie);
      yield* hub
        .service(Sandboxes.Sandboxes)
        .ensureRunning({ spaceId: third.id, actorUserId: owner })
        .pipe(Effect.orDie);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(checking);
    }).pipe(Effect.scoped),
  );

  it.live(
    "a start that finds its server already running records it running, and no check stops it",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ sandboxLifecycle: { diskCheckEvery: "1 hour" } });
        const sandboxes = hub.service(Sandboxes.Sandboxes);
        const { spaceId, environmentId } = yield* acmeWithSandbox(hub);
        // Recorded failed while its server still runs, as after a write that went wrong.
        yield* hub.server.sql`UPDATE sandboxes SET status = 'failed' WHERE space_id = ${spaceId}`;
        yield* sandboxes.ensureRunning({ spaceId, actorUserId: undefined }).pipe(Effect.orDie);
        yield* sandboxes.checkDisk;
        const [row] = yield* hub.server.sql<{ readonly status: string }>`
          SELECT status FROM sandboxes WHERE space_id = ${spaceId}
        `;
        assert.equal(row?.status, "running");
        assert.equal(sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId).status, "online");
      }).pipe(Effect.scoped),
  );

  it.live("a limit raised while its home is measured keeps it running", () =>
    Effect.gen(function* () {
      let armed = false;
      let raise: Effect.Effect<unknown> = Effect.void;
      const hub = yield* makeHub({
        sandboxLifecycle: { diskCheckEvery: "1 hour" },
        // The Owner raises the limit after the check read it, before it decides.
        beforeSandboxInspect: () =>
          Effect.suspend(() => {
            if (!armed) return Effect.void;
            armed = false;
            return raise.pipe(Effect.asVoid);
          }),
      });
      const { spaceId, environmentId } = yield* acmeWithSandbox(hub);
      yield* fillHome(hub, spaceId, 2 * 1024 * 1024);
      yield* overrideDisk(hub, spaceId, 1024 * 1024);
      raise = overrideDisk(hub, spaceId, null).pipe(Effect.orDie);
      armed = true;
      yield* hub.service(Sandboxes.Sandboxes).checkDisk;
      assert.equal(sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId).status, "online");
    }).pipe(Effect.scoped),
  );

  it.live("limits below a Sandbox's floors or above the Hub's machine are refused with why", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const { environmentId } = yield* acmeWithSandbox(hub);
      for (const [limits, why] of [
        [{ ...NO_OVERRIDE, memoryBytes: 1024 * 1024 }, "256 MiB"],
        [{ ...NO_OVERRIDE, pids: 10 }, "64"],
        [{ ...NO_OVERRIDE, diskBytes: 100 * 1024 * 1024 }, "1.0 GiB"],
        [{ ...NO_OVERRIDE, cpus: 0.05 }, "0.1"],
        [{ ...NO_OVERRIDE, cpus: 100_000 }, "CPUs"],
        [{ ...NO_OVERRIDE, memoryBytes: 1024 ** 5 }, "Memory can be at most"],
      ] as const) {
        const refused = yield* setLimits(hub, hub.owner, { environmentId, limits });
        assert.equal(refused.status, 400, JSON.stringify(limits));
        assert.include(JSON.stringify(refused.body), why, JSON.stringify(refused.body));
      }
      assert.deepEqual(
        sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId).overrides,
        NO_OVERRIDE,
      );
      // At the floors they are taken as given.
      const floors = { cpus: 0.1, memoryBytes: 256 * 1024 ** 2, pids: 64, diskBytes: 1024 ** 3 };
      const taken = yield* setLimits(hub, hub.owner, { environmentId, limits: floors });
      assert.equal(taken.status, 200, JSON.stringify(taken.body));
      assert.deepEqual(
        sandboxOf(taken.body as unknown as HubSandboxList, environmentId).overrides,
        floors,
      );
    }).pipe(Effect.scoped),
  );
});

describe("Hub con Environments: what stops a Sandbox stays stopped until someone starts it", () => {
  it.live(
    "the Owner's stop holds it: waiting work does not start it, a User's own action does",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const { spaceId, environmentId } = yield* acmeWithSandbox(hub);
        const stopped = yield* act(hub, hub.owner, environmentId, "stop");
        assert.equal(stopped.status, 200);
        assert.isTrue((stopped.body as unknown as HubSandboxDetail).heldByOwner);

        const demand = hub.service(EnvironmentDemand.EnvironmentDemand);
        yield* demand.request([environmentId]);
        assert.equal(
          sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId).status,
          "stopped",
        );
        const refused = yield* demand
          .awaitStarted(environmentId, { actorUserId: undefined, explicit: false })
          .pipe(Effect.flip);
        assert.include(refused.detail, "the Owner stopped it");

        // A User's own action (a message, «Try again») starts it, and ends the hold.
        yield* demand
          .awaitStarted(environmentId, { actorUserId: undefined, explicit: true })
          .pipe(Effect.orDie);
        const started = sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId);
        assert.equal(started.status, "online");
        assert.isFalse(started.heldByOwner);
        assert.deepInclude(yield* audited(hub, ["sandbox.stop"]), {
          action: "sandbox.stop",
          via: "settings",
          hold: true,
        });
        assert.isDefined(spaceId);
      }).pipe(Effect.scoped),
  );

  it.live("work that waits while the Owner stops it does not start it again", () =>
    Effect.gen(function* () {
      let duringStop: Effect.Effect<void> = Effect.void;
      const hub = yield* makeHub({
        beforeSandboxStop: () =>
          Effect.suspend(() => {
            const run = duringStop;
            duringStop = Effect.void;
            return run;
          }),
      });
      const { environmentId } = yield* acmeWithSandbox(hub);
      // As its server ends, its socket goes, and work waiting for it asks for it.
      duringStop = hub
        .service(EnvironmentConnections.EnvironmentConnections)
        .close(environmentId, "heartbeat-timeout")
        .pipe(
          Effect.andThen(hub.service(EnvironmentDemand.EnvironmentDemand).request([environmentId])),
          Effect.ignore,
        );
      const stopped = yield* act(hub, hub.owner, environmentId, "stop");
      assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
      // Nothing started it meanwhile: waiting work asking again neither joins a start nor runs one.
      const refused = yield* hub
        .service(EnvironmentDemand.EnvironmentDemand)
        .awaitStarted(environmentId, { actorUserId: undefined, explicit: false })
        .pipe(Effect.flip);
      assert.include(refused.detail, "the Owner stopped it");
      const after = sandboxOf(yield* sandboxesAs(hub, hub.owner), environmentId);
      assert.equal(after.status, "stopped");
      assert.isTrue(after.heldByOwner);
    }).pipe(Effect.scoped),
  );

  it.live(
    "a Hub disk almost full stops the Sandboxes writing to it, every one when critical, and starts none until there is room again",
    () =>
      Effect.gen(function* () {
        let space = { freeBytes: 500 * GIB, totalBytes: 1000 * GIB };
        const hub = yield* makeHub({
          sandboxLifecycle: {
            diskCheckEvery: "1 hour",
            hostSpace: Effect.sync(() => space),
          },
        });
        const sandboxes = hub.service(Sandboxes.Sandboxes);
        const writer = yield* acmeWithSandbox(hub);
        const quiet = yield* organizationWithSandbox(hub, "Globex");
        yield* sandboxes.checkDisk;
        // One Sandbox writes; then the disk is below its floor (10 GiB here).
        yield* fillHome(hub, writer.spaceId, 32 * 1024 * 1024);
        space = { freeBytes: 9 * GIB, totalBytes: 1000 * GIB };
        yield* sandboxes.checkDisk;
        const failed = sandboxOf(yield* sandboxesAs(hub, hub.owner), writer.environmentId);
        assert.equal(failed.status, "failed");
        assert.include(failed.error ?? "", "almost full");
        assert.equal(
          sandboxOf(yield* sandboxesAs(hub, hub.owner), quiet.environmentId).status,
          "online",
        );
        assert.deepInclude(
          (yield* audited(hub, ["sandbox.stop"])).map((entry) => entry.via),
          "host-disk-low",
        );
        // A little room back is not enough to start again: half as much again as the floor is.
        space = { freeBytes: 11 * GIB, totalBytes: 1000 * GIB };
        const refused = yield* sandboxes
          .ensureRunning({ spaceId: writer.spaceId, actorUserId: undefined })
          .pipe(Effect.flip);
        assert.include(refused.detail, "at least 15 GiB");

        // Below half the floor, every running one stops.
        space = { freeBytes: 4 * GIB, totalBytes: 1000 * GIB };
        yield* sandboxes.checkDisk;
        assert.equal(
          sandboxOf(yield* sandboxesAs(hub, hub.owner), quiet.environmentId).status,
          "failed",
        );

        space = { freeBytes: 16 * GIB, totalBytes: 1000 * GIB };
        yield* sandboxes
          .ensureRunning({ spaceId: writer.spaceId, actorUserId: undefined })
          .pipe(Effect.orDie);
        assert.equal(
          sandboxOf(yield* sandboxesAs(hub, hub.owner), writer.environmentId).status,
          "online",
        );
      }).pipe(Effect.scoped),
  );
});

describe("Hub con Environments: the Hub's disk almost full", () => {
  it.live("stops the Sandboxes that grew first, without waiting to measure the others", () =>
    Effect.gen(function* () {
      let space = { freeBytes: 500 * GIB, totalBytes: 1000 * GIB };
      const slow = new Set<string>();
      const release = yield* Deferred.make<void>();
      const writerStopping = yield* Deferred.make<void>();
      let writerId = "";
      const hub = yield* makeHub({
        sandboxLifecycle: { diskCheckEvery: "1 hour", hostSpace: Effect.sync(() => space) },
        beforeSandboxMeasure: (sandboxId) =>
          slow.has(sandboxId) ? Deferred.await(release) : Effect.void,
        beforeSandboxStop: (sandboxId) =>
          sandboxId === writerId
            ? Deferred.succeed(writerStopping, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });
      const sandboxes = hub.service(Sandboxes.Sandboxes);
      const writer = yield* acmeWithSandbox(hub);
      writerId = sandboxIdOf(writer.spaceId);
      const quiet = yield* organizationWithSandbox(hub, "Globex");
      yield* sandboxes.checkDisk;
      // The writer's growth is on record from the last two checks.
      yield* fillHome(hub, writer.spaceId, 32 * 1024 * 1024);
      yield* sandboxes.checkDisk;
      // Measuring takes minutes now, while the disk is below its floor.
      slow.add(sandboxIdOf(writer.spaceId));
      slow.add(sandboxIdOf(quiet.spaceId));
      space = { freeBytes: 9 * GIB, totalBytes: 1000 * GIB };
      const checking = yield* sandboxes.checkDisk.pipe(Effect.forkScoped);
      // Its stop begins while both measurements still run.
      yield* Deferred.await(writerStopping);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(checking);
      assert.equal(
        sandboxOf(yield* sandboxesAs(hub, hub.owner), writer.environmentId).status,
        "failed",
      );
      assert.equal(
        sandboxOf(yield* sandboxesAs(hub, hub.owner), quiet.environmentId).status,
        "online",
      );
    }).pipe(Effect.scoped),
  );
});
