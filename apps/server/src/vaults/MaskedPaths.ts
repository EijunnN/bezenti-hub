/**
 * Spec 5 ticket 05: every way a Thread's process output reaches the Hub, and where `[NAME]` masking
 * applies (`masked`: that file uses the masker), or why not (`noProcessText`, `unmasked`).
 * `MaskedPaths.test.ts` fails when a path is added without a line here.
 */
import type { RemoteOperation, RemoteStreamOperation } from "../environment/RemoteExecutorWire.ts";

export type MaskedPath =
  | { readonly masked: string; readonly how: string }
  | { readonly noProcessText: string }
  | { readonly unmasked: string };

const EVENTS: MaskedPath = {
  masked: "orchestration-v2/EventSink.ts",
  how: "its items become domain events, masked before they are stored, projected or published",
};
const NO_TEXT = (what: string): MaskedPath => ({ noProcessText: what });

/** Each executor operation a machine answers (the Hub machine's executor answers the same). */
export const EXECUTOR_OPERATIONS: Record<RemoteOperation | RemoteStreamOperation, MaskedPath> = {
  "provider.openSession": NO_TEXT("the session's ids and features"),
  "provider.ensureThread": NO_TEXT("nothing"),
  "provider.resumeThread": EVENTS,
  "provider.startTurn": EVENTS,
  "provider.compactThread": EVENTS,
  "provider.steer": EVENTS,
  "provider.interrupt": NO_TEXT("nothing"),
  "provider.respond": NO_TEXT("nothing"),
  "provider.readThreadSnapshot": EVENTS,
  "provider.rollback": EVENTS,
  "provider.forkThread": EVENTS,
  "provider.injectHistory": NO_TEXT("whether the history was taken"),
  "provider.stopTask": NO_TEXT("nothing"),
  "provider.unloadThread": NO_TEXT("nothing"),
  "provider.hasPendingBackgroundWork": NO_TEXT("a boolean"),
  "provider.detach": NO_TEXT("nothing"),
  "textGeneration.threadHandoff": {
    masked: "orchestration-v2/ThreadMoveService.ts",
    how: "the handoff is masked before `orchestration_v2_move_handoffs` and its turn item (events)",
  },
  "textGeneration.threadTitle": EVENTS,
  "checkpoint.isGitRepository": NO_TEXT("a boolean"),
  "checkpoint.hasRef": NO_TEXT("a boolean"),
  "checkpoint.capture": NO_TEXT("refs and file paths"),
  "checkpoint.restore": NO_TEXT("nothing"),
  "checkpoint.diff": {
    masked: "checkpointing/CheckpointDiffQuery.ts",
    how: "turn and thread diffs are masked before they reach a client",
  },
  "checkpoint.listAuthoredPaths": NO_TEXT("file paths"),
  "checkpoint.deleteRefs": NO_TEXT("nothing"),
  "checkpoint.push": NO_TEXT("refs"),
  "checkpoint.fetch": NO_TEXT("refs"),
  "checkpoint.ensureScratch": NO_TEXT("a folder"),
  "move.publishScratch": NO_TEXT("refs"),
  "move.fetch": NO_TEXT("refs"),
  "move.prepare": NO_TEXT("a folder, refs and the setup script's status"),
  "move.recover": NO_TEXT("refs"),
  "files.read": {
    masked: "environment/ThreadWorkspace.ts",
    how: "`readFile` masks the contents a client sees",
  },
  "files.write": NO_TEXT("nothing"),
  "search.paths": NO_TEXT("file paths"),
  "search.contents": {
    masked: "environment/ThreadWorkspace.ts",
    how: "a match on a line holding a value is dropped (a search would otherwise spell it out)",
  },
  "entries.list": NO_TEXT("file names"),
  "entries.listIgnored": NO_TEXT("file names"),
  "entries.browse": NO_TEXT("folder names"),
  "terminal.open": {
    masked: "environment/ThreadWorkspace.ts",
    how: "the snapshot's history is masked",
  },
  "terminal.write": NO_TEXT("nothing"),
  "terminal.resize": NO_TEXT("nothing"),
  "terminal.clear": NO_TEXT("nothing"),
  "terminal.close": NO_TEXT("nothing"),
  "terminal.stream": {
    masked: "vaults/maskTerminal.ts",
    how: "output and snapshots are masked; a value split between frames is held and masked whole",
  },
  "preview.open": NO_TEXT("a preview's address and status"),
  "preview.resize": NO_TEXT("nothing"),
  "preview.adjust": NO_TEXT("nothing"),
  "preview.close": NO_TEXT("nothing"),
  "preview.list": NO_TEXT("previews' addresses and status"),
  "preview.reportStatus": NO_TEXT("nothing"),
  "preview.events": NO_TEXT("previews' addresses and status"),
  "preview.proxyHttp": {
    unmasked:
      "a dev server's own pages, proxied live to the User who may open them and never stored; " +
      "masking would break the app (its bundles, its forms)",
  },
  "preview.proxySocket": { unmasked: "a dev server's own WebSocket, as preview.proxyHttp" },
  "preview.proxySocketSend": NO_TEXT("nothing"),
};

/** What reaches the Hub besides the operations' answers. */
export const OTHER_PATHS: Record<string, MaskedPath> = {
  "provider events (the session's event stream)": EVENTS,
  "live command output (command_output.delta)": {
    masked: "orchestration-v2/CommandOutputHub.ts",
    how: "chunks are masked before viewers get them; a value split between chunks is held",
  },
  "terminal history files of a machine's shells": {
    masked: "terminal/Manager.ts",
    how: "every value the process knows is masked when the history is written",
  },
  "Hub logs (console and OTLP)": {
    masked: "serverLogger.ts",
    how: "messages and causes, with every value the process knows",
  },
  "provider event logs (events.log)": {
    masked: "provider/EventNdjsonLogger.ts",
    how: "each line, with every value the process knows",
  },
  "joined machine's logs, spans and provider event logs": {
    masked: "environments/EnvironmentAgent.ts",
    how: "values it receives join the process's known values, which its logger and tracer mask",
  },
};

/**
 * Who writes the Hub's Thread tables, and why it stores no unmasked process text. A new writer
 * must be added here (`MaskedPaths.test.ts` scans the sources for inserts and updates).
 */
export const ORCHESTRATION_TABLE_WRITERS: Record<string, string> = {
  "orchestration-v2/EventSink.ts": "masks every event it writes",
  "orchestration-v2/ProjectionStore.ts": "projects the events EventSink wrote (masked)",
  "orchestration-v2/messageSearchIndex.ts": "indexes projected messages (masked)",
  "orchestration-v2/ProjectionMaintenance.ts": "rebuilds projections from stored events (masked)",
  "orchestration-v2/EffectOutbox.ts": "work to do: ids and commands from Users, not process output",
  "orchestration-v2/TurnItemPositionStore.ts": "item positions only",
  "orchestration-v2/ThreadMoveService.ts": "masks each handoff before storing it",
  "orchestration-v2/legacy/LegacyV1ThreadImporter.ts": "imports history from before Vaults",
};

/**
 * The doors that give a client a Thread's history: each reads the masked store, never a live
 * provider stream. `MaskedPaths.test.ts` checks none of them reads one.
 */
export const HISTORY_DOORS: ReadonlyArray<string> = [
  "ws.ts",
  "orchestration-v2/http.ts",
  "guest/http.ts",
  "guest/GuestShareService.ts",
  "mcp/OrchestratorMcpService.ts",
  "mcp/toolkits/threadHistory/handlers.ts",
];
