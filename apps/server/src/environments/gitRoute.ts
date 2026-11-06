/**
 * `/api/git/<projectId>`: the Hub repository over git smart HTTP, relayed to `git http-backend`.
 * The Environment credential is checked on every request, and a machine sees and writes only the
 * refs of Threads it runs, in Projects where its owner may start Threads; nobody deletes.
 */
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Pull from "effect/Pull";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HubRepository from "../checkpointing/HubRepository.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { requestUrl } from "../requestUrl.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { bearerOf, isSecureEnvironmentTransport } from "./http.ts";

const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);
/** A request or response that takes longer is cut off: git sees a failed transfer and retries. */
const REQUEST_TIMEOUT = "10 minutes";
const MAX_HEADER_BYTES = 64 * 1024;

class HubRepositoryHttpError extends Schema.TaggedError<HubRepositoryHttpError>()(
  "HubRepositoryHttpError",
  { detail: Schema.String },
) {}

/** The Environment credential: the password of Basic auth, as git's helper sends it, or a Bearer. */
const credentialOf = (authorization: string | undefined) => {
  const bearer = bearerOf(authorization);
  if (bearer !== undefined) return bearer;
  const basic = /^basic\s+(\S+)\s*$/iu.exec(authorization ?? "")?.[1];
  if (basic === undefined) return undefined;
  const decoded = Buffer.from(basic, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator === -1 ? undefined : decoded.slice(separator + 1);
};

const unauthorized = () =>
  HttpServerResponse.text("Unauthorized", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="T3 Code Hub", charset="UTF-8"' },
  });

/** A CGI response head: its status and headers. */
const parseCgiHead = (head: Buffer) => {
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of head.toString("latin1").split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "status") status = Number.parseInt(value, 10) || 500;
    else headers[name] = value;
  }
  return { status, headers };
};

const headEnd = (bytes: Buffer) => {
  const crlf = bytes.indexOf("\r\n\r\n");
  if (crlf !== -1) return { end: crlf, gap: 4 };
  const lf = bytes.indexOf("\n\n");
  return lf === -1 ? undefined : { end: lf, gap: 2 };
};

/** Git config for one request, by environment: nothing from the system or the user's own. */
const isolatedEnvironment = (
  nullDevice: string,
  entries: ReadonlyArray<readonly [string, string]>,
) => {
  const env: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_COUNT: String(entries.length),
  };
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "LANG"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
};

const ZERO_OID = /^0+$/u;

