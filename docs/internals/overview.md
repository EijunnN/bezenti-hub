# Architecture

T3 Code keeps execution in the environment that owns the workspace. Web, desktop, and mobile
clients control it over authenticated RPC. A remote client must never substitute its own filesystem,
provider credentials, or machine state for the environment's. The desktop app bundles a server,
but its renderer follows the same boundary.

## Ownership boundaries

Provider processes, terminals, Git, and project files belong to the server. Shared connection and
domain state belongs in `packages/client-runtime`; clients supply platform services and UI.
Keeping that logic shared prevents reconnect and multi-environment behavior from diverging between
web and mobile. See [connection runtime](./connection-runtime.md) and
[remote environments](./remote.md).

The [RPC contract](../../packages/contracts/src/rpc.ts) is the boundary between independently
versioned clients and servers. Subscriptions send the state a client needs, so a client viewing one
thread does not pay for every thread's history. Authentication of a socket does not authorize every
method on it. See [environment auth](./environment-auth.md).

### Pull request linking compatibility

Every protocol-2 environment advertises `threadPullRequests`. Once an environment's server config
has loaded, clients use persisted `pullRequests[]`, multi-link commands, stack UI, and reverse thread
lookup. Before that, they hide linking actions.

Environments keep advertising `threadPullRequestLinking`, accepting legacy metadata commands, and
emitting the derived `linkedPullRequest` field, because older clients still read them. That
hostless field includes only links in the thread project's own repository. Retain the legacy wire
fields, projection column, and replay support.

Provider-specific behavior belongs behind an adapter. Orchestration works with normalized commands
and events, so adding a provider should not require branches throughout the domain or clients.
See [provider constraints](./providers.md).

## Settings ownership

Client preferences stay in the current client; environment defaults and project overrides stay
on their owning server. The web and desktop settings target is URL state, resolved against current
connections and project membership. An unavailable target must not fall back to another environment.
**All environments** is an explicit bulk edit of connected, loaded servers, not a durable global
default or a promise to synchronize offline or future environments. Project-group targets similarly
select known environment-local checkouts; the group itself does not store inherited defaults.

## Durable intent and side effects

Orchestration state is decided as events, and projections are the source of truth once they apply
them. The [v2 orchestrator](../../apps/server/src/orchestration-v2/Orchestrator.ts) serializes commands and
decides events without performing provider or filesystem work.
[EventSink](../../apps/server/src/orchestration-v2/EventSink.ts) commits events, persisted projections,
the accepted command receipt, and outbox effects in one database transaction. Subscribers receive
events after that commit. This keeps command retries idempotent and prevents a persisted projection
from getting ahead of the event log.

The [effect worker](../../apps/server/src/orchestration-v2/EffectWorker.ts) performs side effects
after intent has been recorded, then feeds results back into orchestration. A command acknowledgement
therefore means the intent committed, not that the provider, checkpoint, or other follow-up work
finished. Keep external I/O out of command decisions and the database transaction. Effects tied to
a lost provider process cannot simply replay; recovery retires them before admitting new work.

The event log only keeps what live readers need: about a day of history for reconnect replay and
command-id retries.
[ProjectionMaintenance](../../apps/server/src/orchestration-v2/ProjectionMaintenance.ts) deletes
older events the projections cover, so projections cannot be rebuilt from the log. It keeps each
stream's newest event (high-water marks, stream versions, snapshot sequences), `thread.created`
(the legacy importer's marker), every `running` run update (Codex usage history reads the first
of each attempt), and prompt anchors that retained subagent rows reference. A client whose cursor
is below both its thread's newest event and the recorded pruned-through sequence missed pruned
events, so it resumes from a snapshot; an idle thread's cursor resumes without one. Resumes
recheck that sequence after reading the replay, since a pass can prune during the read. V2 command
receipts stay for idempotency: a retry older than the retained history is still deduplicated,
but its replay comes back without the pruned events. Receipts of imported legacy commands are
removed once their threads are imported.

Retained events must remain decodable on replay. Changing a schema affects old environments at
startup as well as live RPC traffic. Compatibility work must account for stored history, not just
what the newest client sends.

