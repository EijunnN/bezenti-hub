# Sandboxes

A Space's Sandbox (ADR 0004) is a joined T3 server the Hub runs for that Space. It is an
Environment like any joined machine, `kind = 'sandbox'` with the Space's `space_id` and no owner,
so remote execution, checkpoints, the Hub repository, moves and disconnections apply unchanged. Its
lifecycle is a row in `sandboxes` (migration 100).

## Identity and credential

A Space has one Sandbox id for its whole life, `sandbox:<spaceId>`
(`sandboxEnvironmentIdOf`). The Environments list shows it for every Space the viewer may run
Threads in before it exists, so the composer can offer it; choosing it in `chooseForThread` makes
it ([Sandboxes](../../apps/server/src/sandboxes/Sandboxes.ts)). The Hub issues the credential itself,
with no approval: the Sandbox keeps it in its home, the Hub only its hash, as for `t3 join`. A home
lost while the row stays gets a new credential on its next start.

What the credential reaches is decided by the Space, never by a User:

- `environment.use` on a Sandbox needs the Thread's Space to be the Sandbox's (`workSpaceId` in
  [AccessPolicy](../../apps/server/src/auth/AccessPolicy.ts)), so placement, moves and forwarded
  workspace calls never put another Space's Thread on it, whoever asks. Callers that place or
  forward pass the Thread (or the claimed Space of a new one).
- The [git route](../../apps/server/src/environments/gitRoute.ts) serves a Sandbox only the
  repositories of its own Space: a Project's, or a Thread's own repository by the Thread's Space.
- A Sandbox never `leave`s, and is not renamed or removed as a machine.

## Runtime

Only implementations of [SandboxRuntime](../../apps/server/src/sandboxes/SandboxRuntime.ts) touch
processes or containers. The process runtime runs `t3 serve --base-dir <Hub home>/sandboxes/<id>`
as a child of the Hub, with the Hub's environment stripped to `PATH`, locale and temp dirs and
`HOME` set to the Sandbox's home; a dev Hub passes its `--dev-url`, so its Sandboxes have the Replay
provider. It isolates nothing beyond the home; the Podman runtime does. Its children end with the
Hub, and a start after a restart reads the Hub's address again, since a dev Hub's port can move.

A Sandbox counts as started once its socket is ready, which `EnvironmentConnections.markReady`
signals after the welcome, the recorded hello and the executor's registration: a Thread placed
right after must find its providers and executor.
