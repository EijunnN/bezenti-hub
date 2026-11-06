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
  there. New worktrees are still made on the Hub machine only, so placing a Thread that asks for
  one (a launch strategy, or a `thread.create` with a worktree) on another Environment is refused.

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
