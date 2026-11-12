/**
 * The Hub's one client of the CLIProxyAPI it runs: nothing else in the Hub talks to it. The
 * management key and the Hub's client key go in headers only, never in a URL, a log or a span
 * attribute (Effect's HTTP spans redact `authorization`).
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

/** A token file in CLIProxyAPI's `auth-dir`, as its management API describes it (no token). */
export interface CliproxyCredential {
  readonly name: string;
  readonly provider: string | null;
  readonly email: string | null;
  /** `active`, `error`, …: CLIProxyAPI's own word for it. */
  readonly status: string | null;
  readonly statusMessage: string | null;
  /** Its refresh failed: the provider wants the Owner to sign in again. */
  readonly requiresSignIn: boolean;
  readonly quotaBlocked: boolean;
  readonly unavailable: boolean;
  readonly modtime: string | null;
}

export const makeCliproxyManagement = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  /** A management call with a JSON answer (or none): its status and body, never thrown. */
  const managementJson = (
    endpoint: CliproxyEndpoint,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ) => {
    const url = `${endpoint.baseUrl}${MANAGEMENT_PATH}${path}`;
    const base =
      method === "GET"
        ? HttpClientRequest.get(url)
        : method === "POST"
          ? HttpClientRequest.post(url)
          : HttpClientRequest.delete(url);
    const request = base.pipe(
      HttpClientRequest.bearerToken(Redacted.value(endpoint.managementKey)),
    );
    return client
      .execute(body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
      .pipe(
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.orElseSucceed((): unknown => null),
            Effect.map((json) => ({ status: response.status, body: json })),
          ),
        ),
        Effect.timeout("15 seconds"),
        Effect.mapError(
          () => new CliproxyManagementError({ message: "CLIProxyAPI did not answer." }),
        ),
      );
  };
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
    // Subscription AI accounts (spec 4 ticket 03): CLIProxyAPI's OAuth sign-in and the token files
    // in its `auth-dir`, only through the management API. Tokens travel in bodies, never in a URL,
    // and no error carries what was sent or answered.
    /** Starts a sign-in (`GET /oauth/auth-url?provider=`): the provider's page and its state. */
    oauthStart: (endpoint: CliproxyEndpoint, provider: string) =>
      managementJson(
        endpoint,
        "GET",
        `/oauth/auth-url?provider=${encodeURIComponent(provider)}`,
      ).pipe(
        Effect.flatMap(({ status, body }) => {
          const answer = (body ?? {}) as Record<string, unknown>;
          const state = answer.state;
          const url = answer.url;
          if (status !== 200 || typeof state !== "string" || typeof url !== "string") {
            return Effect.fail(
              new CliproxyManagementError({
                message: `CLIProxyAPI could not start a sign-in (HTTP ${status}).`,
              }),
            );
          }
          return Effect.succeed({
            state,
            url,
            flow: answer.flow === "device" ? ("device" as const) : ("redirect" as const),
            userCode: typeof answer.user_code === "string" ? answer.user_code : null,
          });
        }),
        Effect.withSpan("CliproxyManagement.oauthStart"),
      ),
    /** Hands CLIProxyAPI the address the browser landed on (`POST /oauth/callback`). */
    oauthCallback: (endpoint: CliproxyEndpoint, provider: string, redirectUrl: string) =>
      managementJson(endpoint, "POST", "/oauth/callback", {
        provider,
        redirect_url: redirectUrl,
      }).pipe(
        Effect.map(({ status }) => status === 200),
        Effect.withSpan("CliproxyManagement.oauthCallback"),
      ),
    /** A sign-in's progress (`GET /oauth/status?state=`): waiting, done, or refused. */
    oauthStatus: (endpoint: CliproxyEndpoint, state: string) =>
      managementJson(endpoint, "GET", `/oauth/status?state=${encodeURIComponent(state)}`).pipe(
        Effect.map(({ body }) => {
          const answer = (body ?? {}) as Record<string, unknown>;
          return answer.status === "ok"
            ? ("ok" as const)
            : answer.status === "wait"
              ? ("wait" as const)
              : ("error" as const);
        }),
        Effect.withSpan("CliproxyManagement.oauthStatus"),
      ),
    /** The token files CLIProxyAPI holds and what it says of each (`GET /credentials`). */
    credentials: (endpoint: CliproxyEndpoint) =>
      managementJson(endpoint, "GET", "/credentials").pipe(
        Effect.flatMap(({ status, body }) => {
          const files = (body as { readonly files?: unknown } | null)?.files;
          if (status !== 200 || !Array.isArray(files)) {
            return Effect.fail(
              new CliproxyManagementError({ message: "CLIProxyAPI did not list its credentials." }),
            );
          }
          return Effect.succeed(
            files.flatMap((file: unknown): Array<CliproxyCredential> => {
              const entry = (file ?? {}) as Record<string, unknown>;
              if (typeof entry.name !== "string") return [];
              const text = (value: unknown) => (typeof value === "string" ? value : null);
              return [
                {
                  name: entry.name,
                  provider: text(entry.provider) ?? text(entry.type),
                  email: text(entry.email),
                  status: text(entry.status),
                  statusMessage: text(entry.status_message),
                  requiresSignIn: entry.requires_sign_in === true,
                  quotaBlocked: entry.quota_blocked === true,
                  unavailable: entry.unavailable === true,
                  modtime: text(entry.modtime) ?? text(entry.updated_at),
                },
              ];
            }),
          );
        }),
        Effect.withSpan("CliproxyManagement.credentials"),
      ),
    /** One token file's bytes (`GET /credentials/download?name=`); none when it is not there. */
    downloadCredential: (endpoint: CliproxyEndpoint, name: string) =>
      client
        .execute(
          HttpClientRequest.get(
            `${endpoint.baseUrl}${MANAGEMENT_PATH}/credentials/download?name=${encodeURIComponent(name)}`,
          ).pipe(HttpClientRequest.bearerToken(Redacted.value(endpoint.managementKey))),
        )
        .pipe(
          Effect.flatMap((response): Effect.Effect<Option.Option<Uint8Array>, unknown> =>
            response.status === 404
              ? Effect.succeed(Option.none<Uint8Array>())
              : response.status === 200
                ? response.arrayBuffer.pipe(
                    Effect.map((bytes) => Option.some(new Uint8Array(bytes))),
                  )
                : Effect.fail(response.status),
          ),
          Effect.timeout("15 seconds"),
          Effect.mapError(
            () =>
              new CliproxyManagementError({ message: "CLIProxyAPI did not hand a credential." }),
          ),
          Effect.withSpan("CliproxyManagement.downloadCredential"),
        ),
    /** Writes one token file into its `auth-dir` (`POST /credentials?name=`). */
    uploadCredential: (endpoint: CliproxyEndpoint, name: string, bytes: Uint8Array) =>
      client
        .execute(
          HttpClientRequest.post(
            `${endpoint.baseUrl}${MANAGEMENT_PATH}/credentials?name=${encodeURIComponent(name)}`,
          ).pipe(
            HttpClientRequest.bearerToken(Redacted.value(endpoint.managementKey)),
            HttpClientRequest.bodyUint8Array(bytes, "application/json"),
          ),
        )
        .pipe(
          Effect.flatMap((response): Effect.Effect<void, number> =>
            response.status === 200 ? Effect.void : Effect.fail(response.status),
          ),
          Effect.timeout("15 seconds"),
          Effect.mapError(
            () =>
              new CliproxyManagementError({ message: "CLIProxyAPI did not take a credential." }),
          ),
          Effect.withSpan("CliproxyManagement.uploadCredential"),
        ),
    /** Removes one token file (`DELETE /credentials?name=`): `missing` when it was not there. */
    deleteCredential: (endpoint: CliproxyEndpoint, name: string) =>
      managementJson(endpoint, "DELETE", `/credentials?name=${encodeURIComponent(name)}`).pipe(
        Effect.flatMap(({ status }) =>
          status === 200
            ? Effect.succeed("deleted" as const)
            : status === 404
              ? Effect.succeed("missing" as const)
              : Effect.fail(
                  new CliproxyManagementError({
                    message: `CLIProxyAPI did not remove a credential (HTTP ${status}).`,
                  }),
                ),
        ),
        Effect.withSpan("CliproxyManagement.deleteCredential"),
      ),
    /** Imports a Vertex service account (`POST /oauth/import?provider=vertex`, a file). */
    importVertex: (endpoint: CliproxyEndpoint, serviceAccount: Uint8Array) =>
      Effect.suspend(() => {
        const form = new FormData();
        form.append(
          "file",
          new Blob([serviceAccount], { type: "application/json" }),
          "service-account.json",
        );
        return client.execute(
          HttpClientRequest.post(
            `${endpoint.baseUrl}${MANAGEMENT_PATH}/oauth/import?provider=vertex`,
          ).pipe(
            HttpClientRequest.bearerToken(Redacted.value(endpoint.managementKey)),
            HttpClientRequest.bodyFormData(form),
          ),
        );
      }).pipe(
        Effect.flatMap(
          (
            response,
          ): Effect.Effect<
            { readonly _tag: "accepted" } | { readonly _tag: "refused"; readonly reason: string }
          > =>
            response.status === 200
              ? Effect.succeed({ _tag: "accepted" } as const)
              : response.text.pipe(
                  Effect.orElseSucceed(() => ""),
                  Effect.map((text) => ({
                    _tag: "refused" as const,
                    reason: refusalReasonOf(text, []),
                  })),
                ),
        ),
        Effect.timeout("15 seconds"),
        Effect.mapError(
          () => new CliproxyManagementError({ message: "CLIProxyAPI did not answer." }),
        ),
        Effect.withSpan("CliproxyManagement.importVertex"),
      ),
  };
});

export type CliproxyManagement = Effect.Success<typeof makeCliproxyManagement>;
