/**
 * The local relay to the Hub's AI gateway (spec 4 ticket 06): loopback only, the gateway's routes
 * only, nothing added, kept or followed; never a way to anything else on the Hub or the network.
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off globalTimers:off -- raw sockets and a fake Hub on loopback.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import * as AiGatewayRelay from "./AiGatewayRelay.ts";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

/** A fake Hub on loopback that notes every request it gets and answers as the gateway would. */
const fakeHub = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        readonly url: string;
        readonly seen: Array<Seen>;
        readonly server: NodeHttp.Server;
      }>((resolve) => {
        const seen: Array<Seen> = [];
        const server = NodeHttp.createServer((request, response) => {
          let body = "";
          request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
          request.on("end", () => {
            seen.push({
              method: request.method ?? "",
              url: request.url ?? "",
              headers: request.headers,
              body,
            });
            if (request.url === "/api/ai/openai/v1/models") {
              response.writeHead(302, { location: "http://example.invalid/" });
              response.end();
              return;
            }
            response.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "a=b" });
            response.write("data: one\n\n");
            setTimeout(() => response.end("data: two\n\n"), 50);
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const port = (server.address() as NodeNet.AddressInfo).port;
          resolve({ url: `http://127.0.0.1:${port}`, seen, server });
        });
      }),
  ),
  (hub) => Effect.promise(() => new Promise<void>((resolve) => hub.server.close(() => resolve()))),
);

/** Sends `raw` as is to the relay and returns what came back. */
const rawRequest = (port: number, raw: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve) => {
        const socket = NodeNet.connect(port, "127.0.0.1", () => socket.write(raw));
        let answer = "";
        socket.on("data", (chunk) => (answer += chunk.toString("utf8")));
        socket.on("close", () => resolve(answer));
        socket.on("error", () => resolve(answer));
        socket.setTimeout(3000, () => socket.destroy());
      }),
  );

const relayOn = Effect.fn(function* () {
  const hub = yield* fakeHub;
  const relay = yield* AiGatewayRelay.make(hub.url);
  const baseUrl = yield* relay.baseUrl;
  const port = Number(new URL(baseUrl).port);
  return { hub, baseUrl, port };
});

