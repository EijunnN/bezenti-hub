import { fetchInstallationUsers } from "@t3tools/client-runtime/spaces/space-directory";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AiAccountDetails,
  AiAccountProvider,
  AiAccountStatus,
  AiAccountLoginStartResult,
  AiAccountSummary,
  AiAccountUpdateInput,
  AiApiKeyProvider,
  AiSubscriptionProvider,
  EnvironmentId,
  InstallationUser,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { errorMessageOf } from "../../lib/errorMessage";
import { runPrimaryHttp } from "../../lib/runtime";
import { aiGatewayEnvironment } from "../../state/aiGateway";
import { useCurrentSpace } from "../../state/currentSpace";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const SELECT_CLASS = "h-8 w-full rounded-md border border-input bg-background px-2 text-sm";
/** Hidden as typed, and no password manager prompt: it is not a login. */
const KEY_INPUT_PROPS = {
  type: "text",
  className: "[-webkit-text-security:disc]",
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
} as const;

const API_KEY_PROVIDERS: ReadonlyArray<readonly [AiApiKeyProvider, string]> = [
  ["claude", "Anthropic (Claude)"],
  ["codex", "OpenAI (Codex)"],
  ["gemini", "Gemini"],
  ["vertex", "Vertex AI"],
  ["xai", "xAI"],
  ["meta", "Meta"],
  ["openai-compatible", "OpenAI-compatible (DeepSeek, OpenRouter…)"],
];
/** Subscriptions the Owner signs in to through the Hub's AI gateway (spec 4 ticket 03). */
const SUBSCRIPTION_PROVIDERS: ReadonlyArray<readonly [AiSubscriptionProvider, string]> = [
  ["claude", "Claude (Pro or Max)"],
  ["codex", "ChatGPT (Codex)"],
  ["antigravity", "Google (Antigravity: AI Pro or Ultra)"],
  ["kimi", "Kimi"],
  ["xai", "xAI (Grok)"],
  ["devin", "Devin"],
  ["meta", "Meta"],
];
const providerLabel = (provider: AiAccountProvider, type?: AiAccountSummary["type"]) =>
  (type === "subscription"
    ? (SUBSCRIPTION_PROVIDERS.find(([value]) => value === provider)?.[1] ??
      (provider === "vertex" ? "Vertex AI (service account)" : undefined))
    : undefined) ??
  API_KEY_PROVIDERS.find(([value]) => value === provider)?.[1] ??
  provider;

/** ADR 0005: the Owner shares a personal subscription knowingly. */
const TOS_WARNING =
  "Sharing a personal subscription with your team may break the provider's terms; the provider may suspend the account. API keys and per-seat plans are the compliant choice.";
const ANTIGRAVITY_NOTE =
  "CLIProxyAPI disguises its Antigravity traffic (hardened in v8.0.65), a sign that Google detects and may suspend this use.";

const STATUS_LABELS: Readonly<Record<AiAccountStatus, string>> = {
  pending: "Waiting for the AI gateway",
  working: "Working",
  unverified: "In the gateway, unverified",
  error: "Error",
  disabled: "Disabled",
  removing: "Still live in the gateway",
  "needs-sign-in": "Needs sign-in again",
  "quota-exhausted": "Quota exhausted",
};

const splitModels = (text: string) =>
  text
    .split(/[\s,]+/u)
    .map((model) => model.trim())
    .filter((model) => model.length > 0);

async function settle<A, E>(pending: Promise<AtomCommandResult<A, E>>): Promise<A> {
  const result = await pending;
  if (result._tag === "Success") return result.value;
  throw new Error(errorMessageOf(squashAtomCommandFailure(result), "That did not work."));
}

const fetchUsers = () =>
  runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(fetchInstallationUsers)));

