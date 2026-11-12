/**
 * The Hub's one client of the CLIProxyAPI it runs: nothing else in the Hub talks to it. The
 * management key and the Hub's client key go in headers only, never in a URL, a log or a span
 * attribute (Effect's HTTP spans redact `authorization`).
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest } from "effect/http";

const MANAGEMENT_PATH = "/v8/management";

export interface CliproxyEndpoint {
  /** `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  readonly managementKey: Redacted.Redacted<string>;
  readonly clientKey: Redacted.Redacted<string>;
}

/** What one request answered: its HTTP status, or none when nothing answered. */
export interface CliproxyAnswer {
  readonly status: number | null;
  /** The `X-CPA-VERSION` the server reports. */
  readonly version: string | null;
}

export const makeCliproxyManagement = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const ask = (url: string, key: Redacted.Redacted<string> | undefined) =>
    client
      .execute(
        key === undefined
          ? HttpClientRequest.get(url)
          : HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(Redacted.value(key))),
      )
      .pipe(
        Effect.map((response): CliproxyAnswer => ({
          status: response.status,
          version: response.headers["x-cpa-version"] ?? null,
        })),
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed((): CliproxyAnswer => ({ status: null, version: null })),
      );

  return {
    /** The management API with the Hub's key (`GET /v8/management/config`): 200 when healthy. */
    health: (endpoint: CliproxyEndpoint) =>
      ask(`${endpoint.baseUrl}${MANAGEMENT_PATH}/config`, endpoint.managementKey).pipe(
        Effect.withSpan("CliproxyManagement.health"),
      ),
    /** The model list with the Hub's client key: 200 when it serves the API. */
    models: (endpoint: CliproxyEndpoint) =>
      ask(`${endpoint.baseUrl}/v1/models`, endpoint.clientKey).pipe(
        Effect.withSpan("CliproxyManagement.models"),
      ),
  };
});

export type CliproxyManagement = Effect.Success<typeof makeCliproxyManagement>;
