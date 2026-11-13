/**
 * Spec 4 ticket 07: how a direct AI account's credential is named among a Thread's delivered
 * values (`thread_secret_values.value_id`), so SecretMasker reads it back from the AI accounts'
 * credential store instead of the Vault store, and AiAccounts keeps it sealed while a
 * Thread that received it lives.
 */
const PREFIX = "ai-account:";

/** For SQL that reads the credential id out of a value id (`substr(value_id, LENGTH + 1)`). */
export const AI_CREDENTIAL_PREFIX_LENGTH = PREFIX.length;

/** The masker's value id of a direct credential. */
export const aiCredentialValueId = (credentialId: string) => `${PREFIX}${credentialId}`;

/** The credential a value id names, when it is a direct AI account's. */
export const credentialIdOfValueId = (valueId: string): string | undefined =>
  valueId.startsWith(PREFIX) && valueId.length > PREFIX.length
    ? valueId.slice(PREFIX.length)
    : undefined;
