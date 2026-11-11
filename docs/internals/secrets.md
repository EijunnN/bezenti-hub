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

## What is not covered here

- Vault values in the database (ticket 02) use the same master key and their own purpose; their
  rotation and the database's key check come with them.
