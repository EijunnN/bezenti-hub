// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off
// `t3 join` listens on a loopback port so a browser on this machine returns at once, and talks to
// a Hub this process has no HttpClient layer for.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodeReadline from "node:readline";

import {
  EnvironmentJoinStartResult,
  EnvironmentJoinStatus,
  type EnvironmentJoinStartRequest,
} from "@t3tools/contracts";
import { appSignInLoopbackRedirectUri, readAppSignInCallback } from "@t3tools/shared/appSignIn";
import { base64UrlEncode } from "@t3tools/shared/base64Url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  assertEnvironmentHubUrl,
  environmentJoinApproverLabel,
  environmentJoinApproverMatches,
  environmentJoinConfirmationPrompt,
  environmentJoinPageUrl,
  formatEnvironmentCredential,
} from "@t3tools/shared/environmentJoin";
import * as Console from "effect/Console";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  ENVIRONMENT_CREDENTIAL_SECRET,
  readJoinedHubState,
  removeJoinedHubState,
  writeJoinedHubState,
} from "../environments/joinedHubState.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

/** As long as the Hub keeps the request. */
const APPROVAL_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;

const RETURN_PAGE =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>T3 Code</title><style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:360px;padding:32px}h1{font-size:24px}p{line-height:1.6;opacity:.7}</style></head><body><main><h1>Return to your terminal</h1><p><code>t3 join</code> shows there who approved this machine and registers it once that is confirmed. You can close this tab.</p></main></body></html>';

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeStarted = Schema.decodeUnknownOption(EnvironmentJoinStartResult);
const decodeStatus = Schema.decodeUnknownOption(EnvironmentJoinStatus);
const decodeDescriptor = Schema.decodeUnknownOption(
  Schema.Struct({ environmentId: Schema.String }),
);

const userError = (message: string) => new CliError.UserError({ cause: message });

/**
 * A loopback port the Hub's page returns a browser on this machine to: only a nudge to ask the
 * Hub now, never a credential. With the page opened elsewhere, asking every few seconds does it.
 */
const listenForReturn = (state: string) =>
  Effect.acquireRelease(
    Effect.callback<
      {
        readonly server: NodeHttp.Server;
        readonly redirectUri: string;
        readonly returned: Promise<void>;
      },
      CliError.UserError
    >((resume) => {
      const returned = Promise.withResolvers<void>();
      let redirectUri = "";
      const server = NodeHttp.createServer((incoming, response) => {
        response.setHeader("cache-control", "no-store");
        response.setHeader("referrer-policy", "no-referrer");
        const target = incoming.url ?? "/";
        const callback =
          incoming.method === "GET" && URL.canParse(target, redirectUri)
            ? readAppSignInCallback(new URL(target, redirectUri).toString(), { redirectUri, state })
            : ({ _tag: "invalid" } as const);
        if (callback._tag === "invalid") {
          response.writeHead(400).end("This response does not belong to this `t3 join`.");
          return;
        }
        response.setHeader(
          "content-security-policy",
          "default-src 'none'; style-src 'unsafe-inline'",
        );
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(RETURN_PAGE);
        returned.resolve();
      });
      server.once("error", (cause) => resume(Effect.fail(userError(String(cause)))));
      // Port 0: the system picks a free port for this join only.
      server.listen(0, "127.0.0.1", () => {
        redirectUri = appSignInLoopbackRedirectUri((server.address() as NodeNet.AddressInfo).port);
        resume(Effect.succeed({ server, redirectUri, returned: returned.promise }));
      });
    }),
    ({ server }) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );

const openInBrowser = (url: string, platform: NodeJS.Platform) =>
  Effect.sync(() => {
    const [command, args] =
      platform === "darwin"
        ? ["open", [url]]
        : platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    try {
      const child = NodeChildProcess.spawn(command, args as Array<string>, {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => undefined);
      child.unref();
    } catch {
      // The printed link is the way in.
    }
  });

const callHub = (url: URL, init: { readonly body?: unknown; readonly authorization?: string }) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        method: init.body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        headers: {
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init.authorization === undefined ? {} : { authorization: init.authorization }),
        },
        ...(init.body === undefined ? {} : { body: encodeJson(init.body) }),
      });
      return {
        status: response.status,
        body: (await response.json().catch(() => null)) as unknown,
      };
    },
    catch: (cause) => userError(`Could not reach the Hub at ${url.origin}: ${String(cause)}`),
  });

