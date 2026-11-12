/**
 * The AI gateway layer (spec 4 ticket 04) on a real port over the fake CLIProxyAPI, with Ada
 * (Admin), Grace (Member) and Linus (Guest) of Acme and Gus of Globex: a key reaches only what
 * AllowedAiAccounts gives its User in its Space now, streamed, failing over within one provider.
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - a client on the real port: streams, raw paths, the fake gateway's files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import {
  type AiAccountId,
  type AiAccountProvider,
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";

import * as AuditLog from "../audit/AuditLog.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AiAccounts from "./AiAccounts.ts";
import * as AiGateway from "./AiGateway.ts";
import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import * as AiGatewayKeys from "./AiGatewayKeys.ts";
import * as AiGatewayRoute from "./AiGatewayRoute.ts";
import { fakeCliproxyRelease, fakeReleases, pinsOf } from "./AiGateway.testkit.ts";
import { cliproxyPlatformOf } from "./cliproxyRelease.ts";
import { CliproxyReleases } from "./CliproxyReleases.ts";

const os = HostProcess.Platform.defaultValue();
const platform = cliproxyPlatformOf(os, HostProcess.Architecture.defaultValue());
const posix = os === "linux" || os === "darwin";

const PROMPT = "PROMPT-the-secret-plan-7f3a9";
// A small body limit for this file, so the size test sends little.
process.env.T3CODE_AI_GATEWAY_MAX_REQUEST_BYTES = String(256 * 1024);
const PROVIDER_KEYS = ["sk-ant-acme-claude-a-0123456789", "sk-ant-acme-claude-b-0123456789"];

const hub = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const authenticator = yield* makeAuthenticator();
  const { created } = yield* bootstrapOwner(server, authenticator);
  const ownerCookie = created.cookie ?? "";
  const ownerId = UserId.make((created.body.user as { id: string }).id);
  const organization = Effect.fn(function* (name: string) {
    const made = yield* server.request("/api/spaces/organizations", {
      body: { name },
      cookie: ownerCookie,
    });
    return SpaceId.make(made.body.id as string);
  });
  const acmeId = yield* organization("Acme");
  const globexId = yield* organization("Globex");
  const cookies: Record<string, string> = {};
  const person = Effect.fn(function* (
    id: string,
    spaceId: SpaceId,
    role: "admin" | "member" | "guest",
  ) {
    cookies[id] = yield* addMember(server, { id, displayName: id });
    yield* joinOrganization(server, spaceId, id, role);
    if (role === "admin") {
      yield* server.sql`INSERT INTO user_passkeys (credential_id, user_id, public_key, sign_count,
          transports, rp_id, created_at)
        VALUES (${`${id}-key`}, ${id}, 'key', 0, '[]', '127.0.0.1', '2026-01-01T00:00:00.000Z')`;
    }
    return UserId.make(id);
  });
  const people = {
    admin: yield* person("ada", acmeId, "admin"),
    member: yield* person("grace", acmeId, "member"),
    guest: yield* person("linus", acmeId, "guest"),
    globexMember: yield* person("gus", globexId, "member"),
  };
  const directory = Context.get(server.services, SpaceDirectory.SpaceDirectory);
  yield* directory.membershipsChanged(Object.values(people));

  // The fake CLIProxyAPI as the Hub runs it.
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ai-gateway-route-"));
  const release = fakeCliproxyRelease(dir, "1.0.0");
  const stateDir = NodePath.join(dir, "state");
  const memory = NodePath.join(dir, "memory");
  NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const gateway = yield* AiGateway.make({
    placement: { _tag: "forced", enabled: true },
    os,
    stateDir,
    platform: platform!,
    pinned: pinsOf([release]),
    runtimeFolder: { directory: memory, inMemory: true },
    restartDelay: { initialMs: 100, maxMs: 200 },
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          ServerSecretStore.ServerSecretStore,
          Context.get(server.services, ServerSecretStore.ServerSecretStore),
        ),
        Layer.succeed(CliproxyReleases, fakeReleases({ releases: [release] }).service),
        Layer.succeed(
          AuditLog.AuditLog,
          AuditLog.AuditLog.of({ record: () => Effect.void, list: () => Effect.die("not used") }),
        ),
        FetchHttpClient.layer,
      ),
    ),
  );
  yield* gateway.changes.pipe(
    Stream.filter((status) => status.state === "running"),
    Stream.runHead,
  );
  const context = yield* Layer.build(
    AiGatewayKeys.layer.pipe(
      Layer.provideMerge(AiGatewayActivity.layer),
      Layer.provideMerge(AiAccounts.layer),
      Layer.provideMerge(AuditLog.layer),
      Layer.provideMerge(Layer.succeed(AiGateway.AiGateway, gateway)),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(Layer.succeedContext(server.services)),
    ),
  );
  const served = yield* HttpRouter.serve(AiGatewayRoute.layer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(Layer.succeedContext(Context.merge(server.services, context))),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.fresh,
    Layer.build,
  );
  const address = Context.get(served, HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
  const port = address.port;
  const accounts = Context.get(context, AiAccounts.AiAccounts);
  const keys = Context.get(context, AiGatewayKeys.AiGatewayKeys);
  const activity = Context.get(context, AiGatewayActivity.AiGatewayActivity);
  const asOwner = CommandActor.actAs(ownerId);

  const account = Effect.fn(function* (
    name: string,
    provider: AiAccountProvider,
    allow: { readonly spaceIds?: ReadonlyArray<SpaceId>; readonly userIds?: ReadonlyArray<UserId> },
    extra: { readonly baseUrl?: string; readonly models?: ReadonlyArray<string> } = {},
  ) {
    const made = yield* accounts
      .create({
        name,
        provider: provider as never,
        apiKey: Redacted.make(`sk-test-${name.replaceAll(" ", "-")}-0123456789abcdef`),
        ...extra,
      })
      .pipe(asOwner);
    yield* accounts
      .allow({
        accountId: made.id,
        spaceIds: [...(allow.spaceIds ?? [])],
        userIds: [...(allow.userIds ?? [])],
      })
      .pipe(asOwner);
    return made.id;
  });

  let threads = 0;
  /** A Project in `spaceId` and a Thread of `ownerUserId` in it; the Thread's Space is its Project's. */
  const thread = Effect.fn(function* (
    ownerUserId: UserId,
    spaceId: SpaceId,
    aiAccountId?: AiAccountId,
  ) {
    threads += 1;
    const projectId = `project-${threads}`;
    const threadId = ThreadId.make(`thread-${threads}`);
    const at = "2026-11-01T00:00:00.000Z";
    yield* server.sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at,
        updated_at, space_id, owner_user_id)
      VALUES (${projectId}, ${projectId}, ${`/work/${projectId}`}, '[]', ${at}, ${at}, ${spaceId},
        ${ownerUserId})
    `;
    const modelSelection = {
      instanceId: "claudeAgent",
      model: "claude-sonnet-5-5",
      ...(aiAccountId === undefined ? {} : { aiAccountId }),
    };
    yield* server.sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json, owner_user_id
      ) VALUES (
        ${threadId}, ${projectId}, ${threadId}, 'claudeAgent', 'full-access', 'default', ${at},
        ${at}, ${JSON.stringify({ lineage: { rootThreadId: threadId }, modelSelection })},
        ${ownerUserId}
      )
    `;
    const issued = yield* keys.issueForThread(threadId);
    return { threadId, projectId, key: Redacted.value(issued.key) };
  });

  /** What the fake CLIProxyAPI was asked, in order. */
  const upstream = () => {
    const file = NodePath.join(memory, "fake-ai-requests.jsonl");
    return NodeFS.existsSync(file)
      ? NodeFS.readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
          .map(
            (line) =>
              JSON.parse(line) as {
                readonly path: string;
                readonly search: string;
                readonly model: string;
                readonly authOk: boolean;
                readonly headerNames: ReadonlyArray<string>;
                readonly bodyKeys: ReadonlyArray<string>;
              },
          )
      : [];
  };
  const unknownUpstream = () => {
    const file = NodePath.join(memory, "fake-unknown.jsonl");
    return NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : "";
  };
  const flag = (name: string, on = true) => {
    const file = NodePath.join(memory, name);
    if (on) NodeFS.writeFileSync(file, "1");
    else NodeFS.rmSync(file, { force: true });
  };

  return {
    server,
    ownerId,
    ownerCookie,
    cookies,
    acmeId,
    globexId,
    people,
    directory,
    accounts,
    keys,
    activity,
    asOwner,
    port,
    account,
    thread,
    upstream,
    unknownUpstream,
    flag,
  };
});

