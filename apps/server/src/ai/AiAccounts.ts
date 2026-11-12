/**
 * AI accounts of API key (spec 4 ticket 02): rows in the database, credentials sealed in
 * `AiAccountCredentialStore` and never returned; the Owner manages (`aiAccount.manage`), others
 * list what AllowedAiAccounts allows. CLIProxyAPI gets them by its Management API, `acct-<id>`.
 */
import {
  type AiAccountAllowInput,
  type AiAccountCreateInput,
  type AiAccountDeleteInput,
  type AiAccountDeleteResult,
  AiAccountError,
  type AiAccountErrorReason,
  type AiAccountId,
  type AiAccountListResult,
  type AiAccountProvider,
  type AiAccountReorderInput,
  type AiAccountStatus,
  type AiAccountSummary,
  type AiAccountType,
  type AiAccountUpdateInput,
  type AiGatewayState,
  AI_CREDENTIAL_MAX_LENGTH,
  aiAccountPrefixOf,
  type AiApiKeyProvider,
  type SpaceId,
  type UserId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { AiGateway } from "./AiGateway.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";
import {
  type CliproxyEndpoint,
  CliproxyManagementError,
  makeCliproxyManagement,
} from "./CliproxyManagement.ts";
import { type CliproxyApiKeyAccount, renderCliproxyApiKeys } from "./cliproxyConfig.ts";

export class AiAccounts extends Context.Service<
  AiAccounts,
  {
    /** The Owner: every account and its details. Anyone else: what they may use, and where. */
    readonly list: Effect.Effect<AiAccountListResult, AiAccountError>;
    readonly create: (
      input: AiAccountCreateInput,
    ) => Effect.Effect<AiAccountSummary, AiAccountError>;
    readonly update: (
      input: AiAccountUpdateInput,
    ) => Effect.Effect<AiAccountSummary, AiAccountError>;
    readonly remove: (
      input: AiAccountDeleteInput,
    ) => Effect.Effect<AiAccountDeleteResult, AiAccountError>;
    readonly allow: (input: AiAccountAllowInput) => Effect.Effect<AiAccountSummary, AiAccountError>;
    readonly reorder: (
      input: AiAccountReorderInput,
    ) => Effect.Effect<AiAccountListResult, AiAccountError>;
    /**
     * The models an account serves through the gateway (its prefix's `/v1/models`, without the
     * prefix), cached a few minutes; empty while the gateway is not running.
     */
    readonly modelsOf: (
      accountId: AiAccountId,
    ) => Effect.Effect<ReadonlyArray<string>, AiAccountError>;
    /** Writes every enabled account into the running CLIProxyAPI now (the Hub does it itself). */
    readonly sync: Effect.Effect<void>;
  }
>()("t3/ai/AiAccounts") {}

const isAiAccountError = Schema.is(AiAccountError);

const fail = (reason: AiAccountErrorReason, message: string) =>
  Effect.fail(new AiAccountError({ reason, message }));

const NOT_FOUND = "That AI account does not exist.";
const OWNER_ONLY = "Only the Owner manages AI accounts.";
/** How long a gateway's model list stands for the picker and the gateway. */
const CATALOG_TTL_MS = 5 * 60_000;
/** After a write, how long the Hub waits for CLIProxyAPI's model list to show the accounts. */
const MODEL_LIST_ATTEMPTS = 20;
const MODEL_LIST_PAUSE = Duration.millis(250);
/** One change and its check, from reading the accounts to their status, within this. */
const PROVISION_DEADLINE = Duration.seconds(30);
/** After a change the gateway refused or missed, the Hub tries again, waiting longer each time. */
const RETRY_FIRST_MS = 10_000;
const RETRY_MAX_MS = 5 * 60_000;
const RETRY_TICK = Duration.seconds(1);
/** Gateway states with no CLIProxyAPI process: whatever it held is gone with it. */
const GONE_STATES: ReadonlySet<AiGatewayState> = new Set([
  "off",
  "unsupported",
  "restarting",
  "failed",
]);

interface AccountRow {
  readonly accountId: string;
  readonly name: string;
  readonly type: AiAccountType;
  readonly provider: AiAccountProvider;
  readonly priority: number;
  readonly status: AiAccountStatus;
  readonly statusMessage: string | null;
  readonly disabled: number;
  readonly credentialId: string | null;
  readonly keyHint: string | null;
  readonly baseUrl: string | null;
  readonly modelsJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

interface AllowanceRow {
  readonly accountId: string;
  readonly subjectKind: "space" | "user";
  readonly subjectId: string;
}

const ACCOUNT_COLUMNS = `
  account_id AS "accountId", name AS "name", type AS "type", provider AS "provider",
  priority AS "priority", status AS "status", status_message AS "statusMessage",
  disabled AS "disabled", credential_id AS "credentialId", key_hint AS "keyHint",
  base_url AS "baseUrl", models_json AS "modelsJson", created_at AS "createdAt",
  updated_at AS "updatedAt", deleted_at AS "deletedAt"
`;

const encodeModels = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const modelsOfRow = (row: AccountRow): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(row.modelsJson);
    return Array.isArray(parsed)
      ? parsed.filter((model): model is string => typeof model === "string")
      : [];
  } catch {
    return [];
  }
};

/**
 * Text without spaces or control characters, not empty, at most AI_CREDENTIAL_MAX_LENGTH. Says
 * why, never what.
 */
const credentialProblem = (value: string): string | undefined => {
  if (value.length === 0) return "An API key is needed.";
  if (value.length > AI_CREDENTIAL_MAX_LENGTH) {
    return `An API key is at most ${AI_CREDENTIAL_MAX_LENGTH / 1024} KiB.`;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
  if (/[\s\u0000-\u001f\u007f]/u.test(value)) {
    return "An API key has no spaces, line breaks or control characters.";
  }
  // Zero-width and other invisible format characters (U+200B, U+FEFF…), often pasted along.
  if (/\p{Cf}/u.test(value)) {
    return "This API key has an invisible character in it, often copied along with it: type or paste it again.";
  }
  return undefined;
};

/** The last four characters, only of a key long enough that they give nothing away. */
const hintOf = (key: string) => (key.length >= 16 ? key.slice(-4) : null);

/** An `openai-compatible` base URL: http(s), no credentials, query or fragment in it. */
const baseUrlProblem = (value: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "The base URL is not a URL.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "The base URL starts with https:// or http://.";
  }
  if (url.username !== "" || url.password !== "") {
    return "The base URL carries no credentials: put the key in «API key».";
  }
  if (url.search !== "" || url.hash !== "") {
    return "The base URL has no query or fragment.";
  }
  return undefined;
};

