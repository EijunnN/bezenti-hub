# AI gateway: CLIProxyAPI run by the Hub

The Hub runs [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (MIT) as its own child
process and is its only client. Spec: `.scratch/ai-accounts-and-gateway/spec.md`, «CLIProxyAPI
gestionado»; ADR 0005. Code: `apps/server/src/ai/`.

## Where it runs

Only on a Hub (`aiGatewayPlacement` in `AiGateway.ts`, the one rule):

- A joined machine (a Sandbox's server and a dedicated machine included) never runs, downloads
  or prepares it; its status says so.
- `T3CODE_AI_GATEWAY=managed|off` decides where set.
- Otherwise the Owner decides in Settings → AI gateway («Turn on» / «Turn off», audited
  `ai_gateway.enable`, kept in the encrypted store): on by default on a server Hub, off by
  default in the desktop app and on a dev Hub (`vp run dev`).
- Windows (development only; develop in WSL) reports `unsupported`.

## Which release, from where

- Only pinned releases ever run. `cliproxyRelease.ts` lists the pinned versions, oldest first,
  each with the SHA-256 of each production archive (`linux-amd64`, `linux-arm64`,
  `darwin-amd64`, `darwin-arm64`). A new pin comes with a Hub upgrade; keep the one before so
  the Owner can roll back to it. Linux takes the `_no-plugin` build: no code is loaded at run
  time besides the verified binary.
- The download comes only from `https://github.com/router-for-me/CLIProxyAPI/releases/download/v<pinned>/…`,
  read as a stream with a hard 100 MB limit (whatever `content-length` says) and hashed as it
  arrives. A different hash is refused (`CliproxyRefusedError`): nothing is written or run, and
  the Hub does not retry until the Owner acts. Nothing else is asked of GitHub.
- Gunzip runs in libuv's thread pool; the binary (one regular file, `cli-proxy-api`, at the
  top of the archive) is written 0700 to `<stateDir>/ai-gateway/bin/<version>/`, in folders of
  the Hub's user that nobody else may write.
- The record (`active`, `previous`, each with its binary's SHA-256; whether the Owner chose the
  active one; on/off) lives in the encrypted store (`ai-gateway-releases`) and is read and
  written under one lock with every switch. Before every start the binary is hashed again,
  streamed: a file changed on disk is refused, never run; one missing is downloaded again (if
  still pinned). Releases other than `active` and `previous` are deleted.
- At a start the Hub runs the active release if it is still pinned and either the Owner chose
  it (a roll back, or an update to an older pin) or it is the newest pin; otherwise the newest
  pin. So a crash or a Hub restart never undoes the Owner's roll back.

## Running it

- `AiGateway.ts` starts it as `cli-proxy-api -config <path> -local-model` (`-local-model`: its
  embedded model catalogs, never refreshed from the internet), `cwd` and `HOME` its run folder,
  an environment of `PATH`, `HOME` and a start token only (none of the Hub's variables), in its
  own process group, with only stdio passed (Node opens every other descriptor close-on-exec).
  On Linux it runs under `setpriv --pdeathsig KILL`, so it dies with the Hub however the Hub
  ends.
- Each start writes `run-<token>.pid` with the PID, its start time and the binary. At the next
  start a leftover is killed (its whole group) only if that PID still has that start time and
  executable (Linux: `/proc/<pid>/stat` and `exe`; macOS: `ps lstart` and `comm`); a reused PID
  is never touched. Clearing leftovers never stops the Hub from starting: what it cannot do is
  logged.
- Its keys: the management key, random, in the encrypted store; the client key, new at every
  start and kept in memory only, so one a leftover knew is useless.
- The run folder holds `config-<token>.yaml` (0600, one per start, removed when it stops) and
  `auth/` (its `auth-dir`, also its `kv.db`). It is in memory when the platform has a folder
  there (`$XDG_RUNTIME_DIR`, else `/dev/shm`; 0700, never a link or someone else's), else
  `<stateDir>/ai-gateway/run`, which Settings says.
- Config (`cliproxyConfig.ts`, v8 layout, `config-version: 8`): `server.host: 127.0.0.1` on a
  free port the Hub picks, `management.allow-remote: false`, `secret-key` (CLIProxyAPI hashes
  it on start), control panel and panel updates off, one client key, no mDNS discovery,
  plugins (so no plugin store), pprof, usage statistics or request logs.
- Before any key is sent, the Hub checks that its own child (its PID's sockets: `/proc/net/tcp`
  inodes against `/proc/<pid>/fd` on Linux, `lsof -p` on macOS) listens on that port, and only
  on `127.0.0.1`. Another process that took the port first gets nothing; a child listening
  anywhere else is killed and not started again. The check is repeated once it answers.
- Healthy once `GET /v8/management/config` answers 200 with the management key
  (`CliproxyManagement.ts`, the Hub's one client of it). When it stops by itself the Hub starts
  it again after 1 s, doubling to 60 s, back to 1 s after five stable minutes.
- Its stdout and stderr go to the Hub's log as `CLIProxyAPI: …` (`gatewayLogFilter.ts`): the
  Hub's keys, the value of anything named like a credential (`access_token`, `refresh_token`,
  `api_key`, `client_secret`, `key=`, `Authorization`, …) and anything shaped like a token
  (`AIza…`, `ya29.…`, `1//…`, `sk-…`, `ghp_…`, JWTs, bearer) become `[redacted]`.

## Who reaches it

Only the Hub. It listens on `127.0.0.1` only, so a Podman Sandbox (slirp4netns without host
loopback) cannot connect to it (`PodmanSandboxRuntime.test.ts`), nor can a joined machine. A
process of another user on the Hub's machine reaches the port but gets 401 without the keys.

Known limit: CLIProxyAPI runs as the Hub's user, so it could read the Hub's state folder. That
is acceptable only because every binary it runs is pinned in this repository and verified by
the Hub. Running it in its own rootless container or under its own uid is a later hardening
(spec, «Riesgos»). Agents of the Hub machine itself (development) run as the Hub's user too and
could read its run folder; production Hubs run agents in Sandboxes.

## Switching releases

Settings → AI gateway (the Owner's; dropped from a Member's nav) streams the status
(`aiGateway.status`), lists the pinned versions and offers «Update to X» when a newer pin is
there and «Roll back to Y». A switch starts the new release beside the running one, checks its
listeners, its management API and `/v1/models`, records it, and only then stops the old one;
any failure leaves the old one running and the record as it was. An update to anything not
pinned is refused before any download. Audited: `ai_gateway.update` (from, the requested
version, `updated` or `failed`, reason) and `ai_gateway.rollback` (`rolled-back` or `failed`).

## Doors

WS only: `aiGateway.status` (a stream), `aiGateway.checkForUpdates`, `aiGateway.update`,
`aiGateway.rollback`, `aiGateway.setEnabled`, all in `INSTALLATION_RPC_METHODS` (`installation`
in `RpcSpaceAccess`: the Owner's alone, whatever the scopes; the changes also need
`settings:write`). No HttpApi endpoint, raw route, cookie or MCP tool, so `DoorRules.ts` lists
none.

## AI accounts (API keys)

`ai/AiAccounts.ts` is the one service; WS `aiAccounts.*` are its doors (spec 4 ticket 02).

- **Where credentials live:** never in the database (migration 112 keeps `ai_accounts` and
  `ai_account_allowances`; `key_hint` holds at most the last four characters, shown to the Owner
  only). Each key is an entry of `ServerSecretStore.AiAccountCredentialStore`:
  `secrets/ai-accounts/<credential id>.sealed`, purpose `ai-account-credential` (its own folder,
  like Vault values). «Replace credential» writes a new id, then the row, then removes the old
  one; the start sweeps credentials no row holds. No answer returns a key, not to the Owner.
- **Into CLIProxyAPI:** only through the Management API (`PATCH /v8/management/config` with the
  whole `api-keys` section, so a disabled or deleted account goes), never a file the Hub writes.
  Each account is under `prefix: acct-<id>` and `routing.force-model-prefix` is on, so only
  `acct-<id>/<model>` is served. CLIProxyAPI keeps them in its own config in the memory folder.
  Every start (crash, update, roll back) is provisioned from the store before it counts as
  running (`AiGateway.setProvisioner`).
- **One bad account never takes the others out:** each is checked before anything is sent; if
  CLIProxyAPI still refuses the set, the Hub sends what it held before, then each other account
  alone, first to last, and only the refused one stays out (`error`, with CLIProxyAPI's reason,
  quoted values and keys removed). A refused account is not sent again unchanged on that gateway.
  A key the store cannot read aborts the change and leaves the gateway as it was. A change that
  fails as a whole is retried after 10 s, doubling up to 5 min. One change and its check have a
  30 s deadline; the lock covers only the change, not the model-list check (`unverified` when the
  list cannot be read). Renames, allowances and order never reach the gateway.
- **A key leaves only once the gateway drops it:** «Replace credential» and «Delete» retire the
  old key (`ai_account_retired_credentials`; a deleted account stays as `removing`, out of every
  list but the Owner's). It leaves the store, with the row, only after a change the gateway
  accepted without it. Until then the call answers `still-live` and the Hub keeps retrying. With
  no gateway running the key is live nowhere and goes at once (`gateway: "not-running"`). The
  Hub's start, before any CLIProxyAPI holds keys, removes every retired key and orphan.
- **Who:** only the Owner, unlimited, manages (`aiAccount.manage` on the Installation, through
  `SpaceDirectory.authorizer`, so an agent limited to one Space manages nothing; the writes are
  also `INSTALLATION_RPC_METHODS`). `aiAccounts.list` gives anyone else name, provider and status
  of what they may use, and where.
- **AllowedAiAccounts** (`ai/AllowedAiAccounts.ts`) is the one rule: enabled accounts allowed to
  the Space or to the User, and none unless the User may work in that Space (`aiAccount.use`:
  whoever may start a Thread there, Guests included). Evaluated on every call. The gateway layer,
  the picker and the move plan ask it; nothing else decides.
- **Models:** `modelsOf(accountId)` reads the gateway's `/v1/models` for the account's prefix,
  cached five minutes.
- Audit: `ai_account.create|update|delete|allow` with provider, type and counts, never a key.

## Known exception to «no upstream services»

CLIProxyAPI 8.0.67, even with `-local-model`, asks the internet for the latest Antigravity client
version (`antigravity-hub-auto-updater-….run.app`, every 3 h) and the Grok CLI version
(`registry.npmjs.org/@xai-official/grok/latest`). The pinned release has no setting that turns these
off (none among its config keys in the binary), and a proxy scoped to the child
would also carry the providers' own traffic. Accepted as a known exception to ADR 0007: the requests
carry no credential, prompt or account, only the Hub's address. Revisit at each pin update.
