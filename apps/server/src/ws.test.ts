import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthTerminalReadScope,
  EventId,
  GuestShareId,
  MessageId,
  NodeId,
  RunId,
  SpaceId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ShellStreamItem,
  AuthSessionId,
  CommandId,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  UserId,
  WsRpcGroup,
  ProjectId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
  WsServerRefreshProvidersRpc,
  WsSubscribeServerConfigRpc,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationProjectShell,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Headers } from "effect/http";
import { RpcGroup, RpcMessage, RpcServer } from "effect/rpc";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as AssetSigner from "./assets/AssetSigner.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as NativeChildWorkQuery from "./orchestration-v2/NativeChildWorkQuery.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as GuestShareService from "./guest/GuestShareService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "./sourceControl/SourceControlSignIn.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as TriageService from "./triage/TriageService.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfigModule from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";

import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import {
  connectionEnds,
  layerWsRpc,
  resolveOpenDiscoveryForConfig,
  subscribeOrchestrationV2Shell,
  subscribeOrchestrationV2Thread,
  WS_RPC_SERVER_OPTIONS,
  withLateConfigDiscovery,
} from "./ws.ts";
import * as CurrentPrincipal from "./auth/CurrentPrincipal.ts";
import * as SpaceDirectory from "./spaces/SpaceDirectory.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import { layerSeesEverything } from "./spaces/SpaceVisibility.testkit.ts";
import * as SpaceVisibility from "./spaces/SpaceVisibility.ts";
import {
  addMember,
  bootstrapOwner,
  isSignedIn,
  joinOrganization,
  makeAuthenticator,
  serveAuthHttp,
} from "./auth/UserAuth.testkit.ts";
import * as CommandActor from "./auth/CommandActor.ts";
import { untilAccessLost } from "./auth/RpcSpaceAccess.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as McpSessionRegistryTestkit from "./mcp/McpSessionRegistry.testkit.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderTurnStartServiceTestkit from "./orchestration-v2/ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "./orchestration-v2/runtimeLayer.ts";
import { visibleShells } from "./mcp/mcpVisibility.ts";
import { threadNotFound } from "./mcp/threadAccess.ts";
import * as McpInvocationContext from "./mcp/McpInvocationContext.ts";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Context from "effect/Context";

const snapshotConfig = (fields: Partial<ServerConfig>) =>
  ({ availableEditors: [], settings: {}, ...fields }) as unknown as ServerConfig;

const settingsUpdated = (settings: object): ServerConfigStreamEvent => ({
  version: 1,
  type: "settingsUpdated",
  payload: { settings: settings as ServerConfig["settings"] },
});

