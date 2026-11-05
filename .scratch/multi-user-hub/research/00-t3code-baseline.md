# What t3code already has (baseline, 2026-11-04, upstream commit a21d788752)

Facts gathered by a read-only exploration of the clone. Paths relative to the repo root.

## 1. Users & auth

- No user accounts per server. An Environment is one server process owning machine, credentials and state (`docs/internals/glossary.md`). Sessions carry a free-form `subject` label (`one-time-token`, `cli-issued-session`, `administrative-bootstrap`, `mcp-client`) (`apps/server/src/auth/EnvironmentAuth.ts:53-54`). Agents run as the server's OS user.
- Clients authenticate by exchanging a pairing link / one-time token for a scoped session (browser cookie, bearer or DPoP), plus short-lived WebSocket tickets. Every RPC declares a required scope (`apps/server/src/auth/RpcAuthorization.ts`, `docs/internals/environment-auth.md:7-99`).
- Scopes (`packages/contracts/src/auth.ts:31-67`): `orchestration:read/operate`, `settings:write`, `providers:manage`, `environment:maintain`, `preview:operate`, `diagnostics:read`, `terminal:read/operate`, `source-control:write`, `filesystem:read/write`, `access:read/write`, `relay:read/write`.
- No real admin vs standard split: the default grant (`AuthStandardClientScopes`, `auth.ts:150`) is every scope, because a shell or full-access agent can already mint any session. Narrower grants via `--scope`.
- `CLIENT_GUARDED_RPC_SCOPES` (`packages/contracts/src/clientRpcPermissions.ts:17`) only gates UI; the server checks every call.
- Guest links: one browser gets read access to one thread for 24h and may propose messages (`docs/user/guest-links.md`). Sessions are listed/revoked in Settings → Sharing & access.
- No org/team/tenant. "Organization" appears only as a display name in Managed Policy, a per-machine admin policy file (`docs/user/managed-policy.md`).

## 2. AI providers & accounts

- Drivers (`apps/server/src/provider/builtInDrivers.ts`): Codex, Claude, Cursor (SDK), Grok, fx, OpenCode, Antigravity, Kiro, Pi, Muse, plus an ACP registry for generic agents. All wrap a CLI, SDK or agent.
- A provider instance = one configuration + one account; many instances per driver (`docs/internals/providers.md:7-10`). Claude: one instance per `CLAUDE_CONFIG_DIR` (`docs/user/providers-claude.md:7-38`). Codex: multiple ChatGPT accounts, shared-home/shadow-home (`docs/user/providers-codex.md:28-75`).
- Threads pick an instance via `modelSelection.instanceId`. Mid-thread switching only between compatible instances (same config dir or same `CODEX_HOME`).
- No native API client for Anthropic/OpenAI/Gemini/DeepSeek. API keys, base URLs and routers (OpenRouter, claude-code-router) are passed as per-instance env vars to the CLI (`providers-claude.md:104-137`, `docs/user/providers-pi.md:29`, `docs/user/providers-kiro.md:13`).
- No LLM proxy. `apps/server/src/provider/CodexManagedTokenBroker.ts` is only a local token broker for T3-managed ChatGPT sign-in.

## 3. Secrets

- `secret-provider-core`: driver interface + `SecretResolver`; reads `{provider, reference}` pointers, caches each read for the server lifetime. `secret-provider-definitions`: registry, only 1Password. `secret-provider-onepassword`: reads `op://vault/item/field` via the `op` CLI.
- References usable in provider-instance env vars (`packages/contracts/src/providerInstance.ts:32-46`) and some settings fields (`SettingsSecretValue`).
- `<stateDir>/secrets/<name>.bin` (`apps/server/src/config.ts:171`): folder 0700, files 0600, no encryption found (`apps/server/src/auth/ServerSecretStore.ts`). Holds signing keys, cloud tokens, provider auth (`ProviderCredentialStore.ts`), sensitive settings (`settingsSecrets.ts`).
- Agent secret requests (`apps/server/src/secrets/SecretRequests.ts`): agent asks, user answers, value stored behind a one-use ref tied to a `projectId`, or written to an owner-only file.
- Injection: provider env vars per instance; a terminal takes a client-supplied `env` map or a `providerInstanceId` (`packages/contracts/src/terminal.ts:36-44`).
- Not found: per-project env vars or a project secret vault.

