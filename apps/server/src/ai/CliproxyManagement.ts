/**
 * The Hub's one client of the CLIProxyAPI it runs: nothing else in the Hub talks to it. The
 * management key and the Hub's client key go in headers only, never in a URL, a log or a span
 * attribute (Effect's HTTP spans redact `authorization`).
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { filterGatewayLine } from "./gatewayLogFilter.ts";

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

export class CliproxyManagementError extends Schema.TaggedError<CliproxyManagementError>()(
  "CliproxyManagementError",
  { message: Schema.String },
) {}

/**
 * CLIProxyAPI's reason for a refusal, safe to show the Owner: its error code and message, with
 * every quoted fragment (where it echoes what it could not read) dropped and every key it was sent
 * redacted, cut short.
 */
const refusalReasonOf = (text: string, secrets: ReadonlyArray<string>) => {
  try {
    const body = JSON.parse(text) as { readonly error?: unknown; readonly message?: unknown };
    const parts = [body.error, body.message].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    const joined = parts.join(": ").replace(/`[^`]*`|"[^"]*"|'[^']*'/gu, "…");
    return filterGatewayLine(joined, secrets).slice(0, 200);
  } catch {
    return "";
  }
};

/** What CLIProxyAPI said to a config change: applied, or refused (it applies all or nothing). */
export type CliproxyConfigAnswer =
  | { readonly _tag: "accepted" }
  | { readonly _tag: "refused"; readonly status: number; readonly reason: string };

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
    /**
     * Replaces the AI accounts' API keys (the whole `api-keys` section) through the management
     * API, so they never go to a file the Hub writes on the disk. CLIProxyAPI checks the whole
     * patch and applies all or nothing. The error says how it answered, never what was sent.
     */
    setApiKeys: (
      endpoint: CliproxyEndpoint,
      apiKeys: Record<string, unknown>,
      secrets: ReadonlyArray<string>,
    ) =>
      client
        .execute(
          HttpClientRequest.patch(`${endpoint.baseUrl}${MANAGEMENT_PATH}/config`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(endpoint.managementKey)),
            HttpClientRequest.bodyJsonUnsafe({ "api-keys": apiKeys }),
          ),
        )
        .pipe(
          Effect.flatMap((response): Effect.Effect<CliproxyConfigAnswer, unknown> =>
            response.status === 200
              ? Effect.succeed({ _tag: "accepted" })
              : response.text.pipe(
                  Effect.orElseSucceed(() => ""),
                  Effect.map((text): CliproxyConfigAnswer => ({
                    _tag: "refused",
                    status: response.status,
                    reason: refusalReasonOf(text, secrets),
                  })),
                ),
          ),
          Effect.timeout("15 seconds"),
          Effect.mapError(
            () => new CliproxyManagementError({ message: "CLIProxyAPI did not answer." }),
          ),
          Effect.withSpan("CliproxyManagement.setApiKeys"),
        ),
    /** The ids of the models it serves now (`acct-<id>/<model>`), with the Hub's client key. */
    modelIds: (endpoint: CliproxyEndpoint) =>
      client
        .execute(
          HttpClientRequest.get(`${endpoint.baseUrl}/v1/models`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(endpoint.clientKey)),
          ),
        )
        .pipe(
          Effect.flatMap((response): Effect.Effect<unknown, unknown> =>
            response.status === 200 ? response.json : Effect.fail(response.status),
          ),
          Effect.map((body) => {
            const data = (body as { readonly data?: unknown } | null)?.data;
            return Array.isArray(data)
              ? data.flatMap((model: unknown) => {
                  const id = (model as { readonly id?: unknown } | null)?.id;
                  return typeof id === "string" ? [id] : [];
                })
              : [];
          }),
          Effect.timeout("15 seconds"),
          Effect.mapError(
            () => new CliproxyManagementError({ message: "CLIProxyAPI did not list its models." }),
          ),
          Effect.withSpan("CliproxyManagement.modelIds"),
        ),
  };
});

export type CliproxyManagement = Effect.Success<typeof makeCliproxyManagement>;
