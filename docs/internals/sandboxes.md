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

[Which one runs](../../apps/server/src/sandboxes/sandboxRuntimeFromConfig.ts):
`T3CODE_SANDBOX_RUNTIME=podman`, `process` or `off`. Unset, a production Hub (no `--dev-url`, not
joined) runs Podman when `podman info` says rootless and the image (`T3CODE_SANDBOX_IMAGE`, default
`localhost/t3code-sandbox:<Hub version>`, built by ticket 06) exists; otherwise none. Both checks
run once per Hub, together, with a 5-second timeout each. Every runtime needs the Hub to answer on
loopback; Podman Sandboxes need it to listen on loopback **only** (`T3CODE_HOST=127.0.0.1`, or `::1`),
since a container reaches every address of the host but its loopback: a Hub on `0.0.0.0` or a LAN
address offers none. A production Hub binds loopback and is published through a reverse proxy
(or `t3 up`); one that binds elsewhere while rootless Podman is here warns at startup that its
Sandboxes are off for that reason.

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

## Previews through the Hub

A dev server started in a Thread's terminal or by its agent listens on its machine's loopback,
which nobody else reaches: a Sandbox's container, a dedicated machine, a laptop behind NAT. The Hub
serves it at an address of its own, `/preview/<token>/`, and relays each request to that port over
the Environment channel ([HubPreviews](../../apps/server/src/preview/HubPreviews.ts),
[the route](../../apps/server/src/preview/hubPreviewRoute.ts)). It works the same for a Sandbox and
any joined machine.

