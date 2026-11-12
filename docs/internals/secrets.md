# Secrets at rest and the master key

The Hub keeps its secrets in `ServerSecretStore` (`apps/server/src/auth/ServerSecretStore.ts`): one
file per name in `<stateDir>/secrets`. Session signing keys, preview-profile HMAC keys, provider and
source-control credentials from Settings (`settingsSecrets.ts`), the SSH key the Owner keeps «for
updates» (`ssh-install-key-<id>`), `request_secret` answers and replay markers all live there. Since
spec 5 («Vaults», ticket 01) every entry is encrypted with a **master key** that lives in a file of
its own. Callers do not know: the store's API (`get`, `set`, `create`, `getOrCreateRandom`,
`remove`) did not change.

## Files

- `<name>.sealed`: an entry sealed with the master key. `<name>.bin`: an entry in clear, from before
  encryption (sealed at the next start) or on a joined machine that never was a Hub. Which is which
  is told **by the name only**, never by the bytes: a random value that happens to start like a
  sealed one is still read as written.
- `master-key.check`: sealed by the key it checks, it records the key file the Hub last started
  with (a command using another `T3CODE_MASTER_KEY_FILE` warns).
- `master-key.backup`: sealed, when the Owner last confirmed a backup of this key. Neither file is
  an entry, so no `set` of any name can write them.
- Every write goes through `atomicFile.ts`: an owner-only `wx` temp file, fsync, rename (replace) or
  link (create only), fsync of the folder. The key file uses the same helper.

## The sealed format

`SecretCipher.ts`, on `node:crypto` only:

```
\0T3S | format (1 byte, 0x01) | key id (8 bytes) | nonce (12 bytes) | ciphertext | GCM tag (16 bytes)
```

- **AES-256-GCM** under a subkey `HKDF-SHA256(master key, info = "t3code <purpose> v1")`: one subkey
  per use (`server-secret` for entries, `key-check`, `backup-record`, `secret-file`; Vault values in
  the database, ticket 02, get their own).
- **A fresh random 96-bit nonce per seal.** Two writes of one value never share bytes. A Hub writes
  a few thousand entries per key, far below the 2³² seals per key where random nonces start to
  matter.
- **Associated data:** the header (format and key id) followed by the purpose and the entry's name.
  A file copied or renamed to another name, or moved to another purpose, does not open.
- **Key id:** the first 8 bytes of `HKDF(master key, "t3code master key id v1")`: a fingerprint that
  names the key without revealing it. It tells "sealed by another key" from "damaged", and lets a
  rotation stop and resume.

## The master key file

- 32 random bytes, written as one line `t3-master-key-v1:<base64url>`: the same text is the
  backup.
- Default `<stateDir>/master.key`; `T3CODE_MASTER_KEY_FILE` puts it elsewhere (off the disk that is
  backed up). It must be an absolute path (or start with `~`): a server and a CLI started from
  different folders would otherwise read different files. It is the only secret of the Hub kept in
  clear.
- Created on first start with mode `0600` (exclusive create: two processes starting together end
  with one key).
