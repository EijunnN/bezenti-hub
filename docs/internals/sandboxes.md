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
anything is starting, or while a send waits on a Sandbox): the Thread says «Starting the
Sandbox…», or «The Sandbox could not start» with the reason and «Try again»
(`POST /api/environments/start`, for Users who may run Threads in its Space, disabled while the
request is out).

**A start belongs to the Hub.** [Sandboxes](../../apps/server/src/sandboxes/Sandboxes.ts) runs one
supervised start per Space in its own scope: asking again joins it, and whoever asked only waits
for it, with a timeout of their own, so a caller that gives up never leaves it half-started. The
per-Space lock is held only to make it and mark it `starting`, to mark it `running`, and to stop
it; never across the boot. Every start ends `running` or `failed`; a server that did not become
ready in time (or at all) is stopped first, and the runtime waits for it to end, so nothing runs
that the Hub does not track. Each start is audited `sandbox.start` with `via` (`demand`, `retry`),
`outcome` (`started`, `failed`) and the trimmed `reason`, naming the User whose action caused it.

Placing a Thread never starts it. Work goes through
[EnvironmentDemand](../../apps/server/src/environment/EnvironmentDemand.ts), which only the
Sandboxes provide:

- A User's own action starts it and waits (`awaitStarted`, `explicit`): commands the Orchestrator
  decides with the machine (`message.dispatch`, rollback, provider switch, starting a queued run, a
  move onto it), and workspace calls that act (opening or typing in a terminal, writing a file,
  opening a preview). A failed start refuses the command with `ThreadEnvironmentUnavailableError`
  (`sandbox-failed`). A guest's message does not start it.
- Reads (listings, search, reading files, preview and terminal lists) on a Sandbox that is not
  running answer «Sandbox stopped» at once (`ready`), start nothing and count as no use, so a
  client that polls never keeps a Sandbox up.
- Machine-bound effects wait unclaimed, spending no attempt; when the worker finds nothing to claim
  it asks the Sandboxes their work waits for to start (`EffectOutbox.environmentsAwaited`, cleanup
  effects aside).
- A `failed` Sandbox starts again only for a User: «Try again», or their own action after a ten
  second backoff. Waiting work never restarts it.

A running Sandbox stops after `T3CODE_SANDBOX_IDLE_SECONDS` (30 minutes by default) with no run in
progress on it (a projection that cannot be read counts as busy), nothing holding it, and no use
since (`sandbox.stop` via `idle`). Use is `EnvironmentDemand.touch` (every action and start) and
`EnvironmentDemand.hold`, keyed per holder, for as long as something stays open (an attached
terminal stream; previews served through the Hub call the same). Each Space is checked on its own.
The stop marks the Sandbox stopping under its lock before checking again, so work that arrives
meanwhile waits for the stop to end and then starts it again. Only the wait between checks reads
`SandboxLifecyclePolicy`'s clock (a TestClock in tests); the policy also sets the start timeout.

A server that exits by itself while running is `stopped` with why, and its socket is closed at
once, so its Threads are away as on any machine that dropped (spec 2: «paused, environment
offline»). If a run was in progress on it, the Hub starts it again: the hello lists no sessions,
so the turn ends interrupted and its history stays. Every such exit counts: more than three in ten
minutes leaves it `failed` until a User starts it. A start under way reports its own failure; an
exit never overwrites it.
