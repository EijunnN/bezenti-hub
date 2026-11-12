/**
 * `/api/ai/*` (spec 4 ticket 04), in front of CLIProxyAPI: authorize the key, plan the route,
 * pin the model to `acct-<id>/<model>`, send with the Hub's client key, stream the answer back,
 * and on a 429 try the next allowed account of the same provider. docs/internals/ai-gateway.md.
 */
import { AI_GATEWAY_ROUTE_PREFIX, type AiAccountId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as AiAccounts from "./AiAccounts.ts";
import * as AiGateway from "./AiGateway.ts";
import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import * as AiGatewayKeys from "./AiGatewayKeys.ts";
import {
  errorBody,
  FORWARDED_REQUEST_HEADERS,
  type GatewayShape,
  gatewayKeyOf,
  makeResponseTap,
  matchGatewayRoute,
  modelListBody,
  noQuotaMessage,
  parseJsonObject,
  parseRequestedModel,
  parseRequestPath,
  planRoute,
  type RoutableAccount,
  upstreamErrorMessage,
  upstreamModelOf,
} from "./gatewayShapes.ts";

/** Waiting for an answer to start; a long prompt can take minutes. */
const FIRST_BYTE_TIMEOUT = "10 minutes";
/** A whole answer, streamed. */
const RESPONSE_TIMEOUT = "60 minutes";
/** An upstream error body is read up to this much (to filter it), then cut. */
const ERROR_BODY_LIMIT = 64 * 1024;

interface AiGatewayLimits {
  /** A request body larger than this is refused (413) before CLIProxyAPI sees any of it. */
  readonly maxRequestBytes: number;
  /** Requests in flight at once for one key, and for the whole Hub (429 beyond). */
  readonly perKeyConcurrency: number;
  readonly totalConcurrency: number;
}

const DEFAULT_AI_GATEWAY_LIMITS: AiGatewayLimits = {
  maxRequestBytes: 32 * 1024 * 1024,
  perKeyConcurrency: 16,
  totalConcurrency: 256,
};

/** Every answer of the layer: never compressed (that would hold SSE back) nor cached. */
const RESPONSE_HEADERS = {
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
};

const shapeError = (shape: GatewayShape, status: number, message: string) =>
  HttpServerResponse.jsonUnsafe(errorBody(shape, status, message), {
    status,
    headers: {
      ...RESPONSE_HEADERS,
      ...(status === 401 ? { "www-authenticate": 'Bearer realm="T3 Code AI gateway"' } : {}),
    },
  });

class TooLarge {
  readonly _tag = "TooLarge";
}

const readBody = Effect.fn("AiGatewayRoute.readBody")(function* (
  request: HttpServerRequest.HttpServerRequest,
  limit: number,
) {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > limit) return yield* Effect.fail(new TooLarge());
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  yield* Stream.runForEach(request.stream, (chunk) => {
    size += chunk.length;
    if (size > limit) return Effect.fail(new TooLarge());
    chunks.push(chunk);
    return Effect.void;
  });
  return Buffer.concat(chunks);
});