it.effect("resends late editors without rolling back updates already sent", () =>
  Effect.gen(function* () {
    const settingsSent = yield* Deferred.make<void>();
    const events = yield* withLateConfigDiscovery(
      snapshotConfig({ settings: { enableProviderUpdateChecks: true } as never }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () =>
          Deferred.await(settingsSent).pipe(Effect.as("file-explorer" as const)),
      },
      { resolveTargets: () => Effect.succeed([]) },
      { resolve: () => Effect.succeed([]) },
    ).pipe(
      Stream.tap((event) =>
        event.type === "settingsUpdated" ? Deferred.succeed(settingsSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const [first, second] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(first?.type, "settingsUpdated");
    assert.equal(second?.type, "snapshot");
    if (second?.type === "snapshot") {
      assert.deepEqual(second.config.availableEditors, ["file-manager"]);
      assert.equal(second.config.shellRevealInFileManagerKind, "file-explorer");
      assert.deepEqual(second.config.settings, { enableProviderUpdateChecks: false } as never);
    }
  }),
);

it.effect("resends a reveal kind and remote targets that outlast the snapshot timeout", () =>
  Effect.gen(function* () {
    const targets = [{ kind: "mdns" as const, host: "test.local" }];
    const finishDiscovery = yield* Deferred.make<typeof targets>();
    const collecting = yield* withLateConfigDiscovery(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
      },
      { resolveTargets: () => Deferred.await(finishDiscovery) },
      { resolve: () => Effect.succeed([]) },
    ).pipe(Stream.runCollect, Effect.forkScoped({ startImmediately: true }));
    yield* TestClock.adjust("6 seconds");
    yield* Deferred.succeed(finishDiscovery, targets);
    const events = yield* Fiber.join(collecting);

    const [late, remote] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
    assert.equal(remote?.type, "snapshot");
    if (remote?.type === "snapshot") {
      assert.deepEqual(remote.config.remoteOpenTargets, targets);
      assert.equal(remote.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }).pipe(Effect.scoped),
);

it.effect("runs editor, remote open target and direct endpoint discovery side by side", () =>
  Effect.gen(function* () {
    // Each discovery finishes only once the other two have started, so a
    // config that ran them one after another would never resolve.
    const editorsStarted = yield* Deferred.make<void>();
    const targetsStarted = yield* Deferred.make<void>();
    const endpointsStarted = yield* Deferred.make<void>();
    const startThenAwait = <A>(started: Deferred.Deferred<void>, value: A) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(
          Effect.forEach([editorsStarted, targetsStarted, endpointsStarted], Deferred.await),
        ),
        Effect.as(value),
      );

    const discovery = yield* resolveOpenDiscoveryForConfig({
      editors: startThenAwait(editorsStarted, ["file-manager" as const]),
      fileManagerRevealKind: Effect.succeed("finder" as const),
      remoteOpenTargets: startThenAwait(targetsStarted, []),
      directEndpoints: startThenAwait(endpointsStarted, []),
    });

    assert.deepEqual(discovery, {
      availableEditors: ["file-manager"],
      shellRevealInFileManager: true,
      shellRevealInFileManagerKind: "finder",
      remoteOpenTargets: [],
      directEndpoints: [],
    });
  }),
);

const ReplayTestLayer = Layer.merge(OrchestrationEventStore.layer, layerSeesEverything).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.live.each(["thread", "shell"] as const)(
  "%s resume skips unknown types, synchronizes, and receives the live tail",
  (scope) =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread:replay");
      const projectId = ProjectId.make("project:replay");
      const project = {
        id: projectId,
        title: "Replay",
        workspaceRoot: "/tmp/replay",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationProjectShell;
      const insert = (version: number, unknown = false) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`replay:${version}`}, ${scope === "thread" ? "thread" : "project"},
          ${scope === "thread" ? threadId : projectId}, ${version},
          ${unknown ? "future.event" : scope === "thread" ? "provider-session.detached" : "project.meta-updated"},
          ${now}, 'server', ${JSON.stringify(
            scope === "thread"
              ? { providerSessionId: "session:replay", detachedAt: now }
              : { projectId, updatedAt: now },
          )}, '{}', 2
        ) RETURNING sequence
      `;
      const [before] = yield* insert(0);
      yield* insert(1, true);
      const [after] = yield* insert(2);
      const [highWater] = yield* insert(3, true);
      const updates = yield* PubSub.unbounded();
      let liveSequence = 0;
      const consume = <A extends { readonly kind: string; readonly sequence?: number }, E, R>(
        stream: Stream.Stream<A, E, R>,
      ) =>
        stream.pipe(
          Stream.tap((item) =>
            Effect.gen(function* () {
              if (item.kind !== "synchronized") return;
              const [live] = yield* insert(4);
              liveSequence = live!.sequence;
              const events = yield* store
                .readApplicationEvents({
                  afterSequence: highWater!.sequence,
                  throughSequence: liveSequence,
                })
                .pipe(Stream.runCollect);
              yield* store.publishCommitted(events);
            }),
          ),
          Stream.takeUntil((item) => item.sequence === liveSequence),
          Stream.map((item) => ({ kind: item.kind as string, sequence: item.sequence })),
          Stream.runCollect,
        );
      const subscription = Effect.gen(function* () {
        return scope === "thread"
          ? yield* subscribeOrchestrationV2Thread({
              threadId,
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume))
          : yield* subscribeOrchestrationV2Shell({
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume));
      });
      const items = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getShellSnapshot: () => Effect.die("shell resume must not load a full snapshot"),
          listActiveSubagentThreadIds: () => Effect.succeed([]),
          streamStoredEventsFrom: (
            input: Parameters<
              ThreadManagement.ThreadManagementService["Service"]["streamStoredEventsFrom"]
            >[0],
          ) => {
            assert.equal(input?.afterSequence, highWater!.sequence);
            return store
              .streamApplicationEvents({ afterSequence: input?.afterSequence ?? 0 })
              .pipe(
                Stream.filter((event): event is OrchestrationV2StoredEvent => "event" in event),
              );
          },
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedSome(project),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(updates),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
      );
      assert.deepEqual(
        items.map((item) => item.kind),
        scope === "thread"
          ? ["event", "synchronized", "event"]
          : ["project.updated", "synchronized", "project.updated"],
      );
      assert.deepEqual(
        items.flatMap((item) => (item.sequence === undefined ? [] : [item.sequence])),
        [after!.sequence, liveSequence],
      );
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("coalesces streaming replay before synchronization and the live tail", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:streaming-replay");
    const now = "2026-10-27T00:00:00.000Z";
    const insert = (version: number, text: string, streaming: boolean) => sql<{
      sequence: number;
    }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`streaming-replay:${version}`}, 'thread', ${threadId}, ${version}, 'message.updated',
        ${now}, 'server', ${JSON.stringify({
          createdBy: "agent",
          creationSource: "web",
          id: "message:streaming-replay",
          threadId,
          runId: null,
          nodeId: null,
          role: "assistant",
          text,
          attachments: [],
          streaming,
          createdAt: now,
          updatedAt: now,
        })}, '{}', 2
      ) RETURNING sequence
    `;
    yield* insert(0, "H", true);
    yield* insert(1, "He", true);
    const [latest] = yield* insert(2, "Hello", true);
    const [completed] = yield* insert(3, "Hello!", false);
    const items = yield* subscribeOrchestrationV2Thread({
      threadId,
      afterSequence: 0,
      requestCompletionMarker: true,
    }).pipe(
      Effect.flatMap(Stream.runCollect),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        streamStoredEventsFrom: () =>
          Stream.unwrap(
            insert(4, "Next", false).pipe(
              Effect.map(() =>
                store.readAgentEvents({ threadId, afterSequence: completed!.sequence }),
              ),
            ),
          ),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    );
    assert.deepEqual(
      items.map((item) =>
        item.kind === "event"
          ? [item.sequence, item.event.type === "message.updated" ? item.event.payload.text : null]
          : [item.kind],
      ),
      [
        [latest!.sequence, "Hello"],
        [completed!.sequence, "Hello!"],
        ["synchronized"],
        [completed!.sequence + 1, "Next"],
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("shell groups read distinct threads once and keep each event's own sequence", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-10-27T00:00:00.000Z";
    const insert = (aggregateKind: "thread" | "project", streamId: string, version: number) =>
      sql<{ sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`shell-group:${streamId}:${version}`}, ${aggregateKind}, ${streamId}, ${version},
        ${aggregateKind === "thread" ? "provider-session.detached" : "project.meta-updated"},
        ${now}, 'server', ${JSON.stringify(
          aggregateKind === "thread"
            ? { providerSessionId: "session:shell-group", detachedAt: now }
            : { projectId: streamId, updatedAt: now },
        )}, '{}', 2
      ) RETURNING sequence
    `.pipe(Effect.map(([row]) => row!.sequence));
    const shell = (id: string, archivedAt: string | null = null) =>
      ({ id: ThreadId.make(id), archivedAt }) as unknown as OrchestrationV2ThreadShell;
    const project = {
      id: ProjectId.make("project:group"),
    } as unknown as OrchestrationProjectShell;

    const after = yield* insert("project", "project:before", 0);
    yield* insert("thread", "thread:active", 0);
    const archived = yield* insert("thread", "thread:archived", 0);
    const projectUpdated = yield* insert("project", project.id, 0);
    const active = yield* insert("thread", "thread:active", 1);
    const missing = yield* insert("thread", "thread:missing", 0);

    const shellReads: Array<ReadonlyArray<string> | undefined> = [];
    let batchFails = false;
    const collect = (afterSequence: number) =>
      subscribeOrchestrationV2Shell({ afterSequence, requestCompletionMarker: true }).pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          listActiveSubagentThreadIds: () => Effect.succeed([]),
          getShellSnapshot: (options?: { readonly threadIds?: ReadonlyArray<string> }) =>
            Effect.suspend(() => {
              shellReads.push(options?.threadIds);
              return batchFails
                ? Effect.fail("batch failed")
                : Effect.succeed({
                    schemaVersion: 1,
                    snapshotSequence: Number.MAX_SAFE_INTEGER,
                    threads: [shell("thread:active")],
                    archivedThreads: [shell("thread:archived", now)],
                  });
            }),
          getThreadShell: (threadId: string) =>
            Effect.sync(() => {
              shellReads.push([`scalar:${threadId}`]);
              return threadId === "thread:missing"
                ? null
                : shell(threadId, threadId === "thread:archived" ? now : null);
            }),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedSome(project),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideServiceEffect(
          ProjectEnrichment.ProjectEnrichmentService,
          PubSub.unbounded().pipe(
            Effect.map(
              (changes) =>
                ({
                  subscribeChanges: PubSub.subscribe(changes),
                }) as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"],
            ),
          ),
        ),
      );

    const collectSummary = (afterSequence: number) =>
      collect(afterSequence).pipe(
        Effect.map((items) =>
          items.flatMap((item): ReadonlyArray<ReadonlyArray<string | number>> =>
            item.kind === "thread.updated"
              ? [[item.kind, item.sequence, item.thread.id]]
              : item.kind === "thread.removed"
                ? [[item.kind, item.sequence, item.threadId]]
                : item.kind === "project.updated"
                  ? [[item.kind, item.sequence, item.project.id]]
                  : [],
          ),
        ),
      );
    const expectedGroup = [
      ["thread.removed", archived, "thread:archived"],
      ["project.updated", projectUpdated, project.id],
      ["thread.updated", active, "thread:active"],
      ["thread.removed", missing, "thread:missing"],
    ];

    assert.deepEqual(yield* collectSummary(after), expectedGroup);
    assert.deepEqual(shellReads, [["thread:archived", "thread:active", "thread:missing"]]);

    shellReads.length = 0;
    assert.deepEqual(yield* collectSummary(active), [
      ["thread.removed", missing, "thread:missing"],
    ]);
    assert.deepEqual(shellReads, [["scalar:thread:missing"]]);

    shellReads.length = 0;
    batchFails = true;
    assert.deepEqual(yield* collectSummary(after), expectedGroup);
    assert.deepEqual(shellReads, [
      ["thread:archived", "thread:active", "thread:missing"],
      ["scalar:thread:archived"],
      ["scalar:thread:active"],
      ["scalar:thread:missing"],
    ]);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("shell snapshots omit idle children and older settled threads only on request", () =>
  Effect.gen(function* () {
    const shell = (
      id: string,
      parent: string | null,
      activityRunStatus: "running" | null,
      settledDaysAgo: number | null = null,
    ) =>
      ({
        id: ThreadId.make(id),
        projectId: "project",
        archivedAt: null,
        status: activityRunStatus ?? "completed",
        activityRunStatus,
        pendingRuntimeRequest: null,
        pendingBackgroundTasks: [],
        settledOverride: settledDaysAgo === null ? null : "settled",
        settledAt:
          settledDaysAgo === null ? null : DateTime.makeUnsafe(-settledDaysAgo * 86_400_000),
        lineage: {
          parentThreadId: parent === null ? null : ThreadId.make(parent),
          relationshipToParent: parent === null ? null : "subagent",
          rootThreadId: ThreadId.make(parent ?? id),
        },
      }) as unknown as OrchestrationV2ThreadShell;
    const threads = [
      shell("parent", null, null),
      shell("idle", "parent", null),
      shell("live", "parent", "running"),
      ...Array.from({ length: 25 }, (_, index) => shell(`recent-${index}`, null, null, 1)),
      shell("old", null, null, 30),
    ];
    const firstSnapshot = (input: {
      readonly omitIdleSubagents?: boolean;
      readonly omitOlderSettled?: boolean;
    }) =>
      subscribeOrchestrationV2Shell(input).pipe(
        Effect.flatMap((stream) => stream.pipe(Stream.take(1), Stream.runCollect)),
        Effect.map(([item]) => (item?.kind === "snapshot" ? item.snapshot : null)),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          listActiveShellIndex: () =>
            Effect.succeed(
              threads.map((thread) => ({
                ...thread,
                pinnedAt: null,
                snoozedUntil: null,
                mayBeLive: thread.activityRunStatus !== null,
              })),
            ),
          readShellSnapshot: (options?: { readonly threadIds?: ReadonlyArray<string> }) =>
            Effect.succeed(
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: threads.filter(
                  (thread) => options?.threadIds?.includes(thread.id) ?? true,
                ),
                archivedThreads: [],
              }),
            ),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedNone,
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideServiceEffect(
          ProjectEnrichment.ProjectEnrichmentService,
          PubSub.unbounded().pipe(
            Effect.map(
              (changes) =>
                ({
                  subscribeChanges: PubSub.subscribe(changes),
                }) as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"],
            ),
          ),
        ),
      );

    const recent = threads.slice(3, 28).map((thread) => thread.id);
    const full = yield* firstSnapshot({});
    assert.deepEqual(
      full?.threads.map((thread) => thread.id),
      threads.map((thread) => thread.id),
    );
    assert.isUndefined(full?.olderSettled);
    const withoutChildren = yield* firstSnapshot({ omitIdleSubagents: true });
    assert.deepEqual(
      withoutChildren?.threads.map((thread) => thread.id),
      ["parent", "live", ...recent, "old"],
    );
    const withoutOld = yield* firstSnapshot({ omitIdleSubagents: true, omitOlderSettled: true });
    assert.deepEqual(
      withoutOld?.threads.map((thread) => thread.id),
      ["parent", "live", ...recent],
    );
    assert.deepEqual(withoutOld?.olderSettled?.counts, [
      { projectId: ProjectId.make("project"), count: 1 },
    ]);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

// Build the production RPC layer; unrelated capabilities fail if this test calls them.
const layerUnusedConfigRpcServices = Layer.mergeAll(
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(TriageService.TriageService)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(NativeChildWorkQuery.NativeChildWorkQuery)({}),
  Layer.mock(CommandOutputHub.CommandOutputHub)({}),
  Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
  Layer.mock(PairingGrantStore.PairingGrantStore)({}),
  Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(SecretResolver.SecretResolver)({}),
  Layer.mock(GuestShareService.GuestShareService)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(SpaceDirectory.SpaceDirectory)({}),
  Layer.mock(SessionStore.SessionStore)({ cookieName: "config-test", legacyCookieName: undefined }),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(SourceControlSignIn.SourceControlSignIn)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(DatabaseStorage.DatabaseStorage)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(UsageService.UsageService)({}),
  Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
  Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
);

const layerConfigSources = Layer.mergeAll(
  Keybindings.layer,
  AssetSigner.layer.pipe(Layer.provide(ServerSecretStore.layer)),
  ServerSettings.layer.pipe(
    Layer.provide(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layerTest())),
  ),
).pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(
      ServerConfigModule.layerTest(process.cwd(), { prefix: "t3-config-subscription-test-" }),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
// Tests not about Spaces read as the Owner.
const layerOwnerConfigSources = Layer.merge(layerConfigSources, layerSeesEverything);

it.effect.each([
  "pending",
  "cached",
  "direct-pending",
  "direct-cached",
  "direct-failed",
  "direct-interrupted",
] as const)(
  "%s endpoint discovery preserves initial config and updates through discovery and ACK",
  (discovery) =>
    Effect.gen(function* () {
      const keybindings = yield* Keybindings.Keybindings;
      const settings = yield* ServerSettings.ServerSettingsService;
      const keybindingsSubscribed = yield* Deferred.make<void>();
      const settingsSubscribed = yield* Deferred.make<void>();
      const keybindingsChanges = keybindings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(keybindingsSubscribed, undefined)),
      );
      const settingsChanges = settings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(settingsSubscribed, undefined)),
      );
      const initialKeybindings = (yield* keybindings.getSnapshot).keybindings;
      const discoveryStarted = yield* Deferred.make<void>();
      const finishDiscovery = yield* Deferred.make<void>();
      const remoteDiscoveryStarted = yield* Deferred.make<void>();
      const finishRemoteDiscovery = yield* Deferred.make<void>();
      const targets = [{ kind: "mdns" as const, host: "test.local" }];
      const direct = discovery.startsWith("direct-");
      const bound = [{ kind: "lan" as const, httpBaseUrl: "http://192.168.1.10:3773/" }];
      const endpoints = [
        ...bound,
        { kind: "tailnet" as const, httpBaseUrl: "https://test.ts.net/" },
      ];
      const directStarted = yield* Deferred.make<void>();
      const finishDirect = yield* Deferred.make<void>();
      const directStopped = yield* Deferred.make<void>();
      const responses = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const configRpcServices = Layer.mergeAll(
        layerUnusedConfigRpcServices,
        Layer.mock(ExternalLauncher.ExternalLauncher)({
          resolveAvailableEditors: () =>
            Deferred.succeed(discoveryStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishDiscovery)),
              Effect.as([]),
            ),
          resolveFileManagerRevealKind: () => Effect.undefined,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          streamChanges: Stream.never,
        }),
        Layer.mock(UsageLimitSources.UsageLimitSources)({ streamChanges: Stream.make([]) }),
        Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
          resolveTargets: () =>
            Deferred.succeed(remoteDiscoveryStarted, undefined).pipe(
              Effect.andThen(
                discovery === "cached" || direct
                  ? Effect.void
                  : Deferred.await(finishRemoteDiscovery),
              ),
              Effect.as(targets),
            ),
        }),
        Layer.mock(DirectEndpoints.DirectEndpoints)({
          resolveAvailable: () => Effect.succeed(discovery === "direct-cached" ? endpoints : bound),
          resolve: () =>
            direct
              ? Deferred.succeed(directStarted, undefined).pipe(
                  Effect.andThen(
                    discovery === "direct-cached" ? Effect.void : Deferred.await(finishDirect),
                  ),
                  Effect.andThen(
                    discovery === "direct-failed"
                      ? Effect.die("probe failed")
                      : Effect.succeed(endpoints),
                  ),
                  Effect.onExit(() => Deferred.succeed(directStopped, undefined)),
                )
              : Effect.succeed(bound),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          scratchRoot: Effect.succeedNone,
          namedProjectsRoot: process.cwd(),
        }),
        Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("config-test"),
            label: "Config test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          getDescriptor: () =>
            Effect.succeed({
              policy: "loopback-browser",
              bootstrapMethods: [],
              sessionMethods: ["browser-session-cookie"],
              sessionCookieName: "config-test-session",
            }),
        }),
        // Signal subscription on either accessor so the test also fails, rather
        // than hangs, against a handler that subscribes after the snapshot.
        Layer.succeed(Keybindings.Keybindings, {
          ...keybindings,
          streamChanges: Stream.unwrap(keybindingsChanges),
          subscribeChanges: keybindingsChanges,
        }),
        Layer.succeed(ServerSettings.ServerSettingsService, {
          ...settings,
          streamChanges: Stream.unwrap(settingsChanges),
          subscribeChanges: settingsChanges,
        }),
      );
      const server = yield* RpcServer.makeNoSerialization(
        RpcGroup.make(WsSubscribeServerConfigRpc),
        {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) =>
            response._tag === "Chunk"
              ? Effect.forEach(response.values, (event) => Queue.offer(responses, event), {
                  discard: true,
                })
              : Effect.void,
        },
      ).pipe(
        Effect.provide(
          layerWsRpc(yield* ServerBrowser.ServerBrowser, () => Effect.void, {
            secretReferences: true,
          }).pipe(
            Layer.provide(configRpcServices),
            Layer.provide(
              CurrentPrincipal.layer({
                sessionId: AuthSessionId.make("config-test"),
                subject: "config-test",
                method: "browser-session-cookie",
                scopes: [],
              }),
            ),
          ),
        ),
      );
      const requestId = RpcMessage.RequestId("config");
      const acknowledge = server.write(0, { _tag: "Ack", requestId });
      yield* server.write(0, {
        _tag: "Request",
        id: requestId,
        tag: WS_METHODS.subscribeServerConfig,
        payload: {},
        headers: Headers.empty,
      });
      yield* Deferred.await(discoveryStarted);
      assert.isTrue(yield* Deferred.isDone(remoteDiscoveryStarted));

      const duringDiscovery = yield* settings.updateSettings({ defaultAutoPull: true });
      yield* Deferred.succeed(finishDiscovery, undefined);
      const snapshot = yield* Queue.take(responses);
      assert.equal(snapshot.type, "snapshot");
      if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
      assert.deepEqual(
        snapshot.config.remoteOpenTargets,
        discovery === "cached" || direct ? targets : [],
      );
      assert.deepEqual(
        snapshot.config.directEndpoints,
        discovery === "direct-cached" ? endpoints : bound,
      );
      assert.isFalse(snapshot.config.settings.defaultAutoPull);
      assert.deepEqual(snapshot.config.keybindings, initialKeybindings);
      const duringAck = yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+y",
        command: "terminal.toggle",
      });
      yield* acknowledge;
      yield* Deferred.await(keybindingsSubscribed);
      yield* Deferred.await(settingsSubscribed);

      // Later updates expose a dropped buffered event as a value mismatch, not a timeout.
      const latestSettings = yield* settings.updateSettings({ enableProviderUpdateChecks: false });
      const latestKeybindings = yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+z",
        command: "terminal.split",
      });
      const expectedSettings = [duringDiscovery, latestSettings].map((value) =>
        ServerSettings.redactServerSettingsForClient(value, { secretReferences: true }),
      );
      const expectedKeybindings = [duringAck.keybindings, latestKeybindings.keybindings];
      // The two sources can interleave, but each must retain its own publication order.
      for (let i = 0; i < 4; i++) {
        const event = yield* Queue.take(responses);
        if (event.type === "settingsUpdated") {
          assert.deepEqual(event.payload.settings, expectedSettings.shift());
        } else {
          assert.equal(event.type, "keybindingsUpdated");
          if (event.type !== "keybindingsUpdated")
            return yield* Effect.die("Unexpected config event");
          assert.deepEqual(event.payload.keybindings, expectedKeybindings.shift());
          assert.deepEqual(event.payload.issues, []);
        }
        yield* acknowledge;
      }
      assert.isEmpty(expectedSettings);
      assert.isEmpty(expectedKeybindings);
      if (discovery === "pending") {
        yield* Deferred.await(remoteDiscoveryStarted);
        yield* Deferred.succeed(finishRemoteDiscovery, undefined);
        const resolved = yield* Queue.take(responses);
        assert.equal(resolved.type, "snapshot");
        if (resolved.type !== "snapshot") return yield* Effect.die("Missing remote targets");
        assert.deepEqual(resolved.config.remoteOpenTargets, targets);
        assert.deepEqual(
          resolved.config.settings,
          ServerSettings.redactServerSettingsForClient(latestSettings, { secretReferences: true }),
        );
        assert.deepEqual(resolved.config.keybindings, latestKeybindings.keybindings);
        yield* acknowledge;
      }
      if (direct) {
        yield* Deferred.await(directStarted);
        if (discovery === "direct-pending") {
          yield* Deferred.succeed(finishDirect, undefined);
          const resolved = yield* Queue.take(responses);
          assert.equal(resolved.type, "snapshot");
          if (resolved.type !== "snapshot") return yield* Effect.die("Missing direct endpoints");
          assert.deepEqual(resolved.config.directEndpoints, endpoints);
          assert.deepEqual(
            resolved.config.settings,
            ServerSettings.redactServerSettingsForClient(latestSettings, {
              secretReferences: true,
            }),
          );
          assert.deepEqual(resolved.config.keybindings, latestKeybindings.keybindings);
          yield* acknowledge;
        } else if (discovery === "direct-failed") {
          yield* Deferred.succeed(finishDirect, undefined);
          yield* Deferred.await(directStopped);
          yield* settings.updateSettings({ defaultAutoPull: false });
          const event = yield* Queue.take(responses);
          assert.equal(event.type, "settingsUpdated");
          yield* acknowledge;
        }
      }
      yield* server.write(0, { _tag: "Interrupt", requestId, interruptors: [] });
      if (direct) yield* Deferred.await(directStopped);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerOwnerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
      Effect.scoped,
    ),
);

it.effect("on-demand clients get provider config without workspace snapshots", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const snapshotFor = (cwd: string, checkedAt: string) => ({
      cwd,
      checkedAt,
      slashCommands: [{ name: `${cwd.slice(1)}-command` }],
      skills: [],
    });
    const provider: ServerProvider = {
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-25T00:00:00.000Z",
      models: [],
      slashCommands: [{ name: "machine-command" }],
      skills: [],
      workspaceSnapshots: [
        snapshotFor("/a", "2026-10-25T00:00:00.000Z"),
        snapshotFor("/b", "2026-10-25T00:00:00.000Z"),
      ],
    };
    const providerChanges = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
    const pulled = yield* Queue.unbounded<void>();
    const responses = yield* Queue.unbounded<unknown>();
    const configRpcServices = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(ExternalLauncher.ExternalLauncher)({
        resolveAvailableEditors: () => Effect.succeed([]),
        resolveFileManagerRevealKind: () => Effect.undefined,
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([provider]),
        streamChanges: Stream.fromQueue(providerChanges).pipe(
          Stream.tap(() => Queue.offer(pulled, undefined)),
        ),
        refreshWorkspaceSnapshot: () => Effect.succeed([provider]),
      }),
      Layer.mock(UsageLimitSources.UsageLimitSources)({
        current: Effect.succeed([]),
        streamChanges: Stream.make([]),
      }),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
        resolveTargets: () => Effect.succeed([]),
      }),
      Layer.mock(DirectEndpoints.DirectEndpoints)({
        resolve: () => Effect.succeed([]),
        resolveAvailable: () => Effect.succeed([]),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        scratchRoot: Effect.succeedNone,
        namedProjectsRoot: process.cwd(),
      }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("config-test"),
          label: "Config test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        getDescriptor: () =>
          Effect.succeed({
            policy: "loopback-browser",
            bootstrapMethods: [],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "config-test-session",
          }),
      }),
    );
    const server = yield* RpcServer.makeNoSerialization(
      RpcGroup.make(WsSubscribeServerConfigRpc, WsServerRefreshProvidersRpc),
      {
        ...WS_RPC_SERVER_OPTIONS,
        onFromServer: (response) =>
          response._tag === "Chunk"
            ? Effect.forEach(response.values, (value) => Queue.offer(responses, value), {
                discard: true,
              })
            : response._tag === "Exit" && response.exit._tag === "Success"
              ? Queue.offer(responses, response.exit.value)
              : Effect.void,
      },
    ).pipe(
      Effect.provide(
        layerWsRpc(yield* ServerBrowser.ServerBrowser, () => Effect.void, {
          secretReferences: true,
        }).pipe(
          Layer.provide(configRpcServices),
          Layer.provide(
            CurrentPrincipal.layer({
              sessionId: AuthSessionId.make("config-test"),
              subject: "config-test",
              method: "browser-session-cookie",
              scopes: [],
            }),
          ),
        ),
      ),
    );
    const configRequest = RpcMessage.RequestId("config");
    yield* server.write(0, {
      _tag: "Request",
      id: configRequest,
      tag: WS_METHODS.subscribeServerConfig,
      payload: { workspaceSnapshotsOnDemand: true },
      headers: Headers.empty,
    });
    const snapshot = (yield* Queue.take(responses)) as ServerConfigStreamEvent;
    if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
    assert.isUndefined(snapshot.config.providers[0]?.workspaceSnapshots);
    yield* server.write(0, { _tag: "Ack", requestId: configRequest });

    // A rescan that only touches a snapshot sends nothing; the next real change does.
    yield* Queue.offer(providerChanges, [
      { ...provider, workspaceSnapshots: [snapshotFor("/a", "2026-10-25T00:05:00.000Z")] },
    ]);
    yield* Queue.take(pulled);
    yield* TestClock.adjust("1 second");
    yield* Queue.offer(providerChanges, [{ ...provider, status: "warning" }]);
    yield* Queue.take(pulled);
    yield* TestClock.adjust("1 second");
    const update = (yield* Queue.take(responses)) as ServerConfigStreamEvent;
    if (update.type !== "providerStatuses") return yield* Effect.die("Expected provider update");
    assert.equal(update.payload.providers[0]?.status, "warning");
    assert.isUndefined(update.payload.providers[0]?.workspaceSnapshots);

    yield* server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId("refresh"),
      tag: WS_METHODS.serverRefreshProviders,
      payload: { instanceId, cwd: "/b", workspaceSnapshotsOnDemand: true },
      headers: Headers.empty,
    });
    const refreshed = (yield* Queue.take(responses)) as {
      readonly providers: ReadonlyArray<ServerProvider>;
    };
    assert.deepEqual(
      refreshed.providers.map((entry) => [entry.workspaceSnapshots, entry.slashCommands]),
      [[[snapshotFor("/b", "2026-10-25T00:00:00.000Z")], []]],
    );
    yield* server.write(0, { _tag: "Interrupt", requestId: configRequest, interruptors: [] });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerOwnerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
    Effect.scoped,
  ),
);

// Pruned history cannot be replayed: a cursor below the boundary must resync from a snapshot.
it.effect.each(["thread", "shell"] as const)(
  "%s resume from a cursor below the pruned boundary loads a snapshot",
  (scope) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-10-13T00:00:00.000Z";
      const threadId = ThreadId.make("thread:pruned");
      const insert = (version: number) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`pruned:${version}`}, 'thread', ${threadId}, ${version}, 'provider-session.detached',
          ${now}, 'server', ${JSON.stringify({ providerSessionId: "session:pruned", detachedAt: now })},
          '{}', 2
        ) RETURNING sequence
      `;
      const [first] = yield* insert(0);
      const [second] = yield* insert(1);
      yield* insert(2);
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata (
          projection_name, schema_version, last_sequence, updated_at
        ) VALUES (${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}, 2, ${second!.sequence}, ${now})
      `;
      const subscription = Effect.gen(function* () {
        const stream =
          scope === "thread"
            ? yield* subscribeOrchestrationV2Thread({ threadId, afterSequence: first!.sequence })
            : yield* subscribeOrchestrationV2Shell({ afterSequence: first!.sequence });
        return stream;
      });
      const exit = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getThreadSnapshot: () => Effect.die("snapshot"),
          listActiveShellIndex: () => Effect.die("snapshot"),
          readShellSnapshot: () => Effect.die("snapshot"),
          listActiveSubagentThreadIds: () => Effect.die("replay"),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(
          ProjectService.ProjectService,
          {} as ProjectService.ProjectService["Service"],
        ),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(yield* PubSub.unbounded()),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
        Effect.exit,
      );
      assert.deepEqual(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit, "snapshot");
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

// A prune pass can delete replayed rows after the boundary check; the read must not be trusted.
it.effect.each(["thread", "shell"] as const)(
  "%s resume loads a snapshot when pruning advances during the replay read",
  (scope) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-10-13T00:00:00.000Z";
      const threadId = ThreadId.make("thread:prune-race");
      const insert = (version: number) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`prune-race:${version}`}, 'thread', ${threadId}, ${version}, 'provider-session.detached',
          ${now}, 'server', ${JSON.stringify({ providerSessionId: "session:race", detachedAt: now })},
          '{}', 2
        ) RETURNING sequence
      `;
      const [first] = yield* insert(0);
      const [second] = yield* insert(1);
      yield* insert(2);

      const readStarted = yield* Deferred.make<void>();
      const releaseRead = yield* Deferred.make<void>();
      let gated = false;
      const gateReplayRead: Statement.Transformer = (statement) => {
        const [query] = statement.compile();
        // The paged replay read (readApplicationRows), not the stats or high-water queries.
        if (!gated && /^\s*SELECT\s+sequence,\s+event_id,/.test(query)) {
          gated = true;
          return Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRead)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      };
      const subscription = Effect.gen(function* () {
        const stream =
          scope === "thread"
            ? yield* subscribeOrchestrationV2Thread({ threadId, afterSequence: first!.sequence })
            : yield* subscribeOrchestrationV2Shell({ afterSequence: first!.sequence });
        return stream;
      }).pipe(
        Effect.provideService(Statement.CurrentTransformer, gateReplayRead),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getThreadSnapshot: () => Effect.die("snapshot"),
          listActiveShellIndex: () => Effect.die("snapshot"),
          readShellSnapshot: () => Effect.die("snapshot"),
          listActiveSubagentThreadIds: () => Effect.succeed([]),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(
          ProjectService.ProjectService,
          {} as ProjectService.ProjectService["Service"],
        ),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(yield* PubSub.unbounded()),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
        Effect.exit,
        Effect.forkChild,
      );
      const fiber = yield* subscription;
      yield* Deferred.await(readStarted);
      // A pass publishes its boundary, then deletes the rows it covers.
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata (
          projection_name, schema_version, last_sequence, updated_at
        ) VALUES (${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}, 2, ${second!.sequence}, ${now})
      `;
      yield* sql`DELETE FROM orchestration_events WHERE sequence = ${second!.sequence}`;
      yield* Deferred.succeed(releaseRead, undefined);
      const exit = yield* Fiber.join(fiber);
      assert.deepEqual(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit, "snapshot");
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

// A thread idle since before the boundary missed nothing; resuming must not resend its body.
it.effect("thread resume at its own high-water below the pruned boundary skips the snapshot", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-10-13T00:00:00.000Z";
    const threadId = ThreadId.make("thread:idle");
    const [last] = yield* sql<{ sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        'idle:0', 'thread', ${threadId}, 0, 'provider-session.detached',
        ${now}, 'server', ${JSON.stringify({ providerSessionId: "session:idle", detachedAt: now })},
        '{}', 2
      ) RETURNING sequence
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_metadata (
        projection_name, schema_version, last_sequence, updated_at
      ) VALUES (${OrchestrationEventStore.EVENT_LOG_PRUNED_THROUGH}, 2, ${last!.sequence + 10}, ${now})
    `;
    const exit = yield* subscribeOrchestrationV2Thread({
      threadId,
      afterSequence: last!.sequence,
    }).pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        getThreadSnapshot: () => Effect.die("snapshot"),
        streamStoredEventsFrom: () => Stream.empty,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Effect.exit,
    );
    // A snapshot load dies with "snapshot", so success means the resume replayed nothing.
    assert.isTrue(Exit.isSuccess(exit));
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("sends a new Thread on as the session's User, whatever owner the client names", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2Command> = [];
    const exits = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
    const rpcServices = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: process.cwd(),
      }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({}),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
        enqueueCommand: (effect) => effect,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command as OrchestrationV2Command);
            return { sequence: dispatched.length, storedEvents: [] } as never;
          }),
      }),
    );
    const dispatchRpc = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand)!;
    const server = yield* RpcServer.makeNoSerialization(RpcGroup.make(dispatchRpc), {
      ...WS_RPC_SERVER_OPTIONS,
      onFromServer: (response) =>
        response._tag === "Exit" ? Queue.offer(exits, response.exit) : Effect.void,
    }).pipe(
      Effect.provide(
        layerWsRpc(yield* ServerBrowser.ServerBrowser, () => Effect.void, {
          secretReferences: true,
        }).pipe(
          Layer.provideMerge(RpcAuthorization.layer),
          Layer.provide(rpcServices),
          Layer.provide(
            CurrentPrincipal.layer({
              sessionId: AuthSessionId.make("member-session"),
              subject: "user-sign-in",
              userId: UserId.make("member-1"),
              method: "browser-session-cookie",
              scopes: [AuthOrchestrationOperateScope],
            }),
          ),
        ),
      ),
    );
    const createThread = Effect.fn(function* (id: string, extra: Record<string, unknown>) {
      yield* server.write(0, {
        _tag: "Request",
        id: RpcMessage.RequestId(id),
        tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        payload: {
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:${id}`),
          threadId: ThreadId.make(`thread:${id}`),
          projectId: ProjectId.make("project:scratch"),
          title: "Hello",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          ...extra,
        },
        headers: Headers.empty,
      });
      return yield* Queue.take(exits);
    });

    const accepted = yield* createThread("acme", { spaceId: "org-acme", ownerUserId: "owner" });
    assert.isTrue(Exit.isSuccess(accepted));
    const created = dispatched[0];
    assert.equal(created?.type, "thread.create");
    if (created?.type !== "thread.create") return;
    assert.deepEqual([created.spaceId, created.ownerUserId], ["org-acme", "member-1"]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerOwnerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
    Effect.scoped,
  ),
);

describe("Space visibility", () => {
  const PASSWORD = "correct horse battery";
  const read = [
    ORCHESTRATION_V2_WS_METHODS.subscribeShell,
    ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
    ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds,
    ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    WS_METHODS.pullRequestsList,
    WS_METHODS.scheduledTasksSubscribe,
    WS_METHODS.subscribeTerminalMetadata,
    WS_METHODS.terminalWrite,
    WS_METHODS.terminalOpen,
    WS_METHODS.projectsReadFile,
    WS_METHODS.projectsWriteFile,
    WS_METHODS.mcpAppsCallTool,
    WS_METHODS.mcpAppsUpdateModelContext,
    WS_METHODS.secretsAnswerRequest,
    ORCHESTRATION_V2_WS_METHODS.forceStopThread,
  ] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, (typeof read)[number]> =>
        !(read as ReadonlyArray<string>).includes(tag),
    ),
  );

  const threadCreated = (input: {
    readonly id: string;
    readonly projectId: string;
    readonly spaceId?: string;
    readonly ownerUserId?: string;
    readonly worktreePath?: string;
  }) => {
    const id = ThreadId.make(input.id);
    const at = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const payload: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id,
      projectId: ProjectId.make(input.projectId),
      title: input.id,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: input.worktreePath ?? "/wt/shared",
      activeProviderThreadId: null,
      ...(input.spaceId === undefined ? {} : { spaceId: SpaceId.make(input.spaceId) }),
      ...(input.ownerUserId === undefined ? {} : { ownerUserId: UserId.make(input.ownerUserId) }),
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return {
      id: EventId.make(`create-${input.id}`),
      type: "thread.created" as const,
      threadId: id,
      providerInstanceId,
      occurredAt: at,
      payload,
    };
  };

  /** The Owner with Acme (Grace is a Member) and Globex (Linus is a Member), work in each. */
  const hub = Effect.gen(function* () {
    const server = yield* serveAuthHttp;
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const owner = created.cookie ?? "";
    const organization = (name: string) =>
      server
        .request("/api/spaces/organizations", { body: { name }, cookie: owner })
        .pipe(Effect.map((response) => response.body.id as string));
    const acme = yield* organization("Acme");
    const globex = yield* organization("Globex");
    const member = Effect.fn(function* (spaceId: string, loginName: string) {
      const invitation = yield* server.request(`/api/spaces/${spaceId}/invitations`, {
        body: { role: "member" },
        cookie: owner,
      });
      const accepted = yield* server.request("/api/invitations/accept", {
        body: {
          token: invitation.body.token,
          method: "password",
          displayName: loginName,
          loginName,
          password: PASSWORD,
        },
      });
      const [row] = yield* server.sql<{ userId: string }>`
        SELECT user_id AS "userId" FROM users WHERE display_name = ${loginName}
      `;
      return { cookie: accepted.cookie ?? "", userId: UserId.make(row!.userId) };
    });
    const grace = yield* member(acme, "grace");
    const linus = yield* member(globex, "linus");
    const project = (id: string, spaceId: string) =>
      server.request("/api/projects/mutate", {
        cookie: owner,
        body: {
          type: "project.create",
          commandId: `create-${id}`,
          projectId: id,
          title: id,
          workspaceRoot: `/work/${id}`,
          spaceId,
        },
      });
    assert.equal((yield* project("acme-app", acme)).status, 200);
    assert.equal((yield* project("globex-app", globex)).status, 200);
    // A Project from before Spaces: the Owner's Personal space.
    yield* server.sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('legacy-app', 'legacy-app', '/work/legacy', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `;
    yield* server.eventSink.write({
      events: [
        threadCreated({ id: "acme-thread", projectId: "acme-app", spaceId: acme }),
        // Unstamped (like an agent's child): it follows its Project's Space.
        threadCreated({ id: "acme-child", projectId: "acme-app" }),
        threadCreated({ id: "globex-thread", projectId: "globex-app", spaceId: globex }),
        threadCreated({ id: "legacy-thread", projectId: "legacy-app" }),
      ],
    });
    return { server, owner, acme, globex, grace, linus };
  });

  // The production RPC layer and authorization middleware for one connection of this User.
  const connect = Effect.fn(function* (
    server: Effect.Success<typeof serveAuthHttp>,
    userId: UserId | undefined,
    overrides: Layer.Layer<never> = Layer.empty,
  ) {
    const browser = yield* ServerBrowser.ServerBrowser;
    return yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          layerWsRpc(browser, () => Effect.void, { secretReferences: true }),
          RpcAuthorization.layer,
        ).pipe(
          Layer.provideMerge(SpaceVisibility.layerCurrentViewer),
          Layer.provideMerge(
            CurrentPrincipal.layer({
              sessionId: AuthSessionId.make(`session-${userId}`),
              subject: "user-sign-in",
              ...(userId === undefined ? {} : { userId }),
              method: "browser-session-cookie",
              scopes: [
                AuthOrchestrationReadScope,
                AuthOrchestrationOperateScope,
                AuthTerminalReadScope,
                AuthTerminalOperateScope,
                AuthFilesystemReadScope,
                AuthFilesystemWriteScope,
              ],
            }),
          ),
          Layer.provide(
            Layer.mergeAll(
              layerUnusedConfigRpcServices,
              Layer.mock(ExternalLauncher.ExternalLauncher)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              Layer.mock(UsageLimitSources.UsageLimitSources)({}),
              Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
              Layer.mock(DirectEndpoints.DirectEndpoints)({}),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: process.cwd(),
              }),
              Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
              Layer.mock(ServerEnvironment.ServerEnvironment)({}),
              Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
              Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
              // The real Spaces, Projects and Thread reads over the hub's database.
              Layer.succeedContext(server.services),
              overrides,
            ),
          ),
        ),
      ),
    );
  });

  const shellIds = (snapshot: {
    readonly projects: ReadonlyArray<{ readonly id: string }>;
    readonly threads: ReadonlyArray<{ readonly id: string }>;
  }) => ({
    projects: snapshot.projects.map((project) => project.id).toSorted(),
    threads: snapshot.threads.map((thread) => thread.id).toSorted(),
  });

  // Live: the shell tail batches deltas on a wall-clock window.
  it.live(
    "each User sees only their Spaces' work in snapshots, live deltas, RPCs, HTTP and MCP",
    () =>
      Effect.gen(function* () {
        const { server, owner, globex, grace, linus } = yield* hub;
        const acmeWork = { projects: ["acme-app"], threads: ["acme-child", "acme-thread"] };

        // HTTP: the shell, the project list, and a single Thread.
        const httpShell = (cookie: string) =>
          server
            .request("/api/orchestration/shell", { cookie })
            .pipe(Effect.map((response) => shellIds(response.body as never)));
        assert.deepEqual(yield* httpShell(grace.cookie), acmeWork);
        assert.deepEqual(yield* httpShell(linus.cookie), {
          projects: ["globex-app"],
          threads: ["globex-thread"],
        });
        assert.deepEqual(yield* httpShell(owner), {
          projects: ["acme-app", "globex-app", "legacy-app"],
          threads: ["acme-child", "acme-thread", "globex-thread", "legacy-thread"],
        });
        const projects = yield* server.request("/api/projects", { cookie: grace.cookie });
        assert.deepEqual(
          (projects.body.projects as ReadonlyArray<{ id: string }>).map((project) => project.id),
          ["acme-app"],
        );
        const hidden = yield* server.request("/api/orchestration/threads/globex-thread", {
          cookie: grace.cookie,
        });
        const missing = yield* server.request("/api/orchestration/threads/no-such-thread", {
          cookie: grace.cookie,
        });
        assert.equal(hidden.status, 404);
        const { traceId: _hiddenTrace, ...hiddenBody } = hidden.body;
        const { traceId: _missingTrace, ...missingBody } = missing.body;
        assert.deepEqual([hidden.status, hiddenBody], [missing.status, missingBody]);

        // WebSocket: the shell snapshot, then live deltas.
        const client = yield* connect(server, grace.userId);
        const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
          requestCompletionMarker: true,
        }).pipe(
          Stream.runForEach((item) => Queue.offer(items, item)),
          Effect.forkScoped,
        );
        const first = yield* Queue.take(items);
        assert.equal(first.kind, "snapshot");
        if (first.kind !== "snapshot") return;
        assert.deepEqual(shellIds(first.snapshot), acmeWork);
        // Enrichment refreshes may follow; they name only visible Projects too.
        for (let item = yield* Queue.take(items); item.kind !== "synchronized";) {
          if (item.kind === "snapshot") {
            for (const project of item.snapshot.projects) assert.equal(project.id, "acme-app");
          }
          item = yield* Queue.take(items);
        }
        // Globex's new Thread comes first in the log; Grace's stream must skip it.
        yield* server.eventSink.write({
          events: [
            threadCreated({ id: "globex-late", projectId: "globex-app", spaceId: globex }),
            threadCreated({ id: "acme-late", projectId: "acme-app" }),
          ],
        });
        const seen: Array<string> = [];
        while (!seen.includes("acme-late")) {
          const item = yield* Queue.take(items);
          if (item.kind === "thread.updated") seen.push(item.thread.id);
          if (item.kind === "thread.removed") seen.push(item.threadId);
          if (item.kind === "project.updated") seen.push(item.project.id);
        }
        assert.deepEqual(seen, ["acme-late"]);

        // A single-resource read of a hidden Thread fails exactly like a missing one.
        const projection = (threadId: string) =>
          client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: ThreadId.make(threadId),
          }).pipe(Effect.flip);
        const hiddenRpc = yield* projection("globex-thread");
        assert.equal(hiddenRpc._tag, "SpaceResourceNotFoundError");
        assert.deepEqual(hiddenRpc, yield* projection("no-such-thread"));
        const worktreeThreads = client[ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds]({
          worktreePath: "/wt/shared",
        }).pipe(Effect.map(({ threadIds }) => [...threadIds].toSorted()));
        assert.deepEqual(yield* worktreeThreads, ["acme-child", "acme-late", "acme-thread"]);

        // Joining Globex shows its work on the same connection.
        const spaces = Context.get(server.services, SpaceDirectory.SpaceDirectory);
        yield* spaces.addMembership({
          spaceId: SpaceId.make(globex),
          userId: grace.userId,
          role: "member",
        });
        yield* spaces.changed;
        assert.deepEqual(yield* worktreeThreads, [
          "acme-child",
          "acme-late",
          "acme-thread",
          "globex-late",
          "globex-thread",
        ]);

        // MCP: a caller with no User reads as the Owner; one acting as Linus reads as Linus.
        const shells = (yield* Context.get(
          server.services,
          ThreadManagement.ThreadManagementService,
        ).getShellSnapshot()).threads;
        const mcpRead = (scope: { readonly userId?: UserId }) =>
          visibleShells(scope, shells).pipe(
            Effect.map((visible) => visible.map((shell) => shell.id).toSorted()),
            Effect.provide(Layer.succeedContext(server.services)),
          );
        assert.deepEqual(yield* mcpRead({}), [
          "acme-child",
          "acme-late",
          "acme-thread",
          "globex-late",
          "globex-thread",
          "legacy-thread",
        ]);
        assert.deepEqual(yield* mcpRead({ userId: linus.userId }), [
          "globex-late",
          "globex-thread",
        ]);

        // A Pull Request diff in a hidden Project answers like one in a missing Project.
        const diff = (projectId: string) =>
          server.request("/api/pull-requests/diff", {
            cookie: grace.cookie,
            body: { projectId, repository: "acme/app", number: 1 },
          });
        // Grace now sees Globex; the Owner's Personal space stays hidden from her.
        const hiddenDiff = yield* diff("legacy-app");
        const missingDiff = yield* diff("no-such-project");
        assert.equal(hiddenDiff.body._tag, "PullRequestUnavailableError");
        const { traceId: _hiddenDiffTrace, ...hiddenDiffBody } = hiddenDiff.body;
        const { traceId: _missingDiffTrace, ...missingDiffBody } = missingDiff.body;
        assert.deepEqual(
          [hiddenDiff.status, hiddenDiffBody],
          [missingDiff.status, missingDiffBody],
        );

        // An agent that pastes a bare id is pointed at the `mcp:` Thread only if it may see it.
        yield* server.eventSink.write({
          events: [threadCreated({ id: "mcp:hint", projectId: "legacy-app" })],
        });
        const hint = (scope: { readonly userId?: UserId }) =>
          threadNotFound(
            Context.get(server.services, ThreadManagement.ThreadManagementService),
            ThreadId.make("hint"),
            "Not found.",
          ).pipe(
            Effect.flip,
            Effect.map((failure) => failure.message),
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope as never),
            Effect.provide(Layer.succeedContext(server.services)),
          );
        assert.equal(yield* hint({}), "Not found. Did you mean `mcp:hint`?");
        assert.equal(yield* hint({ userId: grace.userId }), "Not found.");

        // An archived Organization disappears for its Members, not for the Owner.
        yield* server.sql`
          UPDATE spaces SET archived_at = '2026-11-02T00:00:00.000Z' WHERE space_id = ${globex}
        `;
        assert.deepEqual(yield* httpShell(linus.cookie), { projects: [], threads: [] });
        assert.include((yield* httpShell(owner)).projects, "globex-app");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            Layer.fresh(layerConfigSources),
            Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
            Layer.mock(ServerBrowser.ServerBrowser)({}),
          ),
        ),
      ),
  );

  const withHub = <A, E, R>(body: (seeded: Effect.Success<typeof hub>) => Effect.Effect<A, E, R>) =>
    hub.pipe(
      Effect.flatMap(body),
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
    );

  // Live: the shell tail batches deltas on a wall-clock window.
  it.live(
    "removing a Member closes their sockets, and their shell resumes without the Organization",
    () =>
      Effect.gen(function* () {
        const { server, owner, acme, grace } = yield* hub;
        const graceAgain = yield* server.request("/api/auth/password/sign-in", {
          body: { loginName: "grace", password: PASSWORD },
        });
        // A second Member of Acme, whose access does not change.
        const invitation = yield* server.request(`/api/spaces/${acme}/invitations`, {
          body: { role: "member" },
          cookie: owner,
        });
        yield* server.request("/api/invitations/accept", {
          body: {
            token: invitation.body.token,
            method: "password",
            displayName: "hedy",
            loginName: "hedy",
            password: PASSWORD,
          },
        });
        const [hedyRow] = yield* server.sql<{ userId: string }>`
        SELECT user_id AS "userId" FROM users WHERE display_name = 'hedy'
      `;
        const hedy = UserId.make(hedyRow!.userId);
        const sessionOf = Effect.fn(function* (userId: UserId) {
          const [row] = yield* server.sql<{ sessionId: string }>`
          SELECT session_id AS "sessionId" FROM auth_sessions
          WHERE user_id = ${userId} AND revoked_at IS NULL LIMIT 1
        `;
          return {
            sessionId: AuthSessionId.make(row!.sessionId),
            subject: "user-sign-in",
            userId,
            method: "browser-session-cookie" as const,
            scopes: [],
          };
        });
        const socketEnds = (userId: UserId) =>
          sessionOf(userId).pipe(
            Effect.flatMap(connectionEnds),
            Effect.provide(Layer.succeedContext(server.services)),
          );
        const graceSocket = yield* (yield* socketEnds(grace.userId)).pipe(Effect.forkScoped);
        const hedySocket = yield* (yield* socketEnds(hedy)).pipe(Effect.forkScoped);

        const firstShell = Effect.fn(function* (
          userId: UserId,
          input: { readonly afterSequence?: number },
        ) {
          const client = yield* connect(server, userId);
          const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
          yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
            ...input,
            requestCompletionMarker: true,
          }).pipe(
            Stream.runForEach((item) => Queue.offer(items, item)),
            Effect.forkScoped,
          );
          return yield* Queue.take(items);
        });
        const before = yield* firstShell(grace.userId, {});
        assert.equal(before.kind, "snapshot");
        if (before.kind !== "snapshot") return;
        assert.deepEqual(shellIds(before.snapshot), {
          projects: ["acme-app"],
          threads: ["acme-child", "acme-thread"],
        });

        // A change to the Role someone already has changes nothing, so their sockets stay.
        const unchanged = yield* server.request(`/api/spaces/${acme}/members/role`, {
          body: { userId: hedy, role: "member" },
          cookie: owner,
        });
        assert.equal(unchanged.status, 200);
        const removed = yield* server.request(`/api/spaces/${acme}/members/remove`, {
          body: { userId: grace.userId },
          cookie: owner,
        });
        assert.equal(removed.status, 200);
        // Every socket of hers closes, whichever browser opened it; Hedy's stays open.
        yield* Fiber.join(graceSocket);
        assert.isUndefined(hedySocket.pollUnsafe());
        assert.equal(yield* isSignedIn(server, graceAgain.cookie), true);

        // Reconnecting from where her shell was, she gets a fresh snapshot without Acme.
        const resumed = yield* firstShell(grace.userId, {
          afterSequence: before.snapshot.snapshotSequence,
        });
        assert.equal(resumed.kind, "snapshot");
        if (resumed.kind !== "snapshot") return;
        assert.isUndefined(resumed.resolvedRepositoryIdentityRoots);
        assert.deepEqual(shellIds(resumed.snapshot), { projects: [], threads: [] });
        // Others resume as before: no authoritative snapshot.
        const hedyResumed = yield* firstShell(hedy, {
          afterSequence: before.snapshot.snapshotSequence,
        });
        assert.isFalse(
          hedyResumed.kind === "snapshot" &&
            hedyResumed.resolvedRepositoryIdentityRoots === undefined,
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            Layer.fresh(layerConfigSources),
            Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
            Layer.mock(ServerBrowser.ServerBrowser)({}),
          ),
        ),
      ),
  );

  it.effect("a command on a hidden Thread or Project fails exactly like one on a missing one", () =>
    withHub(({ server, grace }) =>
      Effect.gen(function* () {
        const client = yield* connect(server, grace.userId);
        const archive = (threadId: string) =>
          client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make(`archive-${threadId}`),
            threadId: ThreadId.make(threadId),
          } as never).pipe(Effect.flip);
        const hidden = yield* archive("globex-thread");
        assert.equal(hidden._tag, "SpaceResourceNotFoundError");
        assert.deepEqual(hidden, yield* archive("no-such-thread"));
        // A new Thread in a hidden Project is refused the same way.
        const created = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("create-in-globex"),
          threadId: ThreadId.make("new-thread"),
          projectId: ProjectId.make("globex-app"),
          title: "Hello",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        }).pipe(Effect.flip);
        assert.deepEqual(created, hidden);
      }),
    ),
  );

  it.effect(
    "listings that name no Project see only the viewer's, streams skip hidden Threads",
    () =>
      withHub(({ server, grace }) =>
        Effect.gen(function* () {
          const listed: Array<unknown> = [];
          const task = (id: string, projectId: string, threadId: string | null) =>
            ({ id, projectId, threadId, prompt: id }) as never;
          const client = yield* connect(
            server,
            grace.userId,
            Layer.mergeAll(
              Layer.mock(PullRequestService.PullRequestService)({
                list: (input) =>
                  Effect.sync(() => {
                    listed.push(input.projectIds);
                    return { pullRequests: [] } as never;
                  }),
              }),
              Layer.mock(ScheduledTasks.ScheduledTaskService)({
                subscribeList: () =>
                  Stream.make({
                    tasks: [
                      task("acme-task", "acme-app", "acme-thread"),
                      task("globex-task", "globex-app", null),
                      task("acme-on-hidden", "acme-app", "globex-thread"),
                    ],
                  }),
              }),
              Layer.mock(TerminalManager.TerminalManager)({
                subscribeMetadata: (listener) =>
                  listener({
                    type: "snapshot",
                    terminals: ["acme-thread", "globex-thread", "draft-thread"].map(
                      (threadId) => ({ threadId, terminalId: "t", cwd: "/work" }) as never,
                    ),
                  }).pipe(Effect.as(() => undefined)),
              }),
            ),
          );
          yield* client[WS_METHODS.pullRequestsList]({ state: "open" } as never);
          assert.deepEqual(listed, [["acme-app"]]);
          const [tasks] = yield* client[WS_METHODS.scheduledTasksSubscribe]({} as never).pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          assert.deepEqual(
            tasks?.tasks.map((item) => item.id),
            ["acme-task"],
          );
          const [terminals] = yield* client[WS_METHODS.subscribeTerminalMetadata]({} as never).pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          // Terminals are their Thread owner's: the Owner's Thread and a draft nobody holds are
          // not Grace's to see.
          assert.deepEqual(
            terminals?.type === "snapshot"
              ? terminals.terminals.map((item) => item.threadId)
              : null,
            [],
          );
        }),
      ),
  );
  // The real orchestrator and Thread services over the hub's database: every transport's
  // commands meet the Role rules there, so these run the production path end to end.
  const codex = ProviderInstanceId.make("codex");
  const codexInstance = {
    instanceId: codex,
    driverKind: ProviderDriverKind.make("codex"),
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("codex"),
      continuationKey: "codex",
    },
    displayName: "Codex",
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed({}) },
    orchestrationAdapter: {
      instanceId: codex,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("no provider turn runs in these tests"),
    },
    textGeneration: {},
  } as never;
  const layerOrchestration = (server: Effect.Success<typeof serveAuthHttp>) =>
    RuntimeLayer.layer.pipe(
      Layer.provide(ProviderTurnStartServiceTestkit.layer),
      Layer.provide(McpSessionRegistryTestkit.layer),
      Layer.provide(McpProviderSessions.layer),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointStore.CheckpointStore)({}),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("no title links in these tests"),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === codex ? codexInstance : undefined),
            listInstances: Effect.succeed([codexInstance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.never,
          }),
        ),
      ),
      Layer.provide(Layer.succeedContext(server.services)),
    );

  // Ada is Acme's Admin and Gus its Guest; Grace, a Member, owns grace-thread. acme-thread,
  // which names no owner, is the Owner's.
  const team = hub.pipe(
    Effect.flatMap((seeded) =>
      Effect.gen(function* () {
        const { server, acme, grace } = seeded;
        yield* server.eventSink.write({
          events: [
            threadCreated({
              id: "grace-thread",
              projectId: "acme-app",
              spaceId: acme,
              ownerUserId: grace.userId,
            }),
          ],
        });
        const adaCookie = yield* addMember(server, { id: "ada", displayName: "Ada" });
        yield* joinOrganization(server, acme, "ada", "admin");
        // An Admin's rights need a passkey or an authenticator app.
        yield* server.sql`INSERT INTO user_passkeys (credential_id, user_id, public_key, sign_count,
            transports, rp_id, created_at)
          VALUES ('ada-key', 'ada', 'key', 0, '[]', '127.0.0.1', '2026-01-01T00:00:00.000Z')`;
        const gusCookie = yield* addMember(server, { id: "gus", displayName: "Gus" });
        yield* joinOrganization(server, acme, "gus", "guest");
        return {
          ...seeded,
          ada: { cookie: adaCookie, userId: UserId.make("ada") },
          gus: { cookie: gusCookie, userId: UserId.make("gus") },
        };
      }),
    ),
  );
  const withTeam = <A, E, R>(
    body: (seeded: Effect.Success<typeof team>) => Effect.Effect<A, E, R>,
  ) =>
    team.pipe(
      Effect.flatMap(body),
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
    );
  const connectWriter = (
    server: Effect.Success<typeof serveAuthHttp>,
    userId: UserId | undefined,
  ) =>
    connect(
      server,
      userId,
      Layer.mergeAll(
        layerOrchestration(server),
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
          enqueueCommand: (effect) => effect,
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          write: () => Effect.void,
          open: () => Effect.succeed({} as never),
        }),
        SecretRequests.layer.pipe(
          Layer.provide(layerOrchestration(server)),
          Layer.provide(
            Layer.succeed(ServerSecretStore.ServerSecretStore, {
              getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
            } as unknown as ServerSecretStore.ServerSecretStore["Service"]),
          ),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    );
  type Writer = Effect.Success<ReturnType<typeof connectWriter>>;
  let sent = 0;
  const dispatch = (client: Writer, command: Record<string, unknown>) =>
    client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
      commandId: CommandId.make(`${String(command.type)}-${(sent += 1)}`),
      ...command,
    } as never).pipe(Effect.result);
  const refusal = (result: Result.Result<unknown, unknown>) =>
    Result.isFailure(result) ? ((result.failure as { detail?: string }).detail ?? null) : null;
  const receiptActor = (server: Effect.Success<typeof serveAuthHttp>, commandId: string) =>
    server.sql<{ actor: string | null }>`
      SELECT actor_user_id AS actor FROM orchestration_command_receipts
      WHERE command_id = ${commandId}
    `.pipe(Effect.map((rows) => rows[0]?.actor));

  it.effect("only a Thread's owner continues it; Admins archive and stop others' Threads", () =>
    withTeam(({ server, grace, ada }) =>
      Effect.gen(function* () {
        const asGrace = yield* connectWriter(server, grace.userId);
        const asAda = yield* connectWriter(server, ada.userId);
        const message = (threadId: string) => ({
          type: "message.dispatch",
          threadId,
          messageId: MessageId.make(`message-${threadId}`),
          text: "Hi",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });

        // Grace sees the Owner's Thread, so she is told why rather than that it is missing.
        assert.equal(
          refusal(yield* dispatch(asGrace, message("acme-thread"))),
          "Only the person who started this Thread can continue it. Start a new Thread to build on it.",
        );
        // Answering its agent's approval acts in the owner's live session too.
        assert.equal(
          refusal(
            yield* dispatch(asGrace, {
              type: "runtime-request.respond",
              threadId: "acme-thread",
              requestId: "approval-1",
              decision: "accept",
            }),
          ),
          "Only the person who started this Thread can continue it. Start a new Thread to build on it.",
        );
        // Not even an Admin continues someone else's Thread.
        assert.isNotNull(refusal(yield* dispatch(asAda, message("grace-thread"))));
        assert.match(
          refusal(yield* dispatch(asGrace, { type: "thread.archive", threadId: "acme-thread" })) ??
            "",
          /Only its creator or an Admin/,
        );
        assert.match(
          refusal(yield* dispatch(asGrace, { type: "thread.stop", threadId: "acme-thread" })) ?? "",
          /Only its creator or an Admin/,
        );
        const forceStop = yield* asGrace[ORCHESTRATION_V2_WS_METHODS.forceStopThread]({
          threadId: ThreadId.make("acme-thread"),
        } as never).pipe(Effect.flip);
        assert.include(forceStop.message, "Only the Thread's creator or an Admin");

        // The Admin stops and archives it; Grace archives her own.
        assert.isTrue(
          Result.isSuccess(
            yield* dispatch(asAda, { type: "thread.stop", threadId: "acme-thread" }),
          ),
        );
        assert.isTrue(
          Result.isSuccess(
            yield* dispatch(asAda, { type: "thread.archive", threadId: "acme-thread" }),
          ),
        );
        assert.isTrue(
          Result.isSuccess(
            yield* dispatch(asGrace, { type: "thread.archive", threadId: "grace-thread" }),
          ),
        );
        // Deleting for good is the Admin's alone.
        assert.match(
          refusal(yield* dispatch(asGrace, { type: "thread.delete", threadId: "grace-thread" })) ??
            "",
          /Only an Admin/,
        );
      }),
    ),
  );

  it.effect("the server stamps the acting User on every receipt; a client cannot set it", () =>
    withTeam(({ server, owner, grace }) =>
      Effect.gen(function* () {
        const asGrace = yield* connectWriter(server, grace.userId);
        const commandId = CommandId.make("grace-pins");
        const pinned = yield* asGrace[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.pin",
          commandId,
          threadId: ThreadId.make("grace-thread"),
          // A forged actor is dropped by the schema; the session decides.
          actorUserId: "someone-else",
        } as never).pipe(Effect.result);
        assert.isTrue(Result.isSuccess(pinned));
        assert.equal(yield* receiptActor(server, commandId), grace.userId);
        // Over HTTP too: the Project the Owner creates carries the Owner.
        const created = yield* server.request("/api/projects/mutate", {
          cookie: owner,
          body: {
            type: "project.create",
            commandId: "owner-creates",
            projectId: "owner-app",
            title: "owner-app",
            workspaceRoot: "/work/owner-app",
          },
        });
        assert.equal(created.status, 200);
        const [ownerRow] = yield* server.sql<{ userId: string }>`
          SELECT user_id AS "userId" FROM users WHERE is_owner = 1
        `;
        assert.equal(yield* receiptActor(server, "owner-creates"), ownerRow?.userId);
      }),
    ),
  );

  it.effect("Project rules hold over HTTP: Guests create none, Members archive only theirs", () =>
    withTeam(({ server, acme, grace, gus, ada }) =>
      Effect.gen(function* () {
        const mutate = (cookie: string, body: Record<string, unknown>) =>
          server.request("/api/projects/mutate", { cookie, body });
        const guestCreates = yield* mutate(gus.cookie, {
          type: "project.create",
          commandId: "gus-creates",
          projectId: "gus-app",
          title: "gus-app",
          workspaceRoot: "/work/gus-app",
          spaceId: acme,
        });
        assert.notEqual(guestCreates.status, 200);
        // acme-app is the Owner's: Grace may not archive it, Ada may.
        const graceArchives = yield* mutate(grace.cookie, {
          type: "project.update",
          commandId: "grace-archives",
          projectId: "acme-app",
          archived: true,
        });
        assert.notEqual(graceArchives.status, 200);
        assert.include(JSON.stringify(graceArchives.body), "Only its creator or an Admin");
        const adaArchives = yield* mutate(ada.cookie, {
          type: "project.update",
          commandId: "ada-archives",
          projectId: "acme-app",
          archived: true,
        });
        assert.equal(adaArchives.status, 200);
      }),
    ),
  );

  it.effect("terminals work only on one's own Thread or a draft one holds", () =>
    withTeam(({ server, grace, ada }) =>
      Effect.gen(function* () {
        const asGrace = yield* connectWriter(server, grace.userId);
        const asAda = yield* connectWriter(server, ada.userId);
        const write = (client: Writer, threadId: string) =>
          client[WS_METHODS.terminalWrite]({ threadId, terminalId: "t", data: "ls" } as never).pipe(
            Effect.result,
          );
        const owners = yield* write(asGrace, "acme-thread");
        assert.isTrue(Result.isFailure(owners) && owners.failure._tag === "SpaceActionDeniedError");
        assert.isTrue(Result.isSuccess(yield* write(asGrace, "grace-thread")));
        // Grace's draft is hers: to Ada it looks like it does not exist.
        assert.isTrue(Result.isSuccess(yield* write(asGrace, "grace-draft")));
        const adas = yield* write(asAda, "grace-draft");
        assert.isTrue(Result.isFailure(adas) && adas.failure._tag === "SpaceResourceNotFoundError");
      }),
    ),
  );

  it.effect("guest links are an Admin's, only in Organizations", () =>
    withTeam(({ server, grace, ada }) =>
      Effect.gen(function* () {
        const services = yield* Layer.build(layerOrchestration(server));
        const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
        const open = (actor: UserId, threadId: string) =>
          orchestrator
            .dispatch({
              type: "thread.guest-share.open",
              commandId: CommandId.make(`share-${actor}-${threadId}`),
              threadId: ThreadId.make(threadId),
              shareId: GuestShareId.make(`share-${actor}`),
              host: "https://hub.example.com",
              expiresAt: "2026-11-06T00:00:00.000Z",
            } as never)
            .pipe(CommandActor.actAs(actor), Effect.result);
        const members = yield* open(grace.userId, "grace-thread");
        assert.equal(
          Result.isFailure(members) ? SpaceDirectory.spaceRefusalMessage(members.failure) : null,
          "Only an Admin can create guest links, and only in an Organization.",
        );
        const admins = yield* open(ada.userId, "grace-thread");
        assert.isTrue(Result.isSuccess(admins));
        // Nothing is shared from a Personal space, not even by the Owner.
        const [ownerRow] = yield* server.sql<{ userId: string }>`
          SELECT user_id AS "userId" FROM users WHERE is_owner = 1
        `;
        const personal = yield* open(UserId.make(ownerRow!.userId), "legacy-thread");
        assert.isTrue(Result.isFailure(personal));
        // Off the WebSocket too (MCP, agents), a hidden Thread fails exactly like a missing one.
        const archive = (threadId: string) =>
          orchestrator
            .dispatch({
              type: "thread.archive",
              commandId: CommandId.make(`archive-${threadId}`),
              threadId: ThreadId.make(threadId),
            })
            .pipe(
              CommandActor.actAs(grace.userId),
              Effect.flip,
              Effect.map((error) => error.cause),
            );
        assert.deepEqual(yield* archive("globex-thread"), yield* archive("no-such-thread"));
      }),
    ),
  );
  it.effect("not even the Owner continues someone else's Thread or works its live session", () =>
    withTeam(({ server, grace }) =>
      Effect.gen(function* () {
        const [ownerRow] = yield* server.sql<{ userId: string }>`
          SELECT user_id AS "userId" FROM users WHERE is_owner = 1
        `;
        const asOwner = yield* connectWriter(server, UserId.make(ownerRow!.userId));
        const sent = yield* dispatch(asOwner, {
          type: "message.dispatch",
          threadId: "grace-thread",
          messageId: MessageId.make("owner-speaks"),
          text: "Hi",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal(
          refusal(sent),
          "Only the person who started this Thread can continue it. Start a new Thread to build on it.",
        );
        // The Owner still archives it.
        assert.isTrue(
          Result.isSuccess(
            yield* dispatch(asOwner, { type: "thread.archive", threadId: "grace-thread" }),
          ),
        );
        // An MCP app acts in the Thread's live session, so it is Grace's alone.
        const app = yield* asOwner[WS_METHODS.mcpAppsCallTool]({
          threadId: ThreadId.make("grace-thread"),
          itemId: "item",
          name: "tool",
          arguments: {},
        } as never).pipe(Effect.flip);
        assert.equal(app._tag, "SpaceActionDeniedError");
        const asGrace = yield* connectWriter(server, grace.userId);
        // Its model context may not name a Thread she cannot see either.
        const context = yield* asGrace[WS_METHODS.mcpAppsUpdateModelContext]({
          threadId: ThreadId.make("grace-thread"),
          itemId: "item",
          conversationThreadId: ThreadId.make("globex-thread"),
        } as never).pipe(Effect.flip);
        assert.equal(context._tag, "SpaceResourceNotFoundError");
      }),
    ),
  );

  it.effect("viewers open a Thread; only its creator or an Admin organizes it", () =>
    withTeam(({ server, gus, ada }) =>
      Effect.gen(function* () {
        const asGus = yield* connectWriter(server, gus.userId);
        const asAda = yield* connectWriter(server, ada.userId);
        const visit = yield* dispatch(asGus, {
          type: "thread.visit",
          threadId: "grace-thread",
          visitedAt: "2026-11-05T00:00:00.000Z",
        });
        assert.isTrue(Result.isSuccess(visit));
        assert.match(
          refusal(yield* dispatch(asGus, { type: "thread.pin", threadId: "grace-thread" })) ?? "",
          /Only its creator or an Admin/,
        );
        assert.isTrue(
          Result.isSuccess(
            yield* dispatch(asAda, { type: "thread.pin", threadId: "grace-thread" }),
          ),
        );
      }),
    ),
  );

  it.effect("a command id replays only for the User who sent it", () =>
    withTeam(({ server, grace, ada }) =>
      Effect.gen(function* () {
        const asGrace = yield* connectWriter(server, grace.userId);
        const asAda = yield* connectWriter(server, ada.userId);
        // Both may archive grace-thread, so only the replay rule tells them apart.
        const pin = (client: Writer) =>
          client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("shared-id"),
            threadId: ThreadId.make("grace-thread"),
          } as never).pipe(Effect.result);
        assert.isTrue(Result.isSuccess(yield* pin(asGrace)));
        assert.isTrue(Result.isSuccess(yield* pin(asGrace)));
        assert.isTrue(Result.isFailure(yield* pin(asAda)));
      }),
    ),
  );

  it.effect("terminals open only in folders the User may work in", () =>
    withTeam(({ server, grace, gus }) =>
      Effect.gen(function* () {
        const asGrace = yield* connectWriter(server, grace.userId);
        const asGus = yield* connectWriter(server, gus.userId);
        const open = (client: Writer, threadId: string, cwd: string) =>
          client[WS_METHODS.terminalOpen]({ threadId, terminalId: "t", cwd } as never).pipe(
            Effect.result,
          );
        const outcome = (result: Result.Result<unknown, unknown>) =>
          Result.isSuccess(result) ? "opened" : (result.failure as { _tag: string })._tag;
        // A Member works in her team's Projects, not in another Organization's.
        assert.equal(outcome(yield* open(asGrace, "grace-draft", "/work/acme-app")), "opened");
        assert.equal(
          outcome(yield* open(asGrace, "grace-draft", "/work/globex-app/src")),
          "SpaceActionDeniedError",
        );
        // A Guest works only in their own Threads' folders.
        assert.equal(
          outcome(yield* open(asGus, "gus-draft", "/work/acme-app")),
          "SpaceActionDeniedError",
        );
      }),
    ),
  );

  it.effect("a file call that names a Thread keeps to who may see and work that Thread", () =>
    withTeam(({ server, ada }) =>
      Effect.gen(function* () {
        const asAda = yield* connectWriter(server, ada.userId);
        const refusal = (result: Result.Result<unknown, unknown>) =>
          Result.isSuccess(result) ? "ran" : (result.failure as { _tag: string })._tag;
        // An Admin sees grace-thread but saves only in a Thread of her own.
        const saved = yield* asAda[WS_METHODS.projectsWriteFile]({
          cwd: "/work/acme-app",
          relativePath: "notes.md",
          contents: "x",
          threadId: "grace-thread",
        } as never).pipe(Effect.result);
        assert.equal(refusal(saved), "SpaceActionDeniedError");
        // A Thread in a Space she cannot see answers like a missing one.
        const read = yield* asAda[WS_METHODS.projectsReadFile]({
          cwd: "/work/globex-app",
          relativePath: "README.md",
          threadId: "globex-thread",
        } as never).pipe(Effect.result);
        assert.equal(refusal(read), "SpaceResourceNotFoundError");
      }),
    ),
  );

  it.effect(
    "a file call with no Thread, or a draft's, keeps to folders of Spaces the User sees",
    () =>
      withTeam(({ server, ada }) =>
        Effect.gen(function* () {
          const asAda = yield* connectWriter(server, ada.userId);
          // The refusal's tag, or "reached" once the call got past the guard to the file services
          // (which these tests do not run).
          const outcome = <A, E, R>(call: Effect.Effect<A, E, R>) =>
            call.pipe(
              Effect.flip,
              Effect.map((error) => (error as { readonly _tag: string })._tag),
              Effect.catchCause(() => Effect.succeed("reached")),
            );
          const read = (cwd: string, threadId?: string) =>
            outcome(
              asAda[WS_METHODS.projectsReadFile]({
                cwd,
                relativePath: "README.md",
                ...(threadId === undefined ? {} : { threadId }),
              } as never),
            );
          // Another Organization's Project answers like a missing one, with no Thread or a draft's,
          // which run on the Hub's own copy of the folder.
          assert.equal(yield* read("/work/globex-app"), "SpaceResourceNotFoundError");
          assert.equal(
            yield* read("/work/globex-app/src", "ada-draft"),
            "SpaceResourceNotFoundError",
          );
          const written = yield* outcome(
            asAda[WS_METHODS.projectsWriteFile]({
              cwd: "/work/globex-app",
              relativePath: "notes.md",
              contents: "x",
            } as never),
          );
          assert.equal(written, "SpaceResourceNotFoundError");
          // Her own team's Project gets past the guard.
          assert.notEqual(yield* read("/work/acme-app"), "SpaceResourceNotFoundError");
          assert.notEqual(yield* read("/work/acme-app", "ada-draft"), "SpaceResourceNotFoundError");
        }),
      ),
  );

  it.effect("answering a secret request is the Thread creator's, refused before storing", () =>
    withTeam(({ server, gus }) =>
      Effect.gen(function* () {
        const asGus = yield* connectWriter(server, gus.userId);
        const answered = yield* asGus[WS_METHODS.secretsAnswerRequest]({
          threadId: ThreadId.make("grace-thread"),
          turnItemId: "item",
          answer: { type: "save", secret: "hunter2" },
        } as never).pipe(Effect.flip);
        assert.equal((answered as { reason?: string }).reason, "not_permitted");
      }),
    ),
  );

  // Live: the shell tail batches deltas on a wall-clock window.
  it.live(
    "the Owner turns a Member's Personal space on and off; her open connection follows at once",
    () =>
      withHub(({ server, owner, grace, linus }) =>
        Effect.gen(function* () {
          const setPersonal = (cookie: string, granted: boolean) =>
            server.request(`/api/installation/users/${grace.userId}/permissions`, {
              cookie,
              body: { permission: "personalSpace.create", granted },
            });
          // Only the Owner lists Users and grants or revokes their permissions.
          assert.equal((yield* setPersonal(grace.cookie, true)).status, 403);
          assert.equal(
            (yield* server.request("/api/installation/users", { cookie: linus.cookie })).status,
            403,
          );
          const users = yield* server.request("/api/installation/users", { cookie: owner });
          assert.deepInclude(users.body.users as ReadonlyArray<unknown>, {
            id: grace.userId,
            displayName: "grace",
            loginName: "grace",
            isOwner: false,
            status: "active",
            installationPermissions: [],
          });

          const createNotes = (id: string) =>
            server.request("/api/projects/mutate", {
              cookie: grace.cookie,
              body: {
                type: "project.create",
                commandId: `create-${id}`,
                projectId: id,
                title: id,
                workspaceRoot: `/work/${id}`,
              },
            });
          const spaceIds = (cookie: string) =>
            server
              .request("/api/spaces", { cookie })
              .pipe(
                Effect.map((response) =>
                  (response.body.spaces as ReadonlyArray<{ id: string }>).map((space) => space.id),
                ),
              );
          const personal = `personal:${grace.userId}`;
          assert.notInclude(yield* spaceIds(grace.cookie), personal);
          assert.equal((yield* createNotes("too-early")).status, 403);

          // Grace's open shell, synchronized before anything changes.
          const client = yield* connect(server, grace.userId);
          const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
          yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
            requestCompletionMarker: true,
          }).pipe(
            Stream.runForEach((item) => Queue.offer(items, item)),
            Effect.forkScoped,
          );
          while ((yield* Queue.take(items)).kind !== "synchronized");

          const granted = yield* setPersonal(owner, true);
          assert.equal(granted.status, 200);
          assert.deepEqual(granted.body.installationPermissions, ["personalSpace.create"]);
          assert.include(yield* spaceIds(grace.cookie), personal);
          const notes = yield* createNotes("notes");
          assert.equal(notes.status, 200);
          assert.equal(notes.body.spaceId, personal);
          // The same connection shows it, with no resubscribe: as a delta, or in the fresh
          // snapshot the grant restarts the stream with.
          for (let item = yield* Queue.take(items); ; item = yield* Queue.take(items)) {
            if (item.kind === "project.updated" && item.project.id === "notes") break;
            if (item.kind === "snapshot" && shellIds(item.snapshot).projects.includes("notes"))
              break;
          }

          // The Owner reads every Personal space; another Member reads none but her own.
          const projectIds = (cookie: string) =>
            server
              .request("/api/projects", { cookie })
              .pipe(
                Effect.map((response) =>
                  (response.body.projects as ReadonlyArray<{ id: string }>).map(
                    (project) => project.id,
                  ),
                ),
              );
          assert.include(yield* projectIds(owner), "notes");
          assert.include(yield* spaceIds(owner), personal);
          assert.notInclude(yield* projectIds(linus.cookie), "notes");
          assert.notInclude(yield* spaceIds(linus.cookie), personal);

          // Revoking hides it again: the open shell gets a fresh snapshot without it.
          assert.equal((yield* setPersonal(owner, false)).status, 200);
          for (let item = yield* Queue.take(items); ; item = yield* Queue.take(items)) {
            if (item.kind === "snapshot" && item.resolvedRepositoryIdentityRoots === undefined) {
              assert.notInclude(shellIds(item.snapshot).projects, "notes");
              break;
            }
          }
          assert.notInclude(yield* spaceIds(grace.cookie), personal);
          assert.notInclude(yield* projectIds(grace.cookie), "notes");
          assert.equal((yield* createNotes("after-revoke")).status, 403);
          assert.include(yield* projectIds(owner), "notes");
        }),
      ),
  );

  it.effect("the Owner's Users endpoints need the access scopes, not just the Owner", () =>
    withHub(({ server, grace }) =>
      Effect.gen(function* () {
        const [ownerRow] = yield* server.sql<{ userId: string }>`
          SELECT user_id AS "userId" FROM users WHERE is_owner = 1
        `;
        // A narrowed session of the Owner's, such as a read-only client paired by the Owner.
        const narrow = yield* server.sessions.issue({
          method: "browser-session-cookie",
          subject: "user-sign-in",
          userId: UserId.make(ownerRow!.userId),
          scopes: ["orchestration:read"],
        });
        const cookie = `${server.sessions.cookieName}=${narrow.token}`;
        assert.equal((yield* server.request("/api/installation/users", { cookie })).status, 403);
        const set = yield* server.request(`/api/installation/users/${grace.userId}/permissions`, {
          cookie,
          body: { permission: "personalSpace.create", granted: true },
        });
        assert.equal(set.status, 403);
        const [granted] = yield* server.sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM installation_permissions
        `;
        assert.equal(granted?.count, 0);
      }),
    ),
  );

  it.effect("naming someone else's Personal space answers like naming a missing one", () =>
    withHub(({ server, grace, linus }) =>
      Effect.gen(function* () {
        const create = (spaceId: string) =>
          server
            .request("/api/projects/mutate", {
              cookie: grace.cookie,
              body: {
                type: "project.create",
                commandId: `probe-${spaceId}`,
                projectId: `probe-${spaceId}`,
                title: "probe",
                workspaceRoot: "/work/probe",
                spaceId,
              },
            })
            .pipe(
              Effect.map((response) => {
                const { traceId: _traceId, ...body } = response.body;
                return [response.status, JSON.stringify(body).replaceAll(spaceId, "<space>")];
              }),
            );
        assert.deepEqual(
          yield* create(`personal:${linus.userId}`),
          yield* create("personal:no-such-user"),
        );
      }),
    ),
  );

  it.effect(
    "revoking a Personal space ends its streams, closes its folders and the Owner only reads it",
    () =>
      withTeam(({ server, owner, grace }) =>
        Effect.gen(function* () {
          const setPersonal = (granted: boolean) =>
            server.request(`/api/installation/users/${grace.userId}/permissions`, {
              cookie: owner,
              body: { permission: "personalSpace.create", granted },
            });
          assert.equal((yield* setPersonal(true)).status, 200);
          yield* server.eventSink.write({
            events: [
              threadCreated({
                id: "notes-thread",
                projectId: "acme-app",
                spaceId: `personal:${grace.userId}`,
                ownerUserId: grace.userId,
                worktreePath: "/wt/notes",
              }),
            ],
          });
          const visibility = Context.get(server.services, SpaceVisibility.SpaceVisibility);
          const mayUseNotes = Effect.flatMap(visibility.of(grace.userId), (seen) =>
            visibility.mayUseDirectory(seen, grace.userId, "/wt/notes"),
          );
          assert.isTrue(yield* mayUseNotes);

          // The Owner reads it but changes nothing in it.
          const services = yield* Layer.build(layerOrchestration(server));
          const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
          const [ownerRow] = yield* server.sql<{ userId: string }>`
            SELECT user_id AS "userId" FROM users WHERE is_owner = 1
          `;
          const archived = yield* orchestrator
            .dispatch({
              type: "thread.archive",
              commandId: CommandId.make("owner-archive-notes"),
              threadId: ThreadId.make("notes-thread"),
            })
            .pipe(CommandActor.actAs(UserId.make(ownerRow!.userId)), Effect.result);
          assert.isTrue(Result.isFailure(archived));

          // A stream the middleware let open on that Thread, such as its command output.
          const viewer = yield* SpaceVisibility.CurrentViewer.pipe(
            Effect.provide(
              SpaceVisibility.layerCurrentViewer.pipe(
                Layer.provide(
                  Layer.succeed(EnvironmentAuthenticatedPrincipal, {
                    sessionId: AuthSessionId.make("session-grace"),
                    subject: "user-sign-in",
                    userId: grace.userId,
                    method: "browser-session-cookie",
                    scopes: new Set([AuthOrchestrationReadScope]),
                  } as never),
                ),
                Layer.provide(Layer.succeedContext(server.services)),
              ),
            ),
          );
          const open = yield* Stream.never.pipe(
            untilAccessLost(
              ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
              { threadId: "notes-thread", itemId: "item-1" },
              viewer,
              visibility,
              grace.userId,
              (lost) => Effect.fail(lost),
            ),
            Stream.runDrain,
            Effect.flip,
            Effect.forkScoped,
          );

          assert.equal((yield* setPersonal(false)).status, 200);
          assert.equal((yield* Fiber.join(open))._tag, "SpaceResourceNotFoundError");
          assert.isFalse(yield* mayUseNotes);
        }),
      ),
  );

  it.effect("once an Owner exists, a request with no User changes nothing", () =>
    withTeam(({ server }) =>
      Effect.gen(function* () {
        const anonymous = yield* connectWriter(server, undefined);
        assert.equal(
          refusal(yield* dispatch(anonymous, { type: "thread.archive", threadId: "acme-thread" })),
          "This session belongs to no User. Sign in again.",
        );
      }),
    ),
  );

  it.effect("the server's own work starts nothing in an archived Organization", () =>
    withTeam(({ server, owner, acme }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        assert.equal(
          (yield* server.request(`/api/spaces/${acme}/archive`, { body: {}, cookie: owner }))
            .status,
          200,
        );
        // A recovery or continuation worker resuming a Thread acts as no User.
        const resumed = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("server-resumes"),
            threadId: ThreadId.make("grace-thread"),
            messageId: MessageId.make("server-resume-message"),
            text: "Continue",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          } as never)
          .pipe(Effect.flip);
        assert.equal(resumed._tag, "OrchestratorCommandRejectedError");
        assert.match(String((resumed as { cause?: unknown }).cause), /archived/);
      }).pipe(Effect.provide(layerOrchestration(server))),
    ),
  );

  it.effect("once its deletion started, an Organization is not restored", () =>
    withHub(({ server, owner, acme }) =>
      Effect.gen(function* () {
        assert.equal(
          (yield* server.request(`/api/spaces/${acme}/archive`, { body: {}, cookie: owner }))
            .status,
          200,
        );
        // A deletion cut short (a crash, or a restore racing it) left the mark behind.
        yield* server.sql`
          UPDATE spaces SET deleting_at = '2026-11-02T00:00:00.000Z' WHERE space_id = ${acme}
        `;
        const restored = yield* server.request(`/api/spaces/${acme}/restore`, {
          body: {},
          cookie: owner,
        });
        assert.equal(restored.status, 403);
        assert.equal(
          restored.body.message,
          "This Organization is being deleted. Delete it again to finish.",
        );
        // A Project-level scheduled task goes with the Organization.
        yield* server.sql`
          INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id,
            workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
            created_by, creation_source, created_at, updated_at, last_run_status, run_count)
          VALUES ('acme-task', 'Check in', 'Check', 1, '{"type":"interval","everyMs":60000}',
            'acme-app', '{"type":"root"}', '{"instanceId":"codex","model":"gpt-5"}',
            'full-access', 'default', 'user', 'web', '2026-11-01T00:00:00.000Z',
            '2026-11-01T00:00:00.000Z', 'never', 0)
        `;
        assert.equal(
          (yield* server.request(`/api/spaces/${acme}/delete`, { body: {}, cookie: owner })).status,
          200,
        );
        const tasks = yield* server.sql`SELECT task_id FROM scheduled_tasks`;
        assert.deepEqual(tasks, []);
      }),
    ),
  );

  it.effect("while a Project moves, nothing is created or started in it", () =>
    withTeam(({ server, acme, ada }) =>
      Effect.gen(function* () {
        yield* server.eventSink.write({
          events: [
            threadCreated({
              id: "ada-thread",
              projectId: "acme-app",
              spaceId: acme,
              ownerUserId: "ada",
            }),
          ],
        });
        const spaces = Context.get(server.services, SpaceDirectory.SpaceDirectory);
        const during = yield* spaces.whileProjectMoves(
          ProjectId.make("acme-app"),
          Effect.all([
            spaces
              .claimCreation({
                action: "thread.create",
                actorUserId: ada.userId,
                projectId: ProjectId.make("acme-app"),
              })
              .pipe(Effect.flip),
            spaces.workBlocked(ThreadId.make("ada-thread")),
          ]),
        );
        assert.equal(
          during[0].message,
          "This Project is moving to another Space. Try again in a moment.",
        );
        // The orchestrator refuses any start in such a Thread, whoever asks.
        assert.equal(during[1], "project-moving");
        assert.isUndefined(yield* spaces.workBlocked(ThreadId.make("ada-thread")));
      }),
    ),
  );

  it.effect("a move restamps only Threads whose Space the mover may move them out of", () =>
    withTeam(({ server, globex, ada }) =>
      Effect.gen(function* () {
        // A Thread of Acme's Project stamped with Globex, which Ada does not run.
        yield* server.eventSink.write({
          events: [threadCreated({ id: "stray", projectId: "acme-app", spaceId: globex })],
        });
        const [acmeSpace] = yield* server.sql<{ spaceId: string }>`
          SELECT space_id AS "spaceId" FROM projection_projects WHERE project_id = 'acme-app'
        `;
        const sameSpace = yield* server.request("/api/projects/mutate", {
          cookie: ada.cookie,
          body: {
            type: "project.move",
            commandId: "move-in-place",
            projectId: "acme-app",
            spaceId: acmeSpace!.spaceId,
          },
        });
        assert.notEqual(sameSpace.status, 200);
        const [stray] = yield* server.sql<{ spaceId: string }>`
          SELECT space_id AS "spaceId" FROM orchestration_v2_projection_threads
          WHERE thread_id = 'stray'
        `;
        assert.equal(stray?.spaceId, globex);
      }),
    ),
  );

  // A User's shell over WebSocket, and the next authoritative snapshot it is sent.
  const watchShell = Effect.fn(function* (
    server: Effect.Success<typeof serveAuthHttp>,
    userId: UserId,
  ) {
    const client = yield* connect(server, userId);
    const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
    yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
      requestCompletionMarker: true,
    }).pipe(
      Stream.runForEach((item) => Queue.offer(items, item)),
      Effect.forkScoped,
    );
    return items;
  });
  /** Skips deltas and enrichment refreshes until a snapshot shows exactly `expected`. */
  const snapshotShowing = Effect.fn(function* (
    items: Queue.Queue<OrchestrationV2ShellStreamItem>,
    expected: { readonly projects: ReadonlyArray<string>; readonly threads: ReadonlyArray<string> },
  ) {
    for (;;) {
      const item = yield* Queue.take(items);
      if (item.kind !== "snapshot") continue;
      const shown = shellIds(item.snapshot);
      if (JSON.stringify(shown) === JSON.stringify(expected)) return shown;
    }
  });
  const spaceNamesOf = (server: Effect.Success<typeof serveAuthHttp>, cookie: string) =>
    server
      .request("/api/spaces", { cookie })
      .pipe(
        Effect.map((response) =>
          (response.body.spaces as ReadonlyArray<{ name: string; archived?: boolean }>).map(
            (space) => `${space.name}${space.archived === true ? " (archived)" : ""}`,
          ),
        ),
      );

  // Live: the shell tail batches deltas on a wall-clock window.
  it.live(
    "archiving an Organization hides it from its Members at once and stops new work; restore brings it back",
    () =>
      withHub(({ server, owner, acme, grace }) =>
        Effect.gen(function* () {
          const lifecycle = (action: "archive" | "restore" | "delete", cookie: string) =>
            server.request(`/api/spaces/${acme}/${action}`, { body: {}, cookie });
          const acmeWork = { projects: ["acme-app"], threads: ["acme-child", "acme-thread"] };
          const shell = yield* watchShell(server, grace.userId);
          yield* snapshotShowing(shell, acmeWork);

          // Only the Owner archives.
          const byMember = yield* lifecycle("archive", grace.cookie);
          assert.equal(byMember.status, 403);
          assert.equal(
            byMember.body.message,
            "Only the Owner archives, restores or deletes an Organization.",
          );

          const archived = yield* lifecycle("archive", owner);
          assert.equal(archived.status, 200);
          // The Owner keeps it, marked archived; Grace's open shell reloads without it.
          assert.include(yield* spaceNamesOf(server, owner), "Acme (archived)");
          yield* snapshotShowing(shell, { projects: [], threads: [] });
          assert.notInclude(yield* spaceNamesOf(server, grace.cookie), "Acme");
          // To her it no longer exists, so she cannot restore it either.
          const restoreByMember = yield* lifecycle("restore", grace.cookie);
          assert.equal(restoreByMember.body.message, "That Organization does not exist.");

          // Nothing new starts in it, not even from the Owner.
          const created = yield* server.request("/api/projects/mutate", {
            cookie: owner,
            body: {
              type: "project.create",
              commandId: "create-in-archived",
              projectId: "late-app",
              title: "late-app",
              workspaceRoot: "/work/late-app",
              spaceId: acme,
            },
          });
          assert.equal(created.status, 403);
          // Archiving twice changes nothing.
          assert.equal((yield* lifecycle("archive", owner)).status, 200);

          assert.equal((yield* lifecycle("restore", owner)).status, 200);
          yield* snapshotShowing(shell, acmeWork);
          assert.include(yield* spaceNamesOf(server, grace.cookie), "Acme");
          assert.include(yield* spaceNamesOf(server, owner), "Acme");
        }),
      ),
  );

  it.effect("an Organization is deleted for good only once archived, with everything in it", () =>
    withHub(({ server, owner, acme, grace }) =>
      Effect.gen(function* () {
        const lifecycle = (action: "archive" | "delete", cookie: string) =>
          server.request(`/api/spaces/${acme}/${action}`, { body: {}, cookie });
        // A pending Invitation, which goes with the Organization.
        yield* server.request(`/api/spaces/${acme}/invitations`, {
          body: { role: "member" },
          cookie: owner,
        });

        const early = yield* lifecycle("delete", owner);
        assert.equal(early.status, 403);
        assert.equal(
          early.body.message,
          "Archive the Organization before deleting it permanently.",
        );
        assert.equal((yield* lifecycle("archive", owner)).status, 200);

        const deleted = yield* lifecycle("delete", owner);
        assert.equal(deleted.status, 200);
        assert.notInclude(
          (deleted.body.spaces as ReadonlyArray<{ name: string }>).map((space) => space.name),
          "Acme",
        );
        // Its Projects and Threads went through their delete paths; Globex's work stays.
        const shell = yield* server.request("/api/orchestration/shell", { cookie: owner });
        assert.deepEqual(shellIds(shell.body as never), {
          projects: ["globex-app", "legacy-app"],
          threads: ["globex-thread", "legacy-thread"],
        });
        const [left] = yield* server.sql<{
          memberships: number;
          invitations: number;
          spaces: number;
        }>`
          SELECT
            (SELECT COUNT(*) FROM space_memberships WHERE space_id = ${acme}) AS memberships,
            (SELECT COUNT(*) FROM space_invitations WHERE space_id = ${acme}) AS invitations,
            (SELECT COUNT(*) FROM spaces WHERE space_id = ${acme}) AS spaces
        `;
        assert.deepEqual(left, { memberships: 0, invitations: 0, spaces: 0 });
        assert.equal(yield* isSignedIn(server, grace.cookie), true);
        assert.equal(
          (yield* lifecycle("delete", owner)).body.message,
          "That Organization does not exist.",
        );
      }),
    ),
  );

  const runEvent = (threadId: string, status: "running" | "completed") => {
    const at = DateTime.makeUnsafe("2026-11-01T00:01:00.000Z");
    const id = ThreadId.make(threadId);
    const runId = RunId.make(`run-${threadId}`);
    const nodeId = NodeId.make(`node-${threadId}`);
    const instanceId = ProviderInstanceId.make("codex");
    return {
      id: EventId.make(`run-${threadId}-${status}`),
      type: status === "running" ? "run.created" : "run.updated",
      threadId: id,
      runId,
      nodeId,
      driver: ProviderDriverKind.make("codex"),
      occurredAt: at,
      payload: {
        id: runId,
        threadId: id,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-5" },
        providerThreadId: null,
        userMessageId: MessageId.make(`message-${threadId}`),
        rootNodeId: nodeId,
        activeAttemptId: null,
        status,
        requestedAt: at,
        startedAt: at,
        completedAt: status === "running" ? null : at,
        checkpointId: null,
        contextHandoffId: null,
      },
    } as const;
  };

  // Live: the shell tail batches deltas on a wall-clock window.
  it.live(
    "a Project moves only for an Admin of both Spaces, never while a Thread runs, and its Threads and viewers follow",
    () =>
      withTeam(({ server, owner, globex, grace, linus, ada }) =>
        Effect.gen(function* () {
          const spaces = Context.get(server.services, SpaceDirectory.SpaceDirectory);
          let moves = 0;
          const move = (cookie: string, spaceId: string) =>
            server.request("/api/projects/mutate", {
              cookie,
              body: {
                type: "project.move",
                commandId: `move-${(moves += 1)}`,
                projectId: "acme-app",
                spaceId,
              },
            });
          // Ada runs Acme but is not in Globex, which answers like a Space that does not exist.
          const hidden = yield* move(ada.cookie, globex);
          const missing = yield* move(ada.cookie, "no-such-space");
          assert.equal(hidden.status, 400);
          const { traceId: _hiddenTrace, ...hiddenBody } = hidden.body;
          const { traceId: _missingTrace, ...missingBody } = missing.body;
          assert.deepEqual([hidden.status, hiddenBody], [missing.status, missingBody]);
          // As a Member of Globex she still may not; nor may Grace, a Member of Acme.
          yield* joinOrganization(server, globex, "ada", "member");
          yield* spaces.changed;
          const asMember = yield* move(ada.cookie, globex);
          assert.equal(asMember.status, 403);
          assert.match(String(asMember.body.message), /Admin where it is and where it goes/);
          assert.equal((yield* move(grace.cookie, globex)).status, 400);
          yield* server.sql`
            UPDATE space_memberships SET role = 'admin' WHERE space_id = ${globex} AND user_id = 'ada'
          `;
          yield* spaces.changed;

          // A running Thread blocks the move, and the message says which.
          yield* server.eventSink.write({ events: [runEvent("acme-thread", "running")] as never });
          const blocked = yield* move(ada.cookie, globex);
          assert.equal(blocked.status, 409);
          assert.equal(
            blocked.body.message,
            'Stop the running Threads of this Project before moving it: "acme-thread".',
          );
          yield* server.eventSink.write({
            events: [runEvent("acme-thread", "completed")] as never,
          });

          const graceShell = yield* watchShell(server, grace.userId);
          const linusShell = yield* watchShell(server, linus.userId);
          const acmeWork = {
            projects: ["acme-app"],
            threads: ["acme-child", "acme-thread", "grace-thread"],
          };
          yield* snapshotShowing(graceShell, acmeWork);
          yield* snapshotShowing(linusShell, {
            projects: ["globex-app"],
            threads: ["globex-thread"],
          });

          const moved = yield* move(ada.cookie, globex);
          assert.equal(moved.status, 200);
          assert.equal(moved.body.spaceId, globex);
          // Every Thread follows, the unstamped child too.
          const threadSpaces = yield* server.sql<{ threadId: string; spaceId: string | null }>`
            SELECT thread_id AS "threadId", space_id AS "spaceId"
            FROM orchestration_v2_projection_threads WHERE project_id = 'acme-app'
            ORDER BY thread_id
          `;
          assert.deepEqual(
            threadSpaces.map((row) => row.spaceId),
            threadSpaces.map(() => globex),
          );
          // Acme's viewers lose it live; Globex's gain it.
          yield* snapshotShowing(graceShell, { projects: [], threads: [] });
          yield* snapshotShowing(linusShell, {
            projects: ["acme-app", "globex-app"],
            threads: ["acme-child", "acme-thread", "globex-thread", "grace-thread"],
          });

          // Not even the Owner moves it into someone else's Personal space.
          const intoPersonal = yield* move(owner, `personal:${grace.userId}`);
          assert.equal(intoPersonal.status, 403);
          assert.equal(
            intoPersonal.body.message,
            "This is someone else's Personal space: you can read it but not change anything in it.",
          );
        }),
      ),
  );
});