describe("AiGatewayRelay", () => {
  it.live("listens on 127.0.0.1 alone and streams a gateway call to the Hub, adding nothing", () =>
    Effect.gen(function* () {
      const { hub, baseUrl, port } = yield* relayOn();
      assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
      const answer = yield* Effect.promise(async () => {
        const response = await fetch(`${baseUrl}/api/ai/openai/v1/chat/completions?x=1`, {
          method: "POST",
          headers: {
            authorization: "Bearer t3gk_test-key",
            "content-type": "application/json",
            cookie: "t3_session=stolen",
            "x-forwarded-for": "10.0.0.1",
            "x-t3-environment": "env-credential",
          },
          body: JSON.stringify({ model: "m", stream: true }),
        });
        return {
          status: response.status,
          text: await response.text(),
          cookie: response.headers.get("set-cookie"),
        };
      });
      assert.equal(answer.status, 200);
      assert.equal(answer.text, "data: one\n\ndata: two\n\n");
      assert.isNull(answer.cookie, "nothing but the content headers crosses back");
      assert.equal(hub.seen.length, 1);
      const seen = hub.seen[0]!;
      assert.equal(seen.url, "/api/ai/openai/v1/chat/completions?x=1");
      assert.equal(seen.headers.authorization, "Bearer t3gk_test-key");
      assert.equal(seen.body, JSON.stringify({ model: "m", stream: true }));
      assert.isUndefined(seen.headers.cookie, "no cookie");
      assert.isUndefined(seen.headers["x-forwarded-for"]);
      assert.isUndefined(seen.headers["x-t3-environment"], "no identity of the relay's own");
      // Another address of this machine does not answer.
      const outside = Object.values(NodeOS.networkInterfaces())
        .flat()
        .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal);
      if (outside !== undefined) {
        const reached = yield* Effect.promise(
          () =>
            new Promise<boolean>((resolve) => {
              const socket = NodeNet.connect(port, outside.address, () => {
                socket.destroy();
                resolve(true);
              });
              socket.on("error", () => resolve(false));
            }),
        );
        assert.isFalse(reached, "only loopback");
      }
    }).pipe(Effect.scoped),
  );

  it.live("forwards no call without its key of its own: the key is the only identity", () =>
    Effect.gen(function* () {
      const { hub, baseUrl } = yield* relayOn();
      yield* Effect.promise(() =>
        fetch(`${baseUrl}/api/ai/anthropic/v1/messages`, { method: "POST", body: "{}" }).then((r) =>
          r.text(),
        ),
      );
      assert.equal(hub.seen.length, 1);
      const headers = hub.seen[0]!.headers;
      assert.isUndefined(headers.authorization);
      assert.isUndefined(headers["x-api-key"]);
    }).pipe(Effect.scoped),
  );

  it.live("is no proxy: other Hub paths, other hosts, tunnels and pages never reach the Hub", () =>
    Effect.gen(function* () {
      const { hub, port } = yield* relayOn();
      const host = `Host: 127.0.0.1:${port}\r\n`;
      const refused = [
        `GET /api/environment/connect HTTP/1.1\r\n${host}\r\n`,
        `GET /mcp HTTP/1.1\r\n${host}\r\n`,
        `GET /api/git/project-1/info/refs HTTP/1.1\r\n${host}\r\n`,
        `GET /v8/management/config HTTP/1.1\r\n${host}\r\n`,
        `GET /api/ai/v0/management/config HTTP/1.1\r\n${host}\r\n`,
        `POST /api/ai/../mcp HTTP/1.1\r\n${host}Content-Length: 0\r\n\r\n`,
        `POST /api/ai/openai/v1/..%2F..%2Fmcp HTTP/1.1\r\n${host}Content-Length: 0\r\n\r\n`,
        `GET //example.com/api/ai/openai/v1/models HTTP/1.1\r\n${host}\r\n`,
        `GET http://example.com/api/ai/openai/v1/models HTTP/1.1\r\nHost: example.com\r\n\r\n`,
        `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n`,
        `GET /api/ai/openai/v1/models HTTP/1.1\r\nHost: attacker.example:${port}\r\n\r\n`,
        `GET /api/ai/openai/v1/models HTTP/1.1\r\n${host}Origin: http://attacker.example\r\n\r\n`,
        `GET /api/ai/openai/v1/models HTTP/1.1\r\n${host}Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
        `DELETE /api/ai/openai/v1/chat/completions HTTP/1.1\r\n${host}\r\n`,
      ];
      for (const raw of refused) {
        const answer = yield* rawRequest(port, raw);
        assert.notMatch(answer, /^HTTP\/1\.1 2\d\d/u, raw);
      }
      assert.deepEqual(hub.seen, [], "the Hub saw none of them");
    }).pipe(Effect.scoped),
  );

  it.live("never follows nor passes on a redirect", () =>
    Effect.gen(function* () {
      const { hub, baseUrl } = yield* relayOn();
      const answer = yield* Effect.promise(() =>
        fetch(`${baseUrl}/api/ai/openai/v1/models`, { redirect: "manual" }).then((r) => ({
          status: r.status,
          location: r.headers.get("location"),
        })),
      );
      assert.equal(answer.status, 502);
      assert.isNull(answer.location);
      assert.equal(hub.seen.length, 1, "asked once, nothing followed");
    }).pipe(Effect.scoped),
  );

  it.live("makes the Thread's own provider home, 0700, out of the machine user's home", () =>
    Effect.gen(function* () {
      const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-relay-home-"));
      const prepared = yield* AiGatewayRelay.prepareGatewaySession({
        access: {
          key: "t3gk_k",
          aiAccountId: "acct-1" as never,
          aiAccountName: "Acme",
          provider: "openai-compatible",
          model: "m",
        },
        threadId: "thread:ada",
        driver: "claudeAgent",
        stateDir,
        baseUrl: Effect.succeed("http://127.0.0.1:1"),
      });
      assert.isDefined(prepared);
      assert.equal(
        prepared!.home,
        AiGatewayRelay.providerHomeOf(stateDir, "thread:ada", "claudeAgent"),
      );
      assert.isTrue(prepared!.home.startsWith(NodePath.join(stateDir, "provider-homes")));
      assert.notInclude(prepared!.home, "thread:ada", "the Thread's id is hashed");
      if ((yield* HostProcess.Platform) !== "win32") {
        assert.equal(NodeFS.statSync(prepared!.home).mode & 0o777, 0o700);
      }
      assert.notEqual(
        AiGatewayRelay.providerHomeOf(stateDir, "thread:grace", "claudeAgent"),
        prepared!.home,
        "each Thread its own",
      );
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses to relay a key to a Hub over plain HTTP off this machine", () =>
    Effect.gen(function* () {
      const relay = yield* AiGatewayRelay.make("http://hub.example.test:8080");
      const exit = yield* Effect.exit(relay.baseUrl);
      assert.isTrue(exit._tag === "Failure");
      assert.include(JSON.stringify(exit), "insecure-hub");
      const secure = yield* AiGatewayRelay.make("https://hub.example.test");
      assert.match(yield* secure.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
    }).pipe(Effect.scoped),
  );

  it.live("passes a body's encoding on, so the Hub refuses what it cannot read", () =>
    Effect.gen(function* () {
      const { hub, baseUrl } = yield* relayOn();
      yield* Effect.promise(() =>
        fetch(`${baseUrl}/api/ai/openai/v1/chat/completions`, {
          method: "POST",
          headers: { "content-encoding": "gzip", authorization: "Bearer t3gk_x" },
          body: "compressed",
        }).then((r) => r.text()),
      );
      assert.equal(hub.seen[0]?.headers["content-encoding"], "gzip");
    }).pipe(Effect.scoped),
  );

  it("decides from the request alone", () => {
    const decide = (url: string, headers: Record<string, string> = {}, method = "POST") =>
      AiGatewayRelay.relayDecision({ method, url, headers: { host: "127.0.0.1:9", ...headers } }, 9)
        ._tag;
    assert.equal(decide("/api/ai/openai/v1/responses"), "forward");
    assert.equal(decide("/api/ai/anthropic/v1/messages", { host: "localhost:9" }), "forward");
    assert.equal(decide("/api/ai/openai/v1/responses", { host: "127.0.0.1:10" }), "refuse");
    assert.equal(decide("/api/ai/openai/v1/embeddings"), "refuse");
  });
});
