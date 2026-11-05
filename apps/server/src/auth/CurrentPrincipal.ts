import {
  EnvironmentAuthenticatedPrincipal,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import * as Layer from "effect/Layer";

import type { AuthenticatedSession } from "./EnvironmentAuth.ts";

/**
 * The principal every authorization decision reads: provided per request over
 * HTTP and once per connection over the WebSocket RPC transport.
 */
export const fromSession = (session: AuthenticatedSession): EnvironmentSessionPrincipalShape => ({
  ...session,
  scopes: new Set(session.scopes),
});

export const layer = (session: AuthenticatedSession) =>
  Layer.succeed(EnvironmentAuthenticatedPrincipal, fromSession(session));
