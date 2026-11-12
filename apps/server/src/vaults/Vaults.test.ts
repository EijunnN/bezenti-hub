/**
 * Vaults, their secrets and who may edit or read them (spec 5 «Vaults», ticket 02): the Owner,
 * an Admin, a Member and a Guest of Acme, and an Admin of Globex. Values never leave the Hub but
 * through the Owner's reveal, and never reach the database, the audit log, a log or a span.
 */
// @effect-diagnostics nodeBuiltinImport:off - the test reads the store's files and the database.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  MAIN_VAULT_ID,
  SpaceId,
  UserId,
  type VaultEntryId,
  type VaultError,
  type VaultId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";

import * as CommandActor from "../auth/CommandActor.ts";
import * as SecretCipher from "../auth/SecretCipher.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  passkeyReauth,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as VaultKeyCheck from "./VaultKeyCheck.ts";
import * as Vaults from "./Vaults.ts";

const REVEAL = "/api/vaults/reveal";
const BOGUS_REAUTH = { method: "password", password: "nope", totpCode: "000000" };
const ORIGINAL = "ghp_original_token_0001";
const ROTATED = "ghp_rotated_token_0002";
const ACME_OWN = "acme-own-secret-value-77";
const ADMIN_WRITES = "admin-wrote-this-value-99";
const ADMIN_REPLACES = "admin-replaced-value-42";
const VALUES = [ORIGINAL, ROTATED, ACME_OWN, ADMIN_WRITES, ADMIN_REPLACES];

const hub = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const authenticator = yield* makeAuthenticator();
  const { created } = yield* bootstrapOwner(server, authenticator);
  const owner = created.cookie ?? "";
  const ownerId = UserId.make((created.body.user as { id: string }).id);
  const organization = Effect.fn(function* (name: string) {
    const made = yield* server.request("/api/spaces/organizations", {
      body: { name },
      cookie: owner,
    });
    return SpaceId.make(made.body.id as string);
  });
  const acmeId = yield* organization("Acme");
  const globexId = yield* organization("Globex");
  const person = Effect.fn(function* (
    id: string,
    spaceId: SpaceId,
    role: "admin" | "member" | "guest",
  ) {
    const cookie = yield* addMember(server, { id, displayName: id });
    yield* joinOrganization(server, spaceId, id, role);
    // An Admin's rights need a passkey or an authenticator app.
    if (role === "admin") {
      yield* server.sql`INSERT INTO user_passkeys (credential_id, user_id, public_key, sign_count,
          transports, rp_id, created_at)
        VALUES (${`${id}-key`}, ${id}, 'key', 0, '[]', '127.0.0.1', '2026-01-01T00:00:00.000Z')`;
    }
    return { id: UserId.make(id), cookie };
  });
  const people = {
    admin: yield* person("ada", acmeId, "admin"),
    member: yield* person("grace", acmeId, "member"),
    guest: yield* person("linus", acmeId, "guest"),
    otherAdmin: yield* person("gus", globexId, "admin"),
  };
  // Joined behind the directory's back: it forgets what it read of them.
  yield* Context.get(server.services, SpaceDirectory.SpaceDirectory).membershipsChanged(
    Object.values(people).map((who) => who.id),
  );
  const vaults = Context.get(server.services, Vaults.Vaults);
  const store = Context.get(server.services, ServerSecretStore.ServerSecretStore);
  const as =
    (userId: UserId, spaceLimit?: SpaceId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      spaceLimit === undefined
        ? CommandActor.actAs(userId)(effect)
        : CommandActor.actAsResolved({ _tag: "User", userId, spaceLimit })(effect);
  const reveal = (cookie: string, vaultId: string, entryId: string, reauth: unknown) =>
    server.request(REVEAL, { cookie, body: { vaultId, entryId, reauth } });
  return {
    server,
    authenticator,
    owner,
    ownerId,
    acmeId,
    globexId,
    people,
    vaults,
    store,
    as,
    reveal,
  };
});

type Hub = Effect.Success<typeof hub>;

