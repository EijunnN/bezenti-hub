# AI gateway: CLIProxyAPI run by the Hub

The Hub runs [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (MIT) as its own child
process and is its only client. Spec: `.scratch/ai-accounts-and-gateway/spec.md`, «CLIProxyAPI
gestionado»; ADR 0005. Code: `apps/server/src/ai/`.

## Which release, from where

- `cliproxyRelease.ts` pins one version and the SHA-256 of each production archive
  (`linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64`). Linux takes the
  `_no-plugin` build: no code is loaded at run time besides the verified binary. Windows Hubs
  (development only; develop in WSL) report `unsupported` and run none.
- Files come only from `https://github.com/router-for-me/CLIProxyAPI/releases/download/v<version>/…`
  and the newest version from `api.github.com/…/releases/latest`; the version is checked
  (`1.2.3`) before any address is built from it (`CliproxyReleases.ts`).
- Install (`cliproxyInstall.ts`): the archive's hash must be the one the release's
  `checksums.txt` lists for it and, for the pinned version, the pinned one. A missing entry,
  a different pin or a different download is refused (`CliproxyRefusedError`), nothing is
  written and nothing runs; the Hub does not retry a refusal until the Owner acts. The binary
  is taken out of the archive in memory (one regular file, `cli-proxy-api`, at the top) and
  written 0700 to `<stateDir>/ai-gateway/bin/<version>/`, in folders of the Hub's user that
  nobody else may write.
- The installed releases (`active`, `previous`, each with its binary's SHA-256) live in the
  encrypted store (`ai-gateway-releases`). Before every start the binary is hashed again: a
  file changed on disk is refused (`failed`), never run. One missing from the disk is
  downloaded and verified again.

## Running it

- `AiGateway.ts` starts it with `-config <path>` as its only arguments, `cwd` and `HOME` its
  run folder, and an environment of `PATH`, `HOME` and a start token only: none of the Hub's
  variables (provider keys among them) reach it. On Linux it runs under
  `setpriv --pdeathsig KILL`, so it dies with the Hub however the Hub ends; a start left by a
  killed Hub (a `run-*.pid` whose process has that start's token in `/proc/<pid>/environ`) is
  stopped at the next start, and a PID file naming any other process is only removed.
- The run folder holds `config-<token>.yaml` (0600, one per start, removed when it stops) and
  `auth/` (its `auth-dir`, also its `kv.db`). It is in memory when the platform has a folder
  there (`$XDG_RUNTIME_DIR`, else `/dev/shm`; `t3code-ai-gateway-<hash of stateDir>`, 0700,
  never a link or someone else's), else `<stateDir>/ai-gateway/run`, which Settings says.
  Subscription credentials, from ticket 03, are restored there from the encrypted store.
- Config (`cliproxyConfig.ts`): `server.host: 127.0.0.1` on a free port the Hub picks,
  `management.allow-remote: false`, a random `secret-key` (the management key; CLIProxyAPI
  hashes it on start), control panel and panel updates off, one client key in
  `access.api-keys`, no discovery, plugins, pprof, usage statistics or request logs.
- Healthy once `GET /v8/management/config` answers 200 with the management key
  (`CliproxyManagement.ts`, the Hub's one client of it). A start that exits or does not answer
  in 30 s is stopped. When it stops by itself the Hub starts it again after 1 s, doubling to
  60 s, back to 1 s after five stable minutes; Settings shows `restarting`, the reason and
  the count.
- Its stdout and stderr go to the Hub's log as `CLIProxyAPI: …`, with both keys and anything
  shaped like a bearer token or key replaced by `[redacted]`.
- Both keys are random 32 bytes in the encrypted store (`ai-gateway-management-key`,
  `ai-gateway-client-key`), never in an argument, a log, a span attribute or an error.

## Who reaches it

Only the Hub. It listens on `127.0.0.1` only, so a Podman Sandbox (slirp4netns without host
loopback) cannot connect to it (`PodmanSandboxRuntime.test.ts`), nor can a joined machine. A
process of another user on the Hub's machine reaches the port but gets 401 without the keys.
Agents of the Hub machine itself (development) run as the Hub's user and could read its run
folder; production Hubs run agents in Sandboxes.

## Updating and rolling back

`T3CODE_AI_GATEWAY=managed|off`; unset, a production Hub manages it and a dev Hub does not
(so dev Hubs download nothing unless asked). Settings → AI gateway (the Owner's; dropped from
a Member's nav) shows state, version, uptime and restarts, and asks GitHub for the newest
release only while it is open or on «Check for updates». «Update to X» installs and verifies
X (against that release's `checksums.txt`), starts it beside the running one, checks its
management API and `/v1/models` with the client key, then stops the old one and keeps it as
`previous`; any failure leaves the running release as it was. «Roll back to Y» does the same
with the kept release, hashed again from the disk. Both are audited (`ai_gateway.update`,
`ai_gateway.rollback`: from, version, outcome, trimmed reason).

## Doors

WS only: `aiGateway.status`, `aiGateway.checkForUpdates`, `aiGateway.update`,
`aiGateway.rollback`, all in `INSTALLATION_RPC_METHODS` (`installation` in `RpcSpaceAccess`:
the Owner's alone, whatever the scopes; update and roll back also need `settings:write`). No
HttpApi endpoint, raw route, cookie or MCP tool.
