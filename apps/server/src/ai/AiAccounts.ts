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
/** After a write the gateway refused or missed, the Hub tries again this often. */
const RETRY_EVERY = Duration.seconds(10);

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
  updated_at AS "updatedAt"
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

  /** One write at a time: each reads the accounts afresh, so the last one written is the latest. */
  const syncLock = yield* Semaphore.make(1);
  /** The gateway start the accounts were last written to; another one needs them again. */
  let provisionedBaseUrl: string | undefined;
  let dirty = false;
  let catalog:
    | { readonly baseUrl: string; readonly at: number; readonly ids: ReadonlyArray<string> }
    | undefined;

  const enabledAccounts = sql<AccountRow>`
    SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM ai_accounts
    WHERE disabled = 0 AND type = 'api-key' AND credential_id IS NOT NULL
    ORDER BY priority, account_id
  `;

  const setStatus = (accountId: string, status: AiAccountStatus, message: string | null) =>
    sql`UPDATE ai_accounts SET status = ${status}, status_message = ${message} WHERE account_id = ${accountId}`;

  /**
   * Writes the enabled accounts, with their credentials from the store, into `endpoint`: the
   * whole `api-keys` section, so a disabled or deleted account goes. Then each account's status.
   */
  const provision = (endpoint: CliproxyEndpoint) =>
    syncLock
      .withPermits(1)(
        Effect.gen(function* () {
          const rows = yield* enabledAccounts.pipe(
            Effect.mapError(
              () => new CliproxyManagementError({ message: "Could not read the AI accounts." }),
            ),
          );
          const accounts: Array<CliproxyApiKeyAccount> = [];
          const missing: Array<string> = [];
          for (const row of rows) {
            const stored = yield* credentials
              .get(row.credentialId ?? "")
              .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
            if (Option.isNone(stored)) {
              missing.push(row.accountId);
              continue;
            }
            accounts.push({
              id: row.accountId,
              provider: row.provider as AiApiKeyProvider,
              apiKey: new TextDecoder().decode(stored.value),
              baseUrl: row.baseUrl,
              models: modelsOfRow(row),
            });
          }
          yield* management.setApiKeys(endpoint, renderCliproxyApiKeys(accounts));
          provisionedBaseUrl = endpoint.baseUrl;
          catalog = undefined;
          dirty = false;
          const ids = yield* management.modelIds(endpoint).pipe(Effect.option);
          if (Option.isSome(ids)) {
            catalog = {
              baseUrl: endpoint.baseUrl,
              at: yield* Clock.currentTimeMillis,
              ids: ids.value,
            };
          }
          for (const account of accounts) {
            const prefix = `${aiAccountPrefixOf(account.id)}/`;
            const serves = Option.isNone(ids) || ids.value.some((id) => id.startsWith(prefix));
            yield* setStatus(
              account.id,
              serves ? "working" : "error",
              serves ? null : "The AI gateway lists no models for this account.",
            ).pipe(Effect.ignore({ log: true }));
          }
          for (const accountId of missing) {
            yield* setStatus(
              accountId,
              "error",
              "Its credential is missing from the Hub's store: replace it.",
            ).pipe(Effect.ignore({ log: true }));
          }
        }),
      )
      .pipe(Effect.withSpan("AiAccounts.provision"));

  /** After a change: into the running gateway now, or at its next start; retried if refused. */
  const sync = Effect.gen(function* () {
    const endpoint = yield* gateway.endpoint;
    if (Option.isNone(endpoint)) return;
    yield* provision(endpoint.value).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          dirty = true;
          yield* Effect.logWarning("AiAccounts: the AI gateway did not take the AI accounts", {
            reason: error.message,
          });
          // Whatever the gateway holds now is not what the Owner set: no account counts as
          // working until a write goes through.
          yield* sql`
            UPDATE ai_accounts SET status = 'error', status_message = ${`Not in the AI gateway yet: ${error.message}`}
            WHERE disabled = 0
          `.pipe(Effect.ignore({ log: true }));
        }),
      ),
    );
  }).pipe(Effect.withSpan("AiAccounts.sync"));

  // Every start (a crash and its restart, an update, a roll back) gets the accounts before it
  // counts as running; a start that raced this registration is caught by the watcher below.
  yield* gateway.setProvisioner(provision);
  yield* gateway.changes.pipe(
    Stream.filter((status) => status.state === "running"),
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const endpoint = yield* gateway.endpoint;
        if (Option.isSome(endpoint) && endpoint.value.baseUrl !== provisionedBaseUrl) yield* sync;
      }),
    ),
    Effect.forkScoped,
  );
  yield* Effect.gen(function* () {
    yield* Effect.sleep(RETRY_EVERY);
    if (dirty) yield* sync;
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

  const findAccount = (accountId: string) =>
    sql<AccountRow>`SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM ai_accounts WHERE account_id = ${accountId}`.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.catch(storage("read the AI account")),
      Effect.flatMap(
        Option.match({ onNone: () => fail("not-found", NOT_FOUND), onSome: Effect.succeed }),
      ),
    );

  const allowancesOf = (accountIds: ReadonlyArray<string>) =>
    accountIds.length === 0
      ? Effect.succeed([] as ReadonlyArray<AllowanceRow>)
      : sql<AllowanceRow>`
          SELECT account_id AS "accountId", subject_kind AS "subjectKind", subject_id AS "subjectId"
          FROM ai_account_allowances WHERE ${sql.in("account_id", accountIds)}
          ORDER BY subject_kind, subject_id
        `.pipe(Effect.catch(storage("read who may use the AI accounts")));

  const statusOf = (row: AccountRow, running: boolean) =>
    row.disabled === 1
      ? { status: row.status, statusMessage: "Disabled by the Owner." }
      : !running
        ? { status: "pending" as const, statusMessage: "The AI gateway is not running." }
        : { status: row.status, statusMessage: row.statusMessage };

  /** The Owner's view of an account: everything but the credential, which nobody gets back. */
  const ownerSummary = (
    row: AccountRow,
    allowances: ReadonlyArray<AllowanceRow>,
    running: boolean,
  ): AiAccountSummary => {
    const mine = allowances.filter((allowance) => allowance.accountId === row.accountId);
    return {
      id: row.accountId as AiAccountId,
      name: row.name,
      type: row.type,
      provider: row.provider,
      priority: row.priority,
      ...statusOf(row, running),
      disabled: row.disabled === 1,
      usableIn: [],
      details: {
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

  const gatewayRunning = Effect.map(gateway.endpoint, Option.isSome);

  const ownerList = Effect.gen(function* () {
    const rows = yield* sql<AccountRow>`
      SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM ai_accounts ORDER BY priority, account_id
    `.pipe(Effect.catch(storage("read the AI accounts")));
    const allowances = yield* allowancesOf(rows.map((row) => row.accountId));
    const running = yield* gatewayRunning;
    return rows.map((row) => ownerSummary(row, allowances, running));
  });

  const ownerSummaryOf = Effect.fn("AiAccounts.ownerSummaryOf")(function* (accountId: string) {
    const row = yield* findAccount(accountId);
    const allowances = yield* allowancesOf([row.accountId]);
    return ownerSummary(row, allowances, yield* gatewayRunning);
  });

  /**
   * Anyone else: the accounts AllowedAiAccounts lets them use in the Spaces they may act in now
   * (a session limited to one Space: that one), with where; name, provider and status only.
   */
  const usableList = Effect.fn("AiAccounts.usableList")(function* (
    userId: UserId,
    can: (action: AccessPolicy.Action, resource: AccessPolicy.Resource) => boolean,
  ) {
    {
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
        WHERE ${sql.in("account_id", [...usableIn.keys()])}
        ORDER BY priority, account_id
      `.pipe(Effect.catch(storage("read the AI accounts")));
      const running = yield* gatewayRunning;
      return rows.map((row): AiAccountSummary => ({
        id: row.accountId as AiAccountId,
        name: row.name,
        type: row.type,
        provider: row.provider,
        priority: row.priority,
        ...statusOf(row, running),
        disabled: row.disabled === 1,
        usableIn: usableIn.get(row.accountId) ?? [],
        details: null,
      }));
    }
  });

  const list = Effect.gen(function* () {
    const { userId, manages, can } = yield* caller;
    const accounts = manages ? yield* ownerList : yield* usableList(userId, can);
    return { accounts, canManage: manages } satisfies AiAccountListResult;
  }).pipe(Effect.withSpan("AiAccounts.list"));

  const nameTaken = (name: string, except?: string) =>
    sql<{ readonly accountId: string }>`
      SELECT account_id AS "accountId" FROM ai_accounts WHERE name = ${name} COLLATE NOCASE
    `.pipe(
      Effect.map((rows) => rows.some((row) => row.accountId !== except)),
      Effect.catch(storage("read the AI accounts")),
      Effect.flatMap((taken) =>
        taken
          ? fail("duplicate-name", `There is already an AI account named ${name}.`)
          : Effect.void,
      ),
    );

  /** A new credential under a new id: no row points at it until its transaction commits. */
  const writeCredential = Effect.fn("AiAccounts.writeCredential")(function* (key: string) {
    const credentialId = `cred-${yield* newId(16)}`;
    yield* credentials
      .set(credentialId, new TextEncoder().encode(key))
      .pipe(Effect.catch(storage("store the API key")));
    return credentialId;
  });

  /** Removes a credential no row points at; one left behind by a failure is swept at the next start. */
  const removeCredential = (credentialId: string | null) =>
    credentialId === null
      ? Effect.void
      : credentials
          .remove(credentialId)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "AiAccounts: could not remove a credential; the next start removes it",
                { credentialId, cause },
              ),
            ),
          );

  /**
   * Runs `write` (rows and audit) in one transaction after `key` is stored under a new id; on
   * failure that credential goes, on success the one it replaced (`write`'s answer) does.
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
    yield* sync;
    return yield* ownerSummaryOf(accountId);
  });

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
      return yield* ownerSummaryOf(row.accountId);
    }
    const at = yield* now;
    const replaced = yield* withNewCredential(key, "change the AI account", (credentialId) =>
      Effect.gen(function* () {
        const current = yield* sql<{ readonly credentialId: string | null }>`
          SELECT credential_id AS "credentialId" FROM ai_accounts WHERE account_id = ${row.accountId}
        `;
        const before = current[0];
        if (before === undefined) return yield* fail("not-found", NOT_FOUND);
        yield* sql`
          UPDATE ai_accounts SET
            name = ${input.name ?? row.name},
            disabled = ${disabledNow ? 1 : 0},
            credential_id = ${credentialId ?? before.credentialId},
            key_hint = ${key === undefined ? row.keyHint : hintOf(key)},
            base_url = ${input.baseUrl ?? row.baseUrl},
            models_json = ${models === undefined ? row.modelsJson : encodeModels(models)},
            status = ${key === undefined && !toggled ? row.status : "pending"},
            status_message = ${key === undefined && !toggled ? row.statusMessage : null},
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
        return credentialId === null ? null : before.credentialId;
      }),
    );
    // The gateway gets the new credential (or loses a disabled account) before the old one goes.
    yield* sync;
    yield* removeCredential(replaced);
    return yield* ownerSummaryOf(row.accountId);
  });

  /**
   * Its row, allowances and audit in one transaction; then it leaves the gateway, then its
   * credential leaves the store. A Hub that stops half-way loses nothing it should keep: the
   * gateway is rebuilt from the rows at its next start, and the start sweeps credentials no row
   * holds.
   */
  const remove = Effect.fn("AiAccounts.remove")(function* (input: AiAccountDeleteInput) {
    const userId = yield* manager;
    const row = yield* findAccount(input.accountId);
    const gone = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM ai_account_allowances WHERE account_id = ${row.accountId}`;
          const deleted = yield* sql<{ readonly credentialId: string | null }>`
            DELETE FROM ai_accounts WHERE account_id = ${row.accountId}
            RETURNING credential_id AS "credentialId"
          `;
          if (deleted.length === 0) return yield* fail("not-found", NOT_FOUND);
          yield* audit.record({
            actor: AuditLog.userActor(userId),
            action: "ai_account.delete",
            target: { kind: "ai_account", id: row.accountId, name: row.name },
            detail: { provider: row.provider },
          });
          return deleted[0]?.credentialId ?? null;
        }),
      )
      .pipe(Effect.catch(orStorage("delete the AI account")));
    yield* sync;
    yield* removeCredential(gone);
    return { deleted: true } satisfies AiAccountDeleteResult;
  });

  const allow = Effect.fn("AiAccounts.allow")(function* (input: AiAccountAllowInput) {
    const userId = yield* manager;
    const row = yield* findAccount(input.accountId);
    const spaceIds = [...new Set(input.spaceIds)];
    const userIds = [...new Set(input.userIds)];
    const known = yield* spaces.spacesById(spaceIds).pipe(Effect.catch(storage("read the Spaces")));
    const unknownSpace = spaceIds.find((spaceId) => !known.has(spaceId));
    if (unknownSpace !== undefined) {
      return yield* fail("not-found", "One of those Spaces does not exist.");
    }
    for (const user of userIds) {
      const found = yield* spaces
        .installationUser(user)
        .pipe(Effect.catch(storage("read the Users")));
      if (Option.isNone(found))
        return yield* fail("not-found", "One of those Users does not exist.");
    }
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
    return yield* ownerSummaryOf(row.accountId);
  });

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
            FROM ai_accounts
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
    return { accounts: yield* ownerList, canManage: true } satisfies AiAccountListResult;
  });

  const modelsOf = Effect.fn("AiAccounts.modelsOf")(function* (accountId: AiAccountId) {
    const row = yield* findAccount(accountId);
    if (row.disabled === 1) return [] as ReadonlyArray<string>;
    const prefix = `${aiAccountPrefixOf(row.accountId)}/`;
    const ids = yield* catalogIds;
    return ids.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
  });

  return AiAccounts.of({ list, create, update, remove, allow, reorder, modelsOf, sync });
});

/**
 * Credentials no account holds (a write or deletion that stopped half-way, or an older database
 * restored): removed, so no credential outlives its account. Only their own folder of the store.
 */
const sweepOrphanCredentials = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const credentials = yield* ServerSecretStore.AiAccountCredentialStore;
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
 * The Hub's AI accounts: the start sweeps orphaned credentials, then hands the gateway what it
 * writes into every CLIProxyAPI it starts. A joined machine keeps none and writes nothing.
 */
export const layer = Layer.effect(
  AiAccounts,
  Effect.gen(function* () {
    const { keyring } = yield* ServerSecretStore.MasterKeyring;
    if (Option.isNone(keyring)) return unavailable;
    yield* sweepOrphanCredentials.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("AiAccounts: could not sweep credentials no AI account holds", { cause }),
      ),
    );
    return yield* make;
  }),
).pipe(Layer.provideMerge(AllowedAiAccounts.layer));
