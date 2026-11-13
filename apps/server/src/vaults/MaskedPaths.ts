/**
 * Spec 5 ticket 05: every door of the Hub (WS methods, HTTP endpoints, raw routes, MCP tools, the
 * executor wire) says how a Thread's process output reaches it masked, or why it cannot carry any.
 * `MaskedPaths.test.ts` fails for a door without a rule, a rule no door uses, or a missing proof.
 */
import type { RemoteOperation, RemoteStreamOperation } from "../environment/RemoteExecutorWire.ts";

/**
 * `masked`: by the named code, proven by the named test (`file > title`); `history`: from the store
 * EventSink masks; `noProcessText`: ids, names, status or what Users typed; `unmasked`: accepted.
 */
export type DoorRule =
  | { readonly masked: string; readonly proof: string }
  | { readonly history: string }
  | { readonly noProcessText: string }
  | { readonly unmasked: string };

const HISTORY_TEST =
  "environments/HubWithEnvironments.secretMasking.test.ts > stored events, projection, diff and file reads show [OWNER_TOKEN]";
const TERMINAL_TEST =
  "environments/HubWithEnvironments.secretMasking.test.ts > terminal output reaches the client masked, a value split between frames too";
const SAVE_TEST =
  "environments/HubWithEnvironments.secretMasking.test.ts > an editor save puts each [NAME] back to the value the file held";
const COMMAND_OUTPUT_TEST =
  "vaults/SecretMasker.test.ts > masks a value split between two chunks of live command output";
const REJECTED_TEST =
  "vaults/SecretMasker.test.ts > masks a rejected command's error and the outbox's payloads";
const SETUP_TEST =
  "vaults/SecretMasker.test.ts > masks setup-script output before a client sees it";
const PULL_REQUEST_TEST =
  "vaults/SecretMasker.test.ts > masks every answer about a change request with its linked Threads' values";
const GIT_TEST =
  "vaults/SecretMasker.test.ts > masks git hook output with the Thread's values, or sends none";
const REVIEW_TEST =
  "vaults/SecretMasker.test.ts > masks a checkout's diffs and commits with the values of the Threads that run there";
const HANDOFF_TEST =
  "environments/HubWithEnvironments.handoff.test.ts > a summary that names a secret value is stored and shown as [NAME] (spec 5)";

const HISTORY: DoorRule = { history: "a Thread's history, from the masked store" };
const masked = (by: string, proof: string): DoorRule => ({ masked: by, proof });
const none = (what: string): DoorRule => ({ noProcessText: what });

/** WS methods, by name or `prefix*`; the most specific rule applies. */
export const WS_DOOR_RULES: Record<string, DoorRule> = {
  "agentSessions.scan": {
    unmasked: "the Owner's own agent sessions on the Hub machine's disk, listed to import them",
  },
  "agentSessions.import": { history: "an imported session is written as events (masked)" },
  "aiAccounts.*": none("AI accounts' names and status"),
  "aiGateway.*": none("the AI gateway's status"),
  "aiUsage.*": none("usage figures: tokens, requests and costs"),
  "assets.*": none("files Users upload"),
  "attachments.*": none("files Users upload"),
  "device.*": none("device simulators' state"),
  "filesystem.*": none("folder names"),
  "git.preparePullRequestThread": none("refs and links"),
  "git.resolvePullRequest": none("refs and links"),
  "git.runStackedAction": masked("vaults/maskGitProgress.ts", GIT_TEST),
  "guestShare.create": none("a share's link"),
  "mcpApps.*": {
    unmasked: "an MCP app's own answers, live to the User who runs it, never stored",
  },
  "orchestration.*": HISTORY,
  "orchestration.dispatchCommand": masked("vaults/maskEvents.ts", REJECTED_TEST),
  "orchestration.forceStopThread": none("nothing"),
  "orchestration.getTurnDiff": masked("checkpointing/CheckpointDiffQuery.ts", HISTORY_TEST),
  "orchestration.getFullThreadDiff": masked("checkpointing/CheckpointDiffQuery.ts", HISTORY_TEST),
  "orchestration.subscribeCommandOutput": masked(
    "orchestration-v2/CommandOutputHub.ts",
    COMMAND_OUTPUT_TEST,
  ),
  "preview.*": none("previews' addresses and status"),
  "projectClone.*": none("a clone's progress"),
  "projects.*": none("Projects and file names"),
  "projects.readFile": masked("vaults/maskWorkspace.ts", HISTORY_TEST),
  "projects.searchContents": masked("vaults/maskWorkspace.ts", HISTORY_TEST),
  "projects.writeFile": masked("vaults/maskWorkspace.ts", SAVE_TEST),
  "provider.*": none("the Owner's provider sign-in and install flows"),
  "pullRequests.*": masked("vaults/maskPullRequests.ts", PULL_REQUEST_TEST),
  "pullRequests.linkedThreads": HISTORY,
  "review.*": masked("vaults/maskCheckoutReads.ts", REVIEW_TEST),
  "scheduledTasks.*": none("schedules and the webhooks that start them"),
  "secrets.answerRequest": none("an answer a User types"),
  "server.*": none("the Hub's settings, providers and resource figures"),
  "server.getTraceDiagnostics": {
    unmasked:
      "the Owner's own trace file: its lines carry every value the Hub process knows as [NAME] (the logs rule), not one Thread's",
  },
  "server.getProcessDiagnostics": {
    unmasked: "the Owner's own process list (spec 6); secrets never go in arguments (ticket 04)",
  },
  "shell.openInEditor": none("nothing"),
  "sourceControl.*": none("repositories and sign-ins"),
  "subscribe*": none("status and lists"),
  subscribeWorktreeSetup: masked("project/WorktreeSetupTracker.ts", SETUP_TEST),
  "terminal.*": none("nothing"),
  "terminal.open": masked("vaults/maskTerminal.ts", TERMINAL_TEST),
  "terminal.attach": masked("vaults/maskTerminal.ts", TERMINAL_TEST),
  "terminal.observe": masked("vaults/maskTerminal.ts", TERMINAL_TEST),
  "vaults.*": none("Vaults and secret names; values only through HTTP vaults.reveal"),
  "vcs.*": none("refs and status"),
  "worktreeSetup.cancel": none("nothing"),
};