/** Why CLIProxyAPI cannot take an account as it is stored; checked before anything is sent. */
const accountProblem = (row: AccountRow): string | undefined => {
  if (row.type !== "api-key") return "Not an API key account.";
  if (row.provider === "openai-compatible") {
    if (row.baseUrl === null) return "It needs a base URL.";
    const problem = baseUrlProblem(row.baseUrl);
    if (problem !== undefined) return problem;
    if (modelsOfRow(row).length === 0) return "It needs at least one model.";
    return undefined;
  }
  return row.baseUrl === null ? undefined : "Only an OpenAI-compatible account takes a base URL.";
};

/** What CLIProxyAPI holds of an account: a change of any part is a new entry for it. */
const fingerprintOf = (row: AccountRow) =>
  [row.credentialId, row.provider, row.baseUrl ?? "", row.modelsJson].join("|");

/** An enabled account as it goes to CLIProxyAPI. */
interface Desired {
  readonly row: AccountRow;
  readonly fingerprint: string;
  readonly account: CliproxyApiKeyAccount;
}

interface ViewContext {
  readonly running: boolean;
  /** Accounts whose old key the gateway may still hold. */
  readonly stillLive: ReadonlySet<string>;
}

const statusOf = (
  row: AccountRow,
  context: ViewContext,
): Pick<AiAccountSummary, "status" | "statusMessage"> => {
  if (row.deletedAt !== null) {
    return {
      status: "removing",
      statusMessage:
        "Deleted, but its key is still live in the AI gateway, which has not taken the change yet. The Hub keeps trying.",
    };
  }
  if (row.disabled === 1) return { status: "disabled", statusMessage: "Disabled by the Owner." };
  if (!context.running) {
    return { status: "pending", statusMessage: "The AI gateway is not running." };
  }
  if (context.stillLive.has(row.accountId)) {
    return {
      status: row.status,
      statusMessage:
        "Its old key is still live in the AI gateway, which has not taken the new one yet. The Hub keeps trying.",
    };
  }
  return { status: row.status, statusMessage: row.statusMessage };
};

/**
 * One account as a User sees it: the Owner with every detail but the credential (and only the
 * allowances to Spaces and Users that still exist), anyone else with where they may use it.
 */
const summaryOf = (
  row: AccountRow,
  context: ViewContext,
  view:
    | { readonly _tag: "owner"; readonly allowances: ReadonlyArray<AllowanceRow> }
    | { readonly _tag: "user"; readonly usableIn: ReadonlyArray<SpaceId> },
): AiAccountSummary => {
  const mine =
    view._tag === "owner"
      ? view.allowances.filter((allowance) => allowance.accountId === row.accountId)
      : [];
  return {
    id: row.accountId as AiAccountId,
    name: row.name,
    type: row.type,
    provider: row.provider,
    priority: row.priority,
    ...statusOf(row, context),
    disabled: row.disabled === 1,
    usableIn: view._tag === "user" ? view.usableIn : [],
    details:
      view._tag === "user"
        ? null
        : {
            keyHint: row.keyHint,
            baseUrl: row.baseUrl,
            models: modelsOfRow(row),
            allowances: {
              spaceIds: mine
                .filter((allowance) => allowance.subjectKind === "space")
                .map((allowance) => allowance.subjectId as SpaceId),
              userIds: mine
                .filter((allowance) => allowance.subjectKind === "user")
                .map((allowance) => allowance.subjectId as UserId),
            },
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          },
  };
};

const UNAVAILABLE = new AiAccountError({
  reason: "unavailable",
  message: "AI accounts live on the Hub; this machine keeps none.",
});
const refuse = Effect.fn("AiAccounts.unavailable")(function* (_input: unknown) {
  return yield* UNAVAILABLE;
});

