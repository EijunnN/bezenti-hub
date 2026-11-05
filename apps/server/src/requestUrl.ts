import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";

/**
 * The URL the client asked for, which OAuth, DPoP and pairing URLs depend on. Served requests
 * carry the scheme the client-connection middleware took from a trusted proxy; a request built
 * without it, as in a test, falls back to `X-Forwarded-Proto`.
 */
export const requestUrl = (request: HttpServerRequest.HttpServerRequest): Option.Option<URL> =>
  HttpServerRequest.toURL(
    request.protocol === undefined && request.headers["x-forwarded-proto"] === "https"
      ? request.modify({ protocol: "https" })
      : request,
  );
