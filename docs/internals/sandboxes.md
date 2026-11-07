# Sandboxes

A Space's Sandbox (ADR 0004) is a joined T3 server the Hub runs for that Space. It is an
Environment like any joined machine, `kind = 'sandbox'` with the Space's `space_id` and no owner,
so remote execution, checkpoints, the Hub repository, moves and disconnections apply unchanged. Its
lifecycle is a row in `sandboxes` (migration 100).

## Identity and credential

A Space has one Sandbox id for its whole life, `sandbox:<spaceId>`
(`sandboxEnvironmentIdOf`). With a runtime on, the Environments list shows it, `stopped`, for every
Space the viewer may run Threads in before it exists, so the composer can offer it; choosing it in
`chooseForThread` makes it, stopped ([Sandboxes](../../apps/server/src/sandboxes/Sandboxes.ts)). The Hub
issues the credential itself, with no approval: the Sandbox keeps it in its home, the Hub only its
hash, as for `t3 join`. A home lost while the row stays gets a new credential on its next start.

What the credential reaches is decided by the Space, never by a User:

- `environment.use` on a Sandbox needs the Thread's Space to be the Sandbox's (`workSpaceId` in
  [AccessPolicy](../../apps/server/src/auth/AccessPolicy.ts)), so placement, moves and forwarded
  workspace calls never put another Space's Thread on it, whoever asks. Callers that place or
  forward pass the Thread, or the Space a new one is claimed in (`ThreadLaunchService` claims it
  before placing, as `thread.create` will).
- The executor refuses to open a session or start a turn on a Sandbox for a Thread whose Space is no
  longer the Sandbox's (`SandboxSpaceMismatchError`), until moving such Threads exists.
- The [git route](../../apps/server/src/environments/gitRoute.ts) serves a Sandbox only the
  repositories of its own Space: a Project's, or a Thread's own repository by the Thread's Space.
- A Sandbox never `leave`s, and is not renamed or removed as a machine. Archiving its Organization
  stops it and nothing starts it meanwhile; deleting the Organization revokes the credential and
  removes its row and home.

A runtime must never let one Sandbox see another's home: each credential lives in its own home
only, so a container gets its own volume and nothing else of the Hub's (the Podman runtime).

## Runtime

Only implementations of [SandboxRuntime](../../apps/server/src/sandboxes/SandboxRuntime.ts) touch
processes or containers. Without one that runs Sandboxes the Hub offers none and placement refuses
them (`sandbox-unavailable`).

The [process runtime](../../apps/server/src/sandboxes/ProcessSandboxRuntime.ts) is for tests and
development only, on with `T3CODE_SANDBOX_RUNTIME=process`: it isolates nothing from the Hub's user,
so every Sandbox could read the others' credentials. It runs `t3 serve --base-dir
<Hub home>-sandboxes/<id>`, beside the Hub's home rather than in it, as a child of the Hub with the
environment stripped to `PATH`, locale and temp dirs, `HOME` the Sandbox's home, and a start token;
a dev Hub passes its `--dev-url`, so its Sandboxes have the Replay provider. The Hub address it
gives is always loopback; a Hub bound only to another address runs no Sandbox. Its children end
with the Hub; one left by a Hub that crashed is found by the pid file beside its home and stopped,
once its command line and start token prove it is that server, before another starts on the home.

A Sandbox counts as started once its socket is ready: `markReady` on the attached socket (not a
replaced one) after the welcome, the recorded hello and the executor's registration, so work that
waited for it finds its providers and executor. A server that ends first fails the start at once
with its exit code. A launch runs with the runtime's own services, never those of whoever asked
for the start.

## Lifecycle: started for work, stopped when idle

`sandboxes.status` is `stopped`, `starting`, `running` or `failed` (with `last_error`). The
Environments list shows a Sandbox `starting` from the moment its start begins until it is ready,
`failed` with `startError` when its last start failed, online once running and connected, and
`stopped` otherwise. Clients read it from the shared Environments list (polled every second while
anything is starting): the Thread says «Starting the Sandbox…», or «The Sandbox could not start»
with the reason and «Try again» (`POST /api/environments/start`, for Users who may run Threads in
its Space; audited `sandbox.start` via `retry`).

Placing a Thread never starts it. Work that needs the machine does, through
[EnvironmentDemand](../../apps/server/src/environment/EnvironmentDemand.ts), which only the Sandboxes
provide:

- Commands the Orchestrator decides with the machine (`message.dispatch`, rollback, provider
  switch, starting a queued run, a move onto it) wait in `ThreadManagementService` for it to be
  ready; a failed start refuses them with `ThreadEnvironmentUnavailableError` (`sandbox-failed`).
- Machine-bound effects wait unclaimed, spending no attempt, as for any machine that is away;
  when the worker finds nothing to claim it asks the Sandboxes their work waits for to start
  (`EffectOutbox.environmentsAwaited`, cleanup effects aside). One whose last start failed waits
  for a User: «Try again», or a command that waits on it.
- Workspace RPCs (files, search, terminals, previews) start it and wait, then go on as on any
  machine; one that cannot start answers `environment_offline`.

Each start is audited `sandbox.start` (`demand` or `retry`). A running Sandbox stops after
`T3CODE_SANDBOX_IDLE_SECONDS` (30 minutes by default) with no run in progress on it, nothing
holding it, and no use since (`sandbox.stop` via `idle`). Use is `EnvironmentDemand.touch` (every
workspace call, every command that waited on it, its start) and `EnvironmentDemand.hold` for as
long as something stays open (an attached terminal stream; previews served through the Hub call
the same). The idle check reads `SandboxIdlePolicy`'s clock, which tests replace with a TestClock.

A server that exits by itself while running is `stopped` with why, and its socket is closed at
once, so its Threads are away as on any machine that dropped (spec 2: «paused, environment
offline»). If a run was in progress on it, the Hub starts it again: the hello lists no sessions,
so the turn ends interrupted and its history stays. One that exits more than three times in ten
minutes is left `failed` instead. A start under way reports its own failure; an exit never
overwrites it.