/** A joined machine: no AI accounts, nothing written. */
const unavailable = AiAccounts.of({
  list: Effect.fail(UNAVAILABLE),
  create: refuse,
  update: refuse,
  remove: refuse,
  allow: refuse,
  reorder: refuse,
  modelsOf: refuse,
  sync: Effect.void,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const audit = yield* AuditLog.AuditLog;
  const credentials = yield* ServerSecretStore.AiAccountCredentialStore;
  const random = yield* SecureRandom.SecureRandom;
  const gateway = yield* AiGateway;
  const allowed = yield* AllowedAiAccounts.AllowedAiAccounts;
  const management = yield* makeCliproxyManagement;

  /** Logs what failed (never a credential: none reaches these causes) and answers generically. */
  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`AiAccounts: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );
  const orStorage = (what: string) => (error: unknown) =>
    isAiAccountError(error) ? Effect.fail(error) : storage(what)(error);

  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const newId = (bytes: number) =>
    random.randomBytes(bytes).pipe(Effect.map((value) => Buffer.from(value).toString("hex")));

  const actor = spaces.actingUser.pipe(
    Effect.catchTags({
      SpaceAccessDeniedError: () => fail("forbidden", "Sign in to see AI accounts."),
      SpaceDirectoryStorageError: storage("read who you are"),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () => fail("forbidden", "Sign in to see AI accounts."),
        onSome: Effect.succeed,
      }),
    ),
  );

  /** The acting User and what they may do, decided once per request (spaceLimit included). */
  const caller = Effect.gen(function* () {
    const userId = yield* actor;
    const can = yield* spaces
      .authorizer(userId)
      .pipe(Effect.catch(storage("check what you may do")));
    return { userId, manages: can("aiAccount.manage", AccessPolicy.installation), can };
  });

  /** The Owner, acting on the Installation (never a session limited to one Space). */
  const manager = Effect.gen(function* () {
    const { userId, manages } = yield* caller;
    if (!manages) return yield* fail("forbidden", OWNER_ONLY);
    return userId;
  });

  /** One config change at a time: each reads the accounts afresh, so the last one is the latest. */
  const syncLock = yield* Semaphore.make(1);
  const layerScope = yield* Scope.Scope;
  /**
   * What the running CLIProxyAPI holds, as its last accepted change left it (each replaces the
   * whole `api-keys` section): account → credential and fingerprint. A fresh start holds nothing.
   * Forgotten when the process is gone.
   */
  let live:
    | {
        readonly baseUrl: string;
        readonly entries: ReadonlyMap<string, { credentialId: string; fingerprint: string }>;
      }
    | undefined;
  /** Accounts CLIProxyAPI refused, by gateway and fingerprint: not sent again unchanged. */
  const refusedBefore = new Map<string, string>();
  /** What the last attempt sent (for its status if it fails). */
  let attempted: ReadonlyArray<{ readonly id: string; readonly credentialId: string }> = [];
  let dirty = false;
  let retryDelayMs = RETRY_FIRST_MS;
  let nextRetryAt = 0;
  let catalog:
    | { readonly baseUrl: string; readonly at: number; readonly ids: ReadonlyArray<string> }
    | undefined;

  const enabledAccounts = sql<AccountRow>`
    SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM ai_accounts
    WHERE disabled = 0 AND deleted_at IS NULL AND type = 'api-key' AND credential_id IS NOT NULL
    ORDER BY priority, account_id
  `;

  /** Only while the row still holds that credential, enabled and not deleted (no raced write). */
  const setStatus = (
    accountId: string,
    credentialId: string,
    status: AiAccountStatus,
    message: string | null,
  ) =>
    sql`
      UPDATE ai_accounts SET status = ${status}, status_message = ${message}
      WHERE account_id = ${accountId} AND credential_id = ${credentialId}
        AND disabled = 0 AND deleted_at IS NULL
    `.pipe(Effect.ignore({ log: true }));

  /**
   * Retired keys (replaced, or of a deleted account) the gateway no longer holds: out of the
   * store, and a deleted account's row with its last one.
   */
  const cleanupRetired = Effect.fn("AiAccounts.cleanupRetired")(function* (
    liveCredentials: ReadonlySet<string>,
  ) {
    const retired = yield* sql<{ readonly credentialId: string }>`
      SELECT credential_id AS "credentialId" FROM ai_account_retired_credentials
    `;
    for (const { credentialId } of retired) {
      if (liveCredentials.has(credentialId)) continue;
      yield* credentials.remove(credentialId);
      yield* sql`DELETE FROM ai_account_retired_credentials WHERE credential_id = ${credentialId}`;
    }
    yield* sql`
      DELETE FROM ai_accounts WHERE deleted_at IS NOT NULL
        AND account_id NOT IN (SELECT account_id FROM ai_account_retired_credentials)
    `;
    const left = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM ai_account_retired_credentials
    `;
    return (left[0]?.n ?? 0) > 0;
  });

  const unreadable = () =>
    new CliproxyManagementError({
      message: "Could not read the AI accounts on the Hub; the AI gateway keeps what it has.",
    });

  /**
   * Under the lock: the enabled accounts that pass their own checks, with their keys from the
   * store, into `endpoint`. If CLIProxyAPI refuses them together, what it held before and then
   * each other account alone, first to last: only the one it refuses stays out, with its reason.
   * A key the store cannot read aborts it all and leaves the gateway as it is.
   */
  const commit = Effect.fn("AiAccounts.commit")(function* (endpoint: CliproxyEndpoint) {
    const rows = yield* enabledAccounts.pipe(Effect.mapError(unreadable));
    const desired: Array<Desired> = [];
    const bad: Array<{ readonly row: AccountRow; readonly reason: string }> = [];
    for (const row of rows) {
      const problem = accountProblem(row);
      if (problem !== undefined) {
        bad.push({ row, reason: problem });
        continue;
      }
      const stored = yield* credentials
        .get(row.credentialId ?? "")
        .pipe(Effect.mapError(unreadable));
      if (Option.isNone(stored)) {
        bad.push({ row, reason: "Its key is missing from the Hub's store: replace it." });
        continue;
      }
      desired.push({
        row,
        fingerprint: fingerprintOf(row),
        account: {
          id: row.accountId,
          provider: row.provider as AiApiKeyProvider,
          apiKey: new TextDecoder().decode(stored.value),
          baseUrl: row.baseUrl,
          models: modelsOfRow(row),
        },
      });
    }
    const secrets = desired.map((entry) => entry.account.apiKey);
    const refusalKey = (entry: Desired) => `${endpoint.baseUrl}|${entry.fingerprint}`;
    const sendable = desired.filter((entry) => {
      const reason = refusedBefore.get(refusalKey(entry));
      if (reason !== undefined) bad.push({ row: entry.row, reason });
      return reason === undefined;
    });
    // Every account this change tries to send, for its status if it all fails.
    attempted = sendable.map((entry) => ({
      id: entry.row.accountId,
      credentialId: entry.row.credentialId ?? "",
    }));
    const attempt = (set: ReadonlyArray<Desired>) =>
      management.setApiKeys(
        endpoint,
        renderCliproxyApiKeys(set.map((entry) => entry.account)),
        secrets,
      );
    let accepted: Array<Desired> = sendable;
    const together = yield* attempt(sendable);
    if (together._tag === "refused") {
      const before = live?.baseUrl === endpoint.baseUrl ? live.entries : new Map();
      let base = sendable.filter(
        (entry) => before.get(entry.row.accountId)?.fingerprint === entry.fingerprint,
      );
      if ((yield* attempt(base))._tag === "refused") {
        base = [];
        const empty = yield* attempt([]);
        if (empty._tag === "refused") {
          return yield* new CliproxyManagementError({
            message: `CLIProxyAPI refused even no AI accounts (HTTP ${empty.status}${empty.reason === "" ? "" : `: ${empty.reason}`}).`,
          });
        }
      }
      accepted = [...base];
      for (const entry of sendable) {
        if (accepted.includes(entry)) continue;
        const next = sendable.filter((other) => other === entry || accepted.includes(other));
        const answer = yield* attempt(next);
        if (answer._tag === "accepted") {
          accepted = next;
        } else {
          const reason = `The AI gateway refused it${answer.reason === "" ? "" : `: ${answer.reason}`}.`;
          refusedBefore.set(refusalKey(entry), reason);
          bad.push({ row: entry.row, reason });
        }
      }
      // The last change sent may be a refused one: send what stands, so it is what runs.
      if ((yield* attempt(accepted))._tag === "refused") {
        return yield* new CliproxyManagementError({
          message: "CLIProxyAPI refused AI accounts it had just taken.",
        });
      }
    }
    live = {
      baseUrl: endpoint.baseUrl,
      entries: new Map(
        accepted.map((entry) => [
          entry.row.accountId,
          { credentialId: entry.row.credentialId ?? "", fingerprint: entry.fingerprint },
        ]),
      ),
    };
    attempted = [];
    catalog = undefined;
    for (const { row, reason } of bad) {
      yield* setStatus(row.accountId, row.credentialId ?? "", "error", reason);
    }
    const retiredLeft = yield* cleanupRetired(
      new Set([...live.entries.values()].map((entry) => entry.credentialId)),
    ).pipe(Effect.mapError(unreadable));
    dirty = retiredLeft;
    retryDelayMs = RETRY_FIRST_MS;
    return accepted;
  });

  /**
   * Outside the lock: CLIProxyAPI applies a change by reloading its config, so its model list
   * catches up shortly. Each account sent is `working` once listed, `unverified` if the list
   * cannot be read, `error` if it never shows.
   */
  const verify = Effect.fn("AiAccounts.verify")(function* (
    endpoint: CliproxyEndpoint,
    accepted: ReadonlyArray<Desired>,
  ) {
    const expected = accepted.map((entry) => `${aiAccountPrefixOf(entry.row.accountId)}/`);
    let ids = yield* management.modelIds(endpoint).pipe(Effect.option);
    for (let round = 0; round < MODEL_LIST_ATTEMPTS; round += 1) {
      const listed = ids;
      if (
        Option.isSome(listed) &&
        expected.every((prefix) => listed.value.some((id) => id.startsWith(prefix)))
      ) {
        break;
      }
      yield* Effect.sleep(MODEL_LIST_PAUSE);
      ids = yield* management.modelIds(endpoint).pipe(Effect.option);
    }
    if (Option.isSome(ids)) {
      catalog = { baseUrl: endpoint.baseUrl, at: yield* Clock.currentTimeMillis, ids: ids.value };
    }
    for (const entry of accepted) {
      const prefix = `${aiAccountPrefixOf(entry.row.accountId)}/`;
      const credentialId = entry.row.credentialId ?? "";
      if (Option.isNone(ids)) {
        yield* setStatus(
          entry.row.accountId,
          credentialId,
          "unverified",
          "In the AI gateway, but its model list could not be read.",
        );
      } else if (ids.value.some((id) => id.startsWith(prefix))) {
        yield* setStatus(entry.row.accountId, credentialId, "working", null);
      } else {
        yield* setStatus(
          entry.row.accountId,
          credentialId,
          "error",
          "The AI gateway lists no models for this account.",
        );
      }
    }
  });

  /** A change, then its check, within one deadline. */
  const provision = Effect.fn("AiAccounts.provision")(function* (endpoint: CliproxyEndpoint) {
    const done = yield* Effect.gen(function* () {
      const accepted = yield* syncLock.withPermits(1)(commit(endpoint));
      yield* verify(endpoint, accepted);
    }).pipe(Effect.timeoutOption(PROVISION_DEADLINE));
    if (Option.isNone(done)) {
      return yield* new CliproxyManagementError({
        message: `The AI gateway did not take the AI accounts within ${Duration.toSeconds(PROVISION_DEADLINE)} s.`,
      });
    }
  });

  /**
   * The gateway did not take them: the accounts it was sent and does not hold are `error`, and
   * the Hub tries again, waiting longer each time (up to RETRY_MAX_MS). The gateway keeps running.
   */
  const failed = Effect.fn("AiAccounts.failed")(function* (error: CliproxyManagementError) {
    dirty = true;
    nextRetryAt = (yield* Clock.currentTimeMillis) + retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
    yield* Effect.logWarning("AiAccounts: the AI gateway did not take the AI accounts", {
      reason: error.message,
    });
    const sent = attempted;
    attempted = [];
    for (const { id, credentialId } of sent) {
      if (live?.entries.get(id)?.credentialId === credentialId) continue;
      yield* setStatus(id, credentialId, "error", `Not in the AI gateway yet: ${error.message}`);
    }
  });

  /**
   * After a change to what the gateway holds: into the running gateway now. With none running,
   * no key is live anywhere, so retired ones go at once (`not-running`).
   */
  const syncNow = Effect.gen(function* () {
    const endpoint = yield* gateway.endpoint;
    if (Option.isNone(endpoint)) {
      yield* syncLock.withPermits(1)(
        Effect.suspend(() =>
          live === undefined
            ? cleanupRetired(new Set()).pipe(
                Effect.tap((left) => Effect.sync(() => (dirty = left))),
                Effect.ignore({ log: true }),
              )
            : Effect.sync(() => (dirty = true)),
        ),
      );
      return "not-running" as const;
    }
    return yield* provision(endpoint.value).pipe(
      Effect.as("applied" as const),
      Effect.catch((error) => failed(error).pipe(Effect.as("failed" as const))),
    );
  }).pipe(Effect.withSpan("AiAccounts.sync"));

  // Every start (a crash and its restart, an update, a roll back) gets the accounts before it
  // counts as running, its check forked; a start that raced this registration is caught below.
  yield* gateway.setProvisioner((endpoint) =>
    syncLock
      .withPermits(1)(commit(endpoint))
      .pipe(
        Effect.timeoutOption(PROVISION_DEADLINE),
        Effect.flatMap(
          Option.match({
            onNone: () => failed(new CliproxyManagementError({ message: "It took too long." })),
            onSome: (accepted) => verify(endpoint, accepted).pipe(Effect.forkIn(layerScope)),
          }),
        ),
        Effect.catch(failed),
        Effect.asVoid,
      ),
  );
  yield* gateway.changes.pipe(
    Stream.runForEach((status) =>
      Effect.gen(function* () {
        if (GONE_STATES.has(status.state)) {
          // Its process is gone, and what it held with it.
          live = undefined;
          yield* syncNow;
          return;
        }
        if (status.state !== "running") return;
        const endpoint = yield* gateway.endpoint;
        if (Option.isSome(endpoint) && endpoint.value.baseUrl !== live?.baseUrl) yield* syncNow;
      }),
    ),
    Effect.forkScoped,
  );
  yield* Effect.gen(function* () {
    yield* Effect.sleep(RETRY_TICK);
    if (dirty && (yield* Clock.currentTimeMillis) >= nextRetryAt) yield* syncNow;
  }).pipe(Effect.forever, Effect.forkScoped);

  const catalogIds = Effect.gen(function* () {
    const endpoint = yield* gateway.endpoint;
    if (Option.isNone(endpoint)) return [] as ReadonlyArray<string>;
    const cached = catalog;
    const at = yield* Clock.currentTimeMillis;
    if (
      cached !== undefined &&
      cached.baseUrl === endpoint.value.baseUrl &&
      at - cached.at < CATALOG_TTL_MS
    ) {
      return cached.ids;
    }
    const ids = yield* management
      .modelIds(endpoint.value)
      .pipe(Effect.catch(() => fail("unavailable", "The AI gateway did not list its models.")));
    catalog = { baseUrl: endpoint.value.baseUrl, at, ids };
    return ids;
  });

  const findRow = Effect.fn("AiAccounts.findRow")(function* (accountId: string) {
    const rows = yield* sql<AccountRow>`
      SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM ai_accounts WHERE account_id = ${accountId}
    `.pipe(Effect.catch(storage("read the AI account")));
    const row = rows[0];
    if (row === undefined) return yield* fail("not-found", NOT_FOUND);
    return row;
  });

  /** An account that is not being deleted. */
  const findAccount = Effect.fn("AiAccounts.findAccount")(function* (accountId: string) {
    const row = yield* findRow(accountId);
    if (row.deletedAt !== null) return yield* fail("not-found", NOT_FOUND);
    return row;
  });

  const allowancesOf = (accountIds: ReadonlyArray<string>) =>
    accountIds.length === 0
      ? Effect.succeed([] as ReadonlyArray<AllowanceRow>)
      : sql<AllowanceRow>`
          SELECT account_id AS "accountId", subject_kind AS "subjectKind", subject_id AS "subjectId"
          FROM ai_account_allowances WHERE ${sql.in("account_id", accountIds)}
          ORDER BY subject_kind, subject_id
        `.pipe(Effect.catch(storage("read who may use the AI accounts")));

  /** Accounts whose old key the gateway may still hold (replaced or deleted, not yet dropped). */
  const stillLive = sql<{ readonly accountId: string }>`
    SELECT DISTINCT account_id AS "accountId" FROM ai_account_retired_credentials
  `.pipe(
    Effect.map((rows) => new Set(rows.map((row) => row.accountId))),
    Effect.catch(storage("read the AI accounts")),
  );

  /** What the summaries need to know of the gateway now. */
  const viewContext = Effect.gen(function* () {
    return {
      running: Option.isSome(yield* gateway.endpoint),
      stillLive: yield* stillLive,
    } satisfies ViewContext;
  });

  /**
   * The Owner's existing Spaces and Users, in one read each: an allowance to a deleted Space or a
   * removed User is not shown and is dropped by the next `allow`.
   */
  const existingSubjects = Effect.fn("AiAccounts.existingSubjects")(function* (
    ownerId: UserId,
    spaceIds: ReadonlyArray<SpaceId>,
  ) {
    const known = yield* spaces.spacesById(spaceIds).pipe(Effect.catch(storage("read the Spaces")));
    const users = yield* spaces.listUsers(ownerId).pipe(Effect.catch(storage("read the Users")));
    return {
      spaces: new Set<string>(known.keys()),
      users: new Set<string>(
        users.filter((user) => user.status !== "removed").map((user) => user.id),
      ),
    };
  });

  const ownerAccounts = Effect.fn("AiAccounts.ownerAccounts")(function* (
    ownerId: UserId,
    only?: string,
  ) {
    const rows =
      only === undefined
        ? yield* sql<AccountRow>`
          SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM ai_accounts ORDER BY priority, account_id
        `.pipe(Effect.catch(storage("read the AI accounts")))
        : [yield* findRow(only)];
    const allowances = yield* allowancesOf(rows.map((row) => row.accountId));
    const existing = yield* existingSubjects(
      ownerId,
      allowances.flatMap((allowance) =>
        allowance.subjectKind === "space" ? [allowance.subjectId as SpaceId] : [],
      ),
    );
    const shown = allowances.filter((allowance) =>
      allowance.subjectKind === "space"
        ? existing.spaces.has(allowance.subjectId)
        : existing.users.has(allowance.subjectId),
    );
    const context = yield* viewContext;
    return rows.map((row) => summaryOf(row, context, { _tag: "owner", allowances: shown }));
  });

  const ownerSummaryOf = Effect.fn("AiAccounts.ownerSummaryOf")(function* (
    ownerId: UserId,
    accountId: string,
  ) {
    const [summary] = yield* ownerAccounts(ownerId, accountId);
    if (summary === undefined) return yield* fail("not-found", NOT_FOUND);
    return summary;
  });

  /**
   * Anyone else: the accounts AllowedAiAccounts lets them use in the Spaces they may act in now
   * (a session limited to one Space: that one), with where; name, provider and status only.
   */
  const usableList = Effect.fn("AiAccounts.usableList")(function* (
    userId: UserId,
    can: (action: AccessPolicy.Action, resource: AccessPolicy.Resource) => boolean,
  ) {
    const limit = yield* CommandActor.spaceLimit;
    const viewable = yield* spaces
      .viewableSpaces(userId)
      .pipe(Effect.catch(storage("read your Spaces")));
    const candidates = limit !== undefined ? [limit] : viewable === "all" ? [] : [...viewable];
    const known = yield* spaces
      .spacesById(candidates)
      .pipe(Effect.catch(storage("read your Spaces")));
    const working = candidates.filter((spaceId) => {
      const space = known.get(spaceId);
      return space !== undefined && can("aiAccount.use", space.resource);
    });
    const bySpace = yield* allowed
      .forSpaces(userId, working)
      .pipe(Effect.catch(storage("read the AI accounts you may use")));
    const usableIn = new Map<string, Array<SpaceId>>();
    for (const [spaceId, accounts] of bySpace) {
      for (const account of accounts) {
        const where = usableIn.get(account.id) ?? [];
        where.push(spaceId);
        usableIn.set(account.id, where);
      }
    }
    if (usableIn.size === 0) return [] as ReadonlyArray<AiAccountSummary>;
    const rows = yield* sql<AccountRow>`
      SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM ai_accounts
      WHERE ${sql.in("account_id", [...usableIn.keys()])} AND deleted_at IS NULL
      ORDER BY priority, account_id
    `.pipe(Effect.catch(storage("read the AI accounts")));
    const context = yield* viewContext;
    return rows.map((row) =>
      summaryOf(row, context, { _tag: "user", usableIn: usableIn.get(row.accountId) ?? [] }),
    );
  });

  const list = Effect.gen(function* () {
    const { userId, manages, can } = yield* caller;
    const accounts = manages ? yield* ownerAccounts(userId) : yield* usableList(userId, can);
    return { accounts, canManage: manages } satisfies AiAccountListResult;
  }).pipe(Effect.withSpan("AiAccounts.list"));

  const nameTaken = Effect.fn("AiAccounts.nameTaken")(function* (name: string, except?: string) {
    const rows = yield* sql<{ readonly accountId: string }>`
      SELECT account_id AS "accountId" FROM ai_accounts WHERE name = ${name} COLLATE NOCASE
    `.pipe(Effect.catch(storage("read the AI accounts")));
    if (rows.some((row) => row.accountId !== except)) {
      return yield* fail("duplicate-name", `There is already an AI account named ${name}.`);
    }
  });

  /** A new credential under a new id: no row points at it until its transaction commits. */
  const writeCredential = Effect.fn("AiAccounts.writeCredential")(function* (key: string) {
    const credentialId = `cred-${yield* newId(16)}`;
    yield* credentials
      .set(credentialId, new TextEncoder().encode(key))
      .pipe(Effect.catch(storage("store the API key")));
    return credentialId;
  });

  /** Removes a credential no row holds; one left behind by a failure is swept at the next start. */
  const removeCredential = Effect.fn("AiAccounts.removeCredential")(function* (
    credentialId: string | null,
  ) {
    if (credentialId === null) return;
    yield* credentials.remove(credentialId).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("AiAccounts: could not remove a credential; the next start removes it", {
          credentialId,
          cause,
        }),
      ),
    );
  });

  /**
   * Runs `write` (rows and audit) in one transaction after `key` is stored under a new id; on
   * failure that credential goes.
   */
  const withNewCredential = Effect.fn("AiAccounts.withNewCredential")(function* <A, E>(
    key: string | undefined,
    what: string,
    write: (credentialId: string | null) => Effect.Effect<A, E>,
  ) {
    const credentialId = key === undefined ? null : yield* writeCredential(key);
    return yield* sql
      .withTransaction(write(credentialId))
      .pipe(
        Effect.catch((error) =>
          removeCredential(credentialId).pipe(Effect.andThen(orStorage(what)(error))),
        ),
      );
  });

  const checkEndpoint = (
    provider: AiAccountProvider,
    baseUrl: string | undefined,
    models: ReadonlyArray<string> | undefined,
  ) => {
    if (provider !== "openai-compatible") {
      return baseUrl === undefined && models === undefined
        ? Effect.void
        : fail("invalid", "Only an OpenAI-compatible account takes a base URL and models.");
    }
    if (baseUrl !== undefined) {
      const problem = baseUrlProblem(baseUrl);
      if (problem !== undefined) return fail("invalid", problem);
    }
    if (models !== undefined && models.length === 0) {
      return fail("invalid", "List at least one model it serves.");
    }
    return Effect.void;
  };

  /** Whether the gateway still may hold one of the account's retired keys. */
  const keyStillLive = Effect.fn("AiAccounts.keyStillLive")(function* (accountId: string) {
    const rows = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM ai_account_retired_credentials WHERE account_id = ${accountId}
    `.pipe(Effect.catch(storage("read the AI account")));
    return (rows[0]?.n ?? 0) > 0;
  });

  const create = Effect.fn("AiAccounts.create")(function* (input: AiAccountCreateInput) {
    const userId = yield* manager;
    const key = Redacted.value(input.apiKey).trim();
    const problem = credentialProblem(key);
    if (problem !== undefined) return yield* fail("invalid", problem);
    yield* checkEndpoint(input.provider, input.baseUrl, input.models);
    if (
      input.provider === "openai-compatible" &&
      (input.baseUrl === undefined || input.models === undefined)
    ) {
      return yield* fail("invalid", "An OpenAI-compatible account needs its base URL and models.");
    }
    yield* nameTaken(input.name);
    const accountId = yield* newId(8);
    const at = yield* now;
    const models = [...new Set(input.models ?? [])];
    yield* withNewCredential(key, "add the AI account", (credentialId) =>
      Effect.gen(function* () {
        const last = yield* sql<{ readonly top: number | null }>`
          SELECT MAX(priority) AS top FROM ai_accounts
        `;
        yield* sql`
          INSERT INTO ai_accounts (account_id, name, type, provider, priority, status, disabled,
            credential_id, key_hint, base_url, models_json, created_at, updated_at, created_by)
          VALUES (${accountId}, ${input.name}, 'api-key', ${input.provider}, ${(last[0]?.top ?? 0) + 1},
            'pending', 0, ${credentialId}, ${hintOf(key)}, ${input.baseUrl ?? null},
            ${encodeModels(models)}, ${at}, ${at}, ${userId})
        `;
        yield* audit.record({
          actor: AuditLog.userActor(userId),
          action: "ai_account.create",
          target: { kind: "ai_account", id: accountId, name: input.name },
          detail: { provider: input.provider, type: "api-key" },
        });
      }),
    ).pipe(
      Effect.catch((error) =>
        // A name taken meanwhile says so; anything else stays as it was.
        nameTaken(input.name).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
    yield* syncNow;
    return yield* ownerSummaryOf(userId, accountId);
  });

  /**
   * Rename, disable or enable, «Replace credential», or an OpenAI-compatible account's URL and
   * models. Only what the gateway holds (not the name) changes the gateway. A replaced key stays
   * retired until the gateway confirms it dropped it; until then the call says it is still live.
   */
  const update = Effect.fn("AiAccounts.update")(function* (input: AiAccountUpdateInput) {
    const userId = yield* manager;
    const row = yield* findAccount(input.accountId);
    const key = input.apiKey === undefined ? undefined : Redacted.value(input.apiKey).trim();
    if (key !== undefined) {
      const problem = credentialProblem(key);
      if (problem !== undefined) return yield* fail("invalid", problem);
    }
    yield* checkEndpoint(row.provider, input.baseUrl, input.models);
    const renamed = input.name !== undefined && input.name !== row.name;
    if (renamed) yield* nameTaken(input.name ?? "", row.accountId);
    const disabledNow = input.disabled === undefined ? row.disabled === 1 : input.disabled;
    const toggled = disabledNow !== (row.disabled === 1);
    const models = input.models === undefined ? undefined : [...new Set(input.models)];
    const endpointChanged =
      (input.baseUrl !== undefined && input.baseUrl !== row.baseUrl) ||
      (models !== undefined && encodeModels(models) !== row.modelsJson);
    if (!renamed && !toggled && key === undefined && !endpointChanged) {
      return yield* ownerSummaryOf(userId, row.accountId);
    }
    const gatewayChanges = toggled || key !== undefined || endpointChanged;
    const at = yield* now;
    yield* withNewCredential(key, "change the AI account", (credentialId) =>
      Effect.gen(function* () {
        const current = yield* sql<{ readonly credentialId: string | null }>`
          SELECT credential_id AS "credentialId" FROM ai_accounts
          WHERE account_id = ${row.accountId} AND deleted_at IS NULL
        `;
        const before = current[0];
        if (before === undefined) return yield* fail("not-found", NOT_FOUND);
        if (credentialId !== null && before.credentialId !== null) {
          yield* sql`
            INSERT INTO ai_account_retired_credentials (credential_id, account_id, retired_at)
            VALUES (${before.credentialId}, ${row.accountId}, ${at})
          `;
        }
        yield* sql`
          UPDATE ai_accounts SET
            name = ${input.name ?? row.name},
            disabled = ${disabledNow ? 1 : 0},
            credential_id = ${credentialId ?? before.credentialId},
            key_hint = ${key === undefined ? row.keyHint : hintOf(key)},
            base_url = ${input.baseUrl ?? row.baseUrl},
            models_json = ${models === undefined ? row.modelsJson : encodeModels(models)},
            status = ${gatewayChanges ? "pending" : row.status},
            status_message = ${gatewayChanges ? null : row.statusMessage},
            updated_at = ${at}
          WHERE account_id = ${row.accountId}
        `;
        yield* audit.record({
          actor: AuditLog.userActor(userId),
          action: "ai_account.update",
          target: { kind: "ai_account", id: row.accountId, name: input.name ?? row.name },
          detail: {
            provider: row.provider,
            ...(renamed ? { from: row.name, to: input.name ?? row.name } : {}),
            ...(toggled ? { disabled: disabledNow } : {}),
            ...(key === undefined ? {} : { credential: "replaced" }),
            ...(endpointChanged ? { endpoint: true } : {}),
          },
        });
      }),
    );
    if (gatewayChanges) yield* syncNow;
    if (key !== undefined && (yield* keyStillLive(row.accountId))) {
      return yield* fail(
        "still-live",
        "The new key is saved, but the AI gateway has not taken it yet and the old key is still live there. The Hub keeps trying.",
      );
    }
    return yield* ownerSummaryOf(userId, row.accountId);
  });

  /**
   * Deleted at once for everyone (no allowance, not in the gateway's next change); its key stays
   * retired until the gateway confirms it dropped it, and its row with it. Until then the call says
   * the key is still live; with no gateway running it is live nowhere, and goes at once.
   */
  const remove = Effect.fn("AiAccounts.remove")(function* (input: AiAccountDeleteInput) {
    const userId = yield* manager;
    const row = yield* findRow(input.accountId);
    if (row.deletedAt === null) {
      const at = yield* now;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM ai_account_allowances WHERE account_id = ${row.accountId}`;
            if (row.credentialId !== null) {
              yield* sql`
                INSERT INTO ai_account_retired_credentials (credential_id, account_id, retired_at)
                VALUES (${row.credentialId}, ${row.accountId}, ${at})
              `;
            }
            yield* sql`
              UPDATE ai_accounts SET deleted_at = ${at}, credential_id = NULL, status = 'removing',
                status_message = NULL, updated_at = ${at}
              WHERE account_id = ${row.accountId}
            `;
            yield* audit.record({
              actor: AuditLog.userActor(userId),
              action: "ai_account.delete",
              target: { kind: "ai_account", id: row.accountId, name: row.name },
              detail: { provider: row.provider },
            });
          }),
        )
        .pipe(Effect.catch(orStorage("delete the AI account")));
    }
    const outcome = yield* syncNow;
    if (yield* keyStillLive(row.accountId)) {
      return yield* fail(
        "still-live",
        "Deleted, but its key is still live in the AI gateway, which has not taken the change yet. The Hub keeps trying to remove it.",
      );
    }
    return {
      deleted: true,
      gateway: outcome === "not-running" ? "not-running" : "removed",
    } satisfies AiAccountDeleteResult;
  });

  /** Replaces who may use it; Spaces and Users that no longer exist are dropped. */
  const allow = Effect.fn("AiAccounts.allow")(function* (input: AiAccountAllowInput) {
    const userId = yield* manager;
    const row = yield* findAccount(input.accountId);
    const existing = yield* existingSubjects(userId, [...new Set(input.spaceIds)]);
    const spaceIds = [...new Set(input.spaceIds)].filter((id) => existing.spaces.has(id));
    const userIds = [...new Set(input.userIds)].filter((id) => existing.users.has(id));
    const at = yield* now;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const before = yield* sql<AllowanceRow>`
            SELECT account_id AS "accountId", subject_kind AS "subjectKind", subject_id AS "subjectId"
            FROM ai_account_allowances WHERE account_id = ${row.accountId}
          `;
          const next = new Set([
            ...spaceIds.map((id) => `space:${id}`),
            ...userIds.map((id) => `user:${id}`),
          ]);
          const had = new Set(
            before.map((allowance) => `${allowance.subjectKind}:${allowance.subjectId}`),
          );
          yield* sql`DELETE FROM ai_account_allowances WHERE account_id = ${row.accountId}`;
          for (const [kind, ids] of [
            ["space", spaceIds],
            ["user", userIds],
          ] as const) {
            for (const id of ids) {
              yield* sql`
                INSERT INTO ai_account_allowances (account_id, subject_kind, subject_id, created_at)
                VALUES (${row.accountId}, ${kind}, ${id}, ${at})
              `;
            }
          }
          yield* audit.record({
            actor: AuditLog.userActor(userId),
            action: "ai_account.allow",
            target: { kind: "ai_account", id: row.accountId, name: row.name },
            detail: {
              spaces: spaceIds.length,
              users: userIds.length,
              added: [...next].filter((subject) => !had.has(subject)).length,
              removed: [...had].filter((subject) => !next.has(subject)).length,
            },
          });
        }),
      )
      .pipe(Effect.catch(orStorage("change who may use the AI account")));
    return yield* ownerSummaryOf(userId, row.accountId);
  });

  /** The Installation's one order; the gateway does not hold it, so it is not touched. */
  const reorder = Effect.fn("AiAccounts.reorder")(function* (input: AiAccountReorderInput) {
    const userId = yield* manager;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly accountId: string;
            readonly name: string;
            readonly priority: number;
            readonly provider: string;
          }>`
            SELECT account_id AS "accountId", name AS "name", priority AS "priority", provider AS "provider"
            FROM ai_accounts WHERE deleted_at IS NULL
          `;
          const ordered = [...new Set(input.accountIds)];
          if (
            ordered.length !== rows.length ||
            !rows.every((row) => ordered.includes(row.accountId as AiAccountId))
          ) {
            return yield* fail("invalid", "List every AI account once, first to last.");
          }
          for (const [index, accountId] of ordered.entries()) {
            const row = rows.find((candidate) => candidate.accountId === accountId);
            if (row === undefined || row.priority === index + 1) continue;
            yield* sql`UPDATE ai_accounts SET priority = ${index + 1} WHERE account_id = ${accountId}`;
            yield* audit.record({
              actor: AuditLog.userActor(userId),
              action: "ai_account.update",
              target: { kind: "ai_account", id: accountId, name: row.name },
              detail: { provider: row.provider, priority: index + 1 },
            });
          }
        }),
      )
      .pipe(Effect.catch(orStorage("change the order of the AI accounts")));
    return {
      accounts: yield* ownerAccounts(userId),
      canManage: true,
    } satisfies AiAccountListResult;
  });

  const modelsOf = Effect.fn("AiAccounts.modelsOf")(function* (accountId: AiAccountId) {
    const row = yield* findAccount(accountId);
    if (row.disabled === 1) return [] as ReadonlyArray<string>;
    const prefix = `${aiAccountPrefixOf(row.accountId)}/`;
    const ids = yield* catalogIds;
    return ids.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
  });

  return AiAccounts.of({
    list,
    create,
    update,
    remove,
    allow,
    reorder,
    modelsOf,
    sync: Effect.asVoid(syncNow),
  });
});