type Hub = Effect.Success<typeof hub>;

interface Answer {
  readonly status: number;
  readonly text: string;
  readonly headers: Headers;
  readonly json: Record<string, unknown> | null;
}

/** A request to the gateway on its real port, as an agent or a CLI sends it. */
const call = (
  setup: Hub,
  path: string,
  init: {
    readonly key?: string;
    readonly keyHeader?: "authorization" | "x-api-key" | "x-goog-api-key";
    readonly body?: unknown;
    readonly rawBody?: string;
    readonly method?: string;
    readonly headers?: Record<string, string>;
  } = {},
) =>
  Effect.promise(async (): Promise<Answer> => {
    const keyHeader = init.keyHeader ?? "authorization";
    const response = await fetch(`http://127.0.0.1:${setup.port}${path}`, {
      method:
        init.method ?? (init.body === undefined && init.rawBody === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(init.key === undefined
          ? {}
          : { [keyHeader]: keyHeader === "authorization" ? `Bearer ${init.key}` : init.key }),
        ...init.headers,
      },
      ...(init.body === undefined
        ? init.rawBody === undefined
          ? {}
          : { body: init.rawBody as string }
        : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { status: response.status, text, headers: response.headers, json };
  });

/** A request with its path sent byte for byte (no client normalization of `..` or `%2F`). */
const rawCall = (setup: Hub, path: string, key: string, method = "POST") =>
  Effect.promise(
    () =>
      new Promise<{ readonly status: number; readonly text: string }>((resolve, reject) => {
        const request = NodeHttp.request(
          {
            host: "127.0.0.1",
            port: setup.port,
            method,
            path,
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          },
          (response) => {
            let text = "";
            response.on("data", (chunk) => (text += String(chunk)));
            response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }));
      }),
  );

const messages = (model = "claude-sonnet-5-5", extra: Record<string, unknown> = {}) => ({
  model,
  max_tokens: 64,
  messages: [{ role: "user", content: PROMPT }],
  ...extra,
});

const upstreamModels = (setup: Hub) => setup.upstream().map((request) => request.model);

/** Acme: Claude A then Claude B (priority 1, 2) and an OpenRouter; Globex: its own Claude. */
const acmeSetup = Effect.fn(function* (setup: Hub) {
  const claudeA = yield* setup.account("Acme Claude A", "claude", { spaceIds: [setup.acmeId] });
  const claudeB = yield* setup.account("Acme Claude B", "claude", { spaceIds: [setup.acmeId] });
  const globexClaude = yield* setup.account("Globex Claude", "claude", {
    spaceIds: [setup.globexId],
  });
  const router = yield* setup.account(
    "Acme OpenRouter",
    "openai-compatible",
    { spaceIds: [setup.acmeId] },
    { baseUrl: "https://openrouter.example/api/v1", models: ["deepseek-chat"] },
  );
  const globexRouter = yield* setup.account(
    "Globex OpenRouter",
    "openai-compatible",
    { spaceIds: [setup.globexId] },
    { baseUrl: "https://openrouter.example/api/v1", models: ["globex-secret-model"] },
  );
  const graceGemini = yield* setup.account("Grace Gemini", "gemini", {
    userIds: [setup.people.member],
  });
  return { claudeA, claudeB, globexClaude, router, globexRouter, graceGemini };
});

it.live.skipIf(!posix || platform === undefined)(
  "a Thread key reaches its allowed accounts in every shape, streamed, and the Thread shows the account in use",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ids = yield* acmeSetup(setup);
      const { key, threadId } = yield* setup.thread(setup.people.member, setup.acmeId);
      const changes = yield* (yield* setup.activity.subscribeAccountsInUse).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const records = yield* (yield* setup.activity.subscribeRequests).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      // Claude messages, streamed: the first event arrives while the upstream still holds the rest.
      setup.flag("fake-stream-hold");
      const streamed = yield* Effect.promise(async () => {
        const response = await fetch(
          `http://127.0.0.1:${setup.port}/api/ai/anthropic/v1/messages`,
          {
            method: "POST",
            headers: {
              "x-api-key": key,
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
              "x-forwarded-for": "6.6.6.6",
              "x-amp-provider": "globex",
              "x-cpa-account": "globex",
              cookie: setup.ownerCookie,
            },
            body: JSON.stringify(messages("claude-sonnet-5-5", { stream: true })),
          },
        );
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        const first = decoder.decode((await reader.read()).value);
        setup.flag("fake-stream-release");
        let rest = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          rest += decoder.decode(chunk.value);
        }
        return { response, first, rest };
      });
      setup.flag("fake-stream-hold", false);
      setup.flag("fake-stream-release", false);
      assert.equal(streamed.response.status, 200);
      assert.match(streamed.response.headers.get("content-type") ?? "", /text\/event-stream/u);
      assert.include(streamed.first, "message_start");
      assert.notInclude(streamed.first, "content_block_delta", "the answer was held back whole");
      assert.include(streamed.rest, "Hello from claude-sonnet-5-5");
      assert.notInclude(
        streamed.first + streamed.rest,
        "acct-",
        "the account prefix reached the client",
      );
      // Only known headers cross, in both directions.
      for (const name of ["x-fake-account", "set-cookie", "x-cpa-version"]) {
        assert.isNull(streamed.response.headers.get(name), `${name} reached the client`);
      }
      const sent = setup.upstream().at(-1)!;
      assert.equal(sent.model, `acct-${ids.claudeA}/claude-sonnet-5-5`);
      assert.isTrue(sent.authOk);
      assert.deepEqual(
        sent.headerNames.filter((name) => name.startsWith("x-") || name === "cookie"),
        [],
      );
      assert.include(sent.headerNames, "anthropic-version");
      for (const smuggled of [
        "x-forwarded-for",
        "x-amp-provider",
        "x-cpa-account",
        "cookie",
        "x-api-key",
      ]) {
        assert.notInclude(sent.headerNames, smuggled);
      }
      const inUse = Option.getOrThrow(yield* setup.activity.inUse(threadId));
      assert.equal(inUse.accountId, ids.claudeA);
      const changed = [...(yield* Fiber.join(changes))];
      assert.deepEqual(changed[0], {
        threadId,
        accountId: ids.claudeA,
        model: "claude-sonnet-5-5",
      });
      const [record] = [...(yield* Fiber.join(records))];
      assert.equal(record!.accountId, ids.claudeA);
      assert.equal(record!.threadId, threadId);
      assert.equal(record!.userId, setup.people.member);
      assert.equal(record!.spaceId, setup.acmeId);
      assert.deepEqual(record!.usage, {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      });

      // count_tokens, OpenAI chat and responses, Gemini (stream and not), each pinned upstream.
      const counted = yield* call(setup, "/api/ai/anthropic/v1/messages/count_tokens", {
        key,
        body: messages(),
      });
      assert.equal(counted.status, 200);
      assert.deepEqual(counted.json, { input_tokens: 11 });
      const chat = yield* call(setup, "/api/ai/openai/v1/chat/completions", {
        key,
        body: { model: "deepseek-chat", messages: [{ role: "user", content: PROMPT }] },
      });
      assert.equal(chat.status, 200);
      assert.include(chat.text, "Hello from deepseek-chat");
      assert.notInclude(chat.text, "acct-");
      const chatStream = yield* call(setup, "/api/ai/openai/v1/chat/completions", {
        key,
        body: {
          model: "deepseek-chat",
          stream: true,
          messages: [{ role: "user", content: PROMPT }],
        },
      });
      assert.include(chatStream.text, "data: [DONE]");
      const responses = yield* call(setup, "/api/ai/openai/v1/responses", {
        key,
        body: { model: "deepseek-chat", input: PROMPT },
      });
      assert.equal(responses.status, 200);
      // Grace's own Gemini (allowed to her, not to Acme) works in Acme for her.
      const gemini = yield* call(
        setup,
        "/api/ai/gemini/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse",
        { key, keyHeader: "x-goog-api-key", body: { contents: [{ parts: [{ text: PROMPT }] }] } },
      );
      assert.equal(gemini.status, 200);
      assert.include(gemini.text, "Hello from gemini-3-pro");
      assert.deepEqual(upstreamModels(setup).slice(-5), [
        `acct-${ids.claudeA}/claude-sonnet-5-5`,
        `acct-${ids.router}/deepseek-chat`,
        `acct-${ids.router}/deepseek-chat`,
        `acct-${ids.router}/deepseek-chat`,
        `acct-${ids.graceGemini}/gemini-3-pro`,
      ]);
      assert.equal(setup.upstream().at(-1)!.search, "?alt=sse");

      // Model lists: plain names of what is allowed here, in each shape; never Globex's.
      for (const [path, header] of [
        ["/api/ai/openai/v1/models", "authorization"],
        ["/api/ai/anthropic/v1/models", "x-api-key"],
        ["/api/ai/gemini/v1beta/models", "x-goog-api-key"],
      ] as const) {
        const listed = yield* call(setup, path, { key, keyHeader: header });
        assert.equal(listed.status, 200, path);
        assert.include(listed.text, "deepseek-chat");
        assert.include(listed.text, "gemini-3-pro");
        assert.notInclude(listed.text, "globex-secret-model");
        assert.notInclude(listed.text, "acct-");
      }

      // A User key (Grace's local CLI, for Acme) routes the same way, by priority.
      const cli = yield* setup.keys.createForUser({
        actorUserId: setup.people.member,
        spaceId: setup.acmeId,
        name: "Laptop",
      });
      const byCli = yield* call(setup, "/api/ai/anthropic/v1/messages", {
        key: Redacted.value(cli.key),
        body: messages(),
      });
      assert.equal(byCli.status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${ids.claudeA}/claude-sonnet-5-5`);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "refuses what no key allows: no key, a session cookie, a foreign or unprefixed account, admin paths",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ids = yield* acmeSetup(setup);
      const { key } = yield* setup.thread(setup.people.member, setup.acmeId);
      const before = setup.upstream().length;
      const path = "/api/ai/anthropic/v1/messages";

      // No key: a valid session cookie, an Environment-style credential, junk, a key in the query.
      const refusedAuth = [
        yield* call(setup, path, { body: messages(), headers: { cookie: setup.cookies.grace! } }),
        yield* call(setup, path, { body: messages(), headers: { cookie: setup.ownerCookie } }),
        yield* call(setup, path, { key: "t3env_0123456789abcdef", body: messages() }),
        yield* call(setup, path, {
          key: `t3gk_${NodeCrypto.randomBytes(32).toString("base64url")}`,
          body: messages(),
        }),
        yield* call(setup, `${path}?key=${key}`, { body: messages() }),
        yield* call(setup, path, {
          body: messages(),
          headers: { authorization: `Basic ${Buffer.from(`x:${key}`).toString("base64")}` },
        }),
        // Two different keys: never chosen between.
        yield* call(setup, path, {
          key,
          body: messages(),
          headers: { "x-api-key": `t3gk_${NodeCrypto.randomBytes(32).toString("base64url")}` },
        }),
      ];
      assert.deepEqual(
        refusedAuth.map((answer) => answer.status),
        [401, 401, 401, 401, 401, 401, 401],
      );
      // In the client's own shape.
      assert.equal((refusedAuth[0]!.json as { type?: string }).type, "error");

      // Another account by prefix: Globex's, nonexistent, double, or a model no allowed one serves.
      const foreign = yield* call(setup, path, {
        key,
        body: messages(`acct-${ids.globexClaude}/claude-sonnet-5-5`),
      });
      assert.equal(foreign.status, 403);
      const double = yield* call(setup, path, {
        key,
        body: messages(`acct-${ids.claudeA}/acct-${ids.globexClaude}/claude-sonnet-5-5`),
      });
      assert.equal(double.status, 400);
      const bare = yield* call(setup, path, { key, body: messages("acct-/claude-sonnet-5-5") });
      assert.equal(bare.status, 400);
      const unserved = yield* call(setup, "/api/ai/openai/v1/chat/completions", {
        key,
        body: { model: "globex-secret-model", messages: [] },
      });
      assert.equal(unserved.status, 404);
      const nonsense = yield* call(setup, path, { key, rawBody: "[1,2]" });
      assert.equal(nonsense.status, 400);
      assert.equal(setup.upstream().length, before, "a refused request reached CLIProxyAPI");

      // An allowed account named by its prefix is served by that account.
      const pinned = yield* call(setup, path, {
        key,
        body: messages(`acct-${ids.claudeB}/claude-sonnet-5-5`),
      });
      assert.equal(pinned.status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${ids.claudeB}/claude-sonnet-5-5`);

      // CLIProxyAPI's management API and other paths are never reached through /api/ai.
      const tricks = [
        "/api/ai/v8/management/config",
        "/api/ai/openai/v8/management/config",
        "/api/ai/openai/v1/../../../v8/management/config",
        "/api/ai/openai/v1/chat/completions/../../../../v8/management/config",
        "/api/ai/openai/v0/management/config",
        "/api/ai/openai/v1/chat/completions%2F..%2F..%2Fv8%2Fmanagement",
        `/api/ai/gemini/v1beta/models/acct-${ids.globexClaude}%2Fgemini-3-pro:generateContent`,
        "/api/ai/gemini/v1beta/models/..%2F..%2Fv8%2Fmanagement%2Fconfig:generateContent",
        "/api/ai/anthropic/v1/messages/batches",
        "/api/ai/openai/v1/models/gpt-5.5",
        "/api/ai/openai/v1/embeddings",
      ];
      for (const trick of tricks) {
        const answer = yield* rawCall(setup, trick, key);
        assert.include([404, 405], answer.status, trick);
      }
      const listedAsPost = yield* call(setup, "/api/ai/openai/v1/models", { key, body: {} });
      assert.equal(listedAsPost.status, 405);
      assert.equal(setup.unknownUpstream(), "", "a trick reached CLIProxyAPI");
      assert.equal(setup.upstream().length, before + 1);

      // Each person reaches only their Space's accounts: Gus (Globex) with a Globex key.
      const gusKey = yield* setup.keys.createForUser({
        actorUserId: setup.people.globexMember,
        spaceId: setup.globexId,
        name: "Gus laptop",
      });
      const gusOwn = yield* call(setup, path, {
        key: Redacted.value(gusKey.key),
        body: messages(),
      });
      assert.equal(gusOwn.status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${ids.globexClaude}/claude-sonnet-5-5`);
      const gusAcme = yield* call(setup, "/api/ai/openai/v1/chat/completions", {
        key: Redacted.value(gusKey.key),
        body: { model: `acct-${ids.router}/deepseek-chat`, messages: [] },
      });
      assert.equal(gusAcme.status, 403);
      // Nobody makes a key for a Space they do not work in; Linus (Guest) may for Acme.
      const gusForAcme = yield* Effect.flip(
        setup.keys.createForUser({
          actorUserId: setup.people.globexMember,
          spaceId: setup.acmeId,
          name: "Sneaky",
        }),
      );
      assert.equal(gusForAcme.reason, "forbidden");
      const linusKey = yield* setup.keys.createForUser({
        actorUserId: setup.people.guest,
        spaceId: setup.acmeId,
        name: "Linus",
      });
      const linus = yield* call(setup, path, {
        key: Redacted.value(linusKey.key),
        body: messages(),
      });
      assert.equal(linus.status, 200);
      // Grace's own Gemini is hers alone, not Linus's.
      const linusGemini = yield* call(
        setup,
        "/api/ai/gemini/v1beta/models/gemini-3-pro:generateContent",
        { key: Redacted.value(linusKey.key), keyHeader: "x-goog-api-key", body: { contents: [] } },
      );
      assert.equal(linusGemini.status, 404);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "a key stops at the next request once its allowance, membership, Space, Thread, account or User is gone",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ids = yield* acmeSetup(setup);
      const path = "/api/ai/openai/v1/chat/completions";
      const ask = (key: string) =>
        call(setup, path, { key, body: { model: "deepseek-chat", messages: [] } }).pipe(
          Effect.map((answer) => answer.status),
        );

      // The allowance removed mid-Thread: the next request fails; given back, it works again.
      const first = yield* setup.thread(setup.people.member, setup.acmeId);
      assert.equal(yield* ask(first.key), 200);
      yield* setup.accounts
        .allow({ accountId: ids.router, spaceIds: [], userIds: [] })
        .pipe(setup.asOwner);
      assert.equal(yield* ask(first.key), 404);
      yield* setup.accounts
        .allow({ accountId: ids.router, spaceIds: [setup.acmeId], userIds: [] })
        .pipe(setup.asOwner);
      assert.equal(yield* ask(first.key), 200);

      // Disabled, then deleted.
      yield* setup.accounts.update({ accountId: ids.router, disabled: true }).pipe(setup.asOwner);
      assert.equal(yield* ask(first.key), 404);
      yield* setup.accounts.update({ accountId: ids.router, disabled: false }).pipe(setup.asOwner);
      assert.equal(yield* ask(first.key), 200);

      // A Thread pinned to an account that is no longer allowed says so, and never falls back.
      const pinnedThread = yield* setup.thread(setup.people.member, setup.acmeId, ids.claudeB);
      const pinnedAsk = () =>
        call(setup, "/api/ai/anthropic/v1/messages", { key: pinnedThread.key, body: messages() });
      assert.equal((yield* pinnedAsk()).status, 200);
      assert.equal(setup.upstream().at(-1)!.model, `acct-${ids.claudeB}/claude-sonnet-5-5`);
      yield* setup.accounts
        .allow({ accountId: ids.claudeB, spaceIds: [setup.globexId], userIds: [] })
        .pipe(setup.asOwner);
      const notAllowed = yield* pinnedAsk();
      assert.equal(notAllowed.status, 403);
      assert.include(notAllowed.text, "Switch AI account");

      // The Thread's Project moved to Globex: its key is for Acme, so it stops.
      const moved = yield* setup.thread(setup.people.member, setup.acmeId);
      assert.equal(yield* ask(moved.key), 200);
      yield* setup.server.sql`
        UPDATE projection_projects SET space_id = ${setup.globexId} WHERE project_id = ${moved.projectId}
      `;
      assert.equal(yield* ask(moved.key), 403);

      // Archived, deleted.
      const archived = yield* setup.thread(setup.people.member, setup.acmeId);
      yield* setup.server.sql`
        UPDATE orchestration_v2_projection_threads SET archived_at = '2026-11-02T00:00:00.000Z'
        WHERE thread_id = ${archived.threadId}
      `;
      assert.equal(yield* ask(archived.key), 401);
      const deleted = yield* setup.thread(setup.people.member, setup.acmeId);
      yield* setup.server.sql`
        UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-11-02T00:00:00.000Z'
        WHERE thread_id = ${deleted.threadId}
      `;
      assert.equal(yield* ask(deleted.key), 401);

      // Another owner of the Thread now (a transfer): the old owner's key stops.
      const transferred = yield* setup.thread(setup.people.member, setup.acmeId);
      yield* setup.server.sql`
        UPDATE orchestration_v2_projection_threads SET owner_user_id = ${setup.people.admin}
        WHERE thread_id = ${transferred.threadId}
      `;
      assert.equal(yield* ask(transferred.key), 403);

      // Expired; rotated by the next session's key; a User key revoked (only by its User or the
      // Owner, audited).
      const expiring = yield* setup.thread(setup.people.member, setup.acmeId);
      yield* setup.server.sql`
        UPDATE ai_gateway_keys SET expires_at = '2026-01-01T00:00:00.000Z'
        WHERE thread_id = ${expiring.threadId}
      `;
      assert.equal(yield* ask(expiring.key), 401);
      const rotated = yield* setup.thread(setup.people.member, setup.acmeId);
      const next = yield* setup.keys.issueForThread(rotated.threadId);
      assert.equal(yield* ask(rotated.key), 401);
      assert.equal(yield* ask(Redacted.value(next.key)), 200);
      const cli = yield* setup.keys.createForUser({
        actorUserId: setup.people.member,
        spaceId: setup.acmeId,
        name: "Laptop",
      });
      assert.equal(yield* ask(Redacted.value(cli.key)), 200);
      const byOther = yield* Effect.flip(
        setup.keys.revoke({ actorUserId: setup.people.admin, keyId: cli.keyId }),
      );
      assert.equal(byOther.reason, "not-found");
      assert.equal(yield* ask(Redacted.value(cli.key)), 200);
      assert.deepEqual(
        (yield* setup.keys.listUserKeys(setup.people.member)).map((listed) => listed.name),
        ["Laptop"],
      );
      assert.lengthOf(yield* setup.keys.listUserKeys(setup.people.admin), 0);
      yield* setup.keys.revoke({ actorUserId: setup.people.member, keyId: cli.keyId });
      assert.equal(yield* ask(Redacted.value(cli.key)), 401);
      const audits = yield* setup.server.sql<{ readonly action: string; readonly detail: string }>`
        SELECT action, detail_json AS detail FROM audit_log WHERE action LIKE 'ai_gateway_key.%'
      `;
      assert.deepEqual(
        audits.map((row) => row.action),
        ["ai_gateway_key.create", "ai_gateway_key.revoke"],
      );

      // Grace removed from Acme: her live Thread key and CLI key stop.
      const beforeRemoval = yield* setup.thread(setup.people.member, setup.acmeId);
      const cli2 = yield* setup.keys.createForUser({
        actorUserId: setup.people.member,
        spaceId: setup.acmeId,
        name: "Laptop 2",
      });
      assert.equal(yield* ask(beforeRemoval.key), 200);
      yield* setup.server.sql`
        DELETE FROM space_memberships WHERE space_id = ${setup.acmeId} AND user_id = ${setup.people.member}
      `;
      yield* setup.directory.membershipsChanged([setup.people.member]);
      assert.equal(yield* ask(beforeRemoval.key), 403);
      assert.equal(yield* ask(Redacted.value(cli2.key)), 403);

      // Ada's Thread, then Ada removed from the Installation: her key is dead.
      const adas = yield* setup.thread(setup.people.admin, setup.acmeId);
      assert.equal(yield* ask(adas.key), 200);
      yield* setup.server.sql`
        UPDATE users SET removed_at = '2026-11-02T00:00:00.000Z' WHERE user_id = ${setup.people.admin}
      `;
      assert.equal(yield* ask(adas.key), 401);

      // The router deleted: Linus's key (Acme) no longer reaches it.
      const linus = yield* setup.thread(setup.people.guest, setup.acmeId);
      assert.equal(yield* ask(linus.key), 200);
      yield* setup.accounts.remove({ accountId: ids.router }).pipe(setup.asOwner);
      const sentBefore = setup.upstream().length;
      assert.equal(yield* ask(linus.key), 404);
      assert.equal(setup.upstream().length, sentBefore, "a request after the delete was sent");
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "fails over on quota only to an allowed account of the same provider, and says so when none is left",
  () =>
    Effect.gen(function* () {
      const setup = yield* hub;
      const ids = yield* acmeSetup(setup);
      // Another provider serving the same model name, allowed to Acme: never a failover target.
      const proxy = yield* setup.account(
        "Acme Claude via proxy",
        "openai-compatible",
        { spaceIds: [setup.acmeId] },
        { baseUrl: "https://proxy.example/v1", models: ["claude-sonnet-5-5"] },
      );
      const { key, threadId } = yield* setup.thread(setup.people.member, setup.acmeId);
      const ask = () => call(setup, "/api/ai/anthropic/v1/messages", { key, body: messages() });
      assert.equal((yield* ask()).status, 200);
      assert.equal(Option.getOrThrow(yield* setup.activity.inUse(threadId)).accountId, ids.claudeA);

      // A out of quota: B (same provider, allowed) answers, and the Thread shows B.
      const changes = yield* (yield* setup.activity.subscribeAccountsInUse).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      setup.flag(`fake-quota-${ids.claudeA}`);
      const failedOver = yield* ask();
      assert.equal(failedOver.status, 200);
      assert.deepEqual(upstreamModels(setup).slice(-2), [
        `acct-${ids.claudeA}/claude-sonnet-5-5`,
        `acct-${ids.claudeB}/claude-sonnet-5-5`,
      ]);
      assert.equal(Option.getOrThrow(yield* setup.activity.inUse(threadId)).accountId, ids.claudeB);
      assert.equal([...(yield* Fiber.join(changes))][0]!.accountId, ids.claudeB);

      // B out too: Globex's Claude has quota but is not allowed here; the proxy is another provider.
      setup.flag(`fake-quota-${ids.claudeB}`);
      const count = setup.upstream().length;
      const none = yield* ask();
      assert.equal(none.status, 429);
      assert.include(
        none.text,
        "No allowed AI account for claude has quota left; switch AI account",
      );
      assert.deepEqual(upstreamModels(setup).slice(count), [
        `acct-${ids.claudeA}/claude-sonnet-5-5`,
        `acct-${ids.claudeB}/claude-sonnet-5-5`,
      ]);
      assert.notInclude(upstreamModels(setup), `acct-${proxy}/claude-sonnet-5-5`);
      assert.notInclude(upstreamModels(setup), `acct-${ids.globexClaude}/claude-sonnet-5-5`);
      assert.notInclude(none.text, "owner@example.com");
      assert.notInclude(none.text, "sk-ant");
      // The same in the OpenAI shape for an openai-compatible account with no peer.
      setup.flag(`fake-quota-${ids.router}`);
      const routerNone = yield* call(setup, "/api/ai/openai/v1/chat/completions", {
        key,
        body: { model: "deepseek-chat", messages: [] },
      });
      assert.equal(routerNone.status, 429);
      assert.equal((routerNone.json as { error: { type: string } }).error.type, "rate_limit_error");
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "keeps keys, prompts and upstream words out of answers, logs and spans; limits size and load",
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
      const ids = yield* acmeSetup(setup);
      const { key } = yield* setup.thread(setup.people.member, setup.acmeId);
      const path = "/api/ai/anthropic/v1/messages";

      // An upstream refusal quoting an email, a key and an address reaches the client filtered.
      setup.flag(`fake-error-${ids.claudeA}`);
      const refused = yield* call(setup, path, { key, body: messages() });
      assert.equal(refused.status, 400);
      for (const leak of [
        "owner@example.com",
        "sk-ant-leaky",
        "AIzaSy",
        "https://provider.test",
        "acct-",
      ]) {
        assert.notInclude(refused.text, leak);
      }
      assert.include(refused.text, "Bad request for [redacted]");
      setup.flag(`fake-error-${ids.claudeA}`, false);
      // So does an error event in the middle of a stream.
      setup.flag("fake-stream-error");
      const broken = yield* call(setup, path, {
        key,
        body: messages("claude-sonnet-5-5", { stream: true }),
      });
      setup.flag("fake-stream-error", false);
      assert.include(broken.text, "upstream failure for [redacted]");
      for (const leak of ["owner@example.com", "sk-ant-leaky", "acct-"]) {
        assert.notInclude(broken.text, leak);
      }

      // A body over the limit is refused before CLIProxyAPI sees it.
      const count = setup.upstream().length;
      const huge = yield* call(setup, path, {
        key,
        rawBody: JSON.stringify(messages("claude-sonnet-5-5", { pad: "x".repeat(300 * 1024) })),
      });
      assert.equal(huge.status, 413);
      const compressed = yield* call(setup, path, {
        key,
        body: messages(),
        headers: { "content-encoding": "gzip" },
      });
      assert.equal(compressed.status, 415);
      assert.equal(setup.upstream().length, count);

      // One key holds at most 16 requests at once; the 17th is told to wait.
      setup.flag("fake-stream-hold");
      const held = yield* Effect.forEach(
        Array.from({ length: 16 }),
        () =>
          Effect.promise(() =>
            fetch(`http://127.0.0.1:${setup.port}${path}`, {
              method: "POST",
              headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
              body: JSON.stringify(messages("claude-sonnet-5-5", { stream: true })),
            }),
          ),
        { concurrency: "unbounded" },
      );
      const extra = yield* call(setup, path, { key, body: messages() });
      assert.equal(extra.status, 429);
      setup.flag("fake-stream-release");
      yield* Effect.forEach(held, (response) => Effect.promise(() => response.text()), {
        concurrency: "unbounded",
      });
      setup.flag("fake-stream-hold", false);
      setup.flag("fake-stream-release", false);
      assert.equal((yield* call(setup, path, { key, body: messages() })).status, 200);

      // Nothing recorded carries a key (the gateway key, the Hub's client key, a provider key),
      // a prompt, or a header; the request itself is recorded by route, account and status.
      const recorded = [
        ...logs,
        ...spans.flatMap((span) => [
          span.name,
          ...Array.from(span.attributes.values(), (value) => JSON.stringify(value)),
        ]),
      ].join("\n");
      assert.include(recorded, "AI gateway request");
      assert.include(recorded, ids.claudeA);
      assert.include(recorded, "/api/ai/anthropic/v1/messages");
      for (const leak of [
        key,
        PROMPT,
        "t3gk_",
        ...PROVIDER_KEYS,
        "sk-test-",
        "owner@example.com",
      ]) {
        assert.notInclude(recorded, leak);
      }
      // The database keeps only the key's hash.
      const rows = yield* setup.server.sql.unsafe(`SELECT * FROM ai_gateway_keys`);
      assert.notInclude(JSON.stringify(rows), key);
      assert.include(
        JSON.stringify(rows),
        NodeCrypto.createHash("sha256").update(key).digest("hex"),
      );
    }).pipe(
      Effect.scoped,
      Effect.withTracer(tracer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  },
);
