/**
 * Settings → Vaults over HTTP. The master key's status and its backup: the Owner alone
 * (`masterKey.backup` in AccessPolicy), the backup also with a strong factor in the request and
 * audited before the key leaves. See docs/internals/secrets.md.
 */
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import {
  annotateEnvironmentRequest,
  failAccountChange,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import type * as MasterKeyFile from "../auth/MasterKeyFile.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as UserDirectory from "../auth/UserDirectory.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";

const OWNER_ONLY = "Only the Owner backs up the master key.";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "vaults",
  Effect.fnUntraced(function* (handlers) {
    const spaces = yield* SpaceDirectory.SpaceDirectory;
    const users = yield* UserDirectory.UserDirectory;
    const backup = yield* ServerSecretStore.MasterKeyBackup;
    const audit = yield* AuditLog.AuditLog;

    const failKey = (error: MasterKeyFile.MasterKeyError) =>
      failEnvironmentInternal("master_key_failed", error);

    /** A signed-in User whom AccessPolicy lets back up the master key: the Owner. */
    const requireOwner = Effect.fn("environment.vaults.requireOwner")(function* (
      scope: AuthEnvironmentScope,
    ) {
      const principal = yield* requireEnvironmentScope(scope);
      if (principal.userId === undefined) {
        return yield* new EnvironmentHttpForbiddenError({ message: OWNER_ONLY });
      }
      const policy = yield* spaces
        .principalOf(principal.userId)
        .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
      const decision = AccessPolicy.decide(policy, "masterKey.backup", AccessPolicy.installation);
      if (!AccessPolicy.isAllowed(decision)) {
        return yield* new EnvironmentHttpForbiddenError({ message: OWNER_ONLY });
      }
      return { userId: principal.userId, sessionId: principal.sessionId };
    });

    return handlers
      .handle(
        "masterKeyStatus",
        Effect.fn("environment.vaults.masterKeyStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireOwner(AuthAccessReadScope);
          return yield* backup.status.pipe(Effect.catch(failKey));
        }),
      )
      .handle(
        "masterKeyBackup",
        Effect.fn("environment.vaults.masterKeyBackup")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // Who may comes before the factor, so no one else's proof is ever checked.
          const owner = yield* requireOwner(AuthAccessWriteScope);
          const request = yield* HttpServerRequest.HttpServerRequest;
          yield* failAccountChange(
            users.confirmStrongFactor(
              { ...owner, origin: request.headers.origin ?? "" },
              args.payload.reauth,
            ),
          );
          const key = yield* backup.readKey.pipe(Effect.catch(failKey));
          const status = yield* backup
            .recordBackup(DateTime.formatIso(yield* DateTime.now))
            .pipe(Effect.catch(failKey));
          // Recorded before the key leaves: no backup goes out unaudited.
          yield* audit
            .record({
              actor: AuditLog.userActor(owner.userId),
              action: "secret.master_key.export",
              target: { kind: "secret", id: "master-key", name: "Master key" },
              detail: { via: "settings", keyId: status.keyId },
            })
            .pipe(Effect.catch((cause) => failEnvironmentInternal("master_key_failed", cause)));
          return { key: Redacted.value(key), status };
        }),
      );
  }),
);