- **Permissions**, checked on the open handle at every start (POSIX):
  - owner-only (`0600` or tighter) passes;
  - a file owned by root that others cannot read and group cannot write (`0440`/`0400`, a
    Kubernetes or Docker secret mount shared with the Hub's group) passes: an administrator placed
    it and decides which group reads it, and nobody but root can replace it. `0444`/`0404` (readable
    by everyone) is refused like any other loose mode;
  - anything else stops the startup with «run `chmod 600 <file>`», unless
    `T3CODE_MASTER_KEY_ALLOW_LOOSE_PERMISSIONS=1`, for file systems without real modes (drvfs under
    WSL, some NFS mounts), which logs a warning at every start.
  - On Windows mode bits mean nothing: the file inherits the ACL of its folder, which under the
    user's profile (the default state directory) is that user's alone; put
    `T3CODE_MASTER_KEY_FILE` in a folder with the same ACL.
- Never in the database, a log, a span (not even a span's result), an error message or a process
  argument: its bytes sit in a private field of `MasterKey` (inspecting or serialising one shows
  only its id), errors name files and key ids only, the file reader that returns it has no span,
  and `t3 secrets key import` reads the key from a file or stdin, never argv.
- Client file reads and git never serve it: in the key's own folder, `serverInternalPaths.ts` hides
  the key and every name the key could have become: anything starting with `<key name>.` or
  `<key name>~` (`.next`, `.previous`, `.replaced-<id>`, temp files, backups) and any `.swp` file.
  In other folders nothing is hidden for it. Stale temporary key files (which hold a whole key) are
  removed at startup.

## Startup (`MasterKeyFile.openKeyring`)

Two modes:

- **owner**: the server (it holds the server's ownership lock, `serverOwnership.ts`), or a command
  that took that lock because no server runs. It may create the key, seal, re-seal and finish a
  rotation.
- **client**: a command beside a running server (`t3 pair`, `t3 auth`, `t3 secrets key export`…,
  through `ServerSecretStore.layerClient`). It lists names only (no entry is read; the key check
  tells a wrong key), ignores replay markers (the Hub prunes them) and writes nothing. Only if the
  store needs a startup (no key yet, entries in clear, a rotation to finish) and no server runs
  (its runtime record names no live process) does it take the ownership lock, briefly, to run that
  startup itself; a Hub starting meanwhile wins the lock. Otherwise only what touches a secret
  fails, with «Start the Hub, or stop it and run this again».

In order:

1. **Read** `master.key`, `master.key.next`, `master.key.previous`, the list of entries and the key
   check.
2. **No key:** if anything encrypted exists (a sealed entry, the key check, a `.next`/`.previous`
   key), stop: «The master key … is missing … restore it with `t3 secrets key import`». A new key is
   never created over values another one sealed. Otherwise (owner) create the key.
3. **Headers only:** each sealed entry's key id (13 bytes read). One sealed by a key the Hub does
   not have, or a key check that does not open, stops the startup. Nothing was written.
4. **Anything to write?** Entries in clear, entries under another key (a rotation), expired replay
   markers. If not, the startup is done: a normal start reads headers only.
5. **Authenticate before writing:** every live sealed entry is opened in full. A damaged one stops the
   startup before anything is written.
6. **Write:** expired replay markers (older than a day) are dropped, not re-sealed; each entry in
   clear becomes `<name>.sealed` (atomic) and then its `.bin` goes (a `.bin` that already opens as
   a value sealed under the current key, as the branch's first encrypting build wrote them, is
   renamed, never sealed twice); entries removed while the startup ran are skipped; each entry under another key is
   re-sealed in place. Every rewritten entry keeps its modification time, which replay-marker
   pruning reads. A crash leaves every entry either as it was or done; the next start finishes.
7. **Finish a rotation** that stopped (below), rewrite the key check when needed, remove stale
   temporary files in the secrets folder and in the key's folder.

After startup a value found in clear, sealed by an unknown key, or under the wrong name fails to read
(`SecretStoreDecodeError`); the store never accepts a planted plain file as a secret, and never hands
out sealed bytes as a value.

## Backup, import and rotation

- **Backup** (`MasterKeyBackup.ts`, the same for Settings and the CLI):
  1. `export` records `secret.master_key.export` (`via`, `keyId`) in the audit log first; if it
     cannot, the key is not handed out.
  2. The key goes to the Owner: Settings («Download master key backup», after the strong factor in
     the request: a passkey, or password and TOTP code) downloads it as a file; `t3 secrets key
     export` writes it to a new owner-only file (`--output`, fsynced) or to stdout, and fails if the
     write did not complete.
  3. `confirm` records the backup (`master-key.backup`) only once the Owner shows they hold it: the
     key's first 8 characters after `t3-master-key-v1:`. Settings asks the Owner to type them from
     the saved file; the CLI confirms itself once the write succeeded. An interrupted or abandoned
     download leaves the warning on. A rotation makes it come back.
- **Import** (`t3 secrets key import <file>` or `-` for stdin), with the Hub stopped: the key must
  open the secrets here (the key check and every sealed entry), otherwise nothing changes. A key it
  replaces is kept as `master.key.replaced-<id>`, never discarded. Restoring on another server:
  copy the state directory, import the backup, start.
- **Rotation** (`t3 secrets key rotate`), with the Hub stopped (it takes the server's ownership
  lock): writes the new key as `master.key.next`, re-seals every entry and the key check under it
  (each an atomic replace, after authenticating all of them), drops the old backup record, writes
  the old key to `master.key.previous`, then renames `.next` over `master.key`. A crash at any step
  leaves both keys on disk; the next start (or the command again) finishes it. The previous key
  opens values until the Owner deletes the file. Audit `secret.master_key.rotate`.

## HTTP door

`GET /api/vaults/master-key` (`vaults.masterKeyStatus`), `POST /api/vaults/master-key/backup`
(`vaults.masterKeyBackup`, body `{ reauth }`) and `POST /api/vaults/master-key/backup/confirm`
(`vaults.masterKeyBackupConfirm`, body `{ keyId, proof }`): the Owner only (`AccessPolicy` action
`masterKey.backup`), the download with a strong factor in the request. Declared in `DoorRules.ts`. No
WS RPC or MCP tool reaches the key.

## Joined machines

A machine joined to a Hub (its `joined-hub.json` present) that never was a Hub keeps its store in
clear: the Hub writes a Sandbox's credential into the Sandbox's home, which a Podman Sandbox mounts
read-only, and a key stored beside the credential would protect nothing. A machine that was a Hub
(a master key, a key check or a sealed entry in its state directory) keeps its key when it joins
(`t3 join --force`): what it sealed still opens and new values, the credential included, are sealed
too. Without the key its sealed entries are an error, never bytes passed off as values.

## request_secret file answers

A `file` answer is for the agent's own shell, which reads it by path.

- **At rest, the source of truth:** `secrets/files/<id>.sealed`, sealed under its own purpose
  (`secret-file`, the id as associated data), for the whole TTL (24 h). A reboot or a logout loses
  nothing: a request whose file is missing writes it again from the sealed copy, so a command
  holding the path never reads another value.
- **For the agent, in memory where possible:** `SecretFilesDirectory.ts` picks
  `$XDG_RUNTIME_DIR/t3code-secret-files-<hash>`, else `/dev/shm/t3code-secret-files-<hash>` (one per
  state directory). It is created with `mkdir` and checked with `lstat`: a symlink, or a folder
  someone else made, is never used.
- **Without a folder in memory** (macOS and Windows desktop: a single-user local Hub), the answer
  goes to `secrets/delivered/` on the disk, folder `0700`, file `0600`. Each start empties it, the
  sweep removes expired files, and the Hub logs one warning per start that file answers touch the
  disk on this platform. Pasting a secret in chat keeps working there.
- At startup the folder in memory loses half-written files and answers whose sealed copy is gone.
- Answers that earlier versions left in clear in `secrets/files/<id>` are sealed in place one by
  one (keeping their age); one that cannot be read (a dangling symlink, no permission) is logged
  and removed, and never stops the others. No clear copy stays.
- Nothing logs an answer: logs and spans name the request and the count of files, never a value,
  so a path is never logged together with what it holds.
- The path only means something to a shell on the Hub machine: `file` delivery applies only when the
  Hub machine runs agents (development, `T3CODE_HUB_RUNS_AGENTS`, and the desktop app); a Thread in
  a Sandbox or on a joined machine cannot read a path on the Hub.

## Vaults (spec 5, ticket 02)

A Vault is a named set of secrets, each under an environment-variable name. `vaults/Vaults.ts`
is the one service; WS RPCs `vaults.*` and HTTP `vaults.reveal` are its doors.

- **Where values live:** never in the database. Each `own` or `copy` value is an entry of
  `ServerSecretStore.VaultValueStore`: its own folder, `secrets/vault-values/<value id>.sealed`,
  sealed under its own purpose (`vault-value`; `MasterKeyFile.STORE_NAMESPACES` gives each folder
  its purpose, never a name prefix). The store's own names are single file names, so no other
  caller reaches that folder. The startup authenticates them with every other entry, a rotation
  re-seals them, and `t3 secrets key import` refuses a key that does not open them. A joined
  machine (no master key) keeps no Vault value and runs no Vaults: every call answers
  `unavailable` and nothing is written to its database.
- **AI accounts' credentials** (spec 4) use the same scheme in `secrets/ai-accounts/`, purpose
  `ai-account-credential`; see docs/internals/ai-gateway.md.
- **Writes:** every value write goes to a new value id. The row (pointing at it), its version and
  the audit commit in one transaction; only then is the old value removed; if the transaction
  fails, the new value is. A crash between the two leaves a value no row points at, which the
  next start removes (it lists only the Vault values' folder).
- **Metadata** (migration 111): `vaults` (the Main vault is `vault-main`, made at the Hub's start,
  never deleted or renamed), `vault_entries` (`own` | `copy` | `link`, `value_id`; a Secret link
  keeps `linked_entry_id` and is «broken» once its original is gone), `vault_allowances`,
  `space_default_vaults`, `project_vault_choices` (used from ticket 03) and `vault_key_check`.
- **The database's key check** (`vaults/VaultKeyCheck.ts`): a known text sealed with the master key,
  checked first at the start, before anything is written to the database. Written at the first
  start; re-sealed when it opens only with the previous key (after a rotation; `t3 secrets key
  rotate` re-seals it at once); a key that opens the secrets folder but not this check stops the
  Hub: the database and the folder come from different Hubs.
- **Who may** (`AccessPolicy`, `vault.view|edit|manage|reveal` on a `VaultResource`, through
  `SpaceDirectory.authorizer`, decided once per request, which also keeps an agent bound to one
  Space to that Space):
  the Owner does everything and alone creates, renames, archives, deletes and reveals; the Main
  vault and the Owner's other Vaults are the Owner's alone; an Organization's Admins add, replace,
  rename and delete its secrets without reading them; its Members and Guests see names and
  descriptions. A Vault one cannot see answers like a missing one.
- **Links and copies** come only from the Main vault and need editing it (the Owner), so no Vault
  hands a Main vault value to anyone the Owner did not choose. A link reads its original at use, so
  rotating the original changes every link; a copy is sealed again under its own entry. Deleting an
  original with links answers with the links it would break until it is asked again with
  `breakLinks`.
- **Links seen from an Organization:** whoever does not see the Main vault learns nothing of the
  original: not whether it is short (`unmasked`), not its version or rotation (a link row's own
  version never moves), not its name. Its editors (the Owner, the Organization's Admins) see that
  it broke; its Members and Guests do not.
- **Names** (`secretNameRisk` in contracts, compared uppercased): `^[A-Z_][A-Z0-9_]{0,127}$`,
  unique in a Vault. `gateway`: the Hub's own (`T3_*`, `T3CODE_*`, the AI gateway's variables),
  refused for everyone. `dangerous`: what changes how tools run or whom they trust (process and
  loader options, interpreters' startup options, `GIT_*`, `SSH_*`, proxies and CAs, home, temp,
  shell, `XDG_*`, `BASH_FUNC_*`, and every AI provider's keys and base URLs such as
  `ANTHROPIC_*`, `OPENAI_*`, `GEMINI_*`, `GOOGLE_*`): only the Owner (AccessPolicy
  `vault.dangerousName`), with `confirmDangerous`, audited `dangerous: true`. An Admin can neither
  add one, rename into one, nor replace or rename one the Owner set. **Values:** UTF-8 without
  NUL, at most 64 KiB; shorter than 6 characters is kept with a `short-value` warning and marked
  `unmasked` (never masked later).
- **Values out:** only `vaults.reveal` (HTTP), the Owner, after `Vaults.authorizeReveal` and then a
  strong factor in the request; audited `secret.reveal` before the value leaves. Values in arrive
  as `Schema.RedactedFromValue`, so no log, span or error shows them. Every change is audited
  (`vault.create|update|delete`, `secret.edit` with `op`) with names and kinds, never values.

## Allowing Vaults (spec 5, ticket 03)

Which Vaults may reach a Space or a User is one rule, `vaults/VaultReach.ts`, used by the doors
that choose Vaults and by the effective set:

- **The Main vault** reaches only the Owner's Personal space, where it is always a default (a
  fixed one, «Always» in Settings). It is never allowed to anyone (`main-vault`): its secrets
  reach others only through Secret links or copies.
- **An Organization's Vault** reaches its own Organization, without an allowance, and nothing
  else: allowing it to another Space or to a User is refused (`not-allowed`), so what its Admins
  write stays in their Organization.
- **One of the Owner's other Vaults** reaches the Spaces and Users the Owner allowed it to
  (`vaults.allow`, AccessPolicy `vault.manage`: the Owner; audited `vault.allow`). Taking it back
  never needs the Space or User to exist any more. Taking it back from a Space also drops that
  Space's default and its Projects' choices of it (Projects by `SpaceDirectory.projectSpaceSql`,
  so one from before Spaces counts as the Owner's Personal space's), so allowing it again never
  brings them back unseen. Allowing it to a User shows the shared-Sandbox warning first
  (ADR 0004): only that User's turns, terminals and scripts receive it, but other agents in the
  same Sandbox can read a running process's environment.
- Allowance rows on the Main vault or on an Organization's Vault are ignored when reading, so a
  stray row never widens what a Vault reaches.
- **Who sees and edits the Owner's allowed Vaults** (`AccessPolicy.decideAllowedVault`): whoever
  works in an allowed Space, or is an allowed User, sees its names. An Admin edits its secrets only
  while it reaches nothing but Organizations they run (no User, no Personal space, no other
  Organization). Whom a Vault is allowed to is shown to the Owner alone.

**Choosing** (`vault.choose`, decided on the Space: the Owner anywhere, a Personal space
included; an Organization's Admins while it is open): `vaults.spaceDefaults.set` replaces a
Space's defaults, in order; `vaults.projectChoices.set` adds, removes or clears (`inherit`) one
Vault for a Project. Both accept only Vaults allowed to the Space (`not-allowed`) and are audited
`vault.choose` per effective default or choice changed (`scope`, `choice`, `position`,
`projectId`). An archived Vault never becomes a default or a Project's add; one already a default
may stay or be unchecked. The fixed defaults (`VaultReach.fixedDefaults`: the Main vault in the
Owner's Personal space) are never a Project's add or remove, in the service, in `forThread` and in
the UI. `vaults.choices` shows a Vault's names only to whoever may `vault.view` it. The scratch Project
(Threads without a Project) takes no choices: it spans every Space. `vaults.choices` reads them for
whoever sees the Space.

## The effective set (`vaults/EffectiveVaults.ts`)

`EffectiveVaults.forThread({ threadId, actingUserId })` is the only place that computes which
secrets a turn, a terminal or a script of a Thread receives. Delivery (ticket 04), masking (05),
the agent's list of names (06) and the move plan (07) call it. Recomputed on every call, never
cached: a rotation, a revocation or a Membership that ends takes effect at the next turn or
terminal.

1. The Thread's Space (`SpaceDirectory.placementOf`: the Thread's own, else its Project's) must
   be one the acting User works in, else `forbidden`: nothing is computed for a removed Member.
2. Space side: the Space's defaults, plus the Project's `add`s, minus its `remove`s, all limited to
   the Vaults allowed to that Space now. A choice left behind by a Project that moved Space, or a
   default whose allowance was taken back, changes nothing.
3. User side: the Vaults allowed to the acting User, whichever Space the Thread is in. Never
   another User's, even in the same Thread or Sandbox.
4. Without archived Vaults, broken Secret links (a link's value and length are its original's),
   and names `secretNameRisk` calls `invalid` or `gateway`, however they got in. `dangerous` names
   are delivered (only the Owner sets them) and marked.

**Precedence for a name several Vaults define:** the User's own Vaults, then the Project's adds,
then the Space's defaults. Within the User's and the Project's, the Owner's order (Settings →
Vaults: the Main vault, then position, then name); within the defaults, the order they were set
in (the Main vault first in the Owner's Personal space). The losers are listed as `shadowed`, and
the Thread's «Secrets» panel says «Wins over …». Precedence only picks among entries already
allowed: it never lets a name in that rule 4 keeps out.

It returns value ids (`VaultValueStore` entries; a link's is its original's), never values: only
delivery reads them. `vaults.threadEnvironment` (WS, the Thread must be visible) computes it for the
caller and strips value and entry ids: each User sees what their own turns would receive.
`DoorRules.test.ts` checks that only `server.ts`, `ws.ts` and `SecretDelivery` reach the service
and that no Vault RPC answers a `value` or a `valueId`.

## Delivery as environment variables (`vaults/SecretDelivery.ts`, spec 5 ticket 04)

`SecretDelivery` is the one place that turns the effective set into the environment of one process,
as that process starts. It reads the values from `VaultValueStore` at that moment and hands them to
the caller, which sends them on at once: nothing on the Hub keeps them after the call.

**Who receives what** is decided on the Hub, never from a client or an agent:

- a turn: the Thread's owner (`orchestration_v2_projection_threads.owner_user_id`; a child Thread
  speaks for its root's owner). A Thread without an owner (from before Users) gets nothing;
- a terminal: the signed-in User who opens or attaches it (only the Thread's owner may: `work`);
- a setup script on the Hub machine: the Thread's owner.

**The doors** (each calls `SecretDelivery`, `DoorRules.test.ts` lists them):

| Door                                    | Where                                 | Field on the wire                         |
| --------------------------------------- | ------------------------------------- | ----------------------------------------- |
| A provider session opens                | `ProviderSessionManager.open`         | `provider.openSession` `secretEnv`        |
| A terminal opens                        | `ThreadWorkspace.terminalOpen`        | `terminal.open` `secretEnv`               |
| An attach starts a shell (new terminal) | `ThreadWorkspace.terminalAttach`      | `terminal.stream` `secretEnv` (used once) |
| A setup script on the Hub machine       | `ProjectSetupScriptRunner`            | in process                                |
| Choosing a provider session id          | `Orchestrator` (names only, no value) | none                                      |

Dev servers started from a terminal, by the agent or by a script inherit that process's
environment; previews get nothing of their own. MCP tools that run commands do so inside the agent
or a terminal, and so with that process's environment. A moved Thread's setup script on the target
machine (`move.prepare`) and setup scripts of other machines get no secrets yet.

**Rules, in `SecretDelivery.forProcess`:**

- a machine that does not serve the Thread's Space (`servesSpace`, spec 3 ticket 12) gets nothing;
- a machine on executor contract 9 or earlier and a non-empty set: `SecretDeliveryError`
  (`outdated-machine`, «<machine> needs an update to receive this Thread's secrets»). The turn
  fails with that message, the terminal answers it (`secrets_unavailable`). An empty set works as
  before. `RemoteEnvironments.invoke` also strips `secretEnv` from anything sent to such a machine;
- a `dangerous` name is delivered only while the Owner is the last who set it (`updated_by`);
- a fingerprint (sha256 of the User and each name and value id, never a value) names the set.

**Provider sessions.** `ProviderSessionManager` keeps each live session's fingerprint. A turn whose
set differs (a rotation, a revoked Vault, another set) releases the Thread's session and opens a
new one with the new environment: providers cannot change a live process's environment. A process
that holds secrets serves one Thread: no other Thread joins it, and the instance-wide session a
shared provider (Codex) uses for every Thread never gets secrets. A Thread with secrets gets its own
session id (`Orchestrator.providerSessionIdFor`, `SecretDelivery.receivesSecrets`); a Codex Thread
that got the shared id before it had secrets fails its turn with «… start a new Thread to receive
them». Only adapters with `receivesSecretEnv` (Claude, Codex, and ACP registry agents such as Replay,
through `processEnvironment`) take a non-empty set; any other (Cursor, OpenCode, Pi, Kiro, …)
refuses the session (`SecretDeliveryError`, `provider`) instead of starting without them.

**Terminals.** `TerminalManager.open(input, { secretEnv })` puts the values in the shell's spawn
environment and drops them once it spawned; the session keeps only the fingerprint. A running shell
keeps what it started with: an open (or attach) with another set leaves it running and its snapshot
says `secretsStale`, which the web terminal shows as «Secrets changed: reopen to update». A shell
started again from an attach after it exited starts without secrets and is stale too.

**On the machine** (`EnvironmentAgent`): `secretEnv` goes into the provider adapter
(`openSessionWithSecrets`) or the terminal, and nowhere else: never in arguments (agent scopes
wrap commands without it), files, logs, spans or the idempotency memory (which keeps answers, not
requests). The decoded request is not kept once the call answered.

**What it does not cover (accepted):**

- processes already running keep their environment after a revocation or rotation, until they end
  or are reopened;
- in a shared Sandbox any process of the Space can read another's environment
  (`/proc/<pid>/environ`, ADR 0004): per-process delivery keeps one User's secrets out of another's
  processes, not out of reach of a determined agent in the same Space;
- a provider process keeps its environment in memory for its life; Claude's adapter also keeps the
  session's set to start each turn's process with it;
- Codex's own shell policy leaves out variables whose names contain `KEY`, `SECRET` or `TOKEN` from
  the commands it runs, unless its config says otherwise.

## What is not covered here

- Masking, the agent's names and missing secrets: tickets 05 and 06.
