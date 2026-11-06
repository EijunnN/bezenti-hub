/**
 * `/api/git/<projectId>`: the Hub repository over git smart HTTP, relayed to `git http-backend`.
 * The Environment credential is checked on every request, so a removed machine loses access at
 * once, and only Projects where the machine's owner may start Threads are served.
 */
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { requestUrl } from "../requestUrl.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { bearerOf, isSecureEnvironmentTransport } from "./http.ts";

const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

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

/** Splits a CGI response into its status, headers and body. */
const parseCgi = (output: Uint8Array) => {
  const bytes = Buffer.from(output);
  let end = bytes.indexOf("\r\n\r\n");
  let gap = 4;
  if (end === -1) {
    end = bytes.indexOf("\n\n");
    gap = 2;
  }
  if (end === -1) return undefined;
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of bytes.subarray(0, end).toString("latin1").split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "status") status = Number.parseInt(value, 10) || 500;
    else headers[name] = value;
  }
  return { status, headers, body: new Uint8Array(bytes.subarray(end + gap)) };
};

// One span per request is enough; git's own work happens in the subprocess.
const makeHandler = Effect.fnUntraced(function* (deps: {
  readonly repositories: HubRepository.HubRepositories["Service"];
  readonly registry: EnvironmentRegistry.EnvironmentRegistry["Service"];
  readonly spaces: SpaceDirectory.SpaceDirectory["Service"];
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
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

  yield* deps.repositories.ensure(projectId);
  const contentType = request.headers["content-type"];
  const contentEncoding = request.headers["content-encoding"];
  const contentLength = request.headers["content-length"];
  const gitProtocol = request.headers["git-protocol"];
  const output = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* deps.spawner.spawn(
        ChildProcess.make("git", ["-c", "http.receivepack=true", "http-backend"], {
          cwd: deps.repositories.root,
          extendEnv: true,
          env: {
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
          },
        }),
      );
      const [stdout] = yield* Effect.all(
        [
          Stream.mkUint8Array(child.stdout),
          Stream.run(request.method === "POST" ? request.stream : Stream.empty, child.stdin),
          Stream.runDrain(child.stderr),
        ],
        { concurrency: "unbounded" },
      );
      yield* child.exitCode;
      return stdout;
    }),
  );
  const response = parseCgi(output);
  if (response === undefined) return HttpServerResponse.text("Bad Gateway", { status: 502 });
  const { "content-type": responseType, ...headers } = response.headers;
  return HttpServerResponse.uint8Array(response.body, {
    status: response.status,
    headers,
    ...(responseType === undefined ? {} : { contentType: responseType }),
  });
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
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Hub repository request failed", { cause }).pipe(
          Effect.as(HttpServerResponse.text("Internal Server Error", { status: 500 })),
        ),
      ),
    );
    const path = `${HubRepository.HUB_REPOSITORY_ROUTE_PREFIX}/*`;
    yield* router.add("GET", path, handler);
    yield* router.add("POST", path, handler);
  }),
);