/** The Owner's setup: GITHUB_TOKEN in the Main vault; «Acme secrets» with a link, a copy, its own. */
const acmeSecrets = Effect.fn(function* ({ vaults, as, ownerId, acmeId }: Hub) {
  const github = yield* vaults
    .putEntry({ vaultId: MAIN_VAULT_ID, name: "GITHUB_TOKEN", value: Redacted.make(ORIGINAL) })
    .pipe(as(ownerId));
  const acme = yield* vaults.create({ name: "Acme secrets", spaceId: acmeId }).pipe(as(ownerId));
  const link = yield* vaults
    .linkEntry({ vaultId: acme.id, sourceEntryId: github.entry.id })
    .pipe(as(ownerId));
  const copy = yield* vaults
    .copyEntry({ vaultId: acme.id, sourceEntryId: github.entry.id, name: "GITHUB_TOKEN_COPY" })
    .pipe(as(ownerId));
  const own = yield* vaults
    .putEntry({ vaultId: acme.id, name: "ACME_API_KEY", value: Redacted.make(ACME_OWN) })
    .pipe(as(ownerId));
  return { github: github.entry, acme, link: link.entry, copy: copy.entry, own: own.entry };
});

const reasonOf = <A, R>(effect: Effect.Effect<A, VaultError, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

const mentionsAValue = (text: string) => VALUES.some((value) => text.includes(value));

it.effect("the Main vault exists from the start and is the Owner's alone", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId, people } = setup;
    const listed = yield* vaults.list.pipe(as(ownerId));
    assert.equal(listed.vaults[0]?.id, MAIN_VAULT_ID);
    assert.isTrue(listed.vaults[0]?.isMain);
    assert.equal(
      yield* reasonOf(vaults.remove({ vaultId: MAIN_VAULT_ID }).pipe(as(ownerId))),
      "main-vault",
    );
    for (const who of Object.values(people)) {
      const theirs = yield* vaults.list.pipe(as(who.id));
      assert.notInclude(
        theirs.vaults.map((vault) => vault.id),
        MAIN_VAULT_ID,
      );
      assert.equal(
        yield* reasonOf(
          vaults
            .putEntry({ vaultId: MAIN_VAULT_ID, name: "MINE", value: Redacted.make("x".repeat(9)) })
            .pipe(as(who.id)),
        ),
        "not-found",
      );
    }
  }),
);

