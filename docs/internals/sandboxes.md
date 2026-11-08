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
processes or containers. Without one that runs Sandboxes the Hub offers none (not even one made earlier) and placement refuses
them (`sandbox-unavailable`).

[Which one runs](../../apps/server/src/sandboxes/sandboxRuntimeFromConfig.ts):
`T3CODE_SANDBOX_RUNTIME=podman`, `process` or `off`. Unset, a production Hub (no `--dev-url`, not
joined) runs Podman when `podman info` says rootless and the image (`T3CODE_SANDBOX_IMAGE`, default
`localhost/t3code-sandbox:<Hub version>`, the [base image](#base-image)) exists; otherwise none (a
Hub started before the first build runs Sandboxes once it restarts). Both checks
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
  (stop/start keeps it). No runtime limits a directory's size, so the disk limit is the Hub's own
  check (see [Limits](#limits)).
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
- **Nothing else of the Hub** is mounted, besides the directory of its Hub socket (read-only). The
  [base image](#base-image) runs its own `t3`. Only a dev Hub run from source, given a dev image
  (one the Hub did not build: Debian, git and Node, no version label), mounts `apps/server`,
  `packages` and `node_modules` of its checkout read-only at their own paths
  ([devCodeMounts](../../apps/server/src/sandboxes/sandboxRuntimeFromConfig.ts)) and runs
  `node <checkout>/apps/server/src/bin.ts`. A start is refused when a code mount holds the Hub's
  home, the Sandboxes root or a `.env*` file.
- **Image.** Each start runs the image its tag names then, by id (a build meanwhile changes nothing
  mid-start), and reports that image's version, which `sandboxes.image_version` keeps. A tag that
  names no image fails the start, saying to build it.
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
`--cgroup-manager=cgroupfs`, and then enforces no CPU, memory or PIDs limit (see [Limits](#limits)). Newer Podman defaults to pasta; this runtime asks for slirp4netns
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

## The Hub runs no agents

What nobody places on another machine runs in its Space's Sandbox, never in the Hub's process
([EnvironmentRegistry](../../apps/server/src/environments/EnvironmentRegistry.ts) `chooseForThread`,
previewed by clients with `previewThreadPlacement`): the User's choice, else the Project's preferred
Environment while it can take the Thread (usable, online or a Sandbox not failed, with the
provider, and never a Sandbox this Hub has no runtime for), else the Space's Sandbox, made if
missing and counted while stopped or even failed (its work starts it, or says why). Work the Hub
places with no User (a scheduled task without a creator) goes to the Sandbox of the Thread's Space
too. Every path that makes a Thread goes through it: the composer, MCP-launched Threads
(`thread.create` through `ThreadManagementService`), scheduled tasks and other launches
(`ThreadLaunchService`), Threads without a Project (their scratch Project's Space). Forks,
delegated subagents and Threads an agent creates over MCP run where their parent runs (the Hub
checks that choice like any other); a parent with no Environment leaves it to placement. A new
worktree is made only on the Hub machine until Environments check out from the Hub repository, so
a worktree Thread anywhere else is refused when it is made (MCP, the composer), and a scheduled
task with a worktree strategy is refused when it is saved.

**`HubRunsAgents`** ([HubRunsAgents](../../apps/server/src/environment/HubRunsAgents.ts)) says whether
the server's own machine runs agents. A joined machine (a Sandbox included) always does. A Hub does
only in development: `T3CODE_HUB_RUNS_AGENTS` (`1`/`true`, `0`/`false`) is honored only for a server
the dev runner started (`T3CODE_DEV_RUNNER=1`, set by `vp run dev`, with `--dev-url`); anywhere else
a value that turns it on is ignored with an error in the log. Under the dev runner it is on by
default only with no Sandbox runtime (`T3CODE_SANDBOX_RUNTIME` unset or `off`), so contributors
without Podman keep working as before Sandboxes; with `process` or `podman` it is off. While on, the
Hub machine is listed and is the fallback instead of the Sandbox. Anything the server does not
provide it to (a CLI command, another entry point) reads it off: it fails closed. Tests that run
work in the Hub's process provide it on (the testkit's `hubRunsAgents`, on by default), and the
tests of this rule turn it off.

While off, the Hub machine runs nothing, whatever asks:

- Its executor opens no provider session (`HubRunsNoAgentsError`, «The Hub runs no agents»), has no
  text generation and prepares no moved workspace; `TerminalManager` opens no shell (setup scripts
  included) and `TextGeneration` runs no provider CLI (`hub_runs_no_agents`).
- Workspace calls (`ThreadWorkspace`) for a draft (a Thread not placed yet) or with no Thread still
  read the Hub's copy of the Project: listings, search, reading files, browsing folders, which run
  no code. Since nothing places them, the folder they name must be one the User may read: a
  Project of a Space they see, or a Thread's working folder there (`mayReadDirectory`; a write,
  one they may work in), else they answer like a missing Project (`RpcSpaceAccess`). The same goes
  for a Thread on the Hub machine. What is checked is what the call opens
  ([localWorkspaceTargets](../../apps/server/src/workspace/localWorkspaceTargets.ts)): an absolute
  folder, no `~` and no `..` anywhere, a browse path absolute or explicitly relative (`./`); links
  count where they lead (both sides resolved). Browsing folders with no Thread keeps to them as
  well (only the Owner browses anything). Anything that acts (writing a file, opening or typing in a terminal, opening a preview)
  is refused until the Thread is placed. A Thread not projected yet resolves to no Environment
  (`ActiveEnvironmentResolver`), never the Hub machine.
- Titles are written on the Thread's Active environment (`textGeneration.threadTitle`, in its
  workspace there; attachments stay on the Hub); a machine away or without text generation leaves
  the title as it is. A moved Thread whose source is offline gets its summary from the target
  (`writtenBy: target`), or an assembled one. A pull request's text comes from its commits, and a
  review guide says the Hub runs no agents.
- The Hub machine is not in the Environments list, and choosing it (a new Thread or a move) is
  refused (`hub-machine`). A Project's «Preferred environment» offers no preference, named after the
  Space's Sandbox, and the User's own machines.
- With no Sandboxes either, a new Thread nobody placed is refused, never run on the Hub:
  «No Environment can run this Thread: <why>» (`no-environment`). The why is the Sandbox runtime's
  own (`sandboxRuntimeFromConfig`: no rootless Podman or image, the Hub not on loopback only,
  turned off), also in the list as `sandboxesUnavailable`, so the composer says it before sending
  and still offers the User's own machines. The Hub logs it at startup.
- As the Hub starts, before it recovers its runs, every Thread whose Active environment is the Hub
  machine needs an environment, as for a removed machine (`EnvironmentReturnService`, built before
  `serverRuntimeStartup` recovers anything): its history stays, unfinished turns end, and it moves
  to the Sandbox or a machine of its User's. So does every Thread in a Sandbox once the Owner turned
  Sandboxes off (`T3CODE_SANDBOX_RUNTIME=off`, `sandboxesTurnedOff`), and only then: a runtime that
  is away for now (the image of a new version not built yet, `podman info` failing, the Hub bound
  elsewhere) releases nothing, which could not be undone; those Threads wait, offline, and can be
  moved meanwhile.

## Limits

Each Sandbox has CPU, memory, PIDs and disk limits
([sandboxLimits](../../apps/server/src/sandboxes/sandboxLimits.ts)): the Installation's defaults
(`sandbox_limit_defaults`, migration 104, one row: 2 CPUs, 4 GiB, 4096 processes and threads,
20 GiB; null there is no limit) and each Space's override in its `sandboxes` row (null there takes
the default). `Sandboxes` reads them at every start and passes the effective ones to the runtime
as `start(sandboxId, { limits })` (`SandboxStartOptions`), so a change applies on the next start;
ticket 09's dedicated machines can pass the same options to their own container.

- **CPU, memory, PIDs** are the runtime's. `SandboxRuntime.limitSupport` says which ones it
  enforces on this host and why not, in words for the Owner; Settings and the Hub's log (one
  warning at startup, `Sandbox limits not enforced on this host`) show it, never a limit that is
  not applied. The process runtime enforces none. Podman reads `podman info` once
  ([podmanLimitSupport](../../apps/server/src/sandboxes/PodmanSandboxRuntime.ts)): only cgroups v2
  with the **systemd** cgroup manager gives a rootless container a cgroup of its own, and then
  each of `cpu`, `memory`, `pids` counts if it is delegated to the Hub's user
  (`/sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service/cgroup.controllers`). Under
  **cgroupfs** (no systemd user bus at `$XDG_RUNTIME_DIR/bus`, as in a `wsl -e` session, where
  `dbus-user-session` is not installed) a rootless container shares its caller's cgroup: Podman
  3.4 records `--memory`/`--pids-limit` and ignores them, or fails the run outright with
  «could not find cgroup mount» from the root cgroup, and `--cpus` is dropped. So the runtime passes
  `--cpus`, `--memory` (with `--memory-swap` equal: no swap beyond it) and `--pids-limit` only
  for what is enforced, and labels every container with what it was started with
  (`io.t3code.limit.cpus`, `.memory-bytes`, `.pids`, `io.t3code.limits-enforced`) for
  `podman inspect`. A container killed under an enforced memory limit (exit 137) is reported as
  having gone over it. To enforce them on a host: run the Hub as a systemd user service (or
  `loginctl enable-linger`) with `dbus-user-session` installed, and delegate the controllers
  (`Delegate=cpu cpuset io memory pids` for `user@.service`, the default on recent systemd).
  Measured in the dev WSL (Ubuntu 22.04, Podman 3.4.4): cgroup v2, user slice delegates
  `memory pids`, no user bus from `wsl -e`, so nothing is enforced there and the Podman test that
  checks enforcement skips with that reason.
- **Disk** is the Hub's: a home is a bind-mounted directory, so `Sandboxes` measures it
  (`SandboxRuntime.measureHome`): Podman with `podman unshare du -skx`, as root of the Hub user's
  namespace, so a directory the Sandbox made unreadable is still read (checked on Podman 3.4);
  the process runtime with plain `du`. A measurement is either a total from a clean exit or a
  failure (any other exit, a timeout, too much output), never a smaller size, with one exception:
  exit 1 where every one of `du`'s own errors is `No such file or directory` (files a build
  deleted while `du` ran; read with `LC_ALL=C`, line by line, never kept) is the total of what is
  there. GNU `du` quotes a name with a newline and puts the error after the name, so no name passes
  for that error. `du` runs in a process group of its own, killed whole on a timeout or interrupt,
  so the `du` that `podman unshare` runs in its child does not outlive it. Each failure is counted
  per Sandbox; three in a row count as over the limit (fail closed: «Its disk use could not be
  measured 3 times in a row …»), so a Sandbox cannot make itself unmeasurable. Such a Sandbox
  starts again on a User's own action or the Owner's Start, to repair its home: a failed
  measurement never refuses a start (only one over the limit does), and the count starts from
  none, so it runs for about three checks before it is stopped again unless its home can be
  measured by then; the message says so. At most two `du` run at once for the checks, and two
  more for starts, so a slow home measured by a check never holds back another Space's start.
  Checks run every `T3CODE_SANDBOX_DISK_CHECK_SECONDS` (default 60) for running Sandboxes, at once
  when a limit changes, and before each start; a check reads the limit, status and start again
  under the Sandbox's lock before it stops anything, so a limit raised or a restart meanwhile is
  never stopped on a stale reading. One over its limit is stopped (audit `sandbox.stop`, via
  `disk-full`). Every stop ends the server first, marked stopping (waiting work neither starts it
  nor takes it as ready meanwhile): a stop that fails leaves it `running`, for the next check to
  stop again, never recorded `failed` or `stopped` while its server runs (and each check stops any
  server still running for a Sandbox recorded `stopped` or `failed`). Then it is set `failed` with
  why in one status write (never `stopped` on the way, which waiting work would start again); its
  provider sessions end (`Sandboxes.sessionsEnded` → `RemoteEnvironments.sandboxSessionsEnded`),
  so its turns end interrupted with «… ran out of disk space …» (`EnvironmentSessionLostError`,
  reason `sandbox-disk-full`), and its socket closes with the close reason `sandbox-disk-full`
  (4418, final). It starts again only on a User's own action once its home fits (the Owner raises
  the limit, or its files go). Without `du` the disk limit is not enforced and Settings says so.
