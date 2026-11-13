/**
 * The «Hub con Environments» scenario for spec 5 ticket 05 (masking): the Owner's Thread on a
 * Laptop whose agent printed OWNER_TOKEN and wrote it to notes.md, and the Hub's doors over it.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the tests read the Hub's files on disk.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { assert } from "@effect/vitest";
import {
  MAIN_VAULT_ID,
  type ProviderInstanceId,
  type ThreadId,
  type UserId,
  type VaultEntryId,
} from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { maskDeep } from "@t3tools/shared/secretMasking";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import * as CommandActor from "../auth/CommandActor.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Vaults from "../vaults/Vaults.ts";
import { type Hub, makeHub } from "./HubWithEnvironments.testkit.ts";
import {
  awaitUploaded,
  loadFixture,
  ownerIdOf,
  replayOn,
  withEditingTurns,
} from "./HubWithEnvironments.scenarios.testkit.ts";

export const OWNER_TOKEN = "owner-token-value-3333";
export const ROTATED_TOKEN = "owner-token-rotated-4444";

/** The Hub's workspace RPCs (what `ws.ts` calls), over the Hub's own projection and Environments. */
export const threadWorkspaceOf = (hub: Hub) =>
  ThreadWorkspace.make.pipe(
    Effect.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
    Effect.provideContext(hub.server.services as never),
  ) as Effect.Effect<ThreadWorkspace.ThreadWorkspace["Service"]>;

/**
 * An agent that takes its secrets and prints one: its reply carries the value it received, split
 * in two as a streamed reply would. (The recorded reply is «fixture simple ok».)
 */
const printingSecret = (
  adapters: Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    never,
    McpProviderSessions.McpProviderSessions
  >,
  value: string,
) =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (instanceId: ProviderInstanceId) =>
        registry.get(instanceId).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            receivesSecretEnv: true as const,
            openSession: (open: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
              adapter.openSession(open).pipe(
                Effect.map((runtime) => ({
                  ...runtime,
                  events: runtime.events.pipe(
                    Stream.map((event) =>
                      maskDeep(event, (text) =>
                        text.replaceAll("fixture simple ok", `the token is ${value}, ok`),
                      ),
                    ),
                  ),
                })),
              ),
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

/** Every file of the Hub's state outside the sealed store that holds `value`, by path. */
export const hubFilesHolding = (hub: Hub, value: string) =>
  Effect.promise(async () => {
    const { stateDir } = hub.service(ServerConfig.ServerConfig);
    const needle = Buffer.from(value);
    const found: Array<string> = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
        const full = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (full !== NodePath.join(stateDir, "secrets")) await walk(full);
        } else if (entry.isFile() && NodeFS.readFileSync(full).includes(needle)) {
          found.push(NodePath.relative(stateDir, full));
        }
      }
    };
    await walk(stateDir);
    return found;
  });

/** Every row of every table of the Hub's database, as text. */
export const databaseText = (hub: Hub) =>
  Effect.gen(function* () {
    const tables = yield* hub.server.sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `;
    let text = "";
    for (const { name } of tables) {
      const rows = yield* hub.server.sql.unsafe(`SELECT * FROM "${name}"`);
      text += JSON.stringify(rows);
    }
    return text;
  });

export const putOwnerToken = (hub: Hub, owner: UserId, value: string, entryId?: VaultEntryId) =>
  hub
    .service(Vaults.Vaults)
    .putEntry({
      vaultId: MAIN_VAULT_ID,
      ...(entryId === undefined ? {} : { entryId }),
      name: "OWNER_TOKEN",
      value: Redacted.make(value),
    })
    .pipe(CommandActor.actAs(owner));

/** The Hub's copy of the Thread's Project: the folder clients name. */
export const hubCheckoutOf = Effect.fn(function* (hub: Hub, threadId: ThreadId) {
  const projection = yield* hub.service(Orchestrator.OrchestratorV2).getThreadProjection(threadId);
  const project = yield* hub.service(ProjectStore.ProjectStoreV2).get(projection.thread.projectId);
  return projection.thread.worktreePath ?? Option.getOrThrow(project).workspaceRoot;
});

/** The Owner's Thread on the Laptop: its agent printed OWNER_TOKEN and wrote it to notes.md. */
export const turnThatPrintsTheSecret = Effect.fn(function* () {
  const loaded = yield* loadFixture("simple");
  const hub = yield* makeHub();
  const owner = yield* ownerIdOf(hub);
  const { entry } = yield* putOwnerToken(hub, owner, OWNER_TOKEN);
  const laptop = yield* hub.join({
    name: "Laptop",
    adapters: printingSecret(
      withEditingTurns(loaded.adapters, { file: "notes.md", content: `TOKEN=${OWNER_TOKEN}` }),
      OWNER_TOKEN,
    ),
  });
  yield* replayOn(hub, laptop, loaded, { ownerUserId: owner });
  const [threadId] = loaded.materialized.projectionThreadIds;
  assert.isDefined(threadId);
  yield* awaitUploaded(hub, threadId, 1);
  return { hub, laptop, owner, threadId: threadId as ThreadId, entryId: entry.id };
});