it.effect(
  "only the Owner creates, manages, links and copies; Admins edit their own Organization's",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, people, acmeId, globexId } = setup;
      const { acme, github, own } = yield* acmeSecrets(setup);
      const globex = yield* vaults
        .create({ name: "Globex secrets", spaceId: globexId })
        .pipe(as(setup.ownerId));

      for (const who of Object.values(people)) {
        assert.equal(
          yield* reasonOf(
            vaults.create({ name: `${who.id} vault`, spaceId: acmeId }).pipe(as(who.id)),
          ),
          "forbidden",
          `${who.id} created a Vault`,
        );
      }
      // Acme's Admin: their Organization's Vault, without reading; nothing else.
      const { admin } = people;
      const seen = yield* vaults.list.pipe(as(admin.id));
      assert.deepEqual(
        seen.vaults.map((vault) => [vault.name, vault.canEdit, vault.canManage, vault.canReveal]),
        [["Acme secrets", true, false, false]],
      );
      const added = yield* vaults
        .putEntry({ vaultId: acme.id, name: "ADMIN_TOKEN", value: Redacted.make(ADMIN_WRITES) })
        .pipe(as(admin.id));
      const replaced = yield* vaults
        .putEntry({
          vaultId: acme.id,
          entryId: own.id,
          name: own.name,
          value: Redacted.make(ADMIN_REPLACES),
        })
        .pipe(as(admin.id));
      assert.equal(replaced.entry.version, 2);
      assert.isFalse(mentionsAValue(JSON.stringify([seen, added, replaced])));
      const deleted = yield* vaults
        .deleteEntry({ vaultId: acme.id, entryId: added.entry.id })
        .pipe(as(admin.id));
      assert.isTrue(deleted.deleted);
      assert.equal(
        yield* reasonOf(vaults.update({ vaultId: acme.id, name: "Mine now" }).pipe(as(admin.id))),
        "forbidden",
      );
      assert.equal(
        yield* reasonOf(vaults.remove({ vaultId: acme.id }).pipe(as(admin.id))),
        "forbidden",
      );
      // A link or a copy would hand the Main vault's value to Acme: the Owner's alone.
      assert.equal(
        yield* reasonOf(
          vaults
            .linkEntry({ vaultId: acme.id, sourceEntryId: github.id, name: "STOLEN" })
            .pipe(as(admin.id)),
        ),
        "forbidden",
      );
      assert.equal(
        yield* reasonOf(
          vaults
            .copyEntry({ vaultId: acme.id, sourceEntryId: github.id, name: "STOLEN" })
            .pipe(as(admin.id)),
        ),
        "forbidden",
      );
      // Another Organization's Vault is not there for them.
      assert.equal(
        yield* reasonOf(vaults.listEntries({ vaultId: globex.id }).pipe(as(admin.id))),
        "not-found",
      );
      assert.equal(
        yield* reasonOf(
          vaults
            .putEntry({ vaultId: globex.id, name: "X_TOKEN", value: Redacted.make("y".repeat(9)) })
            .pipe(as(admin.id)),
        ),
        "not-found",
      );
      // Members and Guests: names only.
      for (const who of [people.member, people.guest]) {
        const listed = yield* vaults.listEntries({ vaultId: acme.id }).pipe(as(who.id));
        assert.deepEqual(listed.entries.map((entry) => entry.name).toSorted(), [
          "ACME_API_KEY",
          "GITHUB_TOKEN",
          "GITHUB_TOKEN_COPY",
        ]);
        assert.isFalse(listed.vault.canEdit);
        // A link's original is the Owner's to know.
        assert.isTrue(listed.entries.every((entry) => entry.linkedFrom === null));
        assert.equal(
          yield* reasonOf(
            vaults
              .putEntry({
                vaultId: acme.id,
                entryId: own.id,
                name: own.name,
                value: Redacted.make("z".repeat(9)),
              })
              .pipe(as(who.id)),
          ),
          "forbidden",
        );
        assert.equal(
          yield* reasonOf(
            vaults.deleteEntry({ vaultId: acme.id, entryId: own.id }).pipe(as(who.id)),
          ),
          "forbidden",
        );
      }
      // Globex's Admin sees Globex's only.
      const theirs = yield* vaults.list.pipe(as(people.otherAdmin.id));
      assert.deepEqual(
        theirs.vaults.map((vault) => vault.name),
        ["Globex secrets"],
      );
    }),
);

it.effect("an agent bound to one Space sees no Vault of another, the Owner's own included", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId, acmeId, globexId, people } = setup;
    const { acme } = yield* acmeSecrets(setup);
    const inAcme = yield* vaults.list.pipe(as(ownerId, acmeId));
    assert.deepEqual(
      inAcme.vaults.map((vault) => vault.id),
      [acme.id],
    );
    const inGlobex = yield* vaults.list.pipe(as(people.admin.id, globexId));
    assert.deepEqual(inGlobex.vaults, []);
    assert.equal(
      yield* reasonOf(vaults.listEntries({ vaultId: MAIN_VAULT_ID }).pipe(as(ownerId, acmeId))),
      "not-found",
    );
  }),
);

