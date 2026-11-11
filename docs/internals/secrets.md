# Secrets at rest and the master key

The Hub keeps its secrets in `ServerSecretStore` (`apps/server/src/auth/ServerSecretStore.ts`): one
file per name in `<stateDir>/secrets/<name>.bin`. Session signing keys, preview-profile HMAC keys,
provider and source-control credentials from Settings (`settingsSecrets.ts`), the SSH key the Owner
keeps «for updates» (`ssh-install-key-<id>`), `request_secret` answers and replay markers all live
there. Since spec 5 («Vaults», ticket 01) every entry is encrypted with a **master key** that lives
in a file of its own. Callers do not know: the store's API (`get`, `set`, `create`,
`getOrCreateRandom`, `remove`) did not change.

## The sealed format

`SecretCipher.ts`, on `node:crypto` only:

```
\0T3S | format (1 byte, 0x01) | key id (8 bytes) | nonce (12 bytes) | ciphertext | GCM tag (16 bytes)
```

- **AES-256-GCM** under a subkey `HKDF-SHA256(master key, info = "t3code <purpose> v1")`: one subkey
  per use (`server-secret` for entries, `key-check` for the check below; Vault values in the
  database, ticket 02, get their own purpose).
- **A fresh random 96-bit nonce per seal.** Two writes of one value never share bytes. A Hub writes
  a few thousand entries per key, far below the 2³² seals per key where random nonces start to
  matter.
- **Associated data:** the header (format and key id) followed by the purpose and the entry's name.
  A file copied or renamed to another name, or moved to another purpose, does not open.
- **Key id:** the first 8 bytes of `HKDF(master key, "t3code master key id v1")`: a fingerprint that
  names the key without revealing it. It tells "sealed by another key" from "damaged", and lets a
  rotation stop and resume.
- The magic starts with a NUL byte, which no text value does: a value stored in clear before
  encryption is told from a sealed one. A future format byte is "unknown format", never "plain".

## The master key file

- 32 random bytes, written as one line `t3-master-key-v1:<base64url>`: the same text is the
  backup.
- Default `<stateDir>/master.key`; `T3CODE_MASTER_KEY_FILE` puts it elsewhere (off the disk that is
  backed up). It is the only secret of the Hub kept in clear.
- Created on first start with mode `0600` (exclusive create: a CLI and the server starting together
  end with one key). On POSIX a key file that group or others may read stops the startup with
  «run `chmod 600 <file>`». On Windows mode bits mean nothing: the file inherits the ACL of its
  folder, which under the user's profile (the default state directory) is that user's alone; put
  `T3CODE_MASTER_KEY_FILE` in a folder with the same ACL.
- Never in the database, a log, a span, an error message or a process argument: its bytes sit in a
  private field of `MasterKey` (inspecting or serialising one shows only its id), errors name files
  and key ids only, and `t3 secrets key import` reads the key from a file or stdin, never argv.
- Client file reads and git never serve it: `serverInternalPaths.ts` treats it and its
  `.next`/`.previous`/`.replaced-*` siblings as internal, like the secrets folder.

## Startup (`MasterKeyFile.openKeyring`)

Every store a Hub process builds runs it before serving anything. In order:

1. **Read** `master.key`, `master.key.next`, `master.key.previous`, every `<name>.bin` and the key
   check `secrets/master-key.check` (sealed by the key it checks).
2. **No key:** if anything encrypted exists (a sealed entry, the key check, a `.next`/`.previous`
   key), stop: «The master key … is missing … restore it with `t3 secrets key import`». A new key is
   never created over values another one sealed. Otherwise create the key.
3. **Check before writing:** an entry sealed by a key the Hub does not have, or a key check that does
   not open, stops the startup with the key ids involved. Nothing was written.
4. **Seal what is in clear** (a store from before encryption): each entry is resealed into a
   temporary file (fsync), then renamed over the old one. A crash leaves every entry either as it was
   or sealed; the next start seals the rest. Running it twice rewrites nothing.
5. **Finish a rotation** that stopped (below).
6. Remove temporary files older than a minute (a write that died may have left one in clear).

After startup a value found in clear, sealed by an unknown key, or under the wrong name fails to read
(`SecretStoreDecodeError`); the store never accepts a planted plain file as a secret.

## Backup, import and rotation

- **Backup:** Settings shows «Back up the master key» to the Owner until this key has a backup. The
  Owner downloads it from Settings («Download master key backup», confirmed with the strong factor:
  a passkey, or password and TOTP code, in the request) or runs `t3 secrets key export [--output
  <file>]`. Both record the backup (an entry `master-key-backup`: key id and time; a rotation makes
  the warning come back) and the audit action `secret.master_key.export` (`via`, `keyId`).
- **Import** (`t3 secrets key import <file>` or `-` for stdin), with the Hub stopped: the key must
  open the secrets here (the key check and every sealed entry), otherwise nothing changes. A key it
  replaces is kept as `master.key.replaced-<id>`, never discarded. Restoring on another server:
  copy the state directory, import the backup, start.
- **Rotation** (`t3 secrets key rotate`), with the Hub stopped (it takes the server's ownership
  lock): writes the new key as `master.key.next`, reseals every entry and the key check under it
  (each an atomic replace), writes the old key to `master.key.previous`, then renames `.next` over
  `master.key`. A crash at any step leaves both keys on disk; the next start (or the command again)
  finishes it. The previous key opens values until the Owner deletes the file. Audit
  `secret.master_key.rotate`.

## HTTP door

`GET /api/vaults/master-key` (`vaults.masterKeyStatus`) and `POST /api/vaults/master-key/backup`
(`vaults.masterKeyBackup`, body `{ reauth }`): the Owner only (`AccessPolicy` action
`masterKey.backup`), the second with a strong factor in the request. Declared in `DoorRules.ts`. No
WS RPC or MCP tool reaches the key.

## Joined machines

A machine joined to a Hub (its `joined-hub.json` present) keeps its store in clear, and `t3 join`
writes the credential with `ServerSecretStore.layerJoinedMachine`. The Hub writes a Sandbox's
credential into the Sandbox's home, which a Podman Sandbox mounts read-only, and a key stored beside
the credential would protect nothing. A machine that was a Hub before joining cannot read its old
encrypted entries in joined mode.

## What is not covered here

- `request_secret` answers of type `file` are written, by design, to `secrets/files/<id>` in clear for
  the agent's own shell, owner-only and swept after 24 h.
- Vault values in the database (ticket 02) use the same master key and their own purpose; their
  rotation and the database's key check come with them.