/** HttpApi endpoints. */
export const HTTP_DOOR_RULES: Record<string, DoorRule> = {
  "appSignIn.*": none("sign-in"),
  "audit.*": none("audit entries: names and kinds, never values"),
  "auth.*": none("sessions and sign-in"),
  "environments.*": none("machines and their status"),
  "installationUsers.*": none("Users"),
  "invitations.*": none("invitations"),
  "mcpOAuth.*": none("MCP sign-in"),
  "metadata.*": none("the Hub's description"),
  "orchestration.*": HISTORY,
  "projects.*": none("Projects"),
  "pullRequests.diff": masked("vaults/maskPullRequests.ts", PULL_REQUEST_TEST),
  "sandboxImage.*": none("the Sandbox image's build"),
  "spaces.*": none("Spaces and Members"),
  "vaults.*": none("only vaults.reveal answers a value: the Owner's, on purpose"),
  "webhooks.*": none("webhooks coming in"),
};

/** Raw routes, as DoorRules names them. */
export const RAW_DOOR_RULES: Record<string, DoorRule> = {
  "ai/AiGatewayRoute.ts: *": {
    unmasked: "what agents send their AI provider and get back (decision 9: the provider sees it)",
  },
  "auth/clientAdmission.ts: *": none("admission"),
  "device/DeviceHubProxy.ts: *": none("device simulators"),
  "environments/JoinedHub.ts: *": none("health"),
  "environments/connectRoute.ts: *": {
    history: "the executor wire: each operation is in EXECUTOR_OPERATIONS",
  },
  "environments/gitRoute.ts: *": {
    unmasked:
      "the Hub repository's Git objects, to machines and Users that may fetch them; checkpoints are kept as written",
  },
  "guest/http.ts: GET GUEST_COMMAND_OUTPUT_ROUTE": masked(
    "orchestration-v2/CommandOutputHub.ts",
    COMMAND_OUTPUT_TEST,
  ),
  "guest/http.ts: GET GUEST_ATTACHMENT_ROUTE": none("files Users uploaded"),
  "guest/http.ts: GET GUEST_MEDIA_ROUTE": none("files Users uploaded"),
  "guest/http.ts: *": HISTORY,
  "http.ts: *": none("the web app, assets, uploads and browser traces"),
  "mcp/McpHttpServer.ts: *": { history: "MCP tools: each is in MCP_DOOR_RULES" },
  "preview/ServerBrowserStream.ts: *": {
    unmasked: "a browser preview's screen, live to the User who opened it",
  },
  "preview/hubPreviewRoute.ts: *": {
    unmasked: "a dev server's pages (as preview.proxyHttp), live, never stored",
  },
  "server.ts: *": none("routing"),
  "ws.ts: *": { history: "WS methods: each is in WS_DOOR_RULES" },
};