it.effect(
  "only the Owner reveals, with a strong factor in the request, audited without the value",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { server, people, owner, reveal } = setup;
      const { acme, own, link } = yield* acmeSecrets(setup);
      for (const [who, { cookie, id }] of Object.entries(people)) {
        // Refused by the policy itself, whatever factor they would show.
        assert.oneOf(
          yield* reasonOf(
            setup.vaults.reveal({ vaultId: acme.id, entryId: own.id }).pipe(setup.as(id)),
          ),
          ["forbidden", "not-found"],
          `${who} revealed a value`,
        );
        const refused = yield* reveal(cookie, acme.id, own.id, BOGUS_REAUTH);
        assert.oneOf(refused.status, [403, 404], `${who} revealed a value`);
        assert.isFalse(mentionsAValue(JSON.stringify(refused.body)));
      }
      const bare = yield* reveal(owner, acme.id, own.id, BOGUS_REAUTH);
      assert.equal(bare.status, 403);
      assert.isFalse(mentionsAValue(JSON.stringify(bare.body)));
      const audited = yield* server.sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM audit_log WHERE action = 'secret.reveal'
    `;
      assert.equal(audited[0]?.n, 0);

      const shown = yield* reveal(
        owner,
        acme.id,
        own.id,
        yield* passkeyReauth(server, setup.authenticator),
      );
      assert.equal(shown.status, 200);
      assert.deepEqual(shown.body, { name: "ACME_API_KEY", value: ACME_OWN });
      // A link shows its original's value.
      const linked = yield* reveal(
        owner,
        acme.id,
        link.id,
        yield* passkeyReauth(server, setup.authenticator),
      );
      assert.equal(linked.body.value, ORIGINAL);
      const [entry] = yield* server.sql<{
        readonly detail_json: string;
        readonly target_name: string;
      }>`
      SELECT detail_json, target_name FROM audit_log WHERE action = 'secret.reveal' ORDER BY audit_id LIMIT 1
    `;
      assert.equal(entry?.target_name, "ACME_API_KEY");
      assert.deepEqual(JSON.parse(entry?.detail_json ?? "{}"), {
        vault: "Acme secrets",
        vaultId: acme.id,
        kind: "own",
      });
    }),
);

it.effect("rotating the original changes what its Secret links hold; a copy keeps its value", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId } = setup;
    const { acme, github, link, copy } = yield* acmeSecrets(setup);
    const revealOf = (entryId: VaultEntryId, vaultId: VaultId = acme.id) =>
      vaults.reveal({ vaultId, entryId }).pipe(
        as(ownerId),
        Effect.map((shown) => Redacted.value(shown.value)),
      );
    assert.equal(yield* revealOf(link.id), ORIGINAL);
    yield* vaults
      .putEntry({
        vaultId: MAIN_VAULT_ID,
        entryId: github.id,
        name: github.name,
        value: Redacted.make(ROTATED),
      })
      .pipe(as(ownerId));
    assert.equal(yield* revealOf(link.id), ROTATED);
    assert.equal(yield* revealOf(copy.id), ORIGINAL);
    const listed = yield* vaults.listEntries({ vaultId: acme.id }).pipe(as(ownerId));
    assert.deepEqual(listed.entries.find((entry) => entry.id === link.id)?.linkedFrom, {
      entryId: github.id,
      name: "GITHUB_TOKEN",
    });
    // A link's value is the Main vault's: replacing it here is refused.
    assert.equal(
      yield* reasonOf(
        vaults
          .putEntry({
            vaultId: acme.id,
            entryId: link.id,
            name: link.name,
            value: Redacted.make("q".repeat(9)),
          })
          .pipe(as(ownerId)),
      ),
      "not-linkable",
    );
  }),
);

it.effect(
  "deleting an original lists the links it breaks, which stay «broken» and reveal nothing",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, ownerId } = setup;
      const { acme, github, link } = yield* acmeSecrets(setup);
      const asked = yield* vaults
        .deleteEntry({ vaultId: MAIN_VAULT_ID, entryId: github.id })
        .pipe(as(ownerId));
      assert.isFalse(asked.deleted);
      assert.deepEqual(
        asked.brokenLinks.map((broken) => [broken.vaultName, broken.name]),
        [["Acme secrets", "GITHUB_TOKEN"]],
      );
      const done = yield* vaults
        .deleteEntry({ vaultId: MAIN_VAULT_ID, entryId: github.id, breakLinks: true })
        .pipe(as(ownerId));
      assert.isTrue(done.deleted);
      const listed = yield* vaults.listEntries({ vaultId: acme.id }).pipe(as(ownerId));
      const broken = listed.entries.find((entry) => entry.id === link.id);
      assert.isTrue(broken?.broken);
      assert.equal(
        yield* reasonOf(vaults.reveal({ vaultId: acme.id, entryId: link.id }).pipe(as(ownerId))),
        "not-found",
      );
    }),
);

it.effect(
  "names are environment variables the Hub does not reserve; values are text up to 64 KiB",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { vaults, as, ownerId } = setup;
      const put = (name: string, value = "long-enough-value") =>
        vaults
          .putEntry({ vaultId: MAIN_VAULT_ID, name, value: Redacted.make(value) })
          .pipe(as(ownerId));
      for (const name of ["path", "1ABC", "A=B", "A B", "A\u0000B", "", "Ä"]) {
        assert.equal(yield* reasonOf(put(name)), "invalid-name", JSON.stringify(name));
      }
      for (const name of [
        "PATH",
        "HOME",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "NODE_OPTIONS",
        "BASH_ENV",
        "T3_TOKEN",
        "T3CODE_HOME",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "OPENAI_BASE_URL",
      ]) {
        assert.equal(yield* reasonOf(put(name)), "reserved-name", name);
      }
      assert.equal(yield* reasonOf(put("NUL_INSIDE", "abc\u0000def")), "invalid-value");
      assert.equal(yield* reasonOf(put("TOO_BIG", "x".repeat(64 * 1024 + 1))), "invalid-value");
      yield* put("JUST_FITS", "x".repeat(64 * 1024));
      assert.equal(yield* reasonOf(put("JUST_FITS")), "duplicate-name");
      // Short values are kept, with a warning, and never masked.
      const short = yield* put("PIN", "1234");
      assert.deepEqual(short.warnings, ["short-value"]);
      assert.isTrue(short.entry.unmasked);
      const long = yield* put("API_KEY");
      assert.deepEqual(long.warnings, []);
      assert.isFalse(long.entry.unmasked);
    }),
);

it.effect(
  "values live sealed in the store: not in the database, the audit log, a log or a span",
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
    const logger = Logger.make((options) => {
      logs.push(
        [options.message, options.cause, options.fiber.getRef(References.CurrentLogAnnotations)]
          .map((part) => {
            try {
              return JSON.stringify(part) ?? String(part);
            } catch {
              return String(part);
            }
          })
          .join(" "),
      );
    });
    return Effect.gen(function* () {
      const setup = yield* hub;
      const { server, vaults, as, people, store, owner } = setup;
      const { acme, own } = yield* acmeSecrets(setup);
      yield* vaults
        .putEntry({ vaultId: acme.id, name: "ADMIN_TOKEN", value: Redacted.make(ADMIN_WRITES) })
        .pipe(as(people.admin.id));
      yield* vaults
        .putEntry({
          vaultId: acme.id,
          entryId: own.id,
          name: own.name,
          value: Redacted.make(ADMIN_REPLACES),
        })
        .pipe(as(people.admin.id));
      // An Admin's refused write says why, never what.
      const refused = yield* Effect.flip(
        vaults
          .putEntry({ vaultId: MAIN_VAULT_ID, name: "GITHUB_TOKEN", value: Redacted.make(ROTATED) })
          .pipe(as(people.admin.id)),
      );
      assert.isFalse(mentionsAValue(JSON.stringify(refused) + refused.message));
      const shown = yield* setup.reveal(
        owner,
        acme.id,
        own.id,
        yield* passkeyReauth(server, setup.authenticator),
      );
      assert.equal(shown.body.value, ADMIN_REPLACES);

      // Every table of the database, rows as text.
      const tables = yield* server.sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `;
      for (const { name } of tables) {
        const rows = yield* server.sql.unsafe(`SELECT * FROM "${name}"`);
        const text = JSON.stringify(rows, (_key, value) =>
          value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : value,
        );
        assert.isFalse(mentionsAValue(text), `a value is in the table ${name}`);
      }
      // Sealed files, none in clear.
      const directory = store.directory ?? "";
      const files = NodeFS.readdirSync(directory).filter((file) =>
        file.startsWith(SecretCipher.VAULT_VALUE_ENTRY_PREFIX),
      );
      assert.isAbove(files.length, 0);
      for (const file of files) {
        assert.match(file, /\.sealed$/);
        const bytes = NodeFS.readFileSync(NodePath.join(directory, file)).toString("latin1");
        assert.isFalse(mentionsAValue(bytes), `${file} holds a value in clear`);
      }
      const recorded = [
        ...logs,
        ...spans.flatMap((span) => [
          span.name,
          ...Array.from(span.attributes.values(), (value) => JSON.stringify(value)),
        ]),
      ];
      assert.isAbove(spans.length, 0);
      assert.isFalse(recorded.some(mentionsAValue), "a value reached a log or a span");
    }).pipe(
      Effect.withTracer(tracer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  },
);

