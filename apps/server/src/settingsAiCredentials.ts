/**
 * Spec 4 ticket 09: AI credentials on provider instances (`aiAccountCredentialProviderOf`,
 * `AI_ACCOUNT_CREDENTIAL_FIELDS`). Where AI accounts are in use they belong in AI accounts: a
 * settings write may keep a leftover as it is or remove it, never add or change one, and the
 * Hub's start moves them out (`ai/ProviderKeyMigration.ts`). Nothing here logs or returns a value.
 */
import {
  AI_ACCOUNT_CREDENTIAL_FIELDS,
  aiAccountCredentialProviderOf,
  isSecretReference,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type SecretReference,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";

import { SECRET_REDACTED } from "./settingsSecrets.ts";

type Value = ProviderInstanceEnvironmentVariable["value"];

const sameValue = (left: unknown, right: unknown) =>
  typeof left === "string" || typeof right === "string"
    ? left === right
    : JSON.stringify(left) === JSON.stringify(right);

const instancesOf = (settings: ServerSettings) =>
  Object.entries(settings.providerInstances) as Array<[ProviderInstanceId, ProviderInstanceConfig]>;

const instanceOf = (settings: ServerSettings, instanceId: string) =>
  Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId as ProviderInstanceId]
    : undefined;

const configOf = (instance: ProviderInstanceConfig | undefined): Record<string, unknown> =>
  instance?.config !== null &&
  typeof instance?.config === "object" &&
  !Array.isArray(instance.config)
    ? (instance.config as Record<string, unknown>)
    : {};

const credentialFieldsOf = (instance: ProviderInstanceConfig) =>
  AI_ACCOUNT_CREDENTIAL_FIELDS.get(instance.driver) ?? [];

/** A field value that holds no credential: unset, cleared, or the «saved» marker echoed back. */
const holdsNoField = (value: unknown) =>
  value === undefined || value === null || value === "" || value === SECRET_REDACTED;

/** A variable the write keeps as stored: the redacted echo of a secret, or the same value. */
const keepsVariable = (
  stored: ProviderInstanceEnvironmentVariable,
  next: ProviderInstanceEnvironmentVariable,
) => {
  // The secret store keeps the stored value whatever such an echo carries.
  if (next.sensitive && next.valueRedacted === true && typeof next.value === "string") {
    return stored.sensitive;
  }
  return (
    next.sensitive === stored.sensitive &&
    sameValue(next.value, stored.value) &&
    (next.valueRedacted === true) === (stored.valueRedacted === true)
  );
};

export interface AiCredentialSlot {
  readonly instanceId: string;
  readonly name: string;
}

export interface AiCredentialFieldValue extends AiCredentialSlot {
  readonly driver: string;
  readonly value: string;
}

/**
 * What a write from `current` to `next` does to AI credentials: the first one it adds or changes
 * (`refused`), and literal field values to compare with the stored secret (a materialized echo).
 * Removing one, or clearing it, is always fine.
 */
export function aiCredentialChanges(
  current: ServerSettings,
  next: ServerSettings,
): {
  readonly refused: AiCredentialSlot | undefined;
  readonly literalFields: ReadonlyArray<AiCredentialFieldValue>;
} {
  const literalFields: AiCredentialFieldValue[] = [];
  for (const [instanceId, instance] of instancesOf(next)) {
    const before = instanceOf(current, instanceId);
    for (const variable of instance.environment ?? []) {
      if (aiAccountCredentialProviderOf(variable.name) === undefined) continue;
      const stored = (before?.environment ?? []).filter((old) => old.name === variable.name);
      // Clearing one kept is removing it; a new one, even empty, is refused.
      if (variable.value === "" && variable.valueRedacted !== true && stored.length > 0) continue;
      const kept = stored.some((old) => keepsVariable(old, variable));
      if (!kept) return { refused: { instanceId, name: variable.name }, literalFields };
    }
    const config = configOf(instance);
    const storedConfig = before?.driver === instance.driver ? configOf(before) : {};
    for (const field of credentialFieldsOf(instance)) {
      const value = config[field];
      if (holdsNoField(value)) continue;
      if (typeof value === "string") {
        literalFields.push({ instanceId, driver: instance.driver, name: field, value });
        continue;
      }
      if (!(isSecretReference(value) && sameValue(value, storedConfig[field]))) {
        return { refused: { instanceId, name: field }, literalFields };
      }
    }
  }
  return { refused: undefined, literalFields };
}