function useAccountCommands() {
  return {
    list: useAtomCommand(aiGatewayEnvironment.listAccounts, "list the AI accounts"),
    create: useAtomCommand(aiGatewayEnvironment.createAccount, "add an AI account"),
    update: useAtomCommand(aiGatewayEnvironment.updateAccount, "change an AI account"),
    remove: useAtomCommand(aiGatewayEnvironment.deleteAccount, "delete an AI account"),
    allow: useAtomCommand(aiGatewayEnvironment.allowAccount, "change who may use an AI account"),
    reorder: useAtomCommand(aiGatewayEnvironment.reorderAccounts, "order the AI accounts"),
    loginStart: useAtomCommand(aiGatewayEnvironment.startAccountLogin, "start a sign-in"),
    loginComplete: useAtomCommand(aiGatewayEnvironment.completeAccountLogin, "finish a sign-in"),
    importVertex: useAtomCommand(
      aiGatewayEnvironment.importVertexAccount,
      "import a Vertex service account",
    ),
  };
}
type AccountCommands = ReturnType<typeof useAccountCommands>;

/**
 * Settings → AI accounts: the Owner adds API keys, orders them and allows each to Spaces and
 * Users; everyone else sees the names, providers and status of the accounts they may use. A key
 * is never shown again once saved, only replaced.
 */
export function AiAccountsSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId === null ? null : <AiAccountsPage environmentId={environmentId} />}
    </SettingsPageContainer>
  );
}

interface Subject {
  readonly id: string;
  readonly name: string;
}

