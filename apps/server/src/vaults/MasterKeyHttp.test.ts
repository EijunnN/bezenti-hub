/**
 * The master key's HTTP door (spec 5 «Vaults», ticket 01): only the Owner sees its status, and
 * only the Owner with a strong factor in the request downloads its backup, which is audited. The
 * key never reaches a log or a span.
 */
// @effect-diagnostics nodeBuiltinImport:off - the test reads the key file the Hub wrote.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";

import { masterKeyPath } from "../auth/MasterKeyFile.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  passkeyReauth,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as ServerConfig from "../config.ts";

const STATUS = "/api/vaults/master-key";
const BACKUP = "/api/vaults/master-key/backup";
/** A proof no one could pass: the refusal must come before it is ever checked. */
const BOGUS_REAUTH = { reauth: { method: "password", password: "nope", totpCode: "000000" } };

const hub = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const authenticator = yield* makeAuthenticator();
  const { created } = yield* bootstrapOwner(server, authenticator);
  const owner = created.cookie ?? "";
  const made = yield* server.request("/api/spaces/organizations", {
    body: { name: "Acme" },
    cookie: owner,
  });
  const acmeId = made.body.id as string;
  const role = Effect.fn(function* (id: string, as: "admin" | "member" | "guest") {
    const cookie = yield* addMember(server, { id, displayName: id });
    yield* joinOrganization(server, acmeId, id, as);
    return cookie;
  });
  const others = {
    admin: yield* role("ada", "admin"),
    member: yield* role("grace", "member"),
    guest: yield* role("linus", "guest"),
    // In no Organization at all.
    loner: yield* addMember(server, { id: "alan", displayName: "Alan" }),
  };
  const keyFile = yield* masterKeyPath().pipe(
    Effect.provideService(
      ServerConfig.ServerConfig,
      Context.get(server.services, ServerConfig.ServerConfig),
    ),
    Effect.provide(NodeServices.layer),
  );
  return { server, authenticator, owner, others, keyFile };
});

it.effect("only the Owner sees the master key's status, not yet backed up", () =>
  Effect.gen(function* () {
    const { server, owner, others, keyFile } = yield* hub;
    const status = yield* server.request(STATUS, { cookie: owner });
    assert.equal(status.status, 200);
    assert.equal(status.body.backedUpAt, null);
    assert.equal(status.body.keyFile, keyFile);
    assert.match(status.body.keyId as string, /^[0-9a-f]{16}$/);
    for (const [who, cookie] of Object.entries(others)) {
      const refused = yield* server.request(STATUS, { cookie });
      assert.equal(refused.status, 403, `${who} saw the master key's status`);
      assert.isUndefined(refused.body.keyId);
    }
    const anonymous = yield* server.request(STATUS);
    assert.equal(anonymous.status, 401);
  }),
);

it.effect("nobody but the Owner downloads the backup, whatever proof they send", () =>
  Effect.gen(function* () {
    const { server, owner, others } = yield* hub;
    for (const [who, cookie] of Object.entries(others)) {
      const refused = yield* server.request(BACKUP, { cookie, body: BOGUS_REAUTH });
      assert.equal(refused.status, 403, `${who} downloaded the master key`);
      assert.isUndefined(refused.body.key);
    }
    const audited = yield* server.sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM audit_log WHERE action = 'secret.master_key.export'
    `;
    assert.equal(audited[0]?.count, 0);
    const status = yield* server.request(STATUS, { cookie: owner });
    assert.equal(status.body.backedUpAt, null);
  }),
);

it.effect("the Owner without a strong factor in the request gets nothing", () =>
  Effect.gen(function* () {
    const { server, owner } = yield* hub;
    const bare = yield* server.request(BACKUP, { cookie: owner, body: BOGUS_REAUTH });
    assert.equal(bare.status, 403);
    assert.isUndefined(bare.body.key);
    const status = yield* server.request(STATUS, { cookie: owner });
    assert.equal(status.body.backedUpAt, null);
  }),
);

it.effect(
  "the Owner with a passkey downloads the key, audited, and the warning clears; no log or span holds it",
  () => {
    const logs: Array<string> = [];
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const show = (part: unknown) => {
      try {
        return JSON.stringify(part) ?? String(part);
      } catch {
        return String(part);
      }
    };
    const logger = Logger.make((options) => {
      logs.push(
        [options.message, options.cause, options.fiber.getRef(References.CurrentLogAnnotations)]
          .map(show)
          .join(" "),
      );
    });
    // The whole Hub runs under them: its startup (the key created) and every request.
    return Effect.gen(function* () {
      const { server, authenticator, owner, keyFile } = yield* hub;
      const reauth = yield* passkeyReauth(server, authenticator);
      const backup = yield* server.request(BACKUP, { cookie: owner, body: { reauth } });
      assert.equal(backup.status, 200);
      const keyText = NodeFS.readFileSync(keyFile, "utf8");
      assert.equal(backup.body.key, keyText);
      const status = backup.body.status as { backedUpAt: string | null; keyId: string };
      assert.isString(status.backedUpAt);

      const after = yield* server.request(STATUS, { cookie: owner });
      assert.equal(after.body.backedUpAt, status.backedUpAt);

      const [entry] = yield* server.sql<{
        readonly detail_json: string;
        readonly actor_source: string;
      }>`
        SELECT detail_json, actor_source FROM audit_log WHERE action = 'secret.master_key.export'
      `;
      assert.isDefined(entry);
      assert.equal(entry!.actor_source, "user");
      assert.deepEqual(JSON.parse(entry!.detail_json), { via: "settings", keyId: status.keyId });

      const secret = keyText.trim().split(":")[1]!;
      const recorded = [
        ...logs,
        ...spans.flatMap((span) => [
          span.name,
          ...Array.from(span.attributes.values(), (value) => JSON.stringify(value)),
        ]),
      ];
      assert.include(
        spans.map((span) => span.name),
        "environment.vaults.masterKeyBackup",
      );
      assert.isAbove(logs.length, 0);
      assert.isFalse(
        recorded.some((value) => value.includes(secret)),
        "the master key reached a log or a span",
      );
    }).pipe(
      Effect.withTracer(tracer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  },
);
