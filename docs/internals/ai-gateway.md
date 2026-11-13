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
  `<stateDir>/ai-gateway/run`, which Settings says; there no subscription is loaded (below).
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
`settings:write`). No HttpApi endpoint or MCP tool. The one raw route is the gateway layer
(`/api/ai/*`, below), in `DoorRules.RAW_ROUTE_RULES` and `AMBIENT_COOKIE_RULES`.

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

## Subscription AI accounts (OAuth)

Spec 4 ticket 03. The Owner signs in to a subscription (Claude, ChatGPT/Codex, Antigravity, Kimi,
xAI, Devin, Meta) from Settings → AI accounts → «Add subscription», or imports a Vertex service
account. The same `AiAccounts` service, rows, allowances, priority and AllowedAiAccounts as API
keys; `type: subscription`. Pure parts in `ai/subscriptionLogin.ts`.

- **Sign-in:** `aiAccounts.login.start` asks CLIProxyAPI's management API for the provider's page
  (`GET /oauth/auth-url?provider=`) and keeps one pending sign-in on the Hub (a new one replaces
  it): its CLIProxyAPI `state`, the `redirect_uri` the page names, the Owner's User and **session
  id**, 10 minutes, and the gateway it was started on. The page is shown only if it is `https:`.
  Redirect flows (Claude, Codex, Antigravity, Devin): the provider sends the browser to a localhost
  address that does not open (the Hub may be a VPS); the Owner pastes it («Paste the address you
  landed on») into `aiAccounts.login.complete`. Device flows (Kimi, xAI, Meta): the page shows a
  code; «I have signed in» completes, `pending` until the provider says yes.
- **The pasted address** (`checkPastedRedirect`) must have the same scheme, host, port and path as
  that sign-in's `redirect_uri`, no user info, exactly one `state` equal (constant time) to that
  sign-in's, one `code`, and no `error`. It travels Redacted (never logged). The Hub never fetches
  it: CLIProxyAPI gets an address rebuilt from the `redirect_uri` with only `code`, `state` and
  `scope` (`POST /oauth/callback`). Completion is refused (`expired`) from another session, after
  10 minutes, after the gateway restarted, or once done; refused pastes reach nothing.
