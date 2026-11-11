// @effect-diagnostics nodeBuiltinImport:off -- an app on the loopback that sets a login cookie, and a real Chromium that keeps it.
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { chromium } from "playwright-core";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import type { ProfileOwner } from "./PreviewProfiles.ts";
import { layerTest, testFolders } from "./PreviewProfiles.testkit.ts";
import * as ServerBrowser from "./ServerBrowser.ts";

/** An app with a sign-in: `/login` sets its session cookie; every page shows the cookie it got. */
const startApp = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly server: NodeHttp.Server }>((resolve) => {
        const server = NodeHttp.createServer((request, response) => {
          const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
          const login = /^\/login\?as=(\w+)$/.exec(request.url ?? "");
          if (login) headers["set-cookie"] = `session=${login[1]}; Path=/; Max-Age=3600`;
          response.writeHead(200, headers);
          response.end(`<title>app</title><p>${request.headers.cookie ?? "signed out"}</p>`);
        });
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as NodeNet.AddressInfo;
          resolve({ origin: `http://127.0.0.1:${port}`, server });
        });
      }),
  ),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
);

const environmentId = EnvironmentId.make("profiles-test-environment");
const scopeOf = (threadId: string) => ({
  environmentId,
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: `agent-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: `profiles-${threadId}`,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
});

/**
 * Threads, by whose they are and where: two Users in one Space, Alice again in another, and a
 * draft nobody's yet (no row).
 */
const THREADS: Readonly<Record<string, ProfileOwner | undefined>> = {
  aliceInAcme: { userId: "alice", spaceId: "acme" },
  aliceInAcmeAgain: { userId: "alice", spaceId: "acme" },
  bobInAcme: { userId: "bob", spaceId: "acme" },
  aliceInGlobex: { userId: "alice", spaceId: "globex" },
  draft: undefined,
};
/** Spaces a User has left (`keeps` says no), and where their access changes are told. */
const left = new Set<string>();
const access = new NodeEvents.EventEmitter();
const accessChanges = Stream.callback<string>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const onChange = (userId: string) => Queue.offerUnsafe(queue, userId);
      access.on("change", onChange);
      return onChange;
    }),
    (onChange) => Effect.sync(() => access.off("change", onChange)),
  ),
);
/** Settles when Bob's profiles are next checked. */
let bobChecked = Promise.withResolvers<void>();

const dependencies = Layer.mergeAll(
  Broker.layer,
  Manager.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.sync(() => chromium.executablePath()),
    installed: Effect.succeed(true as never),
  }),
  Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
    available: false,
    awaitAttached: () => Effect.succeed(false),
    detached: Stream.never,
    attached: Stream.never,
    isAttached: () => Effect.succeed(false),
    endpoint: () => Effect.die("no desktop"),
    pointer: () => Effect.void,
    turn: () => Effect.void,
  }),
  PreviewAgentActivity.layer,
  layerTest((threadId) => THREADS[threadId], {
    keeps: (owner) =>
      Effect.sync(() => {
        if (owner.userId === "bob") bobChecked.resolve();
        return !left.has(`${owner.userId}/${owner.spaceId}`);
      }),
    accessChanges: Effect.succeed(accessChanges),
  }),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-browser-profiles-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));

/** Opens a tab of `threadId` in the Default profile at `url` and reads its cookie and storage. */
const visit = Effect.fn(function* (threadId: string, url: string, script?: string) {
  const broker = yield* Broker.PreviewAutomationBroker;
  const scope = scopeOf(threadId);
  const opened = yield* broker.invoke<PreviewAutomationStatus>({
    scope,
    operation: "open",
    input: { reuseExistingTab: false, show: false, profileId: "default", url },
  });
  const read = yield* broker.invoke<unknown>({
    scope,
    operation: "evaluate",
    input: {
      tabId: opened.tabId!,
      expression: `(() => { ${script ?? ""}; return document.cookie + "|" + localStorage.getItem("who"); })()`,
    },
  });
  yield* broker.invoke({ scope, operation: "close", input: { tabId: opened.tabId! } });
  return read;
});

it.live(
  "one User's sign-in in a preview never reaches another User's preview of the same app, nor their own in another Space",
  () =>
    Effect.gen(function* () {
      const app = yield* startApp;
      yield* ServerBrowser.ServerBrowser;
      // The server browser registers as the automation host on its next turn.
      yield* Effect.yieldNow;
      // Alice signs in to her app and the app remembers her in its storage.
      expect(
        yield* visit(
          "aliceInAcme",
          `${app.origin}/login?as=alice`,
          `localStorage.setItem("who", "alice")`,
        ),
      ).toBe("session=alice|alice");
      // Her next preview in the same Space is still signed in.
      expect(yield* visit("aliceInAcmeAgain", `${app.origin}/`)).toBe("session=alice|alice");
      // Bob, in the same Space, previews the same app: signed out.
      expect(yield* visit("bobInAcme", `${app.origin}/`)).toBe("|null");
      // So is Alice's own preview in another Space.
      expect(yield* visit("aliceInGlobex", `${app.origin}/`)).toBe("|null");
      // And a draft's tab, whose User cannot be told yet, gets a throwaway profile of its own.
      expect(yield* visit("draft", `${app.origin}/`)).toBe("|null");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("clearing a profile clears only the caller's own; every User's is the Owner's action", () =>
  Effect.gen(function* () {
    const app = yield* startApp;
    const browser = yield* ServerBrowser.ServerBrowser;
    yield* Effect.yieldNow;
    expect(yield* visit("aliceInAcme", `${app.origin}/login?as=alice`)).toBe("session=alice|null");
    expect(yield* visit("bobInAcme", `${app.origin}/login?as=bob`)).toBe("session=bob|null");
    expect(yield* visit("aliceInGlobex", `${app.origin}/login?as=alice2`)).toBe(
      "session=alice2|null",
    );
    // Bob clears his Default profile: Alice stays signed in.
    yield* browser.clearProfile({ userId: "bob", profileId: "default" });
    expect(yield* visit("bobInAcme", `${app.origin}/`)).toBe("|null");
    expect(yield* visit("aliceInAcme", `${app.origin}/`)).toBe("session=alice|null");
    // Alice clears hers: gone in every Space she has it.
    yield* browser.clearProfile({ userId: "alice", profileId: "default" });
    expect(yield* visit("aliceInAcme", `${app.origin}/`)).toBe("|null");
    expect(yield* visit("aliceInGlobex", `${app.origin}/`)).toBe("|null");
    // The Owner's separate action clears everyone's.
    expect(yield* visit("bobInAcme", `${app.origin}/login?as=bob`)).toBe("session=bob|null");
    yield* browser.clearAllProfiles;
    expect(yield* visit("bobInAcme", `${app.origin}/`)).toBe("|null");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("a User who leaves a Space loses their profiles there, and only there", () =>
  Effect.gen(function* () {
    const app = yield* startApp;
    yield* ServerBrowser.ServerBrowser;
    yield* Effect.yieldNow;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const spaceFolder = (owner: ProfileOwner) =>
      path.join(
        stateDir,
        "server-browser",
        "user-profiles",
        testFolders.userFolder(owner.userId),
        testFolders.spaceFolder(owner.spaceId),
      );
    yield* visit("aliceInAcme", `${app.origin}/login?as=alice`);
    yield* visit("aliceInGlobex", `${app.origin}/login?as=alice2`);
    yield* visit("bobInAcme", `${app.origin}/login?as=bob`);
    const aliceInAcme = spaceFolder(THREADS.aliceInAcme!);
    // Folder names say nothing of whose they are.
    expect(aliceInAcme).not.toContain("alice");
    expect(yield* fs.exists(aliceInAcme)).toBe(true);

    left.add("alice/acme");
    bobChecked = Promise.withResolvers<void>();
    access.emit("change", "alice");
    // Changes are handled in order: once Bob's starts, Alice's is done.
    access.emit("change", "bob");
    yield* Effect.promise(() => bobChecked.promise);
    expect(yield* fs.exists(aliceInAcme)).toBe(false);
    expect(yield* visit("aliceInAcme", `${app.origin}/`)).toBe("|null");
    expect(yield* visit("aliceInGlobex", `${app.origin}/`)).toBe("session=alice2|null");
    expect(yield* visit("bobInAcme", `${app.origin}/`)).toBe("session=bob|null");
  }).pipe(Effect.ensuring(Effect.sync(() => left.clear())), Effect.scoped, Effect.provide(layer)),
);
