/**
 * The Hub's one client of the CLIProxyAPI it runs: nothing else in the Hub talks to it. The
 * management key and the Hub's client key go in headers only, never in a URL, a log or a span
 * attribute (Effect's HTTP spans redact `authorization`).
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
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

export class CliproxyManagementError extends Schema.TaggedError<CliproxyManagementError>()(
  "CliproxyManagementError",
  { message: Schema.String },
) {}

/**
 * CLIProxyAPI's error code on a refusal (`invalid_config`), never its message: that one can quote
 * part of a value it could not read.
 */
const refusalOf = (text: string) => {
  try {
    const code = (JSON.parse(text) as { readonly error?: unknown }).error;
    return typeof code === "string" && /^[a-z_]{1,40}$/u.test(code) ? `: ${code}` : "";
  } catch {
    return "";
  }
};

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
    setApiKeys: (endpoint: CliproxyEndpoint, apiKeys: Record<string, unknown>) =>
      client
        .execute(
          HttpClientRequest.patch(`${endpoint.baseUrl}${MANAGEMENT_PATH}/config`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(endpoint.managementKey)),
            HttpClientRequest.bodyJsonUnsafe({ "api-keys": apiKeys }),
          ),
        )
        .pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(
            () => new CliproxyManagementError({ message: "CLIProxyAPI did not answer." }),
          ),
          Effect.flatMap((response): Effect.Effect<void, CliproxyManagementError> =>
            response.status === 200
              ? Effect.void
              : response.text.pipe(
                  Effect.orElseSucceed(() => ""),
                  Effect.flatMap((text) =>
                    Effect.fail(
                      new CliproxyManagementError({
                        message: `CLIProxyAPI refused the AI accounts (HTTP ${response.status}${refusalOf(text)}).`,
                      }),
                    ),
                  ),
                ),
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