it.effect(
  "deletions leave no sealed value behind; a value left by a crash goes at the next start",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const { server, vaults, as, ownerId, store } = setup;
      const { acme, own } = yield* acmeSecrets(setup);
      const directory = store.directory ?? "";
      const valueFiles = () =>
        NodeFS.readdirSync(directory).filter((file) =>
          file.startsWith(SecretCipher.VAULT_VALUE_ENTRY_PREFIX),
        );
      // GITHUB_TOKEN, its copy and ACME_API_KEY hold values; the link holds none.
      assert.lengthOf(valueFiles(), 3);
      yield* vaults
        .putEntry({ vaultId: acme.id, entryId: own.id, name: "ACME_RENAMED" })
        .pipe(as(ownerId));
      assert.lengthOf(valueFiles(), 3);
      yield* vaults.deleteEntry({ vaultId: acme.id, entryId: own.id }).pipe(as(ownerId));
      assert.lengthOf(valueFiles(), 2);
      yield* vaults.remove({ vaultId: acme.id }).pipe(as(ownerId));
      assert.lengthOf(valueFiles(), 1);

      yield* store.set(
        `${SecretCipher.VAULT_VALUE_ENTRY_PREFIX}secret-gone`,
        new TextEncoder().encode("left-behind-value"),
      );
      assert.lengthOf(valueFiles(), 2);
      yield* Layer.build(Vaults.layer.pipe(Layer.provide(Layer.succeedContext(server.services))));
      assert.lengthOf(valueFiles(), 1);
    }),
);