## Environment executors

Everything that needs a machine sits behind one
[Environment executor](../../apps/server/src/environment/EnvironmentExecutor.ts) per Environment:
the provider adapters (sessions, turns, interrupt, steer, respond, rollback, detach, events), the
workspace (checkpoints, runtime policy and cwd, files, search, browse, terminals, previews) and the
host (resources and provider capabilities). The Hub machine registers an in-process executor under
`HUB_MACHINE_ENVIRONMENT_ID`; a joined Environment's executor
([RemoteEnvironments](../../apps/server/src/environment/RemoteEnvironments.ts)) carries the same
operations, catalogued and versioned in
[the executor contract](../../packages/contracts/src/environmentExecutor.ts), over its WebSocket,
and is registered only while that socket is open. The payload codecs of each operation
([RemoteExecutorWire](../../apps/server/src/environment/RemoteExecutorWire.ts)) live in the server
beside the adapter schemas they are built from; both halves of the server share them.

`ProviderAdapterRegistryV2`, `RuntimePolicyV2` and `CheckpointStore` reach the orchestration as
layers over the executors. Calls that carry a Thread resolve its Active environment each time: a
session opens there, and its runtime policy and capabilities come from there. Checkpoint calls
carry only a cwd, so the effect worker runs every effect that needs the Thread's machine
(`ENVIRONMENT_BOUND_EFFECT_TYPES`) with its Thread's Environment as the checkpoint target;
`HUB_EFFECT_TYPES` run on the Hub. The Active environment is the projection's
`active_environment_id` (migration 096, absent in the payload for the Hub machine), read on each
call, and the registry takes the resolver when it is built: a reference read at call time would
see the caller's fiber, not the server's. An effect bound to a machine whose Environment has no
executor is never claimed (`claimNext` filters on the projection), so it spends no attempt while
the machine is away and runs when its socket returns; anything else that reaches a missing executor
gets a typed error and retries.

