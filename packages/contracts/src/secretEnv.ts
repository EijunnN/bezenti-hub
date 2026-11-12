/** Spec 5 ticket 04: a Thread's secrets on their way to one process, as environment variables. */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The executor contract from which a machine receives `secretEnv`. */
export const SECRET_ENV_CONTRACT_VERSION = 10;

/** One variable of a Thread's secrets, with its value. Sent only over the Environment's link. */
export const SecretEnvVariable = Schema.Struct({ name: Schema.String, value: Schema.String });
export type SecretEnvVariable = typeof SecretEnvVariable.Type;

/** The fingerprint of no secrets: sent explicitly, so a set that became empty is a change. */
export const NO_SECRETS_FINGERPRINT = "none";

/**
 * The secrets of the User who starts a process. `fingerprint` names the set (names and value ids,
 * never values). Without `variables` it only says which set is current: a running process with
 * another is stale, and a process that would start asks for the values (`secrets_required`).
 */
export const SecretEnv = Schema.Struct({
  fingerprint: TrimmedNonEmptyString,
  variables: Schema.optionalKey(Schema.Array(SecretEnvVariable)),
});
export type SecretEnv = typeof SecretEnv.Type;

/** The key `secretEnv` travels under in a request payload. */
export const SECRET_ENV_FIELD = "secretEnv";

/**
 * Why a process of a Thread with secrets was not started: never started without them.
 * - `outdated-machine`: the machine runs an executor contract before 10.
 * - `provider`: the provider cannot take an environment per session.
 * - `shared-process`: the provider runs other Threads in the same process.
 */
export class SecretDeliveryError extends Schema.TaggedError<SecretDeliveryError>()(
  "SecretDeliveryError",
  {
    reason: Schema.Literals(["outdated-machine", "provider", "shared-process"]),
    environmentName: Schema.optional(Schema.String),
    provider: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "outdated-machine":
        return `${this.environmentName ?? "This machine"} needs an update to receive this Thread's secrets.`;
      case "provider":
        return `${this.provider ?? "This provider"} can't receive this Thread's secrets yet. Pick another provider, or remove the Vaults from this Project.`;
      case "shared-process":
        return `${this.provider ?? "This provider"} runs this Thread in a process shared with other Threads, so it can't receive this Thread's secrets. Start a new Thread to receive them.`;
    }
  }
}