- **The Hub's own disk.** A bind-mounted home is on the Hub's filesystem, so between two checks a
  Sandbox can fill it, with the Hub's database on it. The floor is 5% of the Sandboxes root's
  filesystem (at most 10 GiB) (`minHostFreeBytes`). Below it each check measures every running
  home and stops the ones writing to it: each whose home grew more than 16 MiB since it was last
  measured, or that cannot be measured now (via `host-disk-low`, failed with «The Hub's disk for
  Sandboxes is almost full …»); one that is not writing keeps running, since stopping it frees
  nothing (the cause may be no Sandbox at all, such as the Hub's logs). Below half the floor every
  running Sandbox stops. The stops run at once, each under its own lock. No Sandbox starts until
  half as much again as the floor is free (`minHostFreeBytesToStart`, 15 GiB on a large disk), so
  a little room freed (a log rotated) does not start them all, to be stopped again at the next
  write. This is a limitation, not a quota: for a real one put the
  Sandboxes root (`<Hub home>-sandboxes`) on a filesystem of its own, sized for them, apart from
  the Hub's home: a separate disk or partition, an XFS filesystem with a project quota per home
  (`xfs_quota -x -c 'project -s …'`), or a size-capped mount (a loop-mounted image). Moving homes
  onto Podman volumes with a quota is later work.
- **Use** shown in Settings comes from two background samplers, never from the request: CPU and
  resident memory every 10 s for running Sandboxes, summed over the container's processes
  (`podman top … rss pcpu`, CPU averaged over each process's life; read from processes, since a
  cgroupfs container's cgroup is shared), and each home's size from the disk checks (a stopped
  one measured once). Uptime is from `sandboxes.started_at`. The process runtime reports no CPU or
  memory. Settings shows the limits a running Sandbox was started with and, when they changed
  since, «Applies on next restart: …»; an exit 137 under an enforced memory limit names that
  container's limit. What it was started with is kept in memory only, which is enough: a Hub
  that starts finds no Sandbox running (Podman removes its leftover containers by label, the
  process runtime stops its leftover servers), so none outlives the Hub that knew its limits.
- **Validation.** CPUs at least 0.1, memory at least 256 MiB, processes and threads at least 64,
  disk at least 1 GiB, and none above what the Hub's machine has (its CPUs, its memory, the size
  of the Sandboxes' disk); anything else is refused with which (400
  `EnvironmentSandboxLimitsInvalidError`). A Space with a dedicated machine may be given more
  CPUs and memory than the Hub has, for a bigger machine. Every start (on the Hub or a dedicated
  machine) uses at most the CPUs and memory its machine has (`fitLimitsToHost`), since Podman
  refuses more CPUs than the machine's.
- **The Owner's stop holds.** A stop from Settings sets `sandboxes.held_at` in the same write as
  `stopped`, before its socket closes, while the Sandbox is marked stopping: waiting work
  (`EnvironmentDemand.request`, work that is not a User's own action) does not start it again,
  neither during the stop nor after; a User's message, «Try again» or the Owner's Start does, and
  ends the hold. Its turns end interrupted, «The Owner stopped … Send a message to start it
  again and continue.» (`EnvironmentSessionLostError`, reason `sandbox-stopped`), since a held
  Sandbox does not come back by itself to resume them. Audit `sandbox.stop` with `hold: true`.
  Settings asks before stopping or restarting a Sandbox with turns running, saying how many.

**Settings → Environments «Sandboxes»** (`GET /api/environments/sandboxes`,
`POST …/sandboxes/action` with `start`, `stop` or `restart`, `POST …/sandboxes/limits` with or
without an `environmentId`): `sandbox.inspect` (the Owner, an Organization's Admins, a Personal
space's User) sees status, uptime, use, limits, image version (`image_version`, filled by ticket 06) and the enforcement note; `sandbox.manage` (the Owner) acts and changes limits and defaults.
Someone who may not inspect a Sandbox gets 404 for it; a start of an archived Organization's
Sandbox is refused until it is restored. Audit: `sandbox.start`/`sandbox.stop` with via
`settings` (with `hold`), `restart`, `disk-full` or `host-disk-low`, and `sandbox.limits.change` with scope (`defaults` or `space`) and
the new values.

## Base image

Every Sandbox runs one image, [the Containerfile](../../apps/server/sandbox-image/Containerfile):
Debian bookworm-slim, Node of the repository's `engines` (from nodejs.org, checked against its
SHASUMS), git, git-lfs, ripgrep, `build-essential`, Python and the usual shell tools, the CLIs of the
providers that ship one, and the T3 server of the Hub's own version as `t3`. Node is an `ARG`
checked against nodejs.org's SHASUMS; the CLIs are
[clis/package.json](../../apps/server/sandbox-image/clis/package.json) with its `package-lock.json`,
so their whole dependency tree, platform binaries included, is locked with integrity hashes:

| Piece                 | Version   | Installed as                            |
| --------------------- | --------- | --------------------------------------- |
| Node                  | 26.12.1   | nodejs.org tarball, SHASUMS256          |
| Claude Code, `claude` | 2.1.319   | `@anthropic-ai/claude-code` (npm)       |
| Codex, `codex`        | 0.167.0   | `@openai/codex` (npm)                   |
| OpenCode, `opencode`  | 1.19.5    | `opencode-ai` (npm)                     |
| Pi, `pi`              | 1.5.0     | `@earendil-works/pi-coding-agent` (npm) |
| Grok, `grok`          | 1.0.77    | `@xai-official/grok` (npm)              |
| T3 server, `t3`       | the Hub's | the Hub's own (below)                   |

Cursor runs inside the server (its SDK). Kiro, Fx, Muse and Antigravity ship no npm CLI; whoever
needs one installs it in the Sandbox's home.

The image runs `npm ci --ignore-scripts` on the lockfile, then `npm rebuild` for exactly two
packages: Claude Code and OpenCode ship a placeholder `bin` that their postinstall replaces with the
binary of their platform package (an optional dependency, already in the lockfile and checked by
its hash); neither downloads anything. Grok's postinstall only copies its binary into the installing
user's `~/.grok`, and its `bin` runs the locked binary without it; protobufjs's only prints a
version warning; @google/genai's (a dependency of Pi; 2.21.0) has only a `preinstall` that echoes «no-op»
and a `prepare` npm never runs for a registry package; Codex and Pi have none. So none of the five
packages the lockfile marks `hasInstallScript` fetches anything at build time.
`clis/package.json` says the same as npm's `allowScripts` policy (Claude Code and OpenCode
allowed, the other three denied), which npm 12 requires for the rebuild to run their scripts; npm
refuses `--allow-scripts` on a project's `rebuild` (`EALLOWSCRIPTS`). Only `Containerfile`,
`clis/package.json` and `clis/package-lock.json` go into the build context (and the release
archive), so nothing else left in that directory (a stray `clis/node_modules`, an `.npmrc`) ends up in
a layer.

To bump: Node, its `ARG` and this table. A CLI, its version in `clis/package.json`, then in that
directory `npm install --package-lock-only --ignore-scripts` (with the repository's Node), check
whether its install scripts changed (`npm view <pkg>@<version> scripts`, for every package the
new lockfile marks `hasInstallScript`), update `allowScripts`, the paragraph above and this table,
and rebuild.

**Building.** `t3 sandbox image build` on the Hub's machine, or **Build image** in Settings →
Environments («Sandbox image», the Owner's), builds it with the Hub's rootless Podman, one build at
a time ([SandboxImage](../../apps/server/src/sandboxes/SandboxImage.ts)). With the Hub running, the
command asks it as the shell (`POST /api/sandboxes/image/build`) and prints the build's output as
Settings shows it (`GET /api/sandboxes/image?after=<lines>`: only the lines after the ones a client
has). Output lines split on carriage returns and newlines, each cut at 2 KiB; the Hub keeps the last 400 lines and
at most 256 KiB. With no Hub running the command builds in its own process and records the build
itself. One build at a time: claimed in one step, so two requests never both build (the other gets
409). The status reads `podman info` until it says rootless Podman is here (then never again); a
«cannot build» answer stands 5 seconds (polls share one check), so a timeout or a Podman set up later
is not kept. It reads the image at most every 5 seconds (again after
each build), and every Sandbox's version and busy state in one query. Every build is audited on
the Hub machine (`environment:hub-machine`), a build the Hub stopped during included. The build is the Hub's: a client that stops following
it does not stop it. It is plain `podman build` (`--file`, `--tag`, `--build-arg`), so Podman 3.4,
which has no BuildKit, builds it.

The server goes in **from the Hub itself**, so the image always has the Hub's version:

- A `t3` release (a single executable) copies the tree it runs from: the executable, its client and
  its runtime `node_modules`. The release archive carries `sandbox-image/` for this.
- A Hub run from a checkout (source or `dist`) runs
  [stage-sandbox-server.ts](../../scripts/stage-sandbox-server.ts) into the build context, the
  Hub's own 0700 `mkdtemp` (it refuses a directory that does not exist, and never makes or
  replaces one at a path): `vp pack` (never into `apps/server/dist`), and the runtime externals for this Linux, staged as the release stages
  them (pnpm, with the repository's patches). It adds the dev Replay agent where the bundle looks
  for it, so the Sandboxes of a dev Hub (`--dev-url`) offer «Replay (dev)». It runs with a minimal
  environment (HOME, USER, locale, TMPDIR and XDG dirs; the proxy and CA settings `HTTP_PROXY`,
  `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`; and the
  package managers' own `npm_config_*` and `PNPM_*`; no provider keys, tokens or build settings),
  the Hub's Node first on PATH and, in WSL, without the Windows directories the login shell adds
  (their `pnpm` cannot run).

Before the build, everything under the context is made readable by all (directories and
executables searchable), whatever umask made it: the image keeps these modes and the Sandbox runs as
a plain user. The context directory itself stays 0700. The context is `Containerfile`, `server/` (to `/opt/t3/app`), `modules/` (its `node_modules`, a layer
of its own, so a new server rebuilds little) and `extras/` (to `/opt/t3`). The build fails without
rootless Podman, or when this `t3` is neither a release nor a checkout.

**Versions.** A build is `<Hub version>-<UTC time>` (`0.1.7-20261107143509`), which the Containerfile
puts in the label `io.t3code.image-version` (a layer of its own, so every build is a new image).
It is tagged as the configured image (`T3CODE_SANDBOX_IMAGE`, default
`localhost/t3code-sandbox:<Hub version>`) and as `<repository>:<version>`. After a build, older builds
of that repository lose their version tag; one that a running container uses stays until the next.
Each Sandbox records the version it started with; the Owner's view shows them and the newest.

**Updating.**

- A stopped Sandbox runs the newest build from its next start; nothing else is needed.
- A running one moves only when the Owner asks (**Update** beside it in «Sandbox image»,
  `POST /api/sandboxes/image/update`): the Hub stops it and starts it again (`sandbox.stop` and
  `sandbox.start` via `update`), under its lock and marked stopping as an idle stop is, so work that
  arrives meanwhile waits and then runs on the new image.
- Never mid-turn, checked before and again under its lock with it marked stopping (so work arriving
  after waits for the restart): refused with why when a turn runs on it, as its connection reports
  turns (`EnvironmentDemand.turnStarted`, from each `provider.startTurn` until its `turn.terminal`
  or its session ends) or the projection has a run in progress, «A turn is in progress on it
  (1 Thread). Update it once its turns end.»; or when a User sent it work in the last 10 seconds
  whose turn has not reported in, «Work was just sent to it. Update it once that work has ended.»;
  and while it starts or stops. Only dispatched work claims it (`EnvironmentDemand.claim`, scoped
  to the dispatch of each machine-decided command): each dispatch holds its own claim while it runs,
  which then stands until a turn reports in or 10 seconds pass (lapsed ones are dropped whenever
  claims are read). A turn never takes a claim still held, whatever work started it; previews,
  files and terminals never claim it. A
  `provider.startTurn` that fails, and a session that is lost, end their turns too. The Owner's view
  shows a claimed Sandbox as busy.
- Never into a start that cannot succeed: with no newest image (the tag names none, or one the Hub
  did not build) it is refused, «The newest image is missing», and keeps running. Already on the
  newest image it answers `up-to-date`; not running, `next-start`.
- Audited as `sandbox.image.update`. A build: `via` (`settings`, `cli`), `outcome` (`built`,
  `failed`), `version` or `reason`, on the Hub machine. A move: `via: restart`, `from`, `version` and
  `outcome`, on the Sandbox.
- Only the Owner (signed in, enabled) or the Hub's shell sees or does any of this; anyone else, an
  Admin of the Sandbox's Organization included, gets 403 «Only the Owner manages the Sandbox image.».

**Dedicated machines** run their Sandbox from the same image, built on that machine: `t3 join
--dedicated` refuses until `T3CODE_SANDBOX_IMAGE` (default `localhost/t3code-sandbox:<version>`)
exists there and says to run `t3 sandbox image build`. On a joined machine that command always
builds in its own process (its server answers only `/health`, and the audit log is the Hub's), with
the same tags and versions; the machine's Sandbox runs it from its next start. A machine whose
`t3 serve` found no image waits for one, reporting `restarting` with why (Podman asked again every
15 seconds, `awaitDedicatedRuntime`; a failed `podman info` then is waited out too), and starts
its Sandbox once it is built, without a restart.

**Provider logins** live in the Sandbox's home (`~/.claude`, `~/.codex`, …), its volume, not in the
image: they outlive every new image.

**Tests.** The testkit runs Sandboxes from no image; a runtime that reports versions
(`sandboxImageVersion`) and a fake builder (`sandboxImageBuilder`) test the policy
([HubWithEnvironments.sandboxImage.test.ts](../../apps/server/src/environments/HubWithEnvironments.sandboxImage.test.ts)).
[SandboxImage.build.test.ts](../../apps/server/src/sandboxes/SandboxImage.build.test.ts) builds the
real image from the checkout (`localhost/t3code-sandbox-test:latest`, kept for its layers), starts a
Sandbox from it whose own `t3 serve` connects through the socket, and moves it to another build
keeping its logins. It is slow, so it runs only with rootless Podman and
`T3CODE_TEST_SANDBOX_IMAGE_BUILD=1`.

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
environment like any joined machine, `kind = 'external'` with `mode = 'dedicated'`, the
Organization's `space_id` and **no owner** (migration 106): it is the Installation's, so turning a
User off never takes it. Who dedicated it is in `credential_issued_by` and the audit log only. On
the machine its server runs no work itself but one Sandbox for the Space it serves.

**On the Hub.**

- **Registering.** `t3 join --dedicated <Space>` sends the Space (name or id) as a suggestion only
  (`dedicatedSpace`). «Register this machine» offers the Owner alone every Organization not
  archived (`dedicatedSpaces`, the one asked for first) under **Used by**, preselected when it
  matched. Approving with `dedicatedSpaceId` asks `environment.dedicate` (the Owner, on the
  Installation) before the strong factor, and again with the Space (an Organization neither
  archived nor frozen) in the transaction that writes the row. The awaiting-confirmation and
  approved answers carry `dedicatedSpace`, so `t3 join` asks `Approved by Ada (ada) as a machine
  dedicated to Acme. Register it for Acme? [y/N]`. A machine takes only the mode it asked for
  (`joinModeRefusal`): a `--dedicated` join approved as personal, or a plain join approved as
  dedicated, registers nothing. The audit entry is `environment.register` with `mode`, `spaceId`
  and `via: "join"`.
- **Who.** The policy decides on its Space, as for a Sandbox (`decideSpaceBound` in
  [AccessPolicy](../../apps/server/src/auth/AccessPolicy.ts)): seen by whoever sees the Space (the
  Owner sees every one), used by its Admins and Members (not Guests) for that Space's Threads only
  (`workSpaceId`), renamed and removed by the Owner only. With its Space deleted it stays the
  Installation's: the Owner still sees, renames and removes it, nothing runs there, and its
  credential is refused at connect (`space-missing`). Clients offer it only for that Space's
  Threads (`placeableEnvironments`) and as a preferred Environment only of its Space's Projects.
  Placement never picks it by default.
- **Its credential reaches its Space only.** `checkCredential` answers it with its `spaceId`, so
  the git route serves it its Space's repositories alone. The executor refuses work there for a
  Thread no longer in its Space, and **fails closed**: a Space it cannot read refuses the turn with
  `SpaceCheckUnavailableError` (retryable), never skips the check (`boundSpaceOf`). Its `t3 leave`
  is audited as the machine (`source: "cli"`, no User).
- **Only its Sandbox connects, with a credential of its own.** The machine's own credential (from
  `t3 join`) stays with its host and only asks the Hub (`/self`) or leaves: presented at connect
  or to the git route it is refused (`not-sandboxed`). Each answer to `/self` issues a new
  credential for the Sandbox, for the Space it serves then
  (`dedicated_sandbox_credentials`, migration 107, only its hashes); the one a reissue replaces
  stays valid until the new one is first used, for at most 10 minutes, so an answer lost on its way
  to the host breaks nothing; that is the one the container
  holds and the only one that connects as the machine or reaches its Space's repositories. A
  change of mode or Space (and removing the machine) drops it in the same transaction, so a copy an
  agent took from the container reaches nothing afterwards, and the old Space's server is refused
  before it could be welcomed for the new one. The socket also needs the hello to carry
  `sandbox: { runtime }` (checked again on the second credential check, after the socket is
  tracked). The host keeps its own credential under another secret
  (`dedicated-environment-credential`), so its own server run as a personal one (an older one, or
  `joined-hub.json` edited) finds none to present.
- **Changing mode or Space** (`POST /api/environments/mode`, **Change use** in Settings) is the
  Owner's, for joined machines only, to `personal` (the Owner's own) or `dedicated` (owned by
  nobody) to an Organization neither archived nor frozen. Active Threads on it refuse it with 409
  `EnvironmentModeChangeRefusedError`, naming them; archived ones do not block it and need an
  environment from then on (`released`), so unarchiving one never lands on a machine no longer
  its own. The dialog says the Space's work files on the machine will be deleted. It is audited as
  `environment.mode.change`, and after the commit the socket closes (`environment-mode-changed`).
- **The machine asks.** `POST /api/environments/self`, with its own credential, answers its mode
  and Space as the Hub has them now, and a dedicated one its Sandbox's new credential; a dedicated
  host follows that, never what it remembers. Its Space deleted, it answers `dedicated` with no
  Space (and no credential) until the Owner dedicates it elsewhere or makes it personal.

**On the machine.** `t3 join` writes `mode: "dedicated"` and `spaceId` into `joined-hub.json`,
after checking rootless Podman (only `T3CODE_SANDBOX_RUNTIME=process` skips that, for
development, with a warning that it isolates nothing). A dedicated machine's `t3 serve`
([DedicatedHost](../../apps/server/src/environments/DedicatedHost.ts)) serves `/health` as any
joined server, but connects nothing of its own:

- **One Sandbox per Space.** The Sandbox for Space S is `dedicated-<S>`, home
  `<base dir>-sandboxes/dedicated-<S>`, run through the runtime a Hub runs a Space's Sandbox with
  (`dedicatedRuntimeFromConfig`): Podman by default (rootless, with the Sandbox image), or the
  process runtime when asked for. The container rules are the ones above: keep-id, no
  capabilities, no new privileges, its own slirp4netns network without the host's loopback, only
  its home mounted read-write, its Sandbox credential and `joined-hub.json` written outside the home and
  mounted read-only, and the Hub reached only through the UNIX socket proxy
  (`/api/environment/connect`, `/api/git/…`, `/mcp`, 404 otherwise), which forwards to the Hub's
  own address (`https://`, with SNI for a host name; plain `http://` only for a Hub on that
  machine).
- **A home is never reused.** At start, and whenever its Sandbox's server ends, the host asks the
  Hub, and starts the Sandbox again with the credential that answer issued (the runtime's `create`
  replaces it in place). Another Space: it deletes the old Space's home (and container) and makes a
  new one. No Space (its Space deleted): it deletes the home and waits, asking every 10 seconds.
  Personal: it deletes the home, moves the credential back to the personal secret, writes its
  state as the Hub answered and serves as a personal machine from then on, without a restart.
  Every other `dedicated-*` home on disk (directories only, never the runtime's logs beside them)
  is deleted at start, so a change cut short leaves nothing.
- **The Sandbox's server serves only its Space.** Its state names the Space; welcomed as
  someone's personal machine or for another Space (`sandboxedServerRefuses`), it refuses and exits
  with code 78, which is how its host learns to ask; so does a Sandbox's server whose credential
  the Hub refuses (`credential-unknown`, `credential-revoked`, `space-missing`). A personal server whose credential the Hub
  refuses as `not-sandboxed` (dedicated on the Hub since) moves the credential to the dedicated
  secret, writes `mode: "dedicated"` and stops; restarted, it runs as above.
- **Its network.** A container reaches every address of its host but the loopback, and rootless
  Podman cannot firewall that. So, as a Hub runs Podman Sandboxes only when bound to loopback, a
  dedicated machine runs its Sandbox only when nothing of the host listens beyond loopback
  (`/proc/net/tcp*`, [hostExposure](../../apps/server/src/sandboxes/hostExposure.ts)), except its
  own `/health` port and the ports the Owner names in `T3CODE_DEDICATED_HOST_PORTS` (for example
  `22`). Otherwise `t3 status` names each `address:port` to bind to 127.0.0.1, and it runs
  nothing. Other machines of its network stay reachable, as from a Hub's Sandbox.
- **Lifecycle.** It starts and stops with the machine's server. When its server ends for any
  other reason it starts again after 1, 2, 4… seconds (at most 30); more than three ends in ten
  minutes leave it `failed` until `t3 serve` restarts. `t3 status` shows the Sandbox's state. There
  is no idle stop: the machine is the Space's anyway.
- **Limits.** The Hub sends the Space's own Sandbox limits (its override, set in Settings →
  Sandboxes on the Space's Sandbox; not the Installation's defaults, which are sized for
  Sandboxes sharing the Hub's machine, while this machine is the Space's) in the
  `/api/environments/self` answer (`limits`), which the host asks for at start and after each end
  of its Sandbox's server; it starts the Sandbox with them as `SandboxStartOptions`, capped at
  the CPUs and memory the machine has (`fitLimitsToHost`), so its Podman runtime passes what that
  machine enforces (`podmanLimitArgs`) and labels the rest, and a change applies on the next
  start. The disk limit is not enforced there: that is the Hub's own check, for its own
  Sandboxes.
- **Versions.** Upgrade the Hub and its dedicated machines together: neither side keeps
  compatibility with an older other (a host that gets no Sandbox credential from `/self` waits).