interface RefUpdate {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/**
 * The ref updates at the start of a receive-pack request, in pkt-lines up to the flush packet:
 * `<old> <new> <ref>`, the first one followed by NUL and capabilities. `shallow` lines may come
 * before them; anything else (a signed push's certificate) is not accepted.
 */
const parseReceiveCommands = (
  bytes: Buffer,
):
  | { readonly _tag: "incomplete" }
  | { readonly _tag: "invalid" }
  | { readonly _tag: "parsed"; readonly updates: ReadonlyArray<RefUpdate> } => {
  const updates: Array<RefUpdate> = [];
  let offset = 0;
  while (true) {
    if (bytes.length < offset + 4) {
      return bytes.length > MAX_HEADER_BYTES ? { _tag: "invalid" } : { _tag: "incomplete" };
    }
    const length = Number.parseInt(bytes.subarray(offset, offset + 4).toString("latin1"), 16);
    if (!Number.isInteger(length) || (length !== 0 && length < 4)) return { _tag: "invalid" };
    if (length === 0) return { _tag: "parsed", updates };
    if (bytes.length < offset + length) {
      return bytes.length > MAX_HEADER_BYTES ? { _tag: "invalid" } : { _tag: "incomplete" };
    }
    const line = bytes
      .subarray(offset + 4, offset + length)
      .toString("utf8")
      .split("\0")[0]!
      .replace(/\n$/u, "");
    offset += length;
    if (line.startsWith("shallow ")) continue;
    const [oldOid, newOid, ref, ...extra] = line.split(" ");
    if (oldOid === undefined || newOid === undefined || ref === undefined || extra.length > 0) {
      return { _tag: "invalid" };
    }
    updates.push({ oldOid, newOid, ref });
  }
};

/** Why the machine may not make these updates, or undefined when it may. */
const refuseUpdates = (updates: ReadonlyArray<RefUpdate>, prefixes: ReadonlyArray<string>) => {
  for (const update of updates) {
    if (ZERO_OID.test(update.newOid)) return `Deleting ${update.ref} is not allowed.`;
    if (!prefixes.some((prefix) => update.ref.startsWith(prefix))) {
      return `${update.ref} is not a ref of a Thread this machine runs.`;
    }
  }
  return undefined;
};

// One span per request is enough; git's own work happens in the subprocess.
const makeHandler = Effect.fnUntraced(function* (deps: {
  readonly repositories: HubRepository.HubRepositories["Service"];
  readonly registry: EnvironmentRegistry.EnvironmentRegistry["Service"];
  readonly spaces: SpaceDirectory.SpaceDirectory["Service"];
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly sql: SqlClient.SqlClient;
  readonly digest: Digest.Digest["Service"];
  readonly maxRequestBytes: number;
  readonly nullDevice: string;
}) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const [encodedProjectId, ...rest] = url.value.pathname
    .slice(HubRepository.HUB_REPOSITORY_ROUTE_PREFIX.length + 1)
    .split("/");
  const endpoint = rest.join("/");
  const service =
    endpoint === "info/refs" && request.method === "GET"
      ? url.value.searchParams.get("service")
      : request.method === "POST"
        ? endpoint
        : null;
  if (encodedProjectId === undefined || service === null || !SERVICES.has(service)) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  if (!isSecureEnvironmentTransport(request)) {
    return HttpServerResponse.text("The Hub repository is served over HTTPS only.", {
      status: 403,
    });
  }
  const check = yield* deps.registry.checkCredential(credentialOf(request.headers.authorization));
  if (check._tag === "refused") return unauthorized();

  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && Number(contentLength) > deps.maxRequestBytes) {
    return HttpServerResponse.text("Payload Too Large", { status: 413 });
  }
  const projectId = ProjectId.make(decodeURIComponent(encodedProjectId));
  const project = yield* deps.projects.get(projectId).pipe(Effect.orElseSucceed(Option.none));
  if (Option.isNone(project)) return HttpServerResponse.text("Not Found", { status: 404 });
  // The machine works for its owner only: in Spaces where they may start Threads.
  const allowed = yield* deps.spaces
    .claimCreation({ action: "thread.create", actorUserId: check.ownerUserId, projectId })
    .pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  if (!allowed) return HttpServerResponse.text("Forbidden", { status: 403 });

