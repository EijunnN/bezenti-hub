// @effect-diagnostics nodeBuiltinImport:off globalTimersInEffect:off globalFetchInEffect:off
// `t3 join` listens on a loopback port for one approval, as the desktop app's sign-in does, and
// talks to a Hub this process has no HttpClient layer for.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  EnvironmentId,
  EnvironmentJoinTokenResult,
  type EnvironmentJoinTokenRequest,
} from "@t3tools/contracts";
import { appSignInLoopbackRedirectUri, readAppSignInCallback } from "@t3tools/shared/appSignIn";
import { base64UrlEncode } from "@t3tools/shared/base64Url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assertEnvironmentHubUrl, environmentJoinPageUrl } from "@t3tools/shared/environmentJoin";
import * as Console from "effect/Console";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

const APPROVAL_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 15_000;

const RETURN_PAGE =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>T3 Code</title><style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:360px;padding:32px}h1{font-size:24px}p{line-height:1.6;opacity:.7}</style></head><body><main><h1>Machine approved</h1><p>Return to your terminal; <code>t3 join</code> is finishing. You can close this tab.</p></main></body></html>';

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const userError = (message: string) => new CliError.UserError({ cause: message });

/** Waits for the Hub's page to send this one approval to a port on this machine. */
const receiveApproval = (state: string, open: (redirectUri: string) => Effect.Effect<void>) =>
  Effect.callback<{ readonly code: string; readonly redirectUri: string }, CliError.UserError>(
    (resume) => {
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
        resume(
          callback._tag === "code"
            ? Effect.succeed({ code: callback.code, redirectUri })
            : Effect.fail(userError("The registration was cancelled on the Hub.")),
        );
      });
      const timer = setTimeout(
        () =>
          resume(
            Effect.fail(
              userError("Nobody approved the machine in 5 minutes. Run `t3 join` again."),
            ),
          ),
        APPROVAL_TIMEOUT_MS,
      );
      server.once("error", (cause) => resume(Effect.fail(userError(String(cause)))));
      // Port 0: the system picks a free port for this approval only.
      server.listen(0, "127.0.0.1", () => {
        redirectUri = appSignInLoopbackRedirectUri((server.address() as NodeNet.AddressInfo).port);
        Effect.runFork(open(redirectUri));
      });
      return Effect.sync(() => {
        clearTimeout(timer);
        server.closeAllConnections();
        server.close();
      });
    },
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

const postJson = (url: URL, body: unknown, authorization?: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        body: encodeJson(body),
      });
      return {
        status: response.status,
        body: (await response.json().catch(() => null)) as unknown,
      };
    },
    catch: (cause) => userError(`Could not reach the Hub at ${url.origin}: ${String(cause)}`),
  });

const decodeTokenResult = Schema.decodeUnknownOption(EnvironmentJoinTokenResult);

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

const runJoin = (
  flags: CliAuthLocationFlags & {
    readonly url: string;
    readonly name: Option.Option<string>;
    readonly noBrowser: boolean;
  },
) =>
  runWithSecrets(flags, (config) =>
    Effect.gen(function* () {
      const hubUrl = yield* Effect.try({
        try: () => assertEnvironmentHubUrl(flags.url),
        catch: (cause) => userError(cause instanceof Error ? cause.message : String(cause)),
      });
      const joined = yield* readJoinedHubState(config.joinedHubPath).pipe(
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isSome(joined)) {
        return yield* userError(
          `This machine is already joined to ${joined.value.hubUrl}. Run \`t3 leave\` first.`,
        );
      }
      const random = yield* SecureRandom.SecureRandom;
      const digest = yield* Digest.Digest;
      const codeVerifier = base64UrlEncode(yield* random.randomBytes(32));
      const state = base64UrlEncode(yield* random.randomBytes(16));
      const codeChallenge = base64UrlEncode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(codeVerifier)),
      );
      const hostname = NodeOS.hostname() || "machine";
      const platform = yield* HostProcess.Platform;
      const requestedAt = DateTime.formatIso(yield* DateTime.now);
      const approval = yield* receiveApproval(state, (redirectUri) => {
        const page = environmentJoinPageUrl(hubUrl.toString(), {
          redirectUri,
          codeChallenge,
          state,
          name: Option.getOrElse(flags.name, () => hostname).slice(0, 64),
          os: platform,
          hostname,
          requestedAt,
        });
        return Console.log(
          `Approve this machine on the Hub as its Owner. Open:\n  ${page}\nWaiting for approval…`,
        ).pipe(Effect.andThen(flags.noBrowser ? Effect.void : openInBrowser(page, platform)));
      });
      const redeemed = yield* postJson(new URL("/api/environments/join/token", hubUrl), {
        code: approval.code,
        codeVerifier,
        redirectUri: approval.redirectUri,
      } satisfies EnvironmentJoinTokenRequest);
      const result = decodeTokenResult(redeemed.body);
      if (redeemed.status !== 200 || Option.isNone(result)) {
        return yield* userError(
          `The Hub refused the registration (HTTP ${redeemed.status}). Run \`t3 join\` again.`,
        );
      }
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      yield* secrets.set(
        ENVIRONMENT_CREDENTIAL_SECRET,
        new TextEncoder().encode(result.value.credential),
      );
      yield* writeJoinedHubState(config.joinedHubPath, {
        hubUrl: hubUrl.origin,
        hubEnvironmentId: EnvironmentId.make(result.value.hubEnvironmentId),
        environmentId: result.value.environmentId,
        name: result.value.name,
        joinedAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* Console.log(
        `Joined ${hubUrl.origin} as ${result.value.name}. Start (or restart) this machine's server with \`t3 serve\` to connect; \`t3 status\` shows the connection.`,
      );
    }),
  );

const runLeave = (flags: CliAuthLocationFlags) =>
  runWithSecrets(flags, (config) =>
    Effect.gen(function* () {
      const joined = yield* readJoinedHubState(config.joinedHubPath).pipe(
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isNone(joined)) {
        return yield* Console.log("This machine is not joined to a Hub.");
      }
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const credential = yield* secrets
        .get(ENVIRONMENT_CREDENTIAL_SECRET)
        .pipe(Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))));
      const outcome = Option.isNone(credential)
        ? { status: 401 }
        : yield* postJson(
            new URL("/api/environments/leave", joined.value.hubUrl),
            {},
            `Bearer ${credential.value}`,
          ).pipe(Effect.orElseSucceed(() => ({ status: 0 })));
      // Forgotten here either way: a credential the Hub no longer accepts is of no use.
      yield* secrets.remove(ENVIRONMENT_CREDENTIAL_SECRET);
      yield* removeJoinedHubState(config.joinedHubPath);
      yield* Console.log(
        outcome.status === 200
          ? `Left ${joined.value.hubUrl}. Restart this machine's server to run it on its own again.`
          : `Forgot ${joined.value.hubUrl} here, but the Hub did not confirm (${outcome.status === 0 ? "unreachable" : `HTTP ${outcome.status}`}). Remove the machine under Settings → Environments on the Hub if it is still listed.`,
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
    Flag.withDescription("Print the approval link instead of opening a browser."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Join this machine to a Hub as one of your Environments. The Hub's Owner approves it in the browser.",
  ),
  Command.withHandler((flags) => runJoin(flags)),
);

export const leaveCommand = Command.make("leave", { ...authLocationFlags }).pipe(
  Command.withDescription("Remove this machine from its Hub and forget the Hub's credential."),
  Command.withHandler((flags) => runLeave(flags)),
);
