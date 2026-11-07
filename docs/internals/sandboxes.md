# Sandboxes

A Space's Sandbox (ADR 0004) is a joined T3 server the Hub runs for that Space. It is an
Environment like any joined machine, `kind = 'sandbox'` with the Space's `space_id` and no owner,
so remote execution, checkpoints, the Hub repository, moves and disconnections apply unchanged. Its
lifecycle is a row in `sandboxes` (migration 100).

## Identity and credential

A Space has one Sandbox id for its whole life, `sandbox:<spaceId>`
(`sandboxEnvironmentIdOf`). With a runtime on, the Environments list shows it, `stopped`, for every
Space the viewer may run Threads in before it exists, so the composer can offer it; choosing it in
`chooseForThread` makes it ([Sandboxes](../../apps/server/src/sandboxes/Sandboxes.ts)). The Hub
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

[Which one runs](../../apps/server/src/sandboxes/sandboxRuntimeFromConfig.ts):
`T3CODE_SANDBOX_RUNTIME=podman`, `process` or `off`. Unset, a production Hub (no `--dev-url`, not
joined) runs Podman when `podman info` says rootless and the image (`T3CODE_SANDBOX_IMAGE`, default
`localhost/t3code-sandbox:<Hub version>`, built by ticket 06) exists; otherwise none. Both checks
run once per Hub, together, with a 5-second timeout each. Every runtime needs the Hub to answer on
loopback; Podman Sandboxes need it to listen on loopback **only** (`T3CODE_HOST=127.0.0.1`, or `::1`),
since a container reaches every address of the host but its loopback: a Hub on `0.0.0.0` or a LAN
address offers none and logs why. Publish such a Hub through a reverse proxy or `t3 up`.

### Podman

The [Podman runtime](../../apps/server/src/sandboxes/PodmanSandboxRuntime.ts) runs each Sandbox's
server in its own rootless container, `t3-<sandboxId>` (labels `io.t3code.sandbox=<id>` and
`io.t3code.sandbox-root=<Sandboxes root>`), made on each start and removed on stop:

- **Home.** `<Hub home>-sandboxes/<sandboxId>` is bind mounted as `/home/sandbox`, the server's
  base dir, `HOME` and workspace root (`/home/sandbox/projects`). A bind-mounted directory rather
  than a named volume: no Podman call to create or inspect it, and it survives the container
  (stop/start keeps it). Ticket 05's disk limit has to watch the directory, or move it onto a
  volume with a quota.
- **What the Hub writes stays out of the home.** The credential and `joined-hub.json` live in
  `<Sandboxes root>/.state/<sandboxId>/`, which only the Hub writes, and are mounted read-only
  over their paths in the home (`userdata/secrets/environment-credential.bin`,
  `userdata/joined-hub.json`). The Hub never writes in, reads or walks a home the Sandbox has used:
  it makes `userdata/secrets` only in a new home, and before a start (no container running) it
  `lstat`s those paths and refuses a link or a special file there (a FIFO would hang the mount).
  `delete` removes the home without following links, outside the runtime's lock.
- **User.** `--userns=keep-id`: inside it is the Hub's own uid, not root, so the home the Hub made
  is the server's without `chown`; `--cap-drop=all`, `no-new-privileges`, `--init` (reaps agents'
  orphans). It is still the Hub's user on the host, as in any rootless container.
- **Nothing else of the Hub** is mounted, besides the directory of its Hub socket (read-only) and,
  for a dev Hub run from source only, `apps/server`, `packages` and `node_modules` of its checkout
  read-only at their own paths ([devCodeMounts](../../apps/server/src/sandboxes/sandboxRuntimeFromConfig.ts)),
  so a dev image (Debian, git and Node) runs `node <checkout>/apps/server/src/bin.ts`. A start is
  refused when a code mount holds the Hub's home, the Sandboxes root or a `.env*` file.
- **Network.** `slirp4netns:allow_host_loopback=false`: its own namespace with internet, no host
  loopback (`10.0.2.2` leads nowhere), and no other container's ports (none publishes any). Other
  host addresses are reachable as from the LAN, hence the loopback-only rule above.
- **The Hub socket.** [SandboxHubSocket](../../apps/server/src/sandboxes/SandboxHubSocket.ts): per
  Sandbox the Hub listens on `<Sandboxes root>/.hub/<hash>/hub.sock` (short: a UNIX socket path has
  ~107 bytes), mounted at `/run/t3-hub`. It forwards to the Hub's loopback listener only
  `/api/environment/connect` (upgrade included), `/api/git/…` and exactly `/mcp`, normalized,
  dropping `Forwarded`/`X-Forwarded-*`, `TE` and `Trailer`; anything else gets 404 without reaching
  the Hub. A refused upgrade is answered and the connection closed. Seen from the Hub these
  requests come from loopback, which is what lets the credential cross plain HTTP.
- **Inside**, the container's first process is a small Node script (passed with `node -e`, so any
  image with Node works) that listens on the container's own `127.0.0.1:47231`, pipes each
  connection to the socket, and starts the server. The Hub URL it is given is
  `http://127.0.0.1:47231`, so the joined server, its WebSocket and git (with the credential
  helper, as on any machine) need no UNIX-socket support. That port is the container's loopback,
  not the host's.
- **Lifecycle.** Each container is named by the id `podman run --detach` printed in every later
  call, so cleaning up an old one never touches a newer one with the same name. `exits` comes
  from `podman wait`; a failed wait is not an exit until `podman inspect` says it stopped. A
  container that ends without `stop` has its scope (container, socket) closed under the runtime's
  lock before the exit is reported. On start the runtime removes every container labelled with its
  root (a Hub that crashed left them), and before each start that Sandbox's; a container of that
  name with another root is another Hub's and fails the start. The Hub's containers stop with it; one whose Hub died without stopping it (killed, crashed) stops by
  itself once its Hub socket has not answered for 30 seconds. Logs go to `<Sandboxes root>/<sandboxId>.log`, rotated at 10 MB.

Requirements: rootless Podman 3.4 or newer (Ubuntu 22.04's works) with `slirp4netns`, subuid and
subgid ranges for the Hub's user (`/etc/subuid`, `/etc/subgid`), and `XDG_RUNTIME_DIR`. Without a
systemd user session (a `wsl -e` shell, a service without lingering) the runtime passes
`--cgroup-manager=cgroupfs`; CPU and memory limits (ticket 05) may need `loginctl enable-linger`
and delegated cgroup controllers. Newer Podman defaults to pasta; this runtime asks for slirp4netns
explicitly, so it must be installed.

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
replaced one) after the welcome, the recorded hello and the executor's registration, so a Thread
placed right after finds its providers and executor. A server that ends first fails the start at
once with its exit code.