  const prefixes = yield* refPrefixesFor(deps, projectId, check.environmentId);
  yield* deps.repositories.ensure(projectId);
  const contentType = request.headers["content-type"];
  const contentEncoding = request.headers["content-encoding"];
  const gitProtocol = request.headers["git-protocol"];
  const env = {
    ...isolatedEnvironment(deps.nullDevice, [
      ["http.receivepack", "true"],
      ["core.hooksPath", deps.nullDevice],
      ["receive.denyDeletes", "true"],
      ["receive.denyDeleteCurrent", "true"],
      ["uploadpack.allowAnySHA1InWant", "false"],
      // Every ref is hidden from the machine, read and write, but those of Threads it runs.
      ["transfer.hideRefs", "refs/"],
      ["transfer.hideRefs", "HEAD"],
      ...prefixes.readable.map((prefix) => ["transfer.hideRefs", `!${prefix}`] as const),
    ]),
    GIT_PROJECT_ROOT: deps.repositories.root,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${deps.repositories.directoryOf(projectId)}/${endpoint}`,
    REQUEST_METHOD: request.method,
    QUERY_STRING: url.value.search.slice(1),
    REMOTE_USER: check.environmentId,
    REMOTE_ADDR: "127.0.0.1",
    ...(contentType === undefined ? {} : { CONTENT_TYPE: contentType }),
    ...(contentEncoding === undefined ? {} : { HTTP_CONTENT_ENCODING: contentEncoding }),
    ...(contentLength === undefined ? {} : { CONTENT_LENGTH: contentLength }),
    ...(gitProtocol === undefined ? {} : { GIT_PROTOCOL: gitProtocol }),
  };

  // The child lives until the response body is sent, or the request fails before it starts.
  const scope = yield* Scope.make();
  return yield* Effect.gen(function* () {
    let received = 0;
    const counted = request.stream.pipe(
      Stream.mapEffect((chunk) => {
        received += chunk.length;
        return received > deps.maxRequestBytes
          ? Effect.fail(new HubRepositoryHttpError({ detail: "The request is too large." }))
          : Effect.succeed(chunk);
      }),
    );
    let body: typeof counted = request.method === "POST" ? counted : Stream.empty;
    if (request.method === "POST" && service === "git-receive-pack") {
      // The ref updates come first, before the pack: each is checked before git sees any.
      if (contentEncoding !== undefined) {
        return HttpServerResponse.text("Unsupported Media Type", { status: 415 });
      }
      const pull = yield* Stream.toPull(counted);
      let buffered = Buffer.alloc(0);
      let commands = parseReceiveCommands(buffered);
      while (commands._tag === "incomplete") {
        const chunk = yield* pull.pipe(Pull.catchDone(() => Effect.succeed(undefined)));
        if (chunk === undefined) break;
        buffered = Buffer.concat([buffered, ...chunk]);
        commands = parseReceiveCommands(buffered);
      }
      const refusal =
        commands._tag === "parsed"
          ? refuseUpdates(commands.updates, prefixes.writable)
          : "The push could not be read.";
      if (refusal !== undefined) return HttpServerResponse.text(refusal, { status: 403 });
      body = Stream.concat(
        Stream.make(new Uint8Array(buffered)),
        Stream.fromPull(Effect.succeed(pull)),
      );
    }
    const child = yield* deps.spawner.spawn(
      ChildProcess.make("git", ["http-backend"], {
        cwd: deps.repositories.root,
        env,
        extendEnv: false,
      }),
    );
    yield* Stream.run(body, child.stdin).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Hub repository request body failed", { cause }),
      ),
      Effect.forkIn(scope),
    );
    yield* Stream.runDrain(child.stderr).pipe(Effect.ignore, Effect.forkIn(scope));
    const pull = yield* Stream.toPull(child.stdout);
    let buffered = Buffer.alloc(0);
    let found = headEnd(buffered);
    while (found === undefined) {
      const chunk = yield* pull.pipe(Pull.catchDone(() => Effect.succeed(undefined)));
      if (chunk === undefined || buffered.length > MAX_HEADER_BYTES) {
        const exitCode = yield* child.exitCode.pipe(Effect.orElseSucceed(() => -1));
        return yield* new HubRepositoryHttpError({
          detail: `git http-backend ended without a response (exit ${exitCode}).`,
        });
      }
      buffered = Buffer.concat([buffered, ...chunk]);
      found = headEnd(buffered);
    }
    const head = parseCgiHead(buffered.subarray(0, found.end));
    const leftover = new Uint8Array(buffered.subarray(found.end + found.gap));
    // A git that fails after its head was sent breaks the body, so the client sees a failure.
    const exited = child.exitCode.pipe(
      Effect.filterOrFail(
        (code) => code === 0,
        (code) => new HubRepositoryHttpError({ detail: `git http-backend exited with ${code}.` }),
      ),
    );
    const responseBody = Stream.concat(
      Stream.concat(
        leftover.length === 0 ? Stream.empty : Stream.make(leftover),
        Stream.fromPull(Effect.succeed(pull)),
      ),
      Stream.fromEffect(exited).pipe(Stream.drain),
    ).pipe(
      Stream.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () =>
          Stream.fail(new HubRepositoryHttpError({ detail: "The Hub repository timed out." })),
      }),
      Stream.ensuring(Scope.close(scope, Exit.void)),
    );
    const { "content-type": responseType, ...headers } = head.headers;
    return HttpServerResponse.stream(responseBody, {
      status: head.status,
      headers,
      ...(responseType === undefined ? {} : { contentType: responseType }),
    });
  }).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.onError(() => Scope.close(scope, Exit.void)),
    Effect.timeout(REQUEST_TIMEOUT),
  );
});

/**
 * The ref namespaces the machine may see and write in the Project's repository: those of the
 * Threads it is the Active environment of. The target of a Thread's running move may also read
 * them, to fetch what the Thread continues from, but writes none until the Thread is its own.
 */
const refPrefixesFor = Effect.fn("HubRepositoryHttp.refPrefixesFor")(function* (
  deps: { readonly sql: SqlClient.SqlClient; readonly digest: Digest.Digest["Service"] },
  projectId: ProjectId,
  environmentId: EnvironmentId,
) {
  const rows = yield* deps.sql<{
    readonly threadId: string;
    readonly scopeId: string | null;
    readonly active: number;
  }>`
    SELECT thread.thread_id AS "threadId", scope.scope_id AS "scopeId",
      thread.active_environment_id IS ${environmentId} AS active
    FROM orchestration_v2_projection_threads thread
    LEFT JOIN orchestration_v2_projection_checkpoint_scopes scope
      ON scope.thread_id = thread.thread_id
    WHERE thread.project_id = ${projectId}
      AND (
        thread.active_environment_id = ${environmentId}
        OR (
          json_extract(thread.payload_json, '$.move.status') = 'running'
          AND json_extract(thread.payload_json, '$.move.targetEnvironmentId') = ${environmentId}
        )
      )
  `;
  const readable = new Set<string>();
  const writable = new Set<string>();
  for (const row of rows) {
    const prefixes: Array<string> = [...HubRepository.threadRefPrefixes(row.threadId)];
    if (row.scopeId !== null) {
      const ref = yield* checkpointRefForScopeOrdinal({
        scopeId: row.scopeId as never,
        ordinalWithinScope: 0,
      }).pipe(Effect.provideService(Digest.Digest, deps.digest));
      prefixes.push(ref.slice(0, ref.length - "ordinal/0".length));
    }
    for (const prefix of prefixes) {
      readable.add(prefix);
      if (row.active === 1) writable.add(prefix);
    }
  }
  return { readable: [...readable], writable: [...writable] };
});

/** Registered where the server keeps Hub repositories; joined machines serve none. */
export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const repositories = yield* Effect.serviceOption(HubRepository.HubRepositories);
    if (Option.isNone(repositories)) return;
    const handler = makeHandler({
      repositories: repositories.value,
      registry: yield* EnvironmentRegistry.EnvironmentRegistry,
      spaces: yield* SpaceDirectory.SpaceDirectory,
      projects: yield* ProjectStore.ProjectStoreV2,
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      sql: yield* SqlClient.SqlClient,
      digest: yield* Digest.Digest,
      maxRequestBytes: yield* Config.Int("T3CODE_HUB_REPOSITORY_MAX_REQUEST_BYTES").pipe(
        Config.withDefault(2 * 1024 * 1024 * 1024),
      ),
      nullDevice: (yield* HostProcess.Platform) === "win32" ? "NUL" : "/dev/null",
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Hub repository request failed", { cause }).pipe(
          Effect.as(HttpServerResponse.text("Bad Gateway", { status: 502 })),
        ),
      ),
    );
    const path = `${HubRepository.HUB_REPOSITORY_ROUTE_PREFIX}/*`;
    yield* router.add("GET", path, handler);
    yield* router.add("POST", path, handler);
  }),
);