## 4. Environments

- One server process with a stable ID, owns providers, files and SQLite state (`docs/internals/remote.md:3-30`).
- A client connects to several at once: `packages/client-runtime` keeps one connection per environment (`docs/internals/connection-runtime.md`). UI has "All environments" bulk settings and auto load-balancing of new threads (`docs/user/remote-access.md:152-168`).
- Connect via LAN pairing, Tailscale (`packages/tailscale`), T3 Connect tunnel (Clerk identity; 3/10/100 machines per account), desktop-managed SSH.
- SSH provisioning: Settings → Environments → Add environment → SSH downloads the server to `~/.t3/runtime` on Linux / Apple Silicon hosts, starts it and forwards the port (`remote-access.md:208-237`, `packages/ssh/src/tunnel.ts`).
- Headless VPS: `t3 up` or the background service; accepts only loopback, private or tailnet peers (`remote.md:58-65`).
- Peer links (beta): agents in environment A drive environment B over MCP (`remote.md:70-140`).

## 5. Projects & threads

- A project and its threads belong to exactly one environment (`remote.md:13-15`). The UI can group checkouts of the same repo across environments, but permissions are never combined.
- Threads without a project still have a folder: `~/.t3/scratch/<date-slug-id>`, backed by a hidden Scratch project (`ProjectEnsureScratchResult`, `packages/contracts/src/project.ts:521`). `projectId` is required on threads (`packages/contracts/src/orchestrationV2.ts:447`). Convertible to a real project (`docs/user/thread-sidebar.md:25-47`).
- No pure chat without a filesystem. Side chats exist, inside a thread.

## 6. Moving work between environments

- `thread-migration.md` = one-time V1→V2 local DB import. `portable-handoffs.md` / `context-handoffs.md` = carrying text context (~16k tokens budget) when switching provider, forking or restarting.
- No move/migrate RPC for threads or projects. "Existing threads stay where they started" (`remote-access.md:166`). Only unsent drafts change machine.
- Dragging a thread from another environment attaches a transcript snapshot file (`docs/user/composer.md:305-320`). `delegate_task` runs a new thread in a linked environment's project for the same repository.
- Files are never copied; git is the only shared layer. Checkpoints are hidden git refs that stay local.

## 7. Processes & resources

- `terminal-runtime.md`: server owns PTYs and their history (5,000 lines / 8 MiB per terminal). `resource-telemetry.md`: native Rust monitor samples CPU, memory, I/O per process. `activity-log.md`: UI grouping of tool calls only.
- Process diagnostics lists the server's process tree (pid, CPU, memory, command), grouped by category (`provider-root`, `terminal-root`, …) (`packages/contracts/src/resourceTelemetry.ts:26`, `packages/contracts/src/server.ts:431`). `server.signalProcess` sends SIGINT/SIGKILL, requires `environment:maintain` (`RpcAuthorization.ts:112`).
- `forceStopThread` kills a thread's agent processes; listed preview ports can be stopped.
- No per-thread/per-project CPU or memory: telemetry entries carry no `threadId`/`projectId`, and metric groups deliberately exclude threads.

## Biggest gaps vs a multi-user/org product

1. No users, roles or tenants: one environment = one OS user; sessions are scoped capability tokens, not identities.
2. No isolation inside an environment: projects are not sandboxes, shell scope = admin, secrets are unencrypted 0600 files scoped per instance/settings, not per user/project.
3. Projects/threads cannot move between environments; provider access is CLI wrapping only (no API/proxy layer); no per-thread resource attribution.