const makeHandler = (deps: {
  readonly keys: AiGatewayKeys.AiGatewayKeys["Service"];
  readonly accounts: AiAccounts.AiAccounts["Service"];
  readonly gateway: AiGateway.AiGateway["Service"];
  readonly activity: AiGatewayActivity.AiGatewayActivity["Service"];
  readonly httpClient: HttpClient.HttpClient;
  readonly limits: AiGatewayLimits;
}) => {
  const inFlight = new Map<string, number>();
  let total = 0;
  const acquire = (keyId: string) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const held = inFlight.get(keyId) ?? 0;
        if (held >= deps.limits.perKeyConcurrency || total >= deps.limits.totalConcurrency) {
          return false;
        }
        inFlight.set(keyId, held + 1);
        total += 1;
        return true;
      }),
      (taken) =>
        Effect.sync(() => {
          if (!taken) return;
          const held = (inFlight.get(keyId) ?? 1) - 1;
          if (held <= 0) inFlight.delete(keyId);
          else inFlight.set(keyId, held);
          total -= 1;
        }),
    );

  /** The models an account serves; an account the gateway cannot list serves none now. */
  const modelsOf = (accountId: AiAccountId) =>
    deps.accounts.modelsOf(accountId).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const startedAt = yield* DateTime.now;
    const url = parseRequestPath(request.url);
    if (url === undefined) return shapeError("openai", 400, "Bad request.");
    const route = matchGatewayRoute(request.method, url.pathname);
    if (route._tag === "not-found") return shapeError(route.shape, 404, "Not found.");
    if (route._tag === "method-not-allowed") {
      return shapeError(route.shape, 405, "Method not allowed.");
    }
    const shape = route.shape;
    // A key in the query string would reach logs and proxies: never accepted, even a valid one.
    if (url.searchParams.has("key") || url.searchParams.has("api_key")) {
      return shapeError(shape, 401, "Send the AI gateway key in a header, not in the address.");
    }
    const lookup = gatewayKeyOf(shape, request.headers);
    if (lookup._tag !== "key") {
      return shapeError(
        shape,
        401,
        lookup._tag === "ambiguous"
          ? "Send one AI gateway key."
          : "This request needs an AI gateway key.",
      );
    }
    const caller = yield* deps.keys.authorize(Redacted.make(lookup.key)).pipe(Effect.result);
    if (caller._tag === "Failure") {
      return shapeError(shape, caller.failure.status, caller.failure.message);
    }
    const who = caller.success;
    const permitted = yield* acquire(who.keyId);
    if (!permitted) {
      return shapeError(shape, 429, "Too many requests to the AI gateway at once. Try again.");
    }
    const allowed: ReadonlyArray<RoutableAccount> = who.allowed;

    if (route._tag === "models") {
      // The Thread's account, when it chose one; else everything allowed. Plain names only.
      const listed =
        who.chosenAccountId !== null
          ? allowed.filter((account) => account.id === who.chosenAccountId)
          : allowed;
      const models = yield* Effect.forEach(listed, (account) => modelsOf(account.id), {
        concurrency: 4,
      });
      return HttpServerResponse.jsonUnsafe(modelListBody(shape, models.flat()), {
        headers: RESPONSE_HEADERS,
      });
    }

    const endpoint = yield* deps.gateway.endpoint;
    if (Option.isNone(endpoint)) {
      return shapeError(shape, 503, "The AI gateway is not running.");
    }
    if (request.headers["content-encoding"] !== undefined) {
      return shapeError(shape, 415, "Send the request body uncompressed.");
    }
    const body = yield* readBody(request, deps.limits.maxRequestBytes).pipe(Effect.result);
    if (body._tag === "Failure") {
      return body.failure instanceof TooLarge
        ? shapeError(shape, 413, "The request is too large.")
        : shapeError(shape, 400, "The request body could not be read.");
    }
    const json = parseJsonObject(body.success);
    if (json === undefined) {
      return shapeError(shape, 400, "The request body must be a JSON object.");
    }
    const requested = parseRequestedModel(route.pathModel ?? json.model);
    // What each allowed account serves, read once (cached by AiAccounts).
    const served = new Map<string, ReadonlySet<string>>();
    for (const account of allowed) {
      served.set(account.id, new Set(yield* modelsOf(account.id)));
    }
    const plan = planRoute({
      allowed,
      chosenAccountId: who.chosenAccountId,
      requested,
      serves: (accountId, model) => served.get(accountId)?.has(model) === true,
    });
    if (plan._tag === "refused") return shapeError(shape, plan.status, plan.message);

    const forwarded: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (value !== undefined) forwarded[name] = value;
    }
    // Only Gemini's `alt=sse` crosses; no other query parameter reaches CLIProxyAPI.
    const query = shape === "gemini" && url.searchParams.get("alt") === "sse" ? "?alt=sse" : "";
    const client = HttpClient.withScope(deps.httpClient);
    const send = (account: RoutableAccount) => {
      const upstreamModel = upstreamModelOf(account.id, plan.model);
      const bytes =
        route.pathModel === undefined
          ? Buffer.from(JSON.stringify({ ...json, model: upstreamModel }), "utf8")
          : body.success;
      return client
        .execute(
          HttpClientRequest.post(
            `${endpoint.value.baseUrl}${route.upstreamPath(upstreamModel)}${query}`,
          ).pipe(
            HttpClientRequest.setHeaders({ ...forwarded, "accept-encoding": "identity" }),
            HttpClientRequest.bearerToken(Redacted.value(endpoint.value.clientKey)),
            HttpClientRequest.bodyUint8Array(new Uint8Array(bytes), "application/json"),
          ),
        )
        .pipe(Effect.timeout(FIRST_BYTE_TIMEOUT), Effect.result);
    };

    const record = Effect.fn("AiGatewayRoute.record")(
      function* (input: {
        readonly account: RoutableAccount | null;
        readonly status: number;
        readonly failovers: number;
        readonly usage: AiGatewayActivity.GatewayRequestRecord["usage"];
      }) {
        const endedAt = yield* DateTime.now;
        const entry: AiGatewayActivity.GatewayRequestRecord = {
          at: DateTime.formatIso(startedAt),
          keyId: who.keyId,
          keyKind: who.kind,
          userId: who.userId,
          spaceId: who.spaceId,
          threadId: who.threadId,
          shape,
          route: route.route,
          accountId: input.account?.id ?? null,
          provider: input.account?.provider ?? null,
          model: plan.model,
          status: input.status,
          durationMs: DateTime.toEpochMillis(endedAt) - DateTime.toEpochMillis(startedAt),
          failovers: input.failovers,
          usage: input.usage,
        };
        // Method, route, account, model, status and tokens: never a key, a header or a body.
        yield* Effect.logInfo("AI gateway request").pipe(
          Effect.annotateLogs({
            method: request.method,
            route: route.route,
            account: entry.accountId ?? "none",
            model: plan.model,
            status: input.status,
            failovers: input.failovers,
            inputTokens: input.usage?.inputTokens ?? null,
            outputTokens: input.usage?.outputTokens ?? null,
          }),
        );
        yield* deps.activity.record(entry);
      },
      (effect, input) =>
        effect.pipe(
          Effect.withSpan("AiGateway.request", {
            attributes: {
              "http.request.method": request.method,
              "t3.ai.route": route.route,
              "t3.ai.account": input.account?.id ?? "none",
              "t3.ai.model": plan.model,
              "http.response.status_code": input.status,
              "t3.ai.failovers": input.failovers,
              "t3.ai.input_tokens": input.usage?.inputTokens ?? -1,
              "t3.ai.output_tokens": input.usage?.outputTokens ?? -1,
            },
          }),
        ),
    );

    let failovers = 0;
    for (const [index, account] of plan.candidates.entries()) {
      const sent = yield* send(account);
      if (sent._tag === "Failure") {
        yield* Effect.logWarning("AI gateway: CLIProxyAPI did not answer").pipe(
          Effect.annotateLogs({ route: route.route, account: account.id }),
        );
        yield* record({ account, status: 502, failovers, usage: null });
        return shapeError(shape, 502, "The AI gateway did not answer. Try again.");
      }
      const response = sent.success;
      if (response.status === 429) {
        yield* Stream.runDrain(response.stream).pipe(Effect.ignore);
        if (index < plan.candidates.length - 1) {
          failovers += 1;
          continue;
        }
        yield* record({ account, status: 429, failovers, usage: null });
        return shapeError(shape, 429, noQuotaMessage(plan.candidates[0]!.provider));
      }
      if (response.status < 200 || response.status >= 300) {
        let text = "";
        yield* Stream.runForEach(Stream.take(response.stream, 64), (chunk) => {
          if (text.length < ERROR_BODY_LIMIT) {
            text += Buffer.from(chunk)
              .toString("utf8")
              .slice(0, ERROR_BODY_LIMIT - text.length);
          }
          return Effect.void;
        }).pipe(Effect.ignore);
        // CLIProxyAPI refusing the Hub's own key is the Hub's problem, not the client's key.
        const status = response.status === 401 || response.status === 403 ? 502 : response.status;
        yield* record({ account, status, failovers, usage: null });
        return shapeError(shape, status, upstreamErrorMessage(response.status, text));
      }
      if (who.threadId !== null) {
        yield* deps.activity.noteInUse({
          threadId: who.threadId,
          accountId: account.id,
          model: plan.model,
        });
      }
      const contentType = response.headers["content-type"] ?? "application/json";
      const tap = makeResponseTap({
        sse: /text\/event-stream/iu.test(contentType),
        prefix: upstreamModelOf(account.id, "").slice(0, -1),
      });
      let finished = false;
      const answer = response.stream.pipe(
        Stream.map(tap.chunk),
        Stream.concat(
          Stream.fromEffect(
            Effect.sync(() => {
              finished = true;
              return tap.end();
            }),
          ),
        ),
        Stream.filter((chunk) => chunk.length > 0),
        Stream.timeoutOrElse({
          duration: RESPONSE_TIMEOUT,
          orElse: () => Stream.fail(new Error("The AI gateway answer timed out.")),
        }),
        // Tokens only from an answer that ended: one cut off counts the request, not its tokens.
        Stream.ensuring(
          Effect.suspend(() =>
            record({
              account,
              status: response.status,
              failovers,
              usage: finished ? tap.usage() : null,
            }),
          ),
        ),
      );
      return HttpServerResponse.stream(answer, {
        status: response.status,
        headers: RESPONSE_HEADERS,
        contentType,
      });
    }
    return shapeError(shape, 503, "No AI account could serve this request.");
    // The permit and the upstream request live in the request's scope: until the answer is sent.
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("AI gateway request failed", { cause }).pipe(
        Effect.as(shapeError("openai", 502, "The AI gateway failed.")),
      ),
    ),
  );
};

