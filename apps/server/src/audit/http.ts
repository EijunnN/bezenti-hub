import {
  AuthAccessReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as AuditLog from "./AuditLog.ts";

const DENIED = new AuditLog.AuditLogDeniedError({}).message;

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "audit",
  Effect.fnUntraced(function* (handlers) {
    const audit = yield* AuditLog.AuditLog;
    return handlers.handle(
      "list",
      Effect.fn("environment.audit.list")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        // A narrowed session of the Owner's needs the access scope, as the Users view does.
        const principal = yield* requireEnvironmentScope(AuthAccessReadScope);
        if (principal.userId === undefined) {
          return yield* new EnvironmentHttpForbiddenError({ message: DENIED });
        }
        return yield* audit.list({ viewer: principal.userId, query: args.query }).pipe(
          Effect.catchTags({
            AuditLogDeniedError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            AuditLogQueryError: () => failEnvironmentInvalidRequest("invalid_audit_query"),
            AuditLogReadError: (cause) => failEnvironmentInternal("audit_log_failed", cause),
          }),
        );
      }),
    );
  }),
);