const runWithSecrets = Effect.fn("cli.join.runWithSecrets")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (config: ServerConfig.ServerConfig["Service"]) => Effect.Effect<A, E, R>,
) {
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
    quietLogs: true,
  });
  return yield* run(config).pipe(
    Effect.provide(ServerSecretStore.layer.pipe(Layer.provideMerge(ServerConfig.layer(config)))),
  );
});

/** What this server would cut off by joining: its own Owner, Users and Threads. */
const localData = Effect.fn("cli.join.localData")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(config.dbPath).pipe(Effect.orElseSucceed(() => false)))) {
    return { users: 0, threads: 0 };
  }
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [users] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM users`;
    const [threads] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
    `;
    return { users: users?.count ?? 0, threads: threads?.count ?? 0 };
  }).pipe(
    Effect.provide(SqlitePersistence.layerConfig.pipe(Layer.provide(ServerConfig.layer(config)))),
    Effect.mapError((cause) =>
      userError(`Could not read this server's database: ${cause.message}`),
    ),
  );
});

const readLocalEnvironmentId = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(path)),
    Effect.map((text) => text.trim()),
    Effect.orElseSucceed(() => ""),
  );

/** One line typed on this terminal (or written by the desktop app); empty at end of input. */
const readLine = Effect.callback<string>((resume) => {
  const lines = NodeReadline.createInterface({ input: process.stdin, terminal: false });
  let answered = false;
  const answer = (line: string) => {
    if (answered) return;
    answered = true;
    lines.close();
    resume(Effect.succeed(line));
  };
  lines.once("line", answer);
  lines.once("close", () => answer(""));
  return Effect.sync(() => lines.close());
});

const decodeJoinError = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));

/**
 * The Hub says who approved this machine. Anyone who may add machines could have opened the link,
 * so nothing is registered until this machine accepts that User: `--owner` names whom it expects,
 * otherwise the person at the terminal (or the desktop app) answers.
 */
const confirmApprover = Effect.fn("cli.join.confirmApprover")(function* (input: {
  readonly hubUrl: URL;
  readonly requestId: string;
  readonly codeVerifier: string;
  readonly approval: Extract<EnvironmentJoinStatus, { readonly status: "awaiting-confirmation" }>;
  readonly owner: Option.Option<string>;
  readonly confirmOnStdin: boolean;
}) {
  const approver = input.approval.approvedBy;
  const label = environmentJoinApproverLabel(approver);
  let accept: boolean;
  if (Option.isSome(input.owner)) {
    accept = environmentJoinApproverMatches(input.owner.value, approver);
    yield* Console.log(`Approved by ${label} as their personal machine.`);
  } else if (input.confirmOnStdin || process.stdin.isTTY === true) {
    yield* Console.log(environmentJoinConfirmationPrompt(label));
    accept = /^\s*y(es)?\s*$/i.test(yield* readLine);
  } else {
    accept = false;
    yield* Console.log(`Approved by ${label} as their personal machine.`);
  }
  const answer = yield* callHub(new URL("/api/environments/join/confirm", input.hubUrl), {
    body: { requestId: input.requestId, codeVerifier: input.codeVerifier, accept },
  });
  if (!accept) {
    return yield* userError(
      Option.isSome(input.owner)
        ? `Not registered: ${label} approved it, not ${input.owner.value}. Run \`t3 join\` again and approve it with that account.`
        : input.confirmOnStdin || process.stdin.isTTY === true
          ? `Not registered: you did not accept ${label}. Run \`t3 join\` again.`
          : `Not registered: without a terminal to ask, name whom you expect with --owner <sign-in name>. Run \`t3 join\` again.`,
    );
  }
  const status = answer.status === 200 ? decodeStatus(answer.body) : Option.none();
  if (Option.isNone(status)) {
    const refusal = Option.getOrUndefined(decodeJoinError(answer.body))?.message;
    return yield* userError(
      `The Hub did not register the machine (HTTP ${answer.status})${refusal === undefined ? "." : `: ${refusal}`}`,
    );
  }
  return status.value;
});

