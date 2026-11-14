/**
 * Spec 4 ticket 09: on a Hub that runs on AI accounts, provider instances hold no AI credential
 * (the Hub moved them into AI accounts at its start and refuses new ones). The form says so before
 * the Hub does; the Hub decides.
 */
import {
  AI_ACCOUNT_CREDENTIAL_FIELDS,
  aiAccountCredentialProviderOf,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";

const sameVariable = (
  left: ProviderInstanceEnvironmentVariable,
  right: ProviderInstanceEnvironmentVariable,
) =>
  left.sensitive === right.sensitive &&
  (left.valueRedacted === true) === (right.valueRedacted === true) &&
  JSON.stringify(left.value) === JSON.stringify(right.value);

/** The first AI credential `next` adds (even empty) or changes; removing or clearing one is fine. */
export function aiCredentialAdded(
  before: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  next: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): string | undefined {
  for (const variable of next) {
    if (!isAiCredentialVariable(variable.name)) continue;
    const stored = (before ?? []).filter((old) => old.name === variable.name);
    if (variable.value === "" && variable.valueRedacted !== true && stored.length > 0) continue;
    if (!stored.some((old) => sameVariable(old, variable))) return variable.name;
  }
  return undefined;
}

/** The settings fields of `driver` that are AI credentials, hidden from the form. */
export const aiCredentialFieldsOf = (driver: string): ReadonlySet<string> =>
  new Set(AI_ACCOUNT_CREDENTIAL_FIELDS.get(driver) ?? []);

export const isAiCredentialVariable = (name: string) =>
  aiAccountCredentialProviderOf(name) !== undefined;

/** The AI credentials an instance still holds: ones the Hub could not move (such as an unreadable 1Password reference). */
export function aiCredentialLeftovers(instance: ProviderInstanceConfig): ReadonlyArray<string> {
  const names = (instance.environment ?? [])
    .filter((variable) => isAiCredentialVariable(variable.name))
    .map((variable) => variable.name);
  const config =
    instance.config !== null && typeof instance.config === "object"
      ? (instance.config as Record<string, unknown>)
      : {};
  for (const field of aiCredentialFieldsOf(instance.driver)) {
    const value = config[field];
    if (value !== undefined && value !== null && value !== "") names.push("API key");
  }
  return [...new Set(names)];
}
