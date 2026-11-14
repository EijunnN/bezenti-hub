/**
 * Spec 4 ticket 09: where AI accounts are in use, each provider instance's AI credential becomes an
 * account of the Owner's first (`AiAccounts.adoptProviderKey`) and leaves the instance second, so a
 * stop half-way leaves it owned, never live and unowned. docs/internals/ai-gateway.md.
 */
import {
  AI_ACCOUNT_CREDENTIAL_VARIABLES,
  AI_DIRECT_DRIVERS,
  type AiAccountProvider,
  type AiGatewayState,
  isAiApiKeyProvider,
  isAiDirectProvider,
  UserId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import type { ProviderCredential } from "../settingsAiCredentials.ts";
import { AiAccounts } from "./AiAccounts.ts";
import { AiGateway } from "./AiGateway.ts";

/** States of a gateway the Owner (or `T3CODE_AI_GATEWAY`) has not turned on. */
const OFF_STATES: ReadonlySet<AiGatewayState> = new Set(["off", "unsupported"]);

/**
 * The one condition: AI accounts are in use on this server once it has a usable AI account (the
 * condition `AiGatewaySessions.applies` uses) or its AI gateway is turned on. A desktop or dev Hub
 * (gateway off by default) with no AI account keeps its provider keys as before. Unreadable: in use.
 */
export const aiAccountsInUse = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const gateway = yield* AiGateway;
  const accounts = yield* sql<{ readonly found: number }>`
    SELECT EXISTS (
      SELECT 1 FROM ai_accounts WHERE deleted_at IS NULL AND disabled = 0
    ) AS found
  `.pipe(
    Effect.map((rows) => rows[0]?.found === 1),
    Effect.orElseSucceed(() => true),
  );
  if (accounts) return true;
  return !OFF_STATES.has((yield* gateway.status).state);
});

const PROVIDER_LABELS: Partial<Record<AiAccountProvider, string>> = {
  claude: "Claude",
  codex: "OpenAI",
  gemini: "Gemini",
  vertex: "Vertex AI",
  xai: "xAI",
  cursor: "Cursor",
  kiro: "Kiro",
  meta: "Meta",
  fx: "Vercel AI Gateway",
  devin: "Devin",
};

/**
 * Which account a key becomes: the provider its variable names (Antigravity's `apiKey`: Vertex AI
 * with «Agent Platform», else Gemini); direct for a driver that takes no base URL, else through
 * the gateway when the gateway serves that provider.
 */
export const accountFor = (
  item: Pick<ProviderCredential, "kind" | "name" | "driver" | "authMethod">,
): { readonly provider: AiAccountProvider; readonly type: "api-key" | "direct" } => {
  const provider: AiAccountProvider =
    item.kind === "field"
      ? item.authMethod === "agent-platform"
        ? "vertex"
        : "gemini"
      : (AI_ACCOUNT_CREDENTIAL_VARIABLES.get(item.name) ?? "codex");
  const type =
    AI_DIRECT_DRIVERS.has(item.driver) && isAiDirectProvider(provider)
      ? "direct"
      : isAiApiKeyProvider(provider)
        ? "api-key"
        : "direct";
  return { provider, type };
};

const sourceOf = (item: ProviderCredential) =>
  `${item.kind === "environment" ? "env" : "field"}:${item.instanceId}:${item.name}`;

/** How long one secret provider reference may take to read (1Password may ask to unlock). */
const REFERENCE_READ_TIMEOUT = Duration.seconds(15);

/** One pass: what moved, what was removed from the instances, and what stayed (names only). */
export const migrateProviderKeys = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const accounts = yield* AiAccounts;
  const resolver = yield* SecretResolver.SecretResolver;
  const sql = yield* SqlClient.SqlClient;
  const nothing = { created: 0, removed: 0, left: [] as ReadonlyArray<string> };
  const { listProviderCredentials, removeProviderCredentials } = settings;
  if (listProviderCredentials === undefined || removeProviderCredentials === undefined) {
    return nothing;
  }
  if (!(yield* aiAccountsInUse)) return nothing;
  const items = yield* listProviderCredentials;
  if (items.length === 0) return nothing;
  const owners = yield* sql<{ readonly userId: string }>`
    SELECT user_id AS "userId" FROM users WHERE is_owner = 1
  `;
  const owner = owners[0];
  if (owner === undefined) {
    yield* Effect.logInfo("Provider keys wait for the Owner before becoming AI accounts", {
      keys: items.length,
    });
    return nothing;
  }
  const moved: ProviderCredential[] = [];
  const left: string[] = [];
  let created = 0;
  for (const item of items) {
    const where = `${item.instanceId}:${item.name}`;
    const key = Redacted.isRedacted(item.value)
      ? Option.some(item.value)
      : yield* resolver
          .read([item.value])
          .pipe(
            Effect.timeoutOption(REFERENCE_READ_TIMEOUT),
            Effect.map(Option.flatMap((values) => Option.fromNullishOr(values[0]))),
            Effect.map(Option.map((value) => Redacted.make(value))),
          );
    if (Option.isNone(key)) {
      left.push(where);
      continue;
    }
    const { provider, type } = accountFor(item);
    const label = PROVIDER_LABELS[provider] ?? provider;
    const adopted = yield* accounts
      .adoptProviderKey({
        source: sourceOf(item),
        ownerId: UserId.make(owner.userId),
        type,
        provider,
        names: [`${label} (migrated)`, `${label} (migrated, ${item.instanceName})`],
        key: key.value,
      })
      .pipe(Effect.result);
    if (adopted._tag === "Failure") {
      // The reason says why, never the key: AiAccounts never puts one in an error.
      yield* Effect.logWarning("A provider key could not become an AI account; it stays", {
        where,
        reason: adopted.failure.reason,
      });
      left.push(where);
      continue;
    }
    if (adopted.success.created) created += 1;
    moved.push(item);
  }
  const removed = yield* removeProviderCredentials(moved).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Moved provider keys could not be removed from their instances yet", {
        operation: error.operation,
      }).pipe(Effect.as([] as ReadonlyArray<ProviderCredential>)),
    ),
  );
  for (const item of moved) {
    if (!removed.includes(item)) left.push(`${item.instanceId}:${item.name}`);
  }
  yield* Effect.logInfo("Provider keys moved into AI accounts", {
    created,
    removed: removed.length,
    left,
  });
  return { created, removed: removed.length, left };
});

/**
 * Settings refuse AI credentials while AI accounts are in use; the pass runs at the start and
 * again when the gateway is turned on, one at a time.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const services = yield* Effect.context<
      | ServerSettings.ServerSettingsService
      | AiAccounts
      | AiGateway
      | SecretResolver.SecretResolver
      | SqlClient.SqlClient
    >();
    const settings = yield* ServerSettings.ServerSettingsService;
    const gateway = yield* AiGateway;
    if (settings.setAiCredentialGuard !== undefined) {
      yield* settings.setAiCredentialGuard(aiAccountsInUse.pipe(Effect.provideContext(services)));
    }
    const lock = yield* Semaphore.make(1);
    const pass = lock.withPermits(1)(
      migrateProviderKeys.pipe(
        Effect.provideContext(services),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Moving provider keys into AI accounts failed; the next start retries",
            {
              cause,
            },
          ),
        ),
      ),
    );
    yield* pass.pipe(Effect.forkScoped);
    yield* gateway.changes.pipe(
      Stream.map((status) => !OFF_STATES.has(status.state)),
      Stream.changes,
      Stream.drop(1),
      Stream.filter((on) => on),
      Stream.runForEach(() => pass),
      Effect.forkScoped,
    );
  }),
);
