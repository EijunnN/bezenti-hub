import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  makeEntityId,
  SpaceId,
  TrimmedNonEmptyString,
  UserId,
} from "./baseSchemas.ts";
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

// A value enters the Hub only in `put` (Redacted) and leaves only through `vaults.reveal`.

export const VaultId = makeEntityId("VaultId");
export type VaultId = typeof VaultId.Type;
export const VaultEntryId = makeEntityId("VaultEntryId");
export type VaultEntryId = typeof VaultEntryId.Type;

/** The Main vault's fixed id: one per Hub, the Owner's, never deleted. */
export const MAIN_VAULT_ID = VaultId.make("vault-main");

/** An environment-variable name a Vault may hold. */
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
/** Values are UTF-8 text without NUL, at most this many bytes. */
export const SECRET_VALUE_MAX_BYTES = 64 * 1024;
/**
 * Below this many characters a value is accepted with a warning and never masked in the history
 * (masking it would hide ordinary text): the spec's open question 3, decided by the Owner.
 */
export const SECRET_MASK_MIN_LENGTH = 6;

/**
 * What the AI gateway (spec 4) sets in the agent's environment: a Vault never overrides it, not
 * even the Owner's. The list both specs share (spec 4 exports it when its drivers set them).
 */
const AI_GATEWAY_ENV_NAMES: ReadonlySet<string> = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "OPENAI_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
]);
const GATEWAY_PREFIXES = ["T3_", "T3CODE_"] as const;

/**
 * Names that change how the agent's tools run or whom they trust: the process and its loaders,
 * interpreters' startup options, git and ssh hooks, proxies and CAs, home, temp and shell, and the
 * keys and base URLs AI providers read. Only the Owner sets one, after confirming; Admins never.
 */
const DANGEROUS_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "COMSPEC",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "PSMODULEPATH",
  "BASH_ENV",
  "ENV",
  "IFS",
  "PS4",
  "PROMPT_COMMAND",
  "ZDOTDIR",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "BROWSER",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONHTTPSVERIFY",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "CLASSPATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "FTP_PROXY",
]);
const DANGEROUS_PREFIXES = [
  "LD_",
  "DYLD_",
  "BASH_FUNC_",
  "GIT_",
  "SSH_",
  "XDG_",
  "NPM_CONFIG_",
  "YARN_",
  "PIP_",
  "CARGO_",
  "RUSTUP_",
  "GOFLAGS",
  "DOCKER_",
  // AI providers' keys and base URLs: a value here takes over the agent's model account.
  "ANTHROPIC_",
  "OPENAI_",
  "AZURE_OPENAI_",
  "GEMINI_",
  "GOOGLE_",
  "VERTEX_",
  "CLAUDE_",
  "CODEX_",
  "MISTRAL_",
  "GROQ_",
  "OPENROUTER_",
  "XAI_",
  "DEEPSEEK_",
  "CURSOR_",
  "OPENCODE_",
] as const;

/**
 * What a name is, for every door: `invalid` (not an environment variable), `gateway` (the Hub's
 * own: refused for everyone), `dangerous` (the Owner only, confirmed), or undefined. Compared
 * uppercased, as Windows reads environment names.
 */
export const secretNameRisk = (name: string): "invalid" | "gateway" | "dangerous" | undefined => {
  if (!SECRET_NAME_PATTERN.test(name)) return "invalid";
  const upper = name.toUpperCase();
  if (AI_GATEWAY_ENV_NAMES.has(upper) || GATEWAY_PREFIXES.some((p) => upper.startsWith(p))) {
    return "gateway";
  }
  if (DANGEROUS_NAMES.has(upper) || DANGEROUS_PREFIXES.some((p) => upper.startsWith(p))) {
    return "dangerous";
  }
  return undefined;
};

export const VaultEntryKind = Schema.Literals(["own", "copy", "link"]);
export type VaultEntryKind = typeof VaultEntryKind.Type;

