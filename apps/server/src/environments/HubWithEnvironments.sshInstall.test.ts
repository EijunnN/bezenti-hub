// @effect-diagnostics nodeBuiltinImport:off -- checks the kept key's file is gone.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * «Hub con Environments», spec 3 ticket 10: «Add a machine over SSH». The Hub's own SSH client
 * against a real SSH server in the test's process (SshTestMachine), which plays the machine: the
 * Owner confirms its host key, the Hub runs the four steps there, the machine redeems the run's
 * one-use grant as `t3 join --grant-on-stdin` does and its service asks the Hub how it is used.
 */
import { assert, describe, expect, it } from "@effect/vitest";
import { type EnvironmentId, type SshInstallRun, type SpaceId, UserId } from "@t3tools/contracts";
import { formatEnvironmentCredential } from "@t3tools/shared/environmentJoin";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { listEnvironments } from "./environments.testkit.ts";
import { type Hub, makeHub } from "./HubWithEnvironments.testkit.ts";
import * as SshInstall from "./sshInstall/SshInstall.ts";
import {
  makeTestMachine,
  type StepHandler,
  type StepRequest,
  type TestMachine,
} from "./sshInstall/SshTestMachine.testkit.ts";

const POLICY: SshInstall.SshInstallPolicy["Service"] = {
  runner: {
    archiveVersion: "0.1.7",
    releaseBaseUrl: "https://releases.example.com/t3",
    nodeScriptPath: null,
    nodeEngineRange: null,
  },
  version: "0.1.7",
  stepTimeoutMs: { check: 20_000, install: 20_000, register: 20_000, service: 20_000 },
  reachTimeoutMs: 10_000,
  reachPollMs: 25,
  hostKeyTtlMs: 120_000,
  grantTtlMs: 60_000,
};

const sha256 = (value: string) =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => Buffer.from(bytes).toString("base64url"));