The Orchestrator reads capabilities through `EnvironmentCapabilityCache`. For the Hub machine that
reads the live adapter, as before. A remote executor answers from its last snapshot, the newest by
`observedAt`, which every hello and heartbeat carries, so deciding makes no network call. The Hub
machine also publishes a snapshot at startup, when provider instances change, and on every
heartbeat; instances it cannot describe are listed with the reason. The Orchestrator also resolves
runtime policy while deciding (a checkpoint scope's cwd), so a remote executor computes it on the
Hub from the reported checkout and runtime modes, never by asking the machine.

### Turns on a joined Environment

The Hub decides where a new Thread runs (`EnvironmentRegistry.chooseForThread`, called by
`ThreadManagementService` for every `thread.create`): the User's choice, else the Project's
preferred Environment, else the Hub machine. Another Environment must be one the User may use
(`environment.use`: a personal machine is its owner's alone, the Owner included), online, and have
the provider. The client never picks by load.

On the machine, the [agent](../../apps/server/src/environments/EnvironmentAgent.ts) runs each call
on its own in-process executor. Constraints that span both halves:

- Each session event carries `(providerSessionId, seq)`. The machine keeps what the Hub has not
  acknowledged and resends it after a reconnect; the Hub drops a `seq` it already has and
  acknowledges in one frame per burst. `command_output.delta` has no `seq`: it is live only.
- The Hub drops (and logs) an event for a session it retired, or from a machine that is no longer
  the Thread's Active environment, before it reaches the session manager.
- A call made by an effect carries `effectId:<operation>:<n>`, the same on a resend and on the
  effect's next attempt. The Hub resends it on the next socket (waiting a bounded time for one);
  the machine runs a key once, joins a resend to the running call and answers later ones from
  memory. A failed answer is not kept, so a retry runs again.
- The hello names the sessions the machine still runs: the Hub ends the ones it lost and tells it
  to drop the ones the Hub no longer has (`provider.retired`, as after a Hub restart). A session's
  end is spooled in its event order, so it is reported even if it happened while offline.
- The Hub acknowledges an event only once it has delivered or refused it. If the Thread cannot be
  read, it delivers nothing more for that session until the machine resends after a reconnect.
- Machine work for a Thread whose Environment is away waits without holding back the Hub's own
  effects on that Thread; work for a removed Environment fails on its first attempt, and its
  cleanup is skipped (`threadEnvironmentRemoved`, where ticket 10's «needs an environment» hooks in).
- The agent reaches the Hub's MCP: the Hub issues the per-Thread credential as for a local session,
  and the machine points it at `<the Hub URL it joined>/mcp`. Its own MCP server is not used.
- Attachments stay on the Hub. A turn sends each one's id and SHA-256; the machine fetches the ones
  it lacks with `attachment.read`, which answers only attachments a live session's turn sent to
  that machine, while the Thread still runs there.
- The machine uses the Project's checkout where it is, else clones the Hub checkout's `origin`
  there; when the Hub repository has the Thread's checkpoints, the session's open names them and
  the checkout fetches the ones it lacks. New worktrees are still made on the Hub machine only, so
  placing a Thread that asks for one (a launch strategy, or a `thread.create` with a worktree) on
  another Environment is refused; only a move (below) makes one elsewhere.

### Hub repository

The Hub keeps one bare repository per Project under `<state dir>/hub-repositories`
([HubRepository](../../apps/server/src/checkpointing/HubRepository.ts)), so a turn's checkpoint
outlives the machine that captured it. After `checkpoint.capture` commits, the
[uploader](../../apps/server/src/orchestration-v2/CheckpointUploadService.ts) asks the Thread's
Active environment to push the refs of every ready checkpoint not yet uploaded, in batches that
fall back to one ref at a time, and marks each pushed one with `checkpoint.uploaded` (column
`uploaded_to_hub`, migration 097). It runs outside the effect lane, so a slow or failing upload
never holds back the Thread's next turn: failures retry with backoff, at once when an Environment
connects, and from the projection after a restart. A ref the current machine lacks (captured on
the one the Thread left) is set aside until the Thread runs elsewhere instead of failing the rest.
It is tracked per checkpoint, not as an ordinal per scope, because a rollback reuses its ordinals:
a mark is written only if the checkpoint still has the ref and capture time that were pushed.

The Hub machine pushes to the repository on disk through the same executor operation
(`checkpoint.push`), so there is one path; joined machines use `/api/git/<projectId>`
([gitRoute](../../apps/server/src/environments/gitRoute.ts)), git smart HTTP relayed to
`git http-backend` with no system or user git config. Each request carries the Environment
credential, which `t3` hands git through a credential helper in the process environment that
answers only the Hub's own protocol and host (redirects are not followed), after an empty helper
that drops the user's own. The route checks the credential on every request, so a removed machine
loses access at once, and serves only Projects where the machine's owner may start Threads. Within
one, a machine sees and writes only the refs of Threads it is the Active environment of (their
checkpoint scopes, `refs/t3/threads/<id>/`, `refs/t3/recovered/<id>/`, the id percent-encoded):
`transfer.hideRefs` hides the rest, and the ref updates of a push are read and checked before git
sees them. The target of a Thread's running move also reads (never writes) that Thread's refs, so
it can fetch what the Thread continues from before the Thread is its own. Nobody deletes a ref; an update need not fast-forward, since a rollback reuses its own
checkpoint refs. Transfers always name the Hub repository by URL or path, never a remote of the
checkout, so nothing reaches `origin`.

Turn and Thread diffs read the Hub repository once both checkpoints are marked uploaded (a ref
there may be an older capture of a reused ordinal), so they work with the machine offline; until
then they run on the Thread's Active environment. A restore whose ref is missing in the workspace
(a move, or refs dropped there) fetches it from the Hub repository first.

### Threads without a Project

A Thread without a Project is a Thread in the scratch Project, whose workspace root is the Hub's
`<base dir>/scratch` ([ManagedProjectFolders](../../apps/server/src/project/ManagedProjectFolders.ts)).
Its worktree is its own folder there, made with `git init` so its turns get checkpoints. The folder
is inside the scratch Project's checkout, so its logical form is relative (`<folder>`) even for a
Thread created on another Environment, where it resolves under that machine's checkout of the
scratch Project (`<workspace root>/scratch/<folder>`); `ThreadManagementService` places such a
Thread anywhere, while other worktrees still need the Hub machine. A machine opening a session for
one makes the folder, with git, instead of cloning (`WireCheckout.scratch`).

Its checkpoints go to a Hub repository of its own, never one shared by every such Thread
([ScratchWorkspace](../../apps/server/src/environment/ScratchWorkspace.ts)):
`HubRepositoryKey { projectId, scratchThreadId }`, under `hub-repositories/threads/`, served at
`/api/git/thread/<threadId>`. `HubRepositories.keyOfThread` decides it from the projection (the
Thread's Project is the scratch one), and every transfer (`checkpoint.push`/`fetch`, the session's
fetch, a move's fetch) carries `scratchThreadId`. The route authorizes as for a Project (the
machine's owner may start Threads in its Space) and then serves only the Thread's Active
environment and the target of its running move; anyone else gets 403. `/api/git/<scratch Project>`
is 404. Diffs read it once uploaded, as a Project's.

A move of one keeps its folder name: `move.fetch` gets `scratch { threadId, folder }` and makes
`<the target's checkout of the scratch Project>/<folder>` (with git) as the checkout, and
`move.prepare` with `scratch` works in that folder, never a worktree, and runs no setup script. What
the folder already had there that differs from its HEAD is captured to
`refs/t3/recovered/<id>/<time>/workspace` before the checkpoint's files are laid over it. A Thread
made before its folder had git has no checkpoints, and its move fails at `final-checkpoint`.

### Moving a Thread

`thread.move { threadId, targetEnvironmentId, ifRunning }` is a client command. The Hub checks the
target first (`ThreadManagementService`: the sender may use it, it is online and has the Thread's
provider, as for placing a new Thread), then the Orchestrator applies the Role rules of continuing
the Thread (`commandAccess.ts`), refuses a move without its User or while one runs, and records the
move on the Thread (`thread.move-updated`, field `move`) at its first step. Everything else is
[ThreadMoveService](../../apps/server/src/orchestration-v2/ThreadMoveService.ts), outside the
effect lane: each step is written to the Thread under its lock, so clients show it and a restart
resumes from the recorded step. While a move runs, the Orchestrator refuses whatever would start or
continue work on the source (`BLOCKED_WHILE_MOVING`: messages, the queue, prepared-run retries,
rollbacks, forks, provider switches; answering the running turn's requests stays allowed while the
move waits for it) and holds the queue, which resumes on wherever the Thread runs once the move ends.

1. `waiting-for-turn`: the service asks the Orchestrator to leave it (`thread.move.advance`),
   which decides with the Thread's runs, so no run starts between the check and the step. It wakes
   on each change to the Thread's runs, says when the turn waits on the User (`waitingOn`), and
   with `stop` sends `thread.stop` once.
2. `final-checkpoint`: only with the source online. The source captures its workspace (manual
   changes included) to `refs/t3/threads/<id>/moves/<moveId>`, one ref per move so a fetch never
   sees a stale one, and pushes it. An offline source (or one that drops here) skips the step.
3. `fetching`: the move records what it continues from (`continuesFrom`: that final checkpoint,
   else the newest checkpoint marked uploaded, else nothing) and the target fetches it into the
   Project's checkout, cloning it first when the machine has none (`move.fetch`); the checkout is
   recorded (`targetCheckout`).
4. `preparing` (`move.prepare`, [MovedWorkspace](../../apps/server/src/environment/MovedWorkspace.ts)):
   the Thread always gets a worktree of its own on the target,
   `<worktrees>/<project id>/<thread id>`, never the Project's shared checkout. One is reused only
   if that checkout's `git worktree list` names it (a worktree it had there before, kept in
   `knownWorktrees`); a folder there that it does not name is refused. A branch the target had
   that the source's commit does not contain is kept under
   `refs/t3/recovered/<id>/<time>/branch/<branch>` first, a reused worktree's changes under
   `.../workspace`; a branch checked out in another worktree leaves this one detached. The
   checkpoint's files are laid over it and, in a new worktree only, the Project's setup script
   runs (resolved with the User's settings, with a terminal's environment); its output is a
   timeline item. A worktree the move made is removed if a later part fails.
5. `handoff`: empty for now; ticket 09 hands the agent on the target the conversation here.
6. `switched`: one batch sets `activeEnvironmentId` and the Thread's worktree (stored as the
   target's host path), clears `activeProviderThreadId` so the next turn opens a new native
   conversation on the target, detaches the Thread's provider sessions
   (`provider-session.detached`) and adds the timeline entry (`environment_move`: source, target,
   actor, `continuesFrom`). Then `RemoteEnvironments.threadMoved` drops the cached Active
   environment, so the source's late events are refused, and each source session is detached
   outside the effect lane (an offline source drops it on reconnect).

`thread.move.cancel` (same rule as moving) ends a running move before `switched`; the Thread stays
where it was and the timeline says «Move to X cancelled». A failure before `switched` marks the
move `failed` with the step and git's or the script's message. The audit log records `thread.move`
when it starts, switches, fails or is cancelled, with the allow-listed detail. After a restart a
machine that has not said hello yet is unknown, not offline: the move gives each one a minute
(`RECONNECT_GRACE`) before going on without the source or failing for the target. Scope cwds
recorded before a move are still the source machine's paths, so rolling back to a turn from before
the move is not supported yet.

### Workspace RPCs

A client's files, search, browse, terminal and preview RPCs name a folder, not a machine, so
[ThreadWorkspace](../../apps/server/src/environment/ThreadWorkspace.ts) takes the machine from the
Thread the call names (`threadId`, optional on the file, search and browse inputs): its Active
environment, or the Hub machine for a call that names none, a draft, or a Thread on the Hub
machine. A client path never picks a machine. Before forwarding, the Hub checks the spec 1 rules
(`RpcSpaceAccess`: a named Thread is not hidden for reads and is the User's work for writes,
terminals and previews) and `environment.use`, then locates every folder and path inside the
Thread's workspace (its worktree, else its Project's checkout), as the Hub records it or as the
machine reported it, and resolves it onto the machine. Anything outside is refused, including
absolute paths elsewhere and `..`; on another machine only the workspace itself can be browsed.

A forwarded call carries no idempotency key, so a dropped socket fails it at once as
`environment_offline` (`TerminalEnvironmentUnavailableError`, `PreviewEnvironmentUnavailableError`
for terminals and previews): nothing typed or saved waits to run later. Terminal output and
preview events are streams the Hub opens with a request; the machine sends their items as
`workspace.stream` frames, outside the provider events' `seq`, spool and acknowledgements, and
stops on `workspace.streamCancel` or when the socket closes, where the Hub ends them as offline and
the client reopens them. Each connected machine streams its preview events to the Hub for as long
as its socket lives. A joined machine treats every workspace as known, since the Hub authorized
and resolved the path. Server-rendered preview frames (`/api/preview-stream`) still come from the
Hub machine's own browser only.

### Logical workspace paths

A Project's checkout is a per-Environment fact. The Hub machine's checkout is always the Project's
`workspaceRoot`; another Environment uses the checkout chosen there
(`environment_project_checkouts`) or `<its workspace root>/<Project slug>`
([ProjectCheckouts](../../apps/server/src/environment/ProjectCheckouts.ts)). A path the projection
records (a Thread's `worktreePath`, a checkpoint scope's `cwd`) is still the Hub machine's absolute
path, which every Hub-local reader keeps using. Beside it the projection stores its
[logical form](../../apps/server/src/environment/WorkspaceLocation.ts): relative to the checkout,
or, when the path is not plainly inside it (a managed worktree, `..`, another folder), absolute and
bound to the Environment that recorded it. Only a form that resolves back to the identical string
is relative, so the Hub machine sees no change. A Thread on another Environment records its scope
cwds as that machine's paths, since its runtime policy resolves there; their logical forms are
still computed against the Hub machine's checkout, which a move between machines must revisit.

`RuntimePolicyV2` passes the recorded worktree through on the Hub machine. On another Environment
it resolves the stored logical form on that executor, or, when the row has none or its recorded
path has changed since, one computed against the Hub machine's checkout. A host-bound path on
another Environment is a `RuntimePolicyResolveError`, never a wrong directory. Scope cwds are
stored in logical form but still reach `CheckpointStore` as recorded; a Thread that runs or moves
elsewhere must resolve them the same way. A form is stored only once its Project's checkout is
known: a row projected before its Thread or Project stays null (a scope is filled when its Thread
row is written), so a missed join never freezes a path as host-bound.

## Turn completion and checkpoints

A provider turn ending and its follow-up work settling are separate milestones. Orchestration
records provider turn and run state independently from
[run finalization](../../apps/server/src/orchestration-v2/RunFinalizationService.ts). A late
checkpoint or diff must not extend the recorded provider duration or keep the client showing
provider work as active. PR discovery after completion also checks that the checkout still matches
the thread's non-default branch and that a newer run is not active.

[Checkpoints](../../apps/server/src/checkpointing/CheckpointStore.ts) use hidden Git refs to
capture workspace state without adding commits to the user's branch. A revert must coordinate
workspace state with the provider conversation. A provider that cannot roll back its conversation
must reject that operation before changing the filesystem.

Thread settlement is server-owned. The
[settlement service](../../apps/server/src/orchestration-v2/ThreadSettlementService.ts) evaluates PR
and inactivity settings without a connected client. Merge notifications invalidate cached PR state
and trigger a check. A merge outside T3, such as an agent running `gh pr merge`, sends no
notification, so the [PR sync reactor](../../apps/server/src/orchestration-v2/PullRequestSyncReactor.ts)
re-reads a thread's open links when a run that ran a merge or close command ends. Each forge's
definition names its CLI's commands in `changeRequestCloseCommand`. The guarded
`thread.auto-settle` command rejects newer activity, explicit settlement overrides, and live or
blocked work. It records the activity timestamp for stable
sorting and detaches idle provider sessions. Clients render the persisted result; they do not
derive settlement from their own clocks or PR caches.

## Waiting for asynchronous work

Tests use [drainable workers](../../packages/shared/src/DrainableWorker.ts) to wait until both the
queue and its current item have finished. An empty queue alone does not prove the worker is idle.

V2 tests also drain the effect worker or await a specific persisted event or receipt. Test signals
are separate from the durable command receipts that make dispatch idempotent. Production behavior
must use persisted state and events, not test instrumentation or assumptions about elapsed time.

The Electron shell acquires `DesktopPreReadyPlatform.layer` synchronously before asynchronous
services. On Linux this sets the desktop-entry identity and global-shortcut portal flags before
Chromium initializes its portal connection. Setting the identity later in `DesktopAppIdentity`
is too late: Chromium caches the first registration, including failures. The identity must match
the installed entry managed by `DesktopLinuxUrlHandler`. Pre-ready setup also refreshes that entry's
`Exec` path before portal registration: AppImage updates can remove the previous executable, which
makes the old entry invalid even though its filename is correct. The later URL handler avoids
rewriting an identical entry while the portal may be reading it. On Wayland, Electron's synchronous
shortcut-registration result only confirms submission; it does not confirm desktop consent or
an active binding.

Native modules never load in the Electron main process on the startup path, and the two the
snapshot feature keeps are isolated: `@crowecawcaw/xa11y` runs only in forked Node-mode children
(`SnapShotAccessibilityWorker`, `RegionSnapShotWorker`) and a worker thread, and `ffi-rs` loads
lazily inside `WindowsForeground.ts` for a handful of Win32 calls. macOS window lookup shells out
to `osascript` instead of a native addon. A crash or stall in any of these must not take the app
down, so new native capability goes in a child with a deadline, not an `import` in main.

See the [glossary](./glossary.md) for shared terms and the
[development runbook](../operations/development.md) for setup and checks.