/** Registered on a Hub that keeps AI accounts; a joined machine serves none of `/api/ai/*`. */
export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const keys = yield* Effect.serviceOption(AiGatewayKeys.AiGatewayKeys);
    const accounts = yield* Effect.serviceOption(AiAccounts.AiAccounts);
    const gateway = yield* Effect.serviceOption(AiGateway.AiGateway);
    const activity = yield* Effect.serviceOption(AiGatewayActivity.AiGatewayActivity);
    if (
      Option.isNone(keys) ||
      Option.isNone(accounts) ||
      Option.isNone(gateway) ||
      Option.isNone(activity)
    ) {
      return;
    }
    const handler = makeHandler({
      keys: keys.value,
      accounts: accounts.value,
      gateway: gateway.value,
      activity: activity.value,
      httpClient: yield* HttpClient.HttpClient,
      limits: {
        ...DEFAULT_AI_GATEWAY_LIMITS,
        maxRequestBytes: yield* Config.Int("T3CODE_AI_GATEWAY_MAX_REQUEST_BYTES").pipe(
          Config.withDefault(DEFAULT_AI_GATEWAY_LIMITS.maxRequestBytes),
        ),
      },
    });
    yield* router.add("*", `${AI_GATEWAY_ROUTE_PREFIX}/*`, handler);
  }),
);
