import type * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";

/**
 * The URL the client asked for, which OAuth, DPoP and pairing URLs depend on. The client-connection
 * middleware sets the scheme and host from a trusted proxy before any route runs.
 */
export const requestUrl = (request: HttpServerRequest.HttpServerRequest): Option.Option<URL> =>
  HttpServerRequest.toURL(request);