- **Capture:** once CLIProxyAPI reports `ok` (`GET /oauth/status`), the Hub takes the one new
  token file of that provider it did not hold before the sign-in started (`GET /credentials`,
  `/credentials/download`): none, several, or a token whose `type` is not that provider's is
  refused and the files go. It is sealed under a new token id in its own store
  (`ServerSecretStore.AiAccountTokenStore`: `secrets/ai-account-tokens/tok-<id>.sealed`, purpose
  `ai-account-oauth-token`, covered by key rotation) and the file CLIProxyAPI named is deleted. A
  **new** account starts **disabled**, with «Signed in as <email>», until the Owner checks it and
  turns it on; only then does its token go to the gateway as `acct-<account>-<token id>.json` with
  `prefix: acct-<account>` (`POST /credentials?name=`). **«Sign in again»** compares the new
  identity with the sealed one: if it differs, the new token is held and the call answers
  `identity-mismatch` until the Owner confirms («Use the new account», `confirmIdentity`); then it
  replaces the token under the account's allowances, retiring the old one. Vertex: `POST
  /oauth/import?provider=vertex`, then the same capture (its identity is the service account).
- **Reconcile** (`reconcileTokens`, under the same lock as API keys, at every gateway start before
  it counts as running and after every change; one account failing leaves the others, and never
  fails the API keys): for each subscription the newest copy wins, wherever it is. A copy in
  CLIProxyAPI newer than the sealed one (a refresh, which may rotate the refresh token) is sealed
  again, also just before the file of a disabled or deleted account goes; an older one (a stale
  file a restart left in memory) is replaced by the sealed one. "Newer": the first of
  `last_refresh`, then the access expiry (`expired`…), then `timestamp` that both copies carry and
  that differs; with none, a different copy is CLIProxyAPI's (it is the only writer). Files of
  accounts deleted, disabled or signed in again go, and so does every file that is not the Hub's
  own (`acct-…-tok-….json`), except the new file of the sign-in in progress (its provider's, not
  there when it started, on that gateway, within its 10 minutes). The Hub lists the gateway's
  token files every 10 s and reads tokens back when one changed (and every 5 minutes, and while a
  sign-in is open), and once more when the Hub stops (a finalizer), so a refresh is lost only if
  the machine dies within those 10 s.
- **Gateway not running** (off, crashed, restarting) and **before every launch**
  (`AiGateway.setBeforeLaunch`): the Hub reads and removes the memory folder's files directly. A
  newer copy of an account's current token is sealed first; every file that is not an enabled
  account's current token goes, so a deleted or disabled account's token is never left in clear
  and the next CLIProxyAPI never loads it; no sign-in survives its gateway.
- **Unprefixed tokens:** the Hub is CLIProxyAPI's only client and always asks for
  `acct-<id>/<model>`, so a sign-in's own file (no prefix) is never asked for; it lives only until
  it is captured or its sign-in ends, and then goes.
- **Status:** from CLIProxyAPI's credential list: `requires_sign_in` → «Needs sign-in again»,
  `quota_blocked` → «Quota exhausted», `error`/`unavailable` → error (its message, quoted values
  and token shapes removed), else working. The Owner also sees «Signed in as» and, for Claude and
  Codex, the quota windows read by the existing reader (`usage/cliproxyApi.ts`, `api: "v8"`:
  `credentials` and `requests/api-call`) pointed at the managed gateway, cached 5 minutes, only
  windows (nothing derived from the credential).
- **No folder in memory:** decided stricter than API keys. Without `$XDG_RUNTIME_DIR` or
  `/dev/shm` the Hub loads no subscription (their files are deleted from the gateway, the accounts
  show an error, the sealed tokens stay for later) and refuses to start a sign-in or import, so no
  OAuth token is ever on a persistent disk in clear. Settings → AI gateway says so.
- **Delete, disable, «Sign in again»:** the token id is retired (`ai_account_retired_credentials`);
  the file leaves CLIProxyAPI by the next reconcile, and the sealed token leaves the store only
  after a change the gateway accepted without it (ticket 02's guarantee). The provider's own
  refresh token is **not revoked at the provider**: CLIProxyAPI has no call for it, so a token
  copied before the delete keeps working at the provider until the Owner revokes the app there
  (Google, Anthropic or OpenAI account settings).
- **Doors:** WS only, in `INSTALLATION_RPC_METHODS` (the Owner's alone, `settings:write`):
  `aiAccounts.login.start`, `aiAccounts.login.complete`, `aiAccounts.importVertex`;
  `DoorRules.AI_ACCOUNT_SIGN_IN_RULES`. No raw route or HTTP endpoint takes a provider's callback.
  Audit `ai_account.login` (provider, `new`/`again`/`import`, `signed-in`/`failed`, reason) and
  `ai_account.create` for a new one. Tokens never in a log, span, error, answer, the database or
  argv (`AiAccounts.subscriptions.test.ts`; the live pass greps the Hub's home, logs and `ps`).
- **Known limits:** one sign-in at a time per Hub. Two Hub processes over one state folder are not
  supported: the "never older" rule is checked under an in-process lock. ToS risk accepted (ADR
  0005): the form warns on every subscription and, for Antigravity, notes CLIProxyAPI's
  obfuscation (hardened in v8.0.65). **Memory is not a vault:** `/dev/shm` and `$XDG_RUNTIME_DIR`
  are tmpfs, whose pages the kernel may write to swap; a Hub whose swap is not encrypted can leave
  a token on the swap device. Use encrypted swap (or none) on a Hub with subscriptions.
- **Management calls in spans:** the Hub's HTTP spans to CLIProxyAPI carry no query value (a
  sign-in state, a credential name: all redacted), and a refused Vertex import says only its HTTP
  status, never CLIProxyAPI's words, which could quote the key.
- **No callback listener:** CLIProxyAPI 8.0.67 opens no port of its own for an OAuth callback
  (checked with `ss -ltnp` during a redirect sign-in in the live pass): the address the provider
  returns to does not open, and the Owner pastes it.

## The gateway layer: `/api/ai/*`

Spec 4 ticket 04. Every AI request from an agent or a local CLI goes through the Hub's own layer,
never to CLIProxyAPI directly; the Hub's client key never leaves the Hub. `ai/AiGatewayRoute.ts` is
the HTTP door and stays thin (route, key, `authorize`); `ai/AiGatewayProxy.ts` (`forward`) does the
rest, so any other door (ticket 06's relay included) reuses it.

- **Routes** (`gatewayShapes.matchGatewayRoute`, the only paths that exist): OpenAI
  `/api/ai/openai/v1/{chat/completions,responses,models}`, Claude
  `/api/ai/anthropic/v1/{messages,messages/count_tokens,models}`, Gemini
  `/api/ai/gemini/v1beta/models` and `/api/ai/gemini/v1beta/models/<model>:{generateContent,streamGenerateContent}`.
  Each maps to one fixed CLIProxyAPI path; anything else under `/api/ai/` (its management API,
  `/v0`, dot segments, `%2F`, embeddings…) is 404 and reaches nothing. The model lists are answered
  by the Hub: plain names of what the key may use (the Thread's account, or every allowed one).
- **Gateway keys** (`ai/AiGatewayKeys.ts`, migration 113 `ai_gateway_keys`): `t3gk_` + 32 random
  bytes, stored only as SHA-256, revocable. A **Thread key** is for (the Thread's turn owner, its
  Space, the Thread); `issueForThread` revokes the Thread's earlier keys (one per provider session,
  ticket 06 hands it to the agent, with its `providerSessionId`) and it expires after 7 days at
  most. A **User key** is for one Space the User works in (local CLIs; ticket 10 gives it a
  screen), at most five live per User; `revoke` by its User or the Owner, audited
  `ai_gateway_key.create|revoke`.
- **Revocation recorded** (`ai/AiGatewayKeyRevocation.ts`, from the domain events and User status
  changes): a provider session that stops or fails (`provider-session.updated`) takes its keys, a
  detach takes that Thread's; a Thread archived or deleted (its account in use forgotten too); a
  User disabled or removed, every key of theirs. A move or a new owner is recorded by `authorize`
  the first time it sees it. The request-time check stays the guard.
- **Authentication:** only the key, in `Authorization: Bearer` (every shape), `x-api-key`
  (Claude) or `x-goog-api-key` (Gemini). Two different keys, a key in the query, a session cookie
  or any other credential: 401. The route reads no cookie at all (`AMBIENT_COOKIE_RULES`: refused).
- **Every request is decided again** (`AiGatewayKeys.authorize`, the one rule of the door): the
  key's row (unknown, revoked, expired → 401); its User still active (401); for a Thread key, the
  Thread neither archived nor deleted (401), still in the key's Space (a Project moved → 403), still
  owned by the key's User (403), its Project not moving (503); then `AllowedAiAccounts.for(User,
  Space)` now, gateway accounts only (none → 403). Nothing is cached: an allowance removed, a
  membership ended or an account disabled or deleted fails the next request.
- **Routing** (`gatewayShapes.planRoute`): with a User key, the account the client pinned with
  `acct-<id>/<model>` (must be allowed: else 403); a Thread key may name only its Thread's own
  account (anything else 403: an agent, perhaps prompted to, never moves its Thread to another
  account); else the Thread's (`modelSelection.aiAccountId`; no longer allowed →
  403 «Switch AI account», never a silent fallback), else the first allowed account by global
  priority that serves the model (`AiAccounts.modelsOf`; none → 404). Then the failovers: every
  other allowed account of the **same provider** that serves the same model, by priority. The Hub
  always sends `acct-<id>/<model>`; a double or malformed prefix is 400. A 429 from CLIProxyAPI
  tries the next; none left answers 429 «No allowed AI account for <provider> has quota left;
  switch AI account» in the client's shape.
- **What crosses:** to CLIProxyAPI the rewritten body, the Hub's client key and only `accept`,
  `anthropic-version`, `anthropic-beta`, `user-agent` (no `X-*`, cookie or forwarding header), and
  for Gemini only `alt=sse`; an upstream redirect is never followed (1xx/3xx answer 502). Back: the
  status, `content-type` and the Hub's own `cache-control: no-cache, no-transform` (so compression
  never holds SSE back), the body streamed chunk by chunk through `gatewayTap.makeResponseTap`,
  which holds back at most 1 MiB: it strips the account's prefix, filters the words of an error in
  an SSE event or a JSON-array element (Gemini's stream without `alt=sse`), and reads the tokens
  (SSE events, array elements, a plain answer whole up to 1 MiB, past that its tail). An OpenAI
  chat stream without `stream_options.include_usage` gets it from the Hub, and the usage chunk the
  client did not ask for is dropped. An upstream error is answered in the client's shape: the provider's words
  for a 4xx (emails, URLs, keys, token shapes and `acct-…/` removed), a fixed sentence for auth,
  quota and 5xx.
- **Account in use:** `AiGatewayActivity.noteInUse` keeps each Thread's last account and model
  (`ai_gateway_thread_accounts`) and publishes a change (`subscribeAccountsInUse`) for the Thread's
  header (`count_tokens` does not move it); every request ends in one `GatewayRequestRecord`
  (`subscribeRequests`: User, Space, Thread, key, account, provider, model, status, duration,
  failovers, tokens), also one whose answer was never read, which ticket 05 stores as usage.
- **Limits** (`AiGatewayProxyLimits`; no quotas): the body is read first, in its own pool (8 per
  User, 64 per Hub), within 60 s and never 15 s without bytes (408), at most 32 MiB
  (`T3CODE_AI_GATEWAY_MAX_REQUEST_BYTES`, 413), uncompressed (415), and within the Hub's 512 MiB
  of held request bytes, counted three times over for its copies (503). Only then a request slot:
  16 per key, 32 per User, 256 per Hub (429), so one User never takes them all. The answer: 10
  minutes to its first byte, 60 in all, 5 without a byte from upstream, and 2 with a client that
  does not read (bounded backpressure: the next chunk is pulled only once the client took the
  last). Upstream error and 429 bodies are read for at most 10 s and 64 KiB.
- **Logs and spans:** one line and one span (`AiGateway.request`) per request with method, route,
  account, model, status, failovers and tokens; a refusal logs method, matched route and status.
  Never a header, a key, a body or a prompt. The HTTP server's own span is off for `/api/ai/*`
  (`http.ts`), since a client could put a key in the address.
- **Who reaches it:** whoever reaches the Hub's URL: joined machines by it, Sandboxes through their
  Hub socket, which forwards `/api/ai/…` (and still nothing of CLIProxyAPI, which listens on loopback
  only). The key is what decides.

## Agents through the gateway (spec 4 ticket 06)

Decisions; the code is `ai/AiGatewaySessions.ts` (the rule), `environments/AiGatewayRelay.ts`
(the machine's side) and `provider-core/server/instanceEnvironment.ts` (what each driver sets).

- **Who goes through it.** Claude Code, Codex, OpenCode and Pi, on a Hub with a usable AI account
  (not deleted, not disabled, not direct), and always in Sandboxes and dedicated machines, whose
  logins are retired. Never a fallback to a login: no allowed account, an account no longer
  allowed, no allowed account serving the model, a machine before contract 11 or plain HTTP to a
  remote Hub all refuse the session. Unreadable state refuses too.
- **One plan per open, one key per process.** The plan (owner, Space, account) is decided once per
  open, without a key; a running session for another owner or account is not reused, and a busy
  one never serves a turn that must go through the gateway. The key is issued only when a process
  starts, after the shared-process refusal, for the Thread's turn owner; it is revoked when the
  session is released, on any failure or interruption of the open, and at every Hub start (no
  session survives one). A gateway session never serves another Thread.
- **The account shown is the account routed**: the Thread's, else the first allowed by global
  priority that serves the model, as the gateway's `planRoute` picks it. A failover is not shown
  yet (ticket 08's header).
- **The key travels like a secret** (`provider.openSession` only, environment only: never
  arguments, files, logs or the event store). Ambient AI variables are dropped and the gateway's
  set last, so neither the machine nor a Vault overrides them; Vaults refuse those names
  (`AI_GATEWAY_ENV_NAMES`, checked against what the drivers set). Loopback is added to `NO_PROXY`.
- **Project configuration cannot redirect it.** Claude Code gets the base URL and model as flag
  settings, which outrank a project's `.claude/settings*.json` (the key itself never goes there);
  OpenCode runs with `OPENCODE_DISABLE_PROJECT_CONFIG`. Pi loads a project's settings and
  extensions only in a folder the User trusted.
- **The relay** listens on loopback only and forwards the gateway's own routes to the Hub (by the
  Sandbox's socket, or the Hub's https URL), adding, keeping and following nothing.
- **Provider homes** are per Thread and driver, under the machine's state directory: no login or
  setting of the machine's user.
- **Terminals and setup scripts get no key**: a User's shell would carry the Thread's key; local
  CLIs use User keys (ticket 10).

**Accepted risks.** The agent's own process holds the key: anything it runs can read
`/proc/<pid>/environ`, and in a shared Sandbox so can the Space's other processes (ADR 0004).
Claude Code scrubs its Bash tool's environment (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) and Codex's
default shell policy drops `*KEY*` names; OpenCode's and Pi's tools inherit the key, and a Pi
extension of a trusted project runs with it. A key is worth only its Thread's allowed accounts
while its session lives. Provider homes stay on the machine after a Thread is deleted (transcripts,
never the key): removing them needs an executor operation, left for a later ticket.

## Known exception to «no upstream services»

CLIProxyAPI 8.0.67, even with `-local-model`, asks the internet for the latest Antigravity client
version (`antigravity-hub-auto-updater-….run.app`, every 3 h) and the Grok CLI version
(`registry.npmjs.org/@xai-official/grok/latest`). The pinned release has no setting that turns these
off (none among its config keys in the binary), and a proxy scoped to the child
would also carry the providers' own traffic. Accepted as a known exception to ADR 0007: the requests
carry no credential, prompt or account, only the Hub's address. Revisit at each pin update.