/**
 * At the Hub's start no CLIProxyAPI holds a key yet: retired keys and deleted accounts go, and
 * credentials no account holds (a write that stopped half-way, an older database restored).
 */
const sweepCredentials = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const credentials = yield* ServerSecretStore.AiAccountCredentialStore;
  yield* sql`DELETE FROM ai_account_retired_credentials`;
  yield* sql`DELETE FROM ai_account_allowances WHERE account_id IN (SELECT account_id FROM ai_accounts WHERE deleted_at IS NOT NULL)`;
  yield* sql`DELETE FROM ai_accounts WHERE deleted_at IS NOT NULL`;
  const stored = yield* credentials.list;
  const held = new Set(
    (yield* sql<{ readonly credentialId: string }>`
      SELECT credential_id AS "credentialId" FROM ai_accounts WHERE credential_id IS NOT NULL
    `).map((row) => row.credentialId),
  );
  let removed = 0;
  for (const credentialId of stored) {
    if (held.has(credentialId)) continue;
    yield* credentials.remove(credentialId).pipe(Effect.ignore);
    removed += 1;
  }
  if (removed > 0) {
    yield* Effect.logInfo("AiAccounts: removed credentials no AI account holds", { removed });
  }
});

/**
 * The Hub's AI accounts: the start sweeps retired and orphaned credentials, then hands the
 * gateway what it writes into every CLIProxyAPI it starts. A joined machine keeps none.
 */
export const layer = Layer.effect(
  AiAccounts,
  Effect.gen(function* () {
    const { keyring } = yield* ServerSecretStore.MasterKeyring;
    if (Option.isNone(keyring)) return unavailable;
    yield* sweepCredentials.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("AiAccounts: could not sweep credentials no AI account holds", { cause }),
      ),
    );
    return yield* make;
  }),
).pipe(Layer.provideMerge(AllowedAiAccounts.layer));