it.effect("a value's file renamed to another secret, or from another entry, does not open", () =>
  Effect.gen(function* () {
    const setup = yield* hub;
    const { vaults, as, ownerId, store } = setup;
    const { acme, own, copy } = yield* acmeSecrets(setup);
    const directory = store.directory ?? "";
    const fileOf = (entryId: string) =>
      NodePath.join(directory, `${SecretCipher.VAULT_VALUE_ENTRY_PREFIX}${entryId}.sealed`);
    NodeFS.copyFileSync(fileOf(own.id), fileOf(copy.id));
    assert.equal(
      yield* reasonOf(vaults.reveal({ vaultId: acme.id, entryId: copy.id }).pipe(as(ownerId))),
      "storage",
    );
    // A Hub secret (another purpose) moved under a Vault value's name does not open either.
    const hubSecret = NodeFS.readdirSync(directory).find(
      (file) => file.endsWith(".sealed") && !file.startsWith(SecretCipher.VAULT_VALUE_ENTRY_PREFIX),
    );
    assert.isDefined(hubSecret);
    NodeFS.copyFileSync(NodePath.join(directory, hubSecret!), fileOf(own.id));
    assert.equal(
      yield* reasonOf(vaults.reveal({ vaultId: acme.id, entryId: own.id }).pipe(as(ownerId))),
      "storage",
    );
  }),
);

it.effect(
  "the database's key check: written once, re-sealed after a rotation, a wrong key stops the Hub",
  () =>
    Effect.gen(function* () {
      const { server } = yield* hub;
      const keyring = (
        current: SecretCipher.MasterKey,
        ...older: Array<SecretCipher.MasterKey>
      ) => ({
        current,
        keys: [current, ...older],
        keyFile: "/state/master.key",
      });
      const run = (ring: ReturnType<typeof keyring>) =>
        VaultKeyCheck.checkDatabaseKey(ring).pipe(
          Effect.provide(Layer.succeedContext(server.services)),
        );
      const keyIdNow = () =>
        server.sql<{ readonly keyId: string }>`SELECT key_id AS "keyId" FROM vault_key_check`.pipe(
          Effect.map((rows) => rows[0]?.keyId),
        );
      // The Hub wrote it at its start with its own key; another key alone does not open it.
      const stranger = SecretCipher.MasterKey.generate();
      const before = yield* keyIdNow();
      assert.isString(before);
      const refused = yield* Effect.flip(run(keyring(stranger)));
      assert.equal(refused._tag, "MasterKeyError");
      assert.equal(yield* keyIdNow(), before);

      yield* server.sql`DELETE FROM vault_key_check`;
      const first = SecretCipher.MasterKey.generate();
      yield* run(keyring(first));
      assert.equal(yield* keyIdNow(), first.id);
      // Rotated: the new key with the previous one beside it re-seals the check.
      const second = SecretCipher.MasterKey.generate();
      yield* run(keyring(second, first));
      assert.equal(yield* keyIdNow(), second.id);
      yield* run(keyring(second));
      const wrong = yield* Effect.flip(run(keyring(first)));
      assert.equal(wrong._tag, "MasterKeyError");
    }),
);