const ownerIdOf = Effect.fn(function* (hub: Hub) {
  const [row] = yield* hub.server.sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM users WHERE is_owner = 1
  `;
  assert.isDefined(row);
  return UserId.make(row.userId);
});

/** Acme with an Admin, a Member and a Guest, each with a session of their own. */
const acmeWithPeople = Effect.fn(function* (hub: Hub) {
  const created = yield* hub
    .service(SpaceDirectory.SpaceDirectory)
    .createOrganization(yield* ownerIdOf(hub), "Acme")
    .pipe(Effect.orDie);
  const people = {
    admin: { id: UserId.make("admin-1"), displayName: "Ada" },
    member: { id: UserId.make("member-1"), displayName: "Grace" },
    guest: { id: UserId.make("guest-1"), displayName: "Linus" },
  } as const;
  const cookies = {} as Record<keyof typeof people, string>;
  for (const role of ["admin", "member", "guest"] as const) {
    cookies[role] = yield* addMember(hub.server, people[role]);
    yield* joinOrganization(hub.server, created.id, people[role].id, role);
  }
  yield* hub.service(SpaceDirectory.SpaceDirectory).changed;
  return { acme: created.id, cookies };
});

/**
 * A machine that does what each step asks: `register` redeems the grant from its standard input
 * (as `t3 join --grant-on-stdin`), `service` asks the Hub how it is used with that credential (as
 * a dedicated machine's server does first). `overrides` replace a step.
 */
const healthyMachine = (hub: Hub, overrides: Partial<Record<string, StepHandler>> = {}) => {
  const hubId = hub.service(EnvironmentRegistry.EnvironmentRegistry).hubId;
  const state = { credential: undefined as string | undefined };
  const handler: StepHandler = (request) => {
    const override = overrides[request.step];
    if (override !== undefined) return override(request);
    switch (request.step) {
      case "check":
        return written(request, "System: Linux x86_64\nRootless Podman is ready.\n", 0);
      case "install":
        return written(request, "T3 Code: 0.1.7\n", 0);
      case "register":
        return redeem(hub, hubId, state, request);
      case "service":
        return askSelf(hub, state.credential).pipe(Effect.as(0));
      default:
        return Effect.succeed(0);
    }
  };
  return { handler, state };
};

/** Writes `text` to the step's output and exits with `code`. */
const written = (request: StepRequest, text: string, code: number) =>
  Effect.sync(() => {
    request.write(text);
    return code;
  });

const redeem = Effect.fn(function* (
  hub: Hub,
  hubId: string,
  state: { credential: string | undefined },
  request: StepRequest,
) {
  const credential = formatEnvironmentCredential(
    hubId,
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
  );
  const answer = yield* hub.server.request("/api/environments/join/grant", {
    body: {
      grant: request.stdin.trim(),
      credentialHash: yield* Effect.promise(() => sha256(credential)),
      os: "linux",
      hostname: "vps-1",
    },
  });
  if (answer.status !== 200) {
    request.write(`The Hub did not register the machine (HTTP ${answer.status}).\n`);
    return 1;
  }
  state.credential = credential;
  request.write(`Joined as ${String(answer.body.name)}.\n`);
  return 0;
});

const askSelf = (hub: Hub, credential: string | undefined) =>
  hub.server.request("/api/environments/self", {
    body: {},
    authorization: `Bearer ${credential ?? "none"}`,
  });

const startBody = (
  machine: TestMachine,
  spaceId: SpaceId,
  overrides: Record<string, unknown> = {},
) => ({
  host: "127.0.0.1",
  port: machine.port,
  username: machine.username,
  auth: {
    kind: "key",
    privateKey: machine.privateKey,
    ...(machine.passphrase === undefined ? {} : { passphrase: machine.passphrase }),
  },
  spaceId,
  name: "Acme VPS",
  hubUrl: "http://127.0.0.1:3773",
  keepForUpdates: false,
  ...overrides,
});

const runOf = (body: unknown) => body as unknown as SshInstallRun;

/** Starts a run as the Owner and confirms the host key it shows; the run once it has ended. */
const installOver = Effect.fn(function* (
  hub: Hub,
  machine: TestMachine,
  spaceId: SpaceId,
  overrides: Record<string, unknown> = {},
) {
  const started = yield* hub.server.request("/api/environments/ssh/start", {
    cookie: hub.owner,
    body: startBody(machine, spaceId, overrides),
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const run = runOf(started.body);
  assert.equal(run.state, "awaiting-host-key", JSON.stringify(run));
  const confirmed = yield* hub.server.request("/api/environments/ssh/confirm", {
    cookie: hub.owner,
    body: { runId: run.runId, fingerprint: run.hostKey?.fingerprint },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return yield* hub.service(SshInstall.SshInstall).awaitFinished(run.runId);
});

const auditOf = Effect.fn(function* (hub: Hub, environmentId: string) {
  return yield* hub.server.sql<{ readonly action: string; readonly detail: string }>`
    SELECT action, detail_json AS detail FROM audit_log
    WHERE target_id = ${environmentId} ORDER BY rowid
  `;
});

const keyFragments = (privateKey: string) =>
  privateKey.split("\n").filter((line) => line.length >= 16 && !line.startsWith("-----"));

describe("Hub con Environments: add a machine over SSH", () => {
  it.live(
    "installs and registers it dedicated, via ssh, only once the Owner confirms its host key",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ sshInstallPolicy: POLICY });
        const { acme } = yield* acmeWithPeople(hub);
        const machine = yield* makeTestMachine();
        machine.setHandler(healthyMachine(hub).handler);

        const started = yield* hub.server.request("/api/environments/ssh/start", {
          cookie: hub.owner,
          body: startBody(machine, acme),
        });
        assert.equal(started.status, 200, JSON.stringify(started.body));
        const run = runOf(started.body);
        // The host key is shown, and nothing was signed into or run before it is confirmed.
        assert.equal(run.state, "awaiting-host-key");
        assert.deepEqual(run.hostKey, {
          algorithm: "ssh-ed25519",
          fingerprint: machine.fingerprint,
          known: false,
        });
        assert.notInclude(machine.authentications, "publickey");
        assert.deepEqual(machine.steps, []);
        // Another key than the one shown starts nothing.
        const wrong = yield* hub.server.request("/api/environments/ssh/confirm", {
          cookie: hub.owner,
          body: { runId: run.runId, fingerprint: "SHA256:not-the-one-shown" },
        });
        assert.equal(wrong.status, 409, JSON.stringify(wrong.body));
        assert.deepEqual(machine.steps, []);

        const confirmed = yield* hub.server.request("/api/environments/ssh/confirm", {
          cookie: hub.owner,
          body: { runId: run.runId, fingerprint: machine.fingerprint },
        });
        assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
        const done = yield* hub.service(SshInstall.SshInstall).awaitFinished(run.runId);
        assert.equal(done.state, "succeeded", JSON.stringify(done));
        assert.deepEqual(
          done.steps.map((step) => [step.id, step.state]),
          [
            ["check", "succeeded"],
            ["install", "succeeded"],
            ["register", "succeeded"],
            ["service", "succeeded"],
          ],
        );
        assert.include(done.steps[0]?.output ?? [], "Rootless Podman is ready.");
        assert.include(done.steps[3]?.output ?? [], "The machine reached the Hub.");
        assert.deepEqual(
          machine.steps.map((step) => step.step),
          ["check", "install", "register", "service"],
        );
        // T3 of the Hub's version from its release source; the grant only on standard input.
        assert.include(machine.steps[1]?.stdin ?? "", "T3_ARCHIVE_VERSION='0.1.7'");
        const grant = machine.steps[2]?.stdin.trim() ?? "";
        assert.isAbove(grant.length, 30);
        assert.notInclude(machine.steps[2]?.script ?? "", grant);
        assert.notInclude(JSON.stringify(done), grant);

        const environmentId = done.environmentId;
        assert.isNotNull(environmentId);
        const listed = (yield* listEnvironments(hub.server, hub.owner)).find(
          (environment) => environment.id === environmentId,
        );
        assert.deepInclude(listed, { name: "Acme VPS", mode: "dedicated", spaceId: acme });

        // Audited as registered dedicated via ssh, with the host; never the key.
        const audit = yield* auditOf(hub, environmentId!);
        assert.deepEqual(
          audit.map((row) => [row.action, JSON.parse(row.detail)]),
          [
            [
              "environment.register",
              {
                kind: "external",
                os: "linux",
                mode: "dedicated",
                via: "ssh",
                host: "127.0.0.1",
                spaceId: acme,
              },
            ],
          ],
        );
        const allAudit = yield* hub.server.sql<{ readonly row: string }>`
          SELECT detail_json || target_name AS row FROM audit_log
        `;
        for (const fragment of keyFragments(machine.privateKey)) {
          assert.notInclude(JSON.stringify(allAudit), fragment);
        }
        // The key was not kept, and the grant is spent.
        const kept = yield* hub
          .service(ServerSecretStore.ServerSecretStore)
          .get(SshInstall.keptKeySecretName(environmentId!));
        assert.isTrue(Option.isNone(kept));
        const replay = yield* hub.server.request("/api/environments/join/grant", {
          body: {
            grant,
            credentialHash: yield* Effect.promise(() => sha256("another")),
            os: "linux",
            hostname: "evil",
          },
        });
        assert.equal(replay.status, 401, JSON.stringify(replay.body));
      }).pipe(Effect.scoped),
  );

  it.live("refuses Admin, Member and Guest on every door of it, the progress included", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme, cookies } = yield* acmeWithPeople(hub);
      const machine = yield* makeTestMachine();
      const started = yield* hub.server.request("/api/environments/ssh/start", {
        cookie: hub.owner,
        body: startBody(machine, acme),
      });
      const run = runOf(started.body);
      for (const role of ["admin", "member", "guest"] as const) {
        const doors = [
          ["/api/environments/ssh/start", startBody(machine, acme)],
          ["/api/environments/ssh/confirm", { runId: run.runId, fingerprint: machine.fingerprint }],
          ["/api/environments/ssh/status", { runId: run.runId }],
          ["/api/environments/ssh/cancel", { runId: run.runId }],
        ] as const;
        for (const [path, body] of doors) {
          const refused = yield* hub.server.request(path, { cookie: cookies[role], body });
          assert.equal(refused.status, 403, `${role} ${path}: ${JSON.stringify(refused.body)}`);
          assert.notInclude(JSON.stringify(refused.body), machine.fingerprint);
        }
      }
      // Nothing they sent moved the Owner's run, or reached the machine.
      const status = yield* hub.server.request("/api/environments/ssh/status", {
        cookie: hub.owner,
        body: { runId: run.runId },
      });
      assert.equal(runOf(status.body).state, "awaiting-host-key");
      assert.deepEqual(machine.steps, []);
    }).pipe(Effect.scoped),
  );

  it.live("stops at a failing step with its output, and leaves no machine registered", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: { ...POLICY, reachTimeoutMs: 300 } });
      const { acme } = yield* acmeWithPeople(hub);
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly overrides: (machine: TestMachine) => Partial<Record<string, StepHandler>>;
        readonly failedAt: string;
        readonly error: RegExp;
        readonly output?: string;
        readonly undone: boolean;
      }> = [
        {
          name: "no Podman and no sudo",
          overrides: () => ({
            check: (request) =>
              written(request, "Podman is not installed, and deploy cannot use sudo.\n", 12),
          }),
          failedAt: "check",
          error: /Podman is missing/u,
          output: "Podman is not installed, and deploy cannot use sudo.",
          undone: false,
        },
        {
          name: "a failed install",
          overrides: () => ({
            install: (request) =>
              written(request, "curl: (22) The requested URL returned error: 404\n", 1),
          }),
          failedAt: "install",
          error: /Install T3 Code failed \(exit code 1\)/u,
          output: "curl: (22) The requested URL returned error: 404",
          undone: false,
        },
        {
          name: "a registration the machine never made",
          overrides: () => ({ register: () => Effect.succeed(1) }),
          failedAt: "register",
          error: /Register the machine failed/u,
          undone: true,
        },
        {
          name: "a lost connection",
          overrides: (machine) => ({
            install: () => Effect.sync(() => machine.drop()).pipe(Effect.andThen(Effect.never)),
          }),
          failedAt: "install",
          error: /connection was lost/u,
          undone: false,
        },
        {
          name: "a service that never reaches the Hub",
          overrides: () => ({ service: () => Effect.succeed(0) }),
          failedAt: "service",
          error: /did not reach the Hub in time/u,
          undone: true,
        },
      ];
      for (const testCase of cases) {
        const machine = yield* makeTestMachine();
        machine.setHandler(healthyMachine(hub, testCase.overrides(machine)).handler);
        const done = yield* installOver(hub, machine, acme);
        assert.equal(done.state, "failed", `${testCase.name}: ${JSON.stringify(done)}`);
        assert.match(done.error ?? "", testCase.error, testCase.name);
        const failed = done.steps.find((step) => step.state === "failed");
        assert.equal(failed?.id, testCase.failedAt, testCase.name);
        if (testCase.output !== undefined) {
          assert.include(failed?.output ?? [], testCase.output, testCase.name);
        }
        // The steps after it never ran.
        const after = done.steps.slice(done.steps.findIndex((step) => step.state === "failed") + 1);
        assert.isTrue(
          after.every((step) => step.state === "cancelled"),
          testCase.name,
        );
        assert.isNull(done.environmentId, testCase.name);
        assert.equal(
          machine.steps.some((step) => step.step === "undo"),
          testCase.undone,
          testCase.name,
        );
      }
      // No machine of any of them is live, and the one that had registered was removed, audited.
      const listed = yield* listEnvironments(hub.server, hub.owner);
      assert.deepEqual(
        listed.filter((environment) => environment.name === "Acme VPS"),
        [],
      );
      const removed = yield* hub.server.sql<{ readonly detail: string }>`
        SELECT detail_json AS detail FROM audit_log WHERE action = 'environment.remove'
      `;
      assert.deepEqual(
        removed.map((row) => JSON.parse(row.detail)),
        [{ via: "ssh" }],
      );
    }).pipe(Effect.scoped),
  );

  it.live("cancels like a failure: the grant ends and a machine it registered is removed", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme } = yield* acmeWithPeople(hub);
      const service = hub.service(SshInstall.SshInstall);
      const confirmAndCancelAt = Effect.fn(function* (step: string) {
        const reached = yield* Deferred.make<void>();
        const machine = yield* makeTestMachine();
        // Holds the step until the cancel; at `service` the machine is registered already.
        const { handler } = healthyMachine(hub, {
          [step]: (request) =>
            written(request, "Working...\n", 0).pipe(
              Effect.andThen(Deferred.succeed(reached, undefined)),
              Effect.andThen(Effect.never),
            ),
        });
        machine.setHandler(handler);
        const started = yield* hub.server.request("/api/environments/ssh/start", {
          cookie: hub.owner,
          body: startBody(machine, acme),
        });
        const run = runOf(started.body);
        yield* hub.server.request("/api/environments/ssh/confirm", {
          cookie: hub.owner,
          body: { runId: run.runId, fingerprint: machine.fingerprint },
        });
        yield* Deferred.await(reached);
        const cancelled = yield* hub.server.request("/api/environments/ssh/cancel", {
          cookie: hub.owner,
          body: { runId: run.runId },
        });
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
        return { run: yield* service.awaitFinished(run.runId), machine };
      });

      const atInstall = yield* confirmAndCancelAt("install");
      assert.equal(atInstall.run.state, "cancelled");
      assert.equal(atInstall.run.steps[1]?.state, "cancelled");
      assert.isNull(atInstall.run.environmentId);

      const atService = yield* confirmAndCancelAt("service");
      assert.equal(atService.run.state, "cancelled", JSON.stringify(atService.run));
      assert.isNull(atService.run.environmentId);
      assert.isTrue(atService.machine.steps.some((step) => step.step === "undo"));
      const grant = atService.machine.steps.find((step) => step.step === "register")?.stdin;
      const listed = yield* listEnvironments(hub.server, hub.owner);
      assert.deepEqual(
        listed.filter((environment) => environment.name === "Acme VPS"),
        [],
      );
      // Its grant is spent with it.
      const late = yield* hub.server.request("/api/environments/join/grant", {
        body: {
          grant: grant?.trim(),
          credentialHash: yield* Effect.promise(() => sha256("late")),
          os: "linux",
          hostname: "vps-1",
        },
      });
      assert.equal(late.status, 401);

      // Waiting for its host key, a cancel just forgets it.
      const machine = yield* makeTestMachine();
      const waiting = runOf(
        (yield* hub.server.request("/api/environments/ssh/start", {
          cookie: hub.owner,
          body: startBody(machine, acme),
        })).body,
      );
      const cancelled = yield* hub.server.request("/api/environments/ssh/cancel", {
        cookie: hub.owner,
        body: { runId: waiting.runId },
      });
      assert.equal(runOf(cancelled.body).state, "cancelled");
      const confirmLate = yield* hub.server.request("/api/environments/ssh/confirm", {
        cookie: hub.owner,
        body: { runId: waiting.runId, fingerprint: machine.fingerprint },
      });
      assert.equal(confirmLate.status, 409);
      assert.deepEqual(machine.steps, []);
    }).pipe(Effect.scoped),
  );

  it.live("refuses a host key other than the confirmed or stored one, without signing in", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme } = yield* acmeWithPeople(hub);
      // Installed once: its host key is stored with it.
      const firstScope = yield* Scope.make();
      const first = yield* makeTestMachine().pipe(Scope.provide(firstScope));
      first.setHandler(healthyMachine(hub).handler);
      const installed = yield* installOver(hub, first, acme);
      assert.equal(installed.state, "succeeded", JSON.stringify(installed));
      const clientKey = { privateKey: first.privateKey };
      yield* Scope.close(firstScope, Exit.void);

      // The same address now shows another key: refused before any sign-in.
      const impostor = yield* makeTestMachine({ port: first.port, clientKey });
      const again = yield* hub.server.request("/api/environments/ssh/start", {
        cookie: hub.owner,
        body: startBody(impostor, acme),
      });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      const refused = runOf(again.body);
      assert.equal(refused.state, "failed");
      assert.match(refused.error ?? "", /host key changed/u);
      assert.include(refused.error ?? "", first.fingerprint);
      assert.notInclude(impostor.authentications, "publickey");
      assert.deepEqual(impostor.steps, []);
    }).pipe(Effect.scoped),
  );

  it.live("signs in only to the key it confirmed, even if the machine changes it meanwhile", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme } = yield* acmeWithPeople(hub);
      const shownScope = yield* Scope.make();
      const shown = yield* makeTestMachine().pipe(Scope.provide(shownScope));
      const started = yield* hub.server.request("/api/environments/ssh/start", {
        cookie: hub.owner,
        body: startBody(shown, acme),
      });
      const run = runOf(started.body);
      const clientKey = { privateKey: shown.privateKey };
      yield* Scope.close(shownScope, Exit.void);
      const swapped = yield* makeTestMachine({ port: shown.port, clientKey });
      yield* hub.server.request("/api/environments/ssh/confirm", {
        cookie: hub.owner,
        body: { runId: run.runId, fingerprint: shown.fingerprint },
      });
      const done = yield* hub.service(SshInstall.SshInstall).awaitFinished(run.runId);
      assert.equal(done.state, "failed");
      assert.match(done.error ?? "", /host key is not the one confirmed/u);
      assert.notInclude(swapped.authentications, "publickey");
      assert.deepEqual(swapped.steps, []);
    }).pipe(Effect.scoped),
  );

  it.live(
    "keeps the key and passphrase out of its output, unless asked keeps them in the secret store",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ sshInstallPolicy: POLICY });
        const { acme } = yield* acmeWithPeople(hub);
        const machine = yield* makeTestMachine({ passphrase: "correct horse battery" });
        machine.setHandler(
          healthyMachine(hub, {
            // A machine that echoes them anyway.
            check: (request) =>
              written(request, `${machine.privateKey}\npassphrase: correct horse battery\n`, 0),
          }).handler,
        );
        const done = yield* installOver(hub, machine, acme, { keepForUpdates: true });
        assert.equal(done.state, "succeeded", JSON.stringify(done));
        assert.isTrue(done.keyKept);
        const shown = JSON.stringify(done);
        for (const fragment of keyFragments(machine.privateKey)) assert.notInclude(shown, fragment);
        assert.notInclude(shown, "correct horse battery");
        assert.include(done.steps[0]?.output ?? [], "passphrase: [redacted]");

        const environmentId = done.environmentId as EnvironmentId;
        const secrets = hub.service(ServerSecretStore.ServerSecretStore);
        const kept = yield* secrets.get(SshInstall.keptKeySecretName(environmentId));
        assert.isTrue(Option.isSome(kept));
        assert.include(new TextDecoder().decode(Option.getOrThrow(kept)), "correct horse battery");

        // Removing the machine forgets its key and its host record.
        const removed = yield* hub.server.request("/api/environments/remove", {
          cookie: hub.owner,
          body: { environmentId },
        });
        assert.equal(removed.status, 200, JSON.stringify(removed.body));
        const keptFile = NodePath.join(
          hub.service(ServerConfig.ServerConfig).secretsDir,
          `${SshInstall.keptKeySecretName(environmentId)}.bin`,
        );
        yield* Effect.promise(() => expect.poll(() => NodeFS.existsSync(keptFile)).toBe(false));
        const hosts = yield* hub.server.sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM environment_ssh_hosts
        `;
        assert.equal(hosts[0]?.count, 0);
      }).pipe(Effect.scoped),
  );

  it.live("refuses a second run to the same machine, and addresses it never opens", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sshInstallPolicy: POLICY });
      const { acme } = yield* acmeWithPeople(hub);
      const machine = yield* makeTestMachine();
      const first = yield* hub.server.request("/api/environments/ssh/start", {
        cookie: hub.owner,
        body: startBody(machine, acme),
      });
      assert.equal(first.status, 200);
      for (const host of ["127.0.0.1", "localhost"]) {
        const second = yield* hub.server.request("/api/environments/ssh/start", {
          cookie: hub.owner,
          body: startBody(machine, acme, { host }),
        });
        assert.equal(second.status, 409, `${host}: ${JSON.stringify(second.body)}`);
      }
      const refusals: ReadonlyArray<Record<string, unknown>> = [
        { host: "169.254.169.254" },
        { host: "-oProxyCommand=touch /tmp/x" },
        { username: "root" },
        { username: "-oProxyCommand=x" },
        { hubUrl: "http://hub.example.com" },
        { auth: { kind: "key", privateKey: "not a key" } },
        { spaceId: "no-such-space" },
      ];
      for (const overrides of refusals) {
        const refused = yield* hub.server.request("/api/environments/ssh/start", {
          cookie: hub.owner,
          body: startBody(machine, acme, overrides),
        });
        assert.equal(
          refused.status,
          400,
          `${JSON.stringify(overrides)}: ${JSON.stringify(refused.body)}`,
        );
      }
      // A grant only crosses HTTPS or this machine's loopback.
      const remote = yield* hub.server.request("/api/environments/join/grant", {
        peer: "203.0.113.9",
        body: { grant: "x".repeat(43), credentialHash: "y".repeat(43), os: "linux", hostname: "h" },
      });
      assert.equal(remote.status, 400);
      assert.deepEqual(machine.steps, []);
    }).pipe(Effect.scoped),
  );
});