/** Whether `settings` (materialized) holds `value` in that field, under the same driver. */
export const holdsFieldValue = (settings: ServerSettings, slot: AiCredentialFieldValue) => {
  const instance = instanceOf(settings, slot.instanceId);
  return instance?.driver === slot.driver && configOf(instance)[slot.name] === slot.value;
};

/** One AI credential a provider instance holds, read from materialized settings. */
export interface ProviderCredential {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly instanceName: string;
  readonly kind: "environment" | "field";
  /** The variable, or the settings field. */
  readonly name: string;
  readonly value: Redacted.Redacted<string> | SecretReference;
  /** Antigravity's sign-in method, which says whose key its `apiKey` is. */
  readonly authMethod: string | undefined;
}

const credentialOf = (value: unknown): ProviderCredential["value"] | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" || trimmed === SECRET_REDACTED ? undefined : Redacted.make(trimmed);
  }
  return isSecretReference(value) ? value : undefined;
};

const sameCredential = (credential: ProviderCredential["value"], value: Value | unknown) => {
  if (Redacted.isRedacted(credential)) {
    return typeof value === "string" && value.trim() === Redacted.value(credential);
  }
  return isSecretReference(value) && sameValue(credential, value);
};

/** Every AI credential the instances hold (materialized settings: values, not markers). */
export function providerCredentialsIn(settings: ServerSettings): ReadonlyArray<ProviderCredential> {
  const found: ProviderCredential[] = [];
  for (const [instanceId, instance] of instancesOf(settings)) {
    const config = configOf(instance);
    const base = {
      instanceId,
      driver: instance.driver,
      instanceName: instance.displayName ?? instanceId,
      authMethod: typeof config.authMethod === "string" ? config.authMethod : undefined,
    };
    for (const variable of instance.environment ?? []) {
      if (aiAccountCredentialProviderOf(variable.name) === undefined) continue;
      const value = credentialOf(variable.value);
      if (value !== undefined)
        found.push({ ...base, kind: "environment", name: variable.name, value });
    }
    for (const field of credentialFieldsOf(instance)) {
      const value = credentialOf(config[field]);
      if (value !== undefined) found.push({ ...base, kind: "field", name: field, value });
    }
  }
  return found;
}

/**
 * `stored` (as on disk) without the credentials of `items` that `materialized` (the same settings,
 * read) still holds with the same value; a value changed meanwhile stays. Returns what went.
 */
export function withoutProviderCredentials(
  stored: ServerSettings,
  materialized: ServerSettings,
  items: ReadonlyArray<ProviderCredential>,
): { readonly settings: ServerSettings; readonly removed: ReadonlyArray<ProviderCredential> } {
  const removed: ProviderCredential[] = [];
  const providerInstances = { ...stored.providerInstances };
  for (const [instanceId, instance] of instancesOf(stored)) {
    const mine = items.filter((item) => item.instanceId === instanceId);
    const read = instanceOf(materialized, instanceId);
    if (mine.length === 0 || read === undefined || read.driver !== instance.driver) continue;
    const readEnvironment = read.environment ?? [];
    const environment = (instance.environment ?? []).filter((variable, index) => {
      const value = readEnvironment[index]?.value;
      const item = mine.find(
        (candidate) =>
          candidate.kind === "environment" &&
          candidate.name === variable.name &&
          readEnvironment[index]?.name === variable.name &&
          sameCredential(candidate.value, value),
      );
      if (item === undefined) return true;
      if (!removed.includes(item)) removed.push(item);
      return false;
    });
    const config = { ...configOf(instance) };
    const readConfig = configOf(read);
    for (const item of mine) {
      if (item.kind !== "field" || !sameCredential(item.value, readConfig[item.name])) continue;
      delete config[item.name];
      removed.push(item);
    }
    providerInstances[instanceId] = {
      ...instance,
      ...(instance.environment === undefined ? {} : { environment }),
      ...(instance.config === undefined ? {} : { config }),
    };
  }
  return { settings: { ...stored, providerInstances }, removed };
}
