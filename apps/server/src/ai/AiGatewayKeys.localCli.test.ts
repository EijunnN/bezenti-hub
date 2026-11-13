/**
 * Local CLI keys (spec 4 ticket 10): a User's own gateway keys, made, listed and revoked through
 * the session doors (WS `aiGatewayKeys.*`), on a real port over the fake CLIProxyAPI with Ada
 * (Admin), Grace (Member) and Linus (Guest) of Acme and Gus of Globex.
 */
// @effect-diagnostics nodeBuiltinImport:off - the SHA-256 the Hub keeps, computed here to compare.
import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import { SpaceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import { acmeSetup, call, hub, messages, platform, posix } from "./AiGatewayRoute.testkit.ts";

const MESSAGES = "/api/ai/anthropic/v1/messages";

it.live.skipIf(!posix || platform === undefined)(
  "a User makes, lists and revokes only their own keys; the Owner sees and revokes all; no agent makes one",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* acmeSetup(setup);
      const asGrace = CommandActor.actAs(setup.people.member);
      const asGus = CommandActor.actAs(setup.people.globexMember);

      // Grace makes a key for Acme; Gus one for Globex. The key is in the answer, once.
      const grace = yield* setup.keys
        .createForSession({ name: "Grace laptop", spaceId: setup.acmeId })
        .pipe(asGrace);
      assert.match(Redacted.value(grace.key), /^t3gk_[A-Za-z0-9_-]{43}$/u);
      assert.equal(grace.created.spaceId, setup.acmeId);
      assert.equal(grace.created.spaceName, "Acme");
      assert.equal(grace.created.userId, setup.people.member);
      const gus = yield* setup.keys
        .createForSession({ name: "Gus desktop", spaceId: setup.globexId })
        .pipe(asGus);

      // Nobody makes a key for a Space they do not work in.
      const sneaky = yield* setup.keys
        .createForSession({ name: "Sneaky", spaceId: setup.acmeId })
        .pipe(asGus, Effect.flip);
      assert.equal(sneaky.reason, "forbidden");

      // Each lists only their own, never a key or a hash; the Owner lists everyone's.
      const gracesList = yield* setup.keys.listForSession.pipe(asGrace);
      assert.isFalse(gracesList.everyone);
      assert.deepEqual(
        gracesList.keys.map((key) => key.name),
        ["Grace laptop"],
      );
      assert.notInclude(JSON.stringify(gracesList), Redacted.value(grace.key));
      assert.notInclude(JSON.stringify(gracesList), "hash");
      const ownersList = yield* setup.keys.listForSession.pipe(setup.asOwner);
      assert.isTrue(ownersList.everyone);
      assert.sameMembers(
        ownersList.keys.map((key) => key.name),
        ["Grace laptop", "Gus desktop"],
      );
      assert.equal(ownersList.keys.find((key) => key.name === "Gus desktop")?.userName, "gus");

      // Grace cannot revoke Gus's key, nor Gus hers: as if it did not exist.
      const graceOnGus = yield* setup.keys
        .revokeForSession({ keyId: gus.created.keyId })
        .pipe(asGrace, Effect.flip);
      assert.equal(graceOnGus.reason, "not-found");
      const gusOnGrace = yield* setup.keys
        .revokeForSession({ keyId: grace.created.keyId })
        .pipe(asGus, Effect.flip);
      assert.equal(gusOnGrace.reason, "not-found");
      // Ada, Grace's Admin in Acme, neither.
      const adaOnGrace = yield* setup.keys
        .revokeForSession({ keyId: grace.created.keyId })
        .pipe(CommandActor.actAs(setup.people.admin), Effect.flip);
      assert.equal(adaOnGrace.reason, "not-found");
      for (const made of [grace, gus]) {
        const answer = yield* call(setup, MESSAGES, {
          key: Redacted.value(made.key),
          body: messages(),
        });
        assert.equal(answer.status, 200);
      }

      // Grace revokes hers; the Owner revokes Gus's: the next request is refused.
      const afterGrace = yield* setup.keys
        .revokeForSession({ keyId: grace.created.keyId })
        .pipe(asGrace);
      assert.lengthOf(afterGrace.keys, 0);
      yield* setup.keys.revokeForSession({ keyId: gus.created.keyId }).pipe(setup.asOwner);
      for (const made of [grace, gus]) {
        const answer = yield* call(setup, MESSAGES, {
          key: Redacted.value(made.key),
          body: messages(),
        });
        assert.equal(answer.status, 401);
      }
      const audits = yield* setup.server.sql<{
        readonly action: string;
        readonly actor: string | null;
        readonly detail: string;
      }>`
        SELECT action, actor_user_id AS actor, detail_json AS detail FROM audit_log
        WHERE action LIKE 'ai_gateway_key.%' ORDER BY rowid
      `;
      assert.deepEqual(
        audits.map((row) => [row.action, row.actor]),
        [
          ["ai_gateway_key.create", setup.people.member],
          ["ai_gateway_key.create", setup.people.globexMember],
          ["ai_gateway_key.revoke", setup.people.member],
          ["ai_gateway_key.revoke", setup.ownerId],
        ],
      );

      // An agent (MCP, as its User) or a session limited to one Space makes and lists nothing.
      for (const actor of [
        { _tag: "User", userId: setup.people.member, via: "agent" },
        { _tag: "User", userId: setup.people.member, spaceLimit: setup.acmeId },
        { _tag: "ThreadOwner" },
      ] as const) {
        const made = yield* setup.keys
          .createForSession({ name: "Agent", spaceId: setup.acmeId })
          .pipe(CommandActor.actAsResolved(actor), Effect.flip);
        assert.equal(made.reason, "forbidden");
        const listed = yield* setup.keys.listForSession.pipe(
          CommandActor.actAsResolved(actor),
          Effect.flip,
        );
        assert.equal(listed.reason, "forbidden");
      }
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a key is kept only as its hash and defaults to the User's Personal space",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* acmeSetup(setup);
      const made = yield* setup.keys.createForSession({ name: "Owner laptop" }).pipe(setup.asOwner);
      assert.equal(made.created.spaceId, SpaceId.make(`personal:${setup.ownerId}`));
      const key = Redacted.value(made.key);
      const rows = yield* setup.server.sql<Record<string, unknown>>`SELECT * FROM ai_gateway_keys`;
      const stored = JSON.stringify(rows);
      assert.notInclude(stored, key);
      assert.notInclude(stored, key.slice(5));
      assert.include(stored, NodeCrypto.createHash("sha256").update(key, "utf8").digest("hex"));
      const audit = yield* setup.server.sql<Record<string, unknown>>`SELECT * FROM audit_log`;
      assert.notInclude(JSON.stringify(audit), key.slice(5));
      // A key needs a name; without a Space and no Personal space, a User is told to choose one.
      const unnamed = yield* setup.keys
        .createForSession({ name: "   " })
        .pipe(CommandActor.actAs(setup.people.member), Effect.flip);
      assert.equal(unnamed.reason, "invalid");
      yield* setup.server.sql`
        DELETE FROM installation_permissions
        WHERE user_id = ${setup.people.member} AND permission = 'personalSpace.create'
      `;
      const nowhere = yield* setup.keys
        .createForSession({ name: "Grace laptop" })
        .pipe(CommandActor.actAs(setup.people.member), Effect.flip);
      assert.equal(nowhere.reason, "forbidden");
      assert.include(nowhere.message, "Choose a Space");
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a key for Acme reaches only Acme's accounts, the highest priority first, and counts as its User's usage there",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ids = yield* acmeSetup(setup);
      const made = yield* setup.keys
        .createForSession({ name: "Grace laptop", spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(setup.people.member));
      const key = Redacted.value(made.key);
      const before = setup.upstream().length;

      // Globex's own model and Globex's account by name: nothing reaches CLIProxyAPI.
      const globexModel = yield* call(setup, "/api/ai/openai/v1/chat/completions", {
        key,
        body: { model: "globex-secret-model", messages: [] },
      });
      assert.equal(globexModel.status, 404);
      const globexPinned = yield* call(setup, MESSAGES, {
        key,
        body: messages(`acct-${ids.globexClaude}/claude-sonnet-5-5`),
      });
      assert.equal(globexPinned.status, 403);
      assert.equal(setup.upstream().length, before, "a Globex account was reached");
      const models = yield* call(setup, "/api/ai/anthropic/v1/models", { key });
      assert.notInclude(models.text, "globex-secret-model");

      // No model pinned: the first allowed account by global priority that serves it.
      const first = yield* call(setup, MESSAGES, { key, body: messages() });
      assert.equal(first.status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${ids.claudeA}/claude-sonnet-5-5`);
      yield* setup.accounts
        .reorder({
          accountIds: [
            ids.claudeB,
            ids.claudeA,
            ids.globexClaude,
            ids.router,
            ids.globexRouter,
            ids.graceGemini,
          ],
        })
        .pipe(setup.asOwner);
      const second = yield* call(setup, MESSAGES, { key, body: messages() });
      assert.equal(second.status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${ids.claudeB}/claude-sonnet-5-5`);

      // Counted like a Thread's usage: Grace, Acme, the account, no Thread (the two refusals
      // as failed requests that reached no account).
      yield* setup.settled(4);
      const usage = yield* setup.usage.summary({ userId: setup.people.member }).pipe(setup.asOwner);
      assert.sameDeepMembers(
        usage.rows.map((row) => [
          row.userId,
          row.spaceId,
          row.accountId,
          row.requests,
          row.failedRequests,
        ]),
        [
          [setup.people.member, setup.acmeId, null, 2, 2],
          [setup.people.member, setup.acmeId, ids.claudeA, 1, 0],
          [setup.people.member, setup.acmeId, ids.claudeB, 1, 0],
        ],
      );
      // The key's last use shows in the list.
      const listed = yield* setup.keys.listForSession.pipe(CommandActor.actAs(setup.people.member));
      assert.isNotNull(listed.keys[0]!.lastUsedAt);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a key is revoked once its User leaves its Space (403 from the next request) or is removed",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      yield* acmeSetup(setup);
      const asGrace = CommandActor.actAs(setup.people.member);
      const acme = yield* setup.keys
        .createForSession({ name: "Acme key", spaceId: setup.acmeId })
        .pipe(asGrace);
      const ask = (made: { readonly key: Redacted.Redacted<string> }) =>
        call(setup, MESSAGES, { key: Redacted.value(made.key), body: messages() }).pipe(
          Effect.map((answer) => answer.status),
        );
      const unused = yield* setup.keys
        .createForSession({ name: "Unused key", spaceId: setup.acmeId })
        .pipe(asGrace);
      assert.equal(yield* ask(acme), 200);

      // Grace leaves Acme: the next request is 403, and the key is revoked for good (audited).
      yield* setup.server.sql`
        DELETE FROM space_memberships WHERE space_id = ${setup.acmeId} AND user_id = ${setup.people.member}
      `;
      yield* setup.directory.membershipsChanged([setup.people.member]);
      assert.equal(yield* ask(acme), 403);
      const reasonOf = (keyId: string) =>
        setup.server.sql<{ readonly reason: string | null }>`
          SELECT revoked_reason AS reason FROM ai_gateway_keys WHERE key_id = ${keyId}
        `.pipe(Effect.map((rows) => rows[0]?.reason ?? null));
      assert.equal(yield* reasonOf(acme.created.keyId), "space-lost");
      assert.equal(yield* ask(acme), 403);
      // A key not used since is revoked by the Hub's watch of Memberships (here, its call).
      yield* setup.keys.revokeLostSpaces(setup.people.member);
      assert.equal(yield* reasonOf(unused.created.keyId), "space-lost");
      // Back in Acme, the key stays revoked: she makes a new one.
      yield* setup.server.sql`
        INSERT INTO space_memberships (space_id, user_id, role, created_at)
        VALUES (${setup.acmeId}, ${setup.people.member}, 'member', '2026-11-02T00:00:00.000Z')
      `;
      yield* setup.directory.membershipsChanged([setup.people.member]);
      assert.notEqual(yield* ask(acme), 200);
      assert.lengthOf((yield* setup.keys.listForSession.pipe(asGrace)).keys, 0);
      const audits = yield* setup.server.sql<{ readonly action: string; readonly detail: string }>`
        SELECT action, detail_json AS detail FROM audit_log WHERE action = 'ai_gateway_key.revoke'
      `;
      assert.lengthOf(audits, 2);
      for (const row of audits) assert.include(row.detail, "space-lost");

      // Linus (Guest of Acme) removed from the Installation: his key is revoked.
      const linus = yield* setup.keys
        .createForSession({ name: "Linus key", spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(setup.people.guest));
      assert.equal(yield* ask(linus), 200);
      yield* setup.server.sql`
        UPDATE users SET removed_at = '2026-11-02T00:00:00.000Z' WHERE user_id = ${setup.people.guest}
      `;
      yield* setup.directory.userStatusChanged({ userId: setup.people.guest, active: false });
      assert.equal(yield* ask(linus), 401);
      const linusReason = yield* reasonOf(linus.created.keyId);
      assert.equal(linusReason, "user-inactive");
    }).pipe(Effect.scoped),
);