const runJoin = (
  flags: CliAuthLocationFlags & {
    readonly url: string;
    readonly name: Option.Option<string>;
    readonly noBrowser: boolean;
    readonly force: boolean;
    readonly owner: Option.Option<string>;
    readonly confirmOnStdin: boolean;
  },
) =>
  runWithSecrets(flags, (config) =>
    Effect.gen(function* () {
      const hubUrl = yield* Effect.try({
        try: () => assertEnvironmentHubUrl(flags.url),
        catch: (cause) => userError(cause instanceof Error ? cause.message : String(cause)),
      });
      const joined = yield* readJoinedHubState(config.joinedHubPath).pipe(Effect.result);
      if (joined._tag === "Success" && Option.isSome(joined.success)) {
        return yield* userError(
          `This machine is already joined to ${joined.success.value.hubUrl}. Run \`t3 leave\` first.`,
        );
      }
      if (joined._tag === "Failure") {
        yield* Console.warn(`${config.joinedHubPath} is unreadable; joining replaces it.`);
      }
      const descriptor = decodeDescriptor(
        (yield* callHub(new URL("/.well-known/t3/environment", hubUrl), {})).body,
      );
      if (Option.isNone(descriptor)) {
        return yield* userError(`${hubUrl.origin} does not answer as a T3 Code Hub.`);
      }
      const hubId = descriptor.value.environmentId;
      if (hubId === (yield* readLocalEnvironmentId(config.environmentIdPath))) {
        return yield* userError("That address is this server itself; a Hub cannot join itself.");
      }
      const local = yield* localData(config);
      if ((local.users > 0 || local.threads > 0) && !flags.force) {
        return yield* userError(
          `This server has ${local.users} User(s) and ${local.threads} Thread(s) of its own. Once joined it serves no sign-in or web app, so they are cut off until \`t3 leave\`. Run again with --force to join anyway.`,
        );
      }

      const random = yield* SecureRandom.SecureRandom;
      const digest = yield* Digest.Digest;
      const sha256 = (value: string) =>
        digest
          .digest(Digest.sha256, new TextEncoder().encode(value))
          .pipe(Effect.map(base64UrlEncode));
      // Made here and kept here: the Hub only ever learns its hash.
      const credential = formatEnvironmentCredential(
        hubId,
        base64UrlEncode(yield* random.randomBytes(32)),
      );
      const codeVerifier = base64UrlEncode(yield* random.randomBytes(32));
      const state = base64UrlEncode(yield* random.randomBytes(16));
      const hostname = NodeOS.hostname() || "machine";
      const platform = yield* HostProcess.Platform;
      const listener = yield* listenForReturn(state);
      const started = yield* callHub(new URL("/api/environments/join/start", hubUrl), {
        body: {
          codeChallenge: yield* sha256(codeVerifier),
          codeChallengeMethod: "S256",
          credentialHash: yield* sha256(credential),
          name: Option.getOrElse(flags.name, () => hostname).slice(0, 64),
          os: platform,
          hostname,
          redirectUri: listener.redirectUri,
          state,
        } satisfies EnvironmentJoinStartRequest,
      });
      const request = decodeStarted(started.body);
      if (started.status !== 200 || Option.isNone(request)) {
        return yield* userError(`The Hub refused the join request (HTTP ${started.status}).`);
      }
      const page = environmentJoinPageUrl(hubUrl.toString(), request.value.requestId);
      yield* Console.log(
        `Approve this machine on the Hub with your account, from any device. Open:\n  ${page}\nWaiting for approval…`,
      );
      if (!flags.noBrowser) yield* openInBrowser(page, platform);

      const askHub = callHub(new URL("/api/environments/join/status", hubUrl), {
        body: { requestId: request.value.requestId, codeVerifier },
      }).pipe(
        Effect.map((answer) =>
          answer.status === 200 ? Option.getOrUndefined(decodeStatus(answer.body)) : undefined,
        ),
        // A dropped answer is asked for again; the Hub answers the same.
        Effect.orElseSucceed(() => undefined),
      );
      const waitForDecision = Effect.gen(function* () {
        while (true) {
          const status = yield* askHub;
          if (status !== undefined && status.status !== "pending") return status;
          // A browser on this machine returning means the decision is in: ask at once.
          yield* Effect.promise(() => listener.returned).pipe(
            Effect.timeoutOrElse({ duration: POLL_INTERVAL_MS, orElse: () => Effect.void }),
          );
        }
      });
      const approval = yield* waitForDecision.pipe(
        Effect.timeoutOption(APPROVAL_TIMEOUT_MS),
        Effect.map(Option.getOrElse((): EnvironmentJoinStatus => ({ status: "expired" }))),
      );
      const decision =
        approval.status === "awaiting-confirmation"
          ? yield* confirmApprover({
              hubUrl,
              requestId: request.value.requestId,
              codeVerifier,
              approval,
              owner: flags.owner,
              confirmOnStdin: flags.confirmOnStdin,
            })
          : approval;
      if (decision.status !== "approved") {
        return yield* userError(
          decision.status === "denied"
            ? "The registration was cancelled on the Hub."
            : "Nobody approved the machine in time. Run `t3 join` again.",
        );
      }
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      yield* secrets.set(ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode(credential));
      yield* writeJoinedHubState(config.joinedHubPath, {
        hubUrl: hubUrl.origin,
        hubEnvironmentId: decision.hubEnvironmentId,
        environmentId: decision.environmentId,
        name: decision.name,
        joinedAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* Console.log(
        `Joined ${hubUrl.origin} as ${decision.name}. Start (or restart) this machine's server with \`t3 serve\` to connect; \`t3 status\` shows the connection.`,
      );
    }).pipe(Effect.scoped),
  );

const runLeave = (flags: CliAuthLocationFlags) =>
  runWithSecrets(flags, (config) =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const forget = secrets
        .remove(ENVIRONMENT_CREDENTIAL_SECRET)
        .pipe(Effect.andThen(removeJoinedHubState(config.joinedHubPath)));
      const joined = yield* readJoinedHubState(config.joinedHubPath).pipe(Effect.result);
      if (joined._tag === "Failure") {
        yield* forget;
        return yield* Console.log(
          `${config.joinedHubPath} was unreadable; forgot it and this machine's credential. Remove the machine under Settings → Environments on the Hub if it is still listed.`,
        );
      }
      if (Option.isNone(joined.success)) {
        return yield* Console.log("This machine is not joined to a Hub.");
      }
      const hub = joined.success.value;
      const credential = yield* secrets
        .get(ENVIRONMENT_CREDENTIAL_SECRET)
        .pipe(Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))));
      const outcome = Option.isNone(credential)
        ? { status: 401 }
        : yield* callHub(new URL("/api/environments/leave", hub.hubUrl), {
            body: {},
            authorization: `Bearer ${credential.value}`,
          }).pipe(Effect.orElseSucceed(() => ({ status: 0 })));
      // Forgotten here either way: a credential the Hub no longer accepts is of no use.
      yield* forget;
      yield* Console.log(
        outcome.status === 200
          ? `Left ${hub.hubUrl}. Restart this machine's server to run it on its own again.`
          : `Forgot ${hub.hubUrl} here, but the Hub did not confirm (${outcome.status === 0 ? "unreachable" : `HTTP ${outcome.status}`}). Remove the machine under Settings → Environments on the Hub if it is still listed.`,
      );
    }),
  );