function AiAccountsPage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const commands = useAccountCommands();
  const spaceView = useCurrentSpace((state) => state.view);
  // The session may change the Hub's settings at all (settings:write); the Hub decides the rest.
  const mayWrite = useAtomValue(aiGatewayEnvironment.createAccount.permissionAtom(environmentId));
  const [accounts, setAccounts] = useState<ReadonlyArray<AiAccountSummary> | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [users, setUsers] = useState<ReadonlyArray<InstallationUser>>([]);
  const [error, setError] = useState<string | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const manage = canManage && mayWrite;

  const loadAccounts = useEffectEvent((target: EnvironmentId) =>
    settle(commands.list({ environmentId: target, input: {} })),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the AI accounts the signed-in User may see from the Hub when the page opens, then (for the Owner) the Users to allow them to.
  useEffect(() => {
    let cancelled = false;
    void loadAccounts(environmentId).then(
      (listed) => {
        if (cancelled) return;
        setAccounts(listed.accounts);
        setCanManage(listed.canManage);
        if (!listed.canManage) return;
        // The accounts show even when the Users cannot be read.
        void fetchUsers().then(
          (list) => {
            if (!cancelled) setUsers(list.users);
          },
          (cause: unknown) => {
            if (!cancelled) {
              setUsersError(
                errorMessageOf(
                  cause,
                  "Could not read the Users: allowances to Users are not shown.",
                ),
              );
            }
          },
        );
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessageOf(cause, "Could not read the AI accounts."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  const refresh = async () => {
    try {
      const listed = await settle(commands.list({ environmentId, input: {} }));
      setAccounts(listed.accounts);
      setCanManage(listed.canManage);
      setError(null);
    } catch (cause) {
      setError(errorMessageOf(cause, "Could not read the AI accounts."));
    }
  };

  const spaces: ReadonlyArray<Subject> = (spaceView?.spaces ?? []).map((space) => ({
    id: space.id,
    name: space.kind === "personal" ? `${space.name} (personal)` : space.name,
  }));
  const spaceName = (spaceId: SpaceId) =>
    spaces.find((space) => space.id === spaceId)?.name ?? spaceId;
  const people: ReadonlyArray<Subject> = users
    .filter((user) => user.status !== "removed")
    .map((user) => ({ id: user.id, name: user.displayName }));

  /** One move at a time, from the order the Hub last answered. */
  const move = async (accountId: AiAccountSummary["id"], by: -1 | 1) => {
    if (accounts === null || reordering) return;
    const order = accounts
      .filter((account) => account.status !== "removing")
      .map((account) => account.id);
    const index = order.indexOf(accountId);
    if (index < 0 || index + by < 0 || index + by >= order.length) return;
    order.splice(index, 1);
    order.splice(index + by, 0, accountId);
    setReordering(true);
    try {
      const listed = await settle(
        commands.reorder({ environmentId, input: { accountIds: order } }),
      );
      setAccounts(listed.accounts);
    } catch (cause) {
      setError(errorMessageOf(cause, "Could not change the order."));
      await refresh();
    } finally {
      setReordering(false);
    }
  };

  const ordered = (accounts ?? []).filter((account) => account.status !== "removing");
  return (
    <>
      <SettingsSection id="ai-accounts" title="AI accounts">
        <SettingsRow
          title={canManage ? "Your AI accounts" : "AI accounts you may use"}
          description={
            canManage
              ? "API keys and subscriptions the Hub's AI gateway uses for your team's agents, tried first to last. A credential never leaves the Hub and is never shown again: replace it, or sign in again, to change it. Allow each account to Spaces (everyone who works there) or to Users."
              : "The AI accounts your agents may use in your Spaces. Only the Owner adds or changes them."
          }
          status={
            error === null && usersError === null ? null : (
              <span className="text-destructive" role="alert">
                {[error, usersError].filter((part) => part !== null).join(" ")}
              </span>
            )
          }
        />
        {manage ? (
          <NewAccountForm environmentId={environmentId} commands={commands} onAdded={refresh} />
        ) : null}
        {manage ? (
          <NewSubscriptionForm
            environmentId={environmentId}
            commands={commands}
            onAdded={refresh}
          />
        ) : null}
        {manage ? (
          <ImportVertexForm environmentId={environmentId} commands={commands} onAdded={refresh} />
        ) : null}
      </SettingsSection>
      {accounts === null ? null : accounts.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">
          {canManage ? "No AI account yet." : "No AI account is allowed to you."}
        </p>
      ) : (
        <ul aria-label="AI accounts" className="flex flex-col gap-4">
          {accounts.map((account) => (
            <li key={account.id}>
              <AccountSection
                environmentId={environmentId}
                commands={commands}
                account={account}
                canManage={manage}
                spaces={spaces}
                people={people}
                spaceName={spaceName}
                first={ordered[0]?.id === account.id}
                last={ordered.at(-1)?.id === account.id}
                reordering={reordering}
                onMove={(by) => move(account.id, by)}
                onChanged={refresh}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function NewAccountForm(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: AccountCommands;
  readonly onAdded: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<AiApiKeyProvider>("claude");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const compatible = provider === "openai-compatible";
  const modelList = splitModels(models);
  const ready =
    name.trim().length > 0 &&
    apiKey.trim().length > 0 &&
    (!compatible || (baseUrl.trim().length > 0 && modelList.length > 0));
  return (
    <form
      aria-label="Add an API key"
      className="flex flex-col gap-2 px-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        void settle(
          props.commands.create({
            environmentId: props.environmentId,
            input: {
              name: name.trim(),
              provider,
              apiKey: Redacted.make(apiKey.trim()),
              ...(compatible ? { baseUrl: baseUrl.trim(), models: modelList } : {}),
            },
          }),
        )
          .then(async () => {
            setName("");
            setApiKey("");
            setBaseUrl("");
            setModels("");
            await props.onAdded();
          })
          .catch((cause: unknown) => setError(errorMessageOf(cause, "Could not add it.")))
          .finally(() => setPending(false));
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
          AI account name
          <Input
            aria-label="AI account name"
            nativeInput
            disabled={pending}
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium sm:w-64">
          Provider
          <select
            aria-label="Provider"
            className={SELECT_CLASS}
            disabled={pending}
            value={provider}
            onChange={(event) => setProvider(event.currentTarget.value as AiApiKeyProvider)}
          >
            {API_KEY_PROVIDERS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium">
        API key
        <Input
          aria-label="API key"
          nativeInput
          disabled={pending}
          value={apiKey}
          onChange={(event) => setApiKey(event.currentTarget.value)}
          {...KEY_INPUT_PROPS}
        />
      </label>
      {compatible ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
            Base URL
            <Input
              aria-label="Base URL"
              nativeInput
              disabled={pending}
              placeholder="https://openrouter.ai/api/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.currentTarget.value)}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
            Models
            <Input
              aria-label="Models"
              nativeInput
              disabled={pending}
              placeholder="deepseek-chat, deepseek-reasoner"
              value={models}
              onChange={(event) => setModels(event.currentTarget.value)}
            />
          </label>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button disabled={pending || !ready} size="sm" type="submit">
          Add AI account
        </Button>
        {error === null ? null : (
          <span className="text-xs text-destructive" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * The Owner signs in on the provider's page in their own browser. The provider sends the browser
 * back to a localhost address that does not open (the Hub may be on a VPS): the Owner pastes that
 * address here, and the Hub hands it to its CLIProxyAPI. Device sign-ins show a code instead.
 */
function SignInFlow(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: AccountCommands;
  readonly label: string;
  readonly provider: AiSubscriptionProvider;
  readonly target: { readonly name: string } | { readonly accountId: AiAccountSummary["id"] };
  readonly disabled: boolean;
  readonly onDone: () => Promise<void>;
}) {
  const [started, setStarted] = useState<AiAccountLoginStartResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [landed, setLanded] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = () => {
    setPending(true);
    setError(null);
    setLanded("");
    void settle(
      props.commands.loginStart({
        environmentId: props.environmentId,
        input: { provider: props.provider, ...props.target },
      }),
    )
      .then(setStarted)
      .catch((cause: unknown) => setError(errorMessageOf(cause, "Could not start the sign-in.")))
      .finally(() => setPending(false));
  };
  const finish = (confirmIdentity?: boolean) => {
    if (started === null) return;
    setPending(true);
    setError(null);
    setNotice(null);
    setMismatch(false);
    void settle(
      props.commands.loginComplete({
        environmentId: props.environmentId,
        input: {
          loginId: started.loginId,
          ...(started.flow === "redirect" ? { redirectUrl: Redacted.make(landed.trim()) } : {}),
          ...(confirmIdentity === true ? { confirmIdentity } : {}),
        },
      }),
    )
      .then(async (account) => {
        setStarted(null);
        setLanded("");
        // A new subscription waits, off, until the Owner checks who it signed in as.
        if (account.disabled) setNotice(account.statusMessage);
        await props.onDone();
      })
      .catch((cause: unknown) => {
        const message = errorMessageOf(cause, "Could not finish the sign-in.");
        // «Sign in again» as another account: the Owner says whether to use it.
        setMismatch(/Confirm to use it/u.test(message));
        setError(message);
      })
      .finally(() => setPending(false));
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={started === null ? "default" : "outline"}
          type="button"
          disabled={props.disabled || pending}
          onClick={start}
        >
          {started === null ? props.label : "Start over"}
        </Button>
        {started === null ? null : (
          <a
            className="text-sm font-medium underline"
            href={started.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open sign-in
          </a>
        )}
      </div>
      {started === null ? null : started.flow === "device" ? (
        <div className="flex flex-col gap-2 text-sm">
          <span>
            On the provider's page, enter the code{" "}
            <code aria-label="Sign-in code">{started.userCode}</code>, then come back.
          </span>
          <div>
            <Button size="sm" type="button" disabled={pending} onClick={() => finish()}>
              I have signed in
            </Button>
          </div>
        </div>
      ) : (
        <form
          aria-label="Finish the sign-in"
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            finish();
          }}
        >
          <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
            Paste the address you landed on
            <Input
              aria-label="Paste the address you landed on"
              nativeInput
              disabled={pending}
              placeholder="http://localhost:…/callback?code=…&state=…"
              value={landed}
              onChange={(event) => setLanded(event.currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <Button size="sm" type="submit" disabled={pending || landed.trim().length === 0}>
            Finish sign-in
          </Button>
        </form>
      )}
      {started === null ? null : (
        <span className="text-xs text-muted-foreground">
          {started.flow === "device"
            ? "This sign-in lasts 10 minutes."
            : "After you sign in, the browser lands on a localhost address that does not open. Copy that whole address from the address bar and paste it here. This sign-in lasts 10 minutes."}
        </span>
      )}
      {error === null ? null : (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
      {mismatch ? (
        <div>
          <Button
            size="sm"
            variant="destructive"
            type="button"
            disabled={pending}
            onClick={() => finish(true)}
          >
            Use the new account
          </Button>
        </div>
      ) : null}
      {notice === null ? null : (
        <span className="text-xs" role="status">
          {notice}
        </span>
      )}
    </div>
  );
}

/** «Add subscription»: a name, the provider, the ToS warning, then the sign-in. */
function NewSubscriptionForm(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: AccountCommands;
  readonly onAdded: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<AiSubscriptionProvider>("claude");
  return (
    <section aria-label="Add subscription" className="flex flex-col gap-2 border-t px-4 py-4">
      <h3 className="text-sm font-medium">Add subscription</h3>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
          Subscription name
          <Input
            aria-label="Subscription name"
            nativeInput
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium sm:w-72">
          Subscription provider
          <select
            aria-label="Subscription provider"
            className={SELECT_CLASS}
            value={provider}
            onChange={(event) => setProvider(event.currentTarget.value as AiSubscriptionProvider)}
          >
            {SUBSCRIPTION_PROVIDERS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p
        role="note"
        aria-label="Terms of service warning"
        className="text-xs text-warning-foreground"
      >
        {TOS_WARNING}
        {provider === "antigravity" ? ` ${ANTIGRAVITY_NOTE}` : ""}
      </p>
      <SignInFlow
        key={`${provider}|${name.trim()}`}
        environmentId={props.environmentId}
        commands={props.commands}
        label="Start sign-in"
        provider={provider}
        target={{ name: name.trim() }}
        disabled={name.trim().length === 0}
        onDone={async () => {
          setName("");
          await props.onAdded();
        }}
      />
    </section>
  );
}

/** A Vertex service account (its JSON key file), imported into the gateway. */
function ImportVertexForm(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: AccountCommands;
  readonly onAdded: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      aria-label="Import a Vertex service account"
      className="flex flex-col gap-2 border-t px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        void settle(
          props.commands.importVertex({
            environmentId: props.environmentId,
            input: { name: name.trim(), serviceAccount: Redacted.make(key.trim()) },
          }),
        )
          .then(async () => {
            setName("");
            setKey("");
            await props.onAdded();
          })
          .catch((cause: unknown) => setError(errorMessageOf(cause, "Could not import it.")))
          .finally(() => setPending(false));
      }}
    >
      <h3 className="text-sm font-medium">Import a Vertex service account</h3>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Vertex account name
        <Input
          aria-label="Vertex account name"
          nativeInput
          disabled={pending}
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Service account key (JSON)
        <textarea
          aria-label="Service account key (JSON)"
          className="min-h-20 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs [-webkit-text-security:disc]"
          disabled={pending}
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.currentTarget.value)}
        />
      </label>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          type="submit"
          disabled={pending || name.trim().length === 0 || key.trim().length === 0}
        >
          Import
        </Button>
        {error === null ? null : (
          <span className="text-xs text-destructive" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

/** A subscription's quota windows, as its provider reports them. */
const quotaText = (details: AiAccountDetails) =>
  details.usageLimits === undefined || details.usageLimits === null
    ? null
    : details.usageLimits.windows.length === 0
      ? null
      : `Quota: ${details.usageLimits.windows
          .map((window) => `${window.label} ${Math.round(window.usedPercent)}% used`)
          .join(", ")}.`;

function AccountSection(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: AccountCommands;
  readonly account: AiAccountSummary;
  readonly canManage: boolean;
  readonly spaces: ReadonlyArray<Subject>;
  readonly people: ReadonlyArray<Subject>;
  readonly spaceName: (spaceId: SpaceId) => string;
  readonly first: boolean;
  readonly last: boolean;
  readonly reordering: boolean;
  readonly onMove: (by: -1 | 1) => Promise<void>;
  readonly onChanged: () => Promise<void>;
}) {
  const { account, commands, environmentId } = props;
  const details = account.details;
  const removing = account.status === "removing";
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  /** Runs a change; whatever it answered, the list is read again (a key may be still live). */
  const act = async (work: () => Promise<string | null>) => {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      return true;
    } catch (cause) {
      setError(errorMessageOf(cause, "That did not work."));
      return false;
    } finally {
      setPending(false);
      await props.onChanged();
    }
  };
  const update = (input: Omit<AiAccountUpdateInput, "accountId">) =>
    act(() =>
      settle(commands.update({ environmentId, input: { accountId: account.id, ...input } })).then(
        () => null,
      ),
    );

  return (
    <SettingsSection id={`ai-account-${account.id}`} title={account.name}>
      <SettingsRow
        title={providerLabel(account.provider, account.type)}
        description={
          details === null
            ? `Usable in ${account.usableIn.map(props.spaceName).join(", ")}.`
            : [
                removing ? null : `Priority ${account.priority}.`,
                details.keyHint === null ? null : `Key ending in …${details.keyHint}.`,
                details.signedInAs === undefined || details.signedInAs === null
                  ? null
                  : `Signed in as ${details.signedInAs}.`,
                quotaText(details),
                account.type === "subscription" ? TOS_WARNING : null,
                details.baseUrl === null
                  ? null
                  : `${details.baseUrl} (${details.models.join(", ")}).`,
              ]
                .filter((part) => part !== null)
                .join(" ")
        }
        control={
          <span className="flex items-center gap-2">
            <Badge
              aria-label={`Status of ${account.name}`}
              variant={
                account.status === "error" || account.status === "removing"
                  ? "destructive"
                  : "secondary"
              }
            >
              {STATUS_LABELS[account.status]}
            </Badge>
          </span>
        }
        status={
          error !== null ? (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          ) : notice !== null ? (
            <span role="status">{notice}</span>
          ) : account.statusMessage === null ? null : (
            <span>{account.statusMessage}</span>
          )
        }
      />
      {props.canManage && details !== null ? (
        <div className="flex flex-col gap-3 px-4 pb-4">
          <div className="flex flex-wrap gap-2">
            {removing ? null : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || props.reordering || props.first}
                  aria-label={`Move ${account.name} up`}
                  onClick={() => void props.onMove(-1)}
                >
                  Up
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || props.reordering || props.last}
                  aria-label={`Move ${account.name} down`}
                  onClick={() => void props.onMove(1)}
                >
                  Down
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  aria-label={`${account.disabled ? "Enable" : "Disable"} ${account.name}`}
                  onClick={() => void update({ disabled: !account.disabled })}
                >
                  {account.disabled ? "Enable" : "Disable"}
                </Button>
              </>
            )}
            {confirmDelete || removing ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                aria-label={`Confirm delete ${account.name}`}
                onClick={() =>
                  void act(() =>
                    settle(
                      commands.remove({ environmentId, input: { accountId: account.id } }),
                    ).then((result) =>
                      result.gateway === "not-running"
                        ? "Deleted. The AI gateway is not running, so its key was live nowhere."
                        : null,
                    ),
                  )
                }
              >
                {removing ? "Try removing it again" : "Delete for good"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                aria-label={`Delete ${account.name}`}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            )}
          </div>
          {removing ? null : (
            <>
              <EditAccountForm
                key={`${account.name}|${details.baseUrl}|${details.models.join(",")}`}
                account={account}
                details={details}
                pending={pending}
                onSave={(input) => update(input)}
              />
              {account.type === "subscription" && account.provider !== "vertex" ? (
                <SignInFlow
                  environmentId={environmentId}
                  commands={commands}
                  label="Sign in again"
                  provider={account.provider as AiSubscriptionProvider}
                  target={{ accountId: account.id }}
                  disabled={pending}
                  onDone={props.onChanged}
                />
              ) : null}
              {account.type !== "api-key" ? null : (
                <form
                  aria-label={`Replace credential of ${account.name}`}
                  className="flex flex-col gap-2 sm:flex-row sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void update({ apiKey: Redacted.make(newKey.trim()) }).then((saved) => {
                      if (saved) setNewKey("");
                    });
                  }}
                >
                  <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
                    New API key
                    <Input
                      aria-label={`New API key for ${account.name}`}
                      nativeInput
                      disabled={pending}
                      value={newKey}
                      onChange={(event) => setNewKey(event.currentTarget.value)}
                      {...KEY_INPUT_PROPS}
                    />
                  </label>
                  <Button size="sm" type="submit" disabled={pending || newKey.trim().length === 0}>
                    Replace credential
                  </Button>
                </form>
              )}
              <AllowancesForm
                // Read again from the Hub after each change; a key replaced leaves them as they are.
                key={JSON.stringify(details.allowances)}
                account={account}
                allowances={details.allowances}
                spaces={props.spaces}
                people={props.people}
                pending={pending}
                onSave={(allowances) =>
                  act(() =>
                    settle(
                      commands.allow({
                        environmentId,
                        input: { accountId: account.id, ...allowances },
                      }),
                    ).then(() => null),
                  )
                }
              />
            </>
          )}
        </div>
      ) : null}
    </SettingsSection>
  );
}

/** Its name, and for an OpenAI-compatible account its base URL and models. */
function EditAccountForm(props: {
  readonly account: AiAccountSummary;
  readonly details: AiAccountDetails;
  readonly pending: boolean;
  readonly onSave: (input: Omit<AiAccountUpdateInput, "accountId">) => Promise<boolean>;
}) {
  const { account, details } = props;
  const compatible = account.provider === "openai-compatible";
  const [name, setName] = useState(account.name);
  const [baseUrl, setBaseUrl] = useState(details.baseUrl ?? "");
  const [models, setModels] = useState(details.models.join(", "));
  const modelList = splitModels(models);
  const changed =
    name.trim() !== account.name ||
    (compatible &&
      (baseUrl.trim() !== (details.baseUrl ?? "") ||
        modelList.join(",") !== details.models.join(",")));
  return (
    <form
      aria-label={`Edit ${account.name}`}
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onSave({
          ...(name.trim() === account.name ? {} : { name: name.trim() }),
          ...(compatible ? { baseUrl: baseUrl.trim(), models: modelList } : {}),
        });
      }}
    >
      <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
        Name
        <Input
          aria-label={`Name of ${account.name}`}
          nativeInput
          disabled={props.pending}
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      {compatible ? (
        <>
          <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
            Base URL
            <Input
              aria-label={`Base URL of ${account.name}`}
              nativeInput
              disabled={props.pending}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.currentTarget.value)}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
            Models
            <Input
              aria-label={`Models of ${account.name}`}
              nativeInput
              disabled={props.pending}
              value={models}
              onChange={(event) => setModels(event.currentTarget.value)}
            />
          </label>
        </>
      ) : null}
      <Button
        size="sm"
        type="submit"
        disabled={
          props.pending ||
          !changed ||
          name.trim().length === 0 ||
          (compatible && (baseUrl.trim().length === 0 || modelList.length === 0))
        }
      >
        Save changes
      </Button>
    </form>
  );
}

/**
 * Who may use it. Users the page could not read stay as they were (they are sent back as is), and
 * Spaces or Users that no longer exist are dropped by the Hub.
 */
function AllowancesForm(props: {
  readonly account: AiAccountSummary;
  readonly allowances: AiAccountDetails["allowances"];
  readonly spaces: ReadonlyArray<Subject>;
  readonly people: ReadonlyArray<Subject>;
  readonly pending: boolean;
  readonly onSave: (allowances: {
    readonly spaceIds: ReadonlyArray<SpaceId>;
    readonly userIds: ReadonlyArray<UserId>;
  }) => Promise<boolean>;
}) {
  const { account } = props;
  const [allowedSpaces, setAllowedSpaces] = useState<ReadonlyArray<string>>(
    props.allowances.spaceIds,
  );
  const [allowedUsers, setAllowedUsers] = useState<ReadonlyArray<string>>(props.allowances.userIds);
  const toggle = (list: ReadonlyArray<string>, id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((item) => item !== id);
  return (
    <form
      aria-label={`Who may use ${account.name}`}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onSave({
          spaceIds: allowedSpaces as ReadonlyArray<SpaceId>,
          userIds: allowedUsers as ReadonlyArray<UserId>,
        });
      }}
    >
      <fieldset className="flex flex-wrap gap-3 text-sm">
        <legend className="text-xs font-medium">Spaces</legend>
        {props.spaces.map((space) => (
          <label key={space.id} className="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label={`Allow ${account.name} in ${space.name}`}
              checked={allowedSpaces.includes(space.id)}
              disabled={props.pending}
              onChange={(event) =>
                setAllowedSpaces(toggle(allowedSpaces, space.id, event.currentTarget.checked))
              }
            />
            {space.name}
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-wrap gap-3 text-sm">
        <legend className="text-xs font-medium">Users</legend>
        {props.people.map((person) => (
          <label key={person.id} className="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label={`Allow ${account.name} to ${person.name}`}
              checked={allowedUsers.includes(person.id)}
              disabled={props.pending}
              onChange={(event) =>
                setAllowedUsers(toggle(allowedUsers, person.id, event.currentTarget.checked))
              }
            />
            {person.name}
          </label>
        ))}
      </fieldset>
      <div>
        <Button size="sm" type="submit" disabled={props.pending}>
          Save who may use it
        </Button>
      </div>
    </form>
  );
}