/** A Vault as the viewer sees it, with what the viewer may do there. */
export const VaultSummary = Schema.Struct({
  id: VaultId,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** The Organization whose Vault it is; null for the Owner's own (the Main vault among them). */
  spaceId: Schema.NullOr(SpaceId),
  spaceName: Schema.NullOr(Schema.String),
  isMain: Schema.Boolean,
  archived: Schema.Boolean,
  entryCount: Schema.Number,
  /** Add, replace and delete secrets: the Owner, and an Organization's Admins on its Vaults. */
  canEdit: Schema.Boolean,
  /** Rename, describe, archive and delete the Vault: the Owner. */
  canManage: Schema.Boolean,
  /** Reveal values: the Owner, with a strong factor. */
  canReveal: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type VaultSummary = typeof VaultSummary.Type;

/** A secret's name and what it is. Never its value. */
export const VaultEntry = Schema.Struct({
  id: VaultEntryId,
  vaultId: VaultId,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  kind: VaultEntryKind,
  /** A Secret link whose original in the Main vault is gone: shown, never delivered. */
  broken: Schema.Boolean,
  /** A link's original, for whoever sees the Main vault (the Owner); null for anyone else. */
  linkedFrom: Schema.NullOr(Schema.Struct({ entryId: VaultEntryId, name: Schema.String })),
  /** Shorter than SECRET_MASK_MIN_LENGTH: kept, but never masked in the history. */
  unmasked: Schema.Boolean,
  version: Schema.Number,
  updatedAt: IsoDateTime,
  updatedBy: Schema.NullOr(UserId),
});
export type VaultEntry = typeof VaultEntry.Type;

export const VaultWarning = Schema.Literals(["short-value"]);
export type VaultWarning = typeof VaultWarning.Type;

export const VaultErrorReason = Schema.Literals([
  "not-found",
  "forbidden",
  "invalid-name",
  "reserved-name",
  "invalid-value",
  "duplicate-name",
  "main-vault",
  "not-linkable",
  /** A name that changes how tools run: the Owner's alone. */
  "dangerous-name",
  /** The Owner's dangerous name, not yet confirmed (`confirmDangerous`). */
  "confirm-dangerous",
  /** Vaults live on the Hub: a joined machine has none. */
  "unavailable",
  "storage",
]);
export type VaultErrorReason = typeof VaultErrorReason.Type;

/** Never carries a value: messages name secrets, never what they hold. */
export class VaultError extends Schema.TaggedError<VaultError>()("VaultError", {
  reason: VaultErrorReason,
  message: Schema.String,
}) {}

const VaultName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
const VaultDescription = Schema.String.check(Schema.isMaxLength(500));
/** Checked on the Hub with `secretNameRisk`, which says why. */
const SecretName = Schema.String.check(Schema.isMaxLength(128));
/** A value going into the Hub: Redacted, so no log, span or error shows it. */
const SecretValueInput = Schema.RedactedFromValue(Schema.String);

export const VaultListInput = Schema.Struct({});
export const VaultListResult = Schema.Struct({ vaults: Schema.Array(VaultSummary) });
export type VaultListResult = typeof VaultListResult.Type;

export const VaultCreateInput = Schema.Struct({
  name: VaultName,
  description: Schema.optionalKey(VaultDescription),
  /** An Organization's Vault, or null for one of the Owner's own. */
  spaceId: Schema.NullOr(SpaceId),
});
export type VaultCreateInput = typeof VaultCreateInput.Type;

export const VaultUpdateInput = Schema.Struct({
  vaultId: VaultId,
  name: Schema.optionalKey(VaultName),
  description: Schema.optionalKey(Schema.NullOr(VaultDescription)),
  archived: Schema.optionalKey(Schema.Boolean),
});
export type VaultUpdateInput = typeof VaultUpdateInput.Type;

export const VaultDeleteInput = Schema.Struct({ vaultId: VaultId });
export type VaultDeleteInput = typeof VaultDeleteInput.Type;
export const VaultDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type VaultDeleteResult = typeof VaultDeleteResult.Type;

export const VaultEntriesListInput = Schema.Struct({ vaultId: VaultId });
export type VaultEntriesListInput = typeof VaultEntriesListInput.Type;
export const VaultEntriesListResult = Schema.Struct({
  vault: VaultSummary,
  entries: Schema.Array(VaultEntry),
});
export type VaultEntriesListResult = typeof VaultEntriesListResult.Type;

/** Adds a secret (no `entryId`, a value) or changes one: its name, description or value. */
export const VaultEntryPutInput = Schema.Struct({
  vaultId: VaultId,
  entryId: Schema.optionalKey(VaultEntryId),
  name: SecretName,
  description: Schema.optionalKey(Schema.NullOr(VaultDescription)),
  value: Schema.optionalKey(SecretValueInput),
  /** The Owner confirms a name that changes how tools run (`secretNameRisk`: dangerous). */
  confirmDangerous: Schema.optionalKey(Schema.Boolean),
});
export type VaultEntryPutInput = typeof VaultEntryPutInput.Type;

export const VaultEntryResult = Schema.Struct({
  entry: VaultEntry,
  warnings: Schema.Array(VaultWarning),
});
export type VaultEntryResult = typeof VaultEntryResult.Type;

/** A Secret link that breaks when its original goes: in which Vault, under which name. */
export const VaultBrokenLink = Schema.Struct({
  vaultId: VaultId,
  vaultName: Schema.String,
  entryId: VaultEntryId,
  name: Schema.String,
});
export type VaultBrokenLink = typeof VaultBrokenLink.Type;

/**
 * Deletes a secret. An original with Secret links goes only with `breakLinks`; without it nothing
 * changes and the answer lists the links that would break.
 */
export const VaultEntryDeleteInput = Schema.Struct({
  vaultId: VaultId,
  entryId: VaultEntryId,
  breakLinks: Schema.optionalKey(Schema.Boolean),
});
export type VaultEntryDeleteInput = typeof VaultEntryDeleteInput.Type;
export const VaultEntryDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
  brokenLinks: Schema.Array(VaultBrokenLink),
});
export type VaultEntryDeleteResult = typeof VaultEntryDeleteResult.Type;

/** A Secret link to, or a copy of, a secret of the Main vault: the Owner only. */
export const VaultEntryFromMainInput = Schema.Struct({
  vaultId: VaultId,
  sourceEntryId: VaultEntryId,
  /** The variable's name in this Vault; the original's when omitted. */
  name: Schema.optionalKey(SecretName),
  description: Schema.optionalKey(Schema.NullOr(VaultDescription)),
  confirmDangerous: Schema.optionalKey(Schema.Boolean),
});
export type VaultEntryFromMainInput = typeof VaultEntryFromMainInput.Type;

/** «Reveal»: the Owner, confirmed with the strong factor in the request. HTTP only. */
export const VaultRevealRequest = Schema.Struct({
  vaultId: VaultId,
  entryId: VaultEntryId,
  reauth: AuthReauth,
});
export type VaultRevealRequest = typeof VaultRevealRequest.Type;

export const VaultRevealResult = Schema.Struct({
  name: Schema.String,
  value: Schema.RedactedFromValue(Schema.String),
});
export type VaultRevealResult = typeof VaultRevealResult.Type;