export const joinCommand = Command.make("join", {
  ...authLocationFlags,
  url: Argument.String("hub-url").pipe(
    Argument.withDescription("The Hub's address, https:// (http:// only for localhost)."),
  ),
  name: Flag.String("name").pipe(
    Flag.withDescription("The name the Hub shows. Default: this machine's hostname."),
    Flag.optional,
  ),
  noBrowser: Flag.Boolean("no-browser").pipe(
    Flag.withDescription("Print the approval link instead of opening a browser here."),
    Flag.withDefault(false),
  ),
  force: Flag.Boolean("force").pipe(
    Flag.withDescription(
      "Join even though this server has Users or Threads of its own, which joining cuts off.",
    ),
    Flag.withDefault(false),
  ),
  owner: Flag.String("owner").pipe(
    Flag.withDescription(
      "The sign-in name (or user id) of whoever will approve it. Without a terminal to ask, the machine is registered only when the approver is this User.",
    ),
    Flag.optional,
  ),
  confirmOnStdin: Flag.Boolean("confirm-on-stdin").pipe(
    Flag.withDescription(
      "Ask whether to accept the approver on standard input even without a terminal (used by the desktop app).",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Join this machine to a Hub as one of your Environments. You approve it in a browser, on any device, then confirm here who approved it.",
  ),
  Command.withHandler((flags) => runJoin(flags)),
);

export const leaveCommand = Command.make("leave", { ...authLocationFlags }).pipe(
  Command.withDescription("Remove this machine from its Hub and forget the Hub's credential."),
  Command.withHandler((flags) => runLeave(flags)),
);