/** MCP tools. Their answers go to the calling agent, whose process holds its values anyway. */
export const MCP_DOOR_RULES: Record<string, DoorRule> = {
  "*": none("the calling agent's own work; what it says next is an event (masked)"),
  t3_thread_read: HISTORY,
  t3_thread_wait: HISTORY,
  t3_thread_search: HISTORY,
  t3_thread_list: HISTORY,
  thread_history: HISTORY,
  task_status: HISTORY,
  t3_background_wait: HISTORY,
  read_pull_request_guide: masked("vaults/maskPullRequests.ts", PULL_REQUEST_TEST),
  write_pull_request_guides: masked("vaults/maskPullRequests.ts", PULL_REQUEST_TEST),
};

const EVENTS: DoorRule = HISTORY;

/** Each executor operation a machine answers (the Hub machine's executor answers the same). */
export const EXECUTOR_OPERATIONS: Record<RemoteOperation | RemoteStreamOperation, DoorRule> = {
  "provider.openSession": none("the session's ids and features"),
  "provider.ensureThread": none("nothing"),
  "provider.resumeThread": EVENTS,
  "provider.startTurn": EVENTS,
  "provider.compactThread": EVENTS,
  "provider.steer": EVENTS,
  "provider.interrupt": none("nothing"),
  "provider.respond": none("nothing"),
  "provider.readThreadSnapshot": EVENTS,
  "provider.rollback": EVENTS,
  "provider.forkThread": EVENTS,
  "provider.injectHistory": none("whether the history was taken"),
  "provider.stopTask": none("nothing"),
  "provider.unloadThread": none("nothing"),
  "provider.hasPendingBackgroundWork": none("a boolean"),
  "provider.detach": none("nothing"),
  "textGeneration.threadHandoff": masked("orchestration-v2/ThreadMoveService.ts", HANDOFF_TEST),
  "textGeneration.threadTitle": EVENTS,
  "checkpoint.isGitRepository": none("a boolean"),
  "checkpoint.hasRef": none("a boolean"),
  "checkpoint.capture": none("refs and file paths"),
  "checkpoint.restore": none("nothing"),
  "checkpoint.diff": masked("checkpointing/CheckpointDiffQuery.ts", HISTORY_TEST),
  "checkpoint.listAuthoredPaths": none("file paths"),
  "checkpoint.deleteRefs": none("nothing"),
  "checkpoint.push": none("refs"),
  "checkpoint.fetch": none("refs"),
  "checkpoint.ensureScratch": none("a folder"),
  "move.publishScratch": none("refs"),
  "move.fetch": none("refs"),
  "move.prepare": none("a folder, refs and the setup script's status"),
  "move.recover": none("refs"),
  "files.read": masked("vaults/maskWorkspace.ts", HISTORY_TEST),
  "files.write": masked("vaults/maskWorkspace.ts", SAVE_TEST),
  "search.paths": none("file paths"),
  "search.contents": masked("vaults/maskWorkspace.ts", HISTORY_TEST),
  "entries.list": none("file names"),
  "entries.listIgnored": none("file names"),
  "entries.browse": none("folder names"),
  "terminal.open": masked("vaults/maskTerminal.ts", TERMINAL_TEST),
  "terminal.write": none("nothing"),
  "terminal.resize": none("nothing"),
  "terminal.clear": none("nothing"),
  "terminal.close": none("nothing"),
  "terminal.stream": masked("vaults/maskTerminal.ts", TERMINAL_TEST),
  "preview.open": none("a preview's address and status"),
  "preview.resize": none("nothing"),
  "preview.adjust": none("nothing"),
  "preview.close": none("nothing"),
  "preview.list": none("previews' addresses and status"),
  "preview.reportStatus": none("nothing"),
  "preview.events": none("previews' addresses and status"),
  "preview.proxyHttp": {
    unmasked: "a dev server's own pages, live to the User who may open them, never stored",
  },
  "preview.proxySocket": { unmasked: "a dev server's own WebSocket, as preview.proxyHttp" },
  "preview.proxySocketSend": none("nothing"),
};

/** Who writes the Hub's Thread tables, and why it stores no unmasked process text. */
export const ORCHESTRATION_TABLE_WRITERS: Record<string, string> = {
  "orchestration-v2/EventSink.ts": "masks every event, effect and rejected command it writes",
  "orchestration-v2/ProjectionStore.ts": "projects the events EventSink wrote (masked)",
  "orchestration-v2/messageSearchIndex.ts": "indexes projected messages (masked)",
  "orchestration-v2/ProjectionMaintenance.ts": "rebuilds projections from stored events (masked)",
  "orchestration-v2/EffectOutbox.ts": "the outbox, written through EventSink (masked)",
  "orchestration-v2/TurnItemPositionStore.ts": "item positions only",
  "orchestration-v2/ThreadMoveService.ts": "masks each handoff before storing it",
  "orchestration-v2/legacy/LegacyV1ThreadImporter.ts": "imports history from before Vaults",
};