- **Never the Hub itself:** a Thread on the Hub machine gets no address (its loopback is the Hub's),
  nor does any port the Hub answers on: its configured port, the port its HTTP server listens on,
  the dev web server's. With the process runtime (`T3CODE_SANDBOX_RUNTIME=process`, whose Sandboxes
  share the Hub's loopback) neither does any port the Hub process listens on (read from `/proc`).
  The dev server sees `Host: localhost:<port>` and `Origin: http://localhost:<port>`, never the
  Hub's own credentials.
- **Asking:** `preview.proxyUrl { threadId, port }` (the client's «Open preview» in the Thread
  details, Preview section) answers `{ path, url?, expiresAt }`. It follows the rule of the other
  preview RPCs (`work`: the Thread's own User) and `environment.use`, and binds the address to the
  session's User (a principal without one acts as the Owner, as everywhere in spec 1), that session,
  the Thread, its Active environment and the port. Asked again it gives the same address while that
  lasts. `url` is absolute only with `T3CODE_PUBLIC_URL`; the client otherwise puts `path` on the
  Hub address it is connected to.
- **The address alone opens nothing.** Every request must carry the User's Hub session or the
  address's preview cookie. A browser opening the page (`Sec-Fetch-Mode: navigate`,
  `Sec-Fetch-Dest: document`) must carry the Hub session, which top-level navigations always send;
  the answer then sets `t3_preview` (HttpOnly, Secure, SameSite=None, `Path=/preview/<token>/`,
  bound to the address, its User and session), which the page's own requests and WebSockets carry
  from its opaque origin. A leaked link fetched without either answers 401; another User's Hub
  session, 404.
- **Every request checks again:** the session is still live, the User still works the Thread
  (`SpaceVisibility.claimWork`: a Member of another Space, or another Member of the same Space, is
  refused), the Thread is still on that Environment (read on every request: a move ends the address
  at once) and the User may still use it. The rest is answered from the last 2 seconds unless a
  Space or Membership changed. A live WebSocket is checked again on each access change and every
  30 seconds, and closes once the check fails or its session ends. A refusal is a 404 like an
  unknown address. A machine away answers 503 «Environment offline: <name> is not connected.»; a
  port with nothing listening, 502; a dev server that does not answer in time, 504; a machine whose
  T3 predates these operations, 502 asking to update it (executor contract 8, which machines now
  report in their hello).
- **Addresses:** in memory, so a Hub restart ends them all (the client asks again). One expires
  after an hour unused; a User keeps at most 32, and past that their least recently used goes,
  never another User's. A session that ends takes its addresses with it.
- **Origin:** a path on the Hub's own origin would let the page's scripts call the Hub's API with
  the User's cookies. The Hub serves every response with `Content-Security-Policy: sandbox …`
  without `allow-same-origin`, so the page runs in an opaque origin: it cannot read or use the
  Hub's cookies, storage or API. Nothing the dev server answers sets or clears state on the Hub's
  origin (`Set-Cookie`, `Clear-Site-Data`, `Strict-Transport-Security` are dropped). Never sent on:
  `Cookie`, `Authorization`, `Proxy-Authorization`, `Expect` and every client address header
  (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP`, …).
  `CONNECT`, `TRACE` and `TRACK` answer 501. `Referrer-Policy: no-referrer` keeps the token out of
  other sites' logs. Redirects to the dev server itself stay under the address.
- **Trade-off:** the sandboxed page has no cookies or `localStorage` of its own; root-absolute URLs
  (`/src/main.ts`) leave the address, so a dev server must use relative URLs or a base path (`vite
  --base /preview/<token>/`); and requests the page makes in CORS mode with default credentials
  (`fetch()`, module scripts) send no cookie from an opaque origin, so they are refused. Classic
  subresources (`<script src>`, `<img>`, `<link>`), forms and WebSockets work. The preview cookie
  needs a secure context (HTTPS, or `localhost`). A wildcard subdomain per preview
  (`<token>.preview.<host>`) would lift all of this; it needs wildcard DNS and TLS on the public URL,
  so it is left for later.
- **Proxies:** the route sits behind the same client admission as every other one
  (`T3CODE_TRUSTED_PROXIES` decides which forwarded addresses and schemes count) and needs nothing
  of the public URL beyond the absolute `url`.
- **On the wire:** `preview.proxyHttp` and `preview.proxySocket` are workspace streams (spec 2's
  `workspace.stream`): a response's head, then its body in base64 chunks of up to 64 KiB; a
  socket's open (with the subprotocol the dev server chose), messages and close.
  `preview.proxySocketSend` carries the browser's messages in order. The Hub holds at most 512
  chunks of a response (1,024 messages of a socket) for a reader that has not taken them, and the
  machine at most 1,024 socket messages; past that the stream fails, so a slow client never holds
  the machine's socket and a cut response never reads as complete. Request bodies are capped at
  8 MiB. The machine gives a dev server 30 seconds to answer a request's head and 15 to finish a
  WebSocket handshake; the Hub waits 45 for the machine.
- **A stopped Sandbox starts for it.** Opening a preview is a User's own action: asking for an
  address, and every request under it that finds the Sandbox not running, start it and wait
  (`EnvironmentDemand.awaitStarted`, `explicit`), so a page opens on a stopped Sandbox instead of
  answering 503; a start that fails answers 503 with why. Each request served is use (`touch`), and
  an open preview WebSocket holds the Sandbox (`hold`) until it closes, so it does not stop while
  the page is live. Nothing read-only starts it.

## Dedicated machines

A machine the Owner gave to one Organization (spec 3 ticket 09). On the Hub it is an External
environment like any joined machine, `kind = 'external'` with `mode = 'dedicated'` and the
Organization's `space_id`; on the machine its server runs no work itself but one Sandbox.

**On the Hub.**

- **Registering.** `t3 join --dedicated <Space>` sends the Space (name or id) as a suggestion only
  (`dedicatedSpace`). «Register this machine» offers the Owner alone every Organization not
  archived (`dedicatedSpaces`, the one asked for first) under **Used by**, preselected when it
  matched. Approving with `dedicatedSpaceId` asks `environment.dedicate` (the Owner, on the
  Installation) before the strong factor, and again with the Space in the transaction that writes
  the row; `environment.register` alone (a User with `registerOwn`) dedicates nothing. The
  awaiting-confirmation and approved answers carry `dedicatedSpace`, so `t3 join` asks
  `Approved by Ada (ada) as a machine dedicated to Acme. Register it for Acme? [y/N]` (the desktop
  reads both forms). A `t3 join --dedicated` approved as someone's personal machine refuses it.
  The audit entry is `environment.register` with `mode`, `spaceId` and `via: "join"`.
- **Who.** `owner_user_id` is the Owner who dedicated it (on record, and so its credential has an
  owner), but the policy decides on its Space, as for a Sandbox (`decideSpaceBound` in
  [AccessPolicy](../../apps/server/src/auth/AccessPolicy.ts)): it is seen by whoever sees the
  Space (the Owner sees every one), used by its Admins and Members (not Guests) for that Space's
  Threads only (`workSpaceId`), and renamed and removed by the Owner only. The list reports it with
  `ownerUserId: null`, `mode: "dedicated"` and its `spaceId`; clients offer it only for that
  Space's Threads (`placeableEnvironments`) and as a preferred Environment only of its Space's
  Projects. Placement never picks it by default: only a User's choice or the Project's preference.
- **Its credential reaches its Space only.** `checkCredential` answers it with `ownerUserId: null`
  and its `spaceId`, so the git route serves it its Space's repositories alone, exactly as a
  Sandbox's; the executor refuses to start work there for a Thread no longer in its Space
  (`requireSandboxSpace` reads the row's Space). Unlike a Sandbox it may `t3 leave` (audited as its
  registrar).
- **Changing mode or Space** (`POST /api/environments/mode`, Settings' **Change use**) is the
  Owner's (`environment.dedicate`), for joined machines only, to `personal` (the Owner's own) or
  `dedicated` to an Organization not archived. It is refused with 409
  `EnvironmentModeChangeRefusedError` while any Thread not deleted or archived has the machine as
  its Active environment, naming them (`threads`, and the titles in `message`). The row then
  belongs to the Owner who changed it (so turning off its earlier owner takes nothing), the change
  is audited as `environment.mode.change` (`from`, `to`, `fromSpaceId`, `toSpaceId`), and after the
  commit its socket closes (`environment-mode-changed`, not final) so it reconnects at once.

**On the machine.** `t3 join` writes `mode: "dedicated"` and `spaceId` into `joined-hub.json`. It
first checks rootless Podman (`podman info`); only `T3CODE_SANDBOX_RUNTIME=process` skips that, for
development, with a warning that it isolates nothing. A dedicated machine's `t3 serve`
([DedicatedHost](../../apps/server/src/environments/DedicatedHost.ts)) serves `/health` as any
joined server, but connects nothing of its own:

- **One Sandbox.** It runs one Sandbox, `dedicated`, with home `<base dir>-sandboxes/dedicated`,
  through the same runtime a Hub runs a Space's Sandbox with
  (`dedicatedRuntimeFromConfig`): Podman by default, which needs rootless Podman and the Sandbox
  image (`T3CODE_SANDBOX_IMAGE`), or the process runtime when asked for. So the container rules are
  the ones above: keep-id, no capabilities, no new privileges, its own slirp4netns network without
  the host's loopback, only its home mounted read-write, the credential and `joined-hub.json`
  written outside the home and mounted read-only, and the Hub reached only through the UNIX socket
  proxy, which forwards `/api/environment/connect`, `/api/git/…` and `/mcp` and answers 404 to the
  rest. The difference: the socket forwards to the Hub's own address from `joined-hub.json`
  (`https://`, with SNI; plain `http://` only for a Hub on that machine) instead of a loopback port.
- **The Sandbox's server is the machine.** Its home's `joined-hub.json` names the machine's
  Environment id and the Hub, and its credential is the machine's own, so the Hub sees one
  Environment, as for any joined machine; nothing on the Hub knows a container is there. That file
  says `sandboxed: true`, which no file `t3 join` writes.
- **The simplest secure path.** The Sandbox's server connects straight to the Hub through that
  socket rather than through the machine's own server: no second protocol, no relay to trust, and
  the only process holding the credential outside the container is the one that already held it.
  The machine's own server never runs a provider, a terminal or a Project checkout.
- **Lifecycle.** It starts with the machine's server and stops with it (the runtime's finalizer
  removes the container by id). When its server ends it starts again after 1, 2, 4… seconds (at
  most 30); more than three ends in ten minutes leaves it `failed` until `t3 serve` restarts.
  `t3 status` shows the Sandbox's state (`sandbox`: starting, running, restarting or failed, with
  why) instead of a connection. There is no idle stop: the machine is the Space's anyway.
- **Limits.** It runs with the runtime's defaults: the Installation's Sandbox limits live on the
  Hub, which does not send them to a machine it does not run. `DEDICATED_LIMITS` is where they would
  go in.
- **Mode changed on the Hub.** The welcome names the machine's mode and Space. A server joined as
  personal that is welcomed as `dedicated` (and is not `sandboxed`) serves nothing more: it writes
  `mode: "dedicated"` into its `joined-hub.json`, stops connecting (`t3 status` says
  `environment-mode-changed` and to restart it) and, once restarted, runs as above
  (`mustRestartAsDedicated`). A dedicated machine made personal again keeps running its work in its
  Sandbox, as the Owner's personal machine, until it joins again.
