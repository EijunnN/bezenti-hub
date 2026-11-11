import * as Schema from "effect/Schema";

import { AuthReauth } from "./userAccounts.ts";

/** The master key that encrypts the Hub's secrets, as the Owner sees it in Settings. */
export const MasterKeyStatus = Schema.Struct({
  /** A fingerprint of the key, never the key. */
  keyId: Schema.String,
  /** Where the key file is on the Hub. */
  keyFile: Schema.String,
  /** When this key was last backed up; null until then (Settings warns). */
  backedUpAt: Schema.NullOr(Schema.String),
});
export type MasterKeyStatus = typeof MasterKeyStatus.Type;

/** «Download master key backup»: confirmed with the strong factor in the request. */
export const MasterKeyBackupRequest = Schema.Struct({ reauth: AuthReauth });
export type MasterKeyBackupRequest = typeof MasterKeyBackupRequest.Type;

/** Handed out, not yet a backup: the Owner confirms holding it (MasterKeyBackupConfirmRequest). */
export const MasterKeyBackupResult = Schema.Struct({
  /** The backup's text, as `t3 secrets key import` reads it. */
  key: Schema.String,
  keyId: Schema.String,
});
export type MasterKeyBackupResult = typeof MasterKeyBackupResult.Type;

/** The Owner saved it: the key's first 8 characters after `t3-master-key-v1:`. */
export const MasterKeyBackupConfirmRequest = Schema.Struct({
  keyId: Schema.String,
  proof: Schema.String.check(Schema.isMaxLength(64)),
});
export type MasterKeyBackupConfirmRequest = typeof MasterKeyBackupConfirmRequest.Type;
