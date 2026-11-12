import { fetchInstallationUsers } from "@t3tools/client-runtime/spaces/space-directory";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AiAccountProvider,
  AiAccountStatus,
  AiAccountSummary,
  AiApiKeyProvider,
  EnvironmentId,
  InstallationUser,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
const providerLabel = (provider: AiAccountProvider) =>
  API_KEY_PROVIDERS.find(([value]) => value === provider)?.[1] ?? provider;

const STATUS_LABELS: Readonly<Record<AiAccountStatus, string>> = {
  pending: "Waiting for the AI gateway",
  working: "Working",
  error: "Error",
  "needs-sign-in": "Needs sign-in again",
  "quota-exhausted": "Quota exhausted",
};

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
  const [accounts, setAccounts] = useState<ReadonlyArray<AiAccountSummary> | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [users, setUsers] = useState<ReadonlyArray<InstallationUser>>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useEffectEvent(async (target: EnvironmentId) => {
    const listed = await settle(commands.list({ environmentId: target, input: {} }));
    const people = listed.canManage ? (await fetchUsers()).users : [];
    return { listed, people };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the AI accounts the signed-in User may see from the Hub when the page opens.
  useEffect(() => {
    let cancelled = false;
    void load(environmentId).then(
      ({ listed, people }) => {
        if (cancelled) return;
        setAccounts(listed.accounts);
        setCanManage(listed.canManage);
        setUsers(people);
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

  const move = async (index: number, by: -1 | 1) => {
    if (accounts === null) return;
    const order = accounts.map((account) => account.id);
    const [moved] = order.splice(index, 1);
    if (moved === undefined) return;
    order.splice(index + by, 0, moved);
    try {
      const listed = await settle(
        commands.reorder({ environmentId, input: { accountIds: order } }),
      );
      setAccounts(listed.accounts);
    } catch (cause) {
      setError(errorMessageOf(cause, "Could not change the order."));
    }
  };

  return (
    <>
      <SettingsSection id="ai-accounts" title="AI accounts">
        <SettingsRow
          title={canManage ? "Your AI accounts" : "AI accounts you may use"}
          description={
            canManage
              ? "API keys the Hub's AI gateway uses for your team's agents, tried first to last. A key never leaves the Hub and is never shown again: replace it to change it. Allow each account to Spaces (everyone who works there) or to Users."
              : "The AI accounts your agents may use in your Spaces. Only the Owner adds or changes them."
          }
          status={
            error === null ? null : (
              <span className="text-destructive" role="alert">
                {error}
              </span>
            )
          }
        />
        {canManage ? (
          <NewAccountForm environmentId={environmentId} commands={commands} onAdded={refresh} />
        ) : null}
      </SettingsSection>
      {accounts === null ? null : accounts.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">
          {canManage ? "No AI account yet." : "No AI account is allowed to you."}
        </p>
      ) : (
        <ul aria-label="AI accounts" className="flex flex-col gap-4">
          {accounts.map((account, index) => (
            <li key={account.id}>
              <AccountSection
                environmentId={environmentId}
                commands={commands}
                account={account}
                canManage={canManage}
                spaces={spaces}
                people={people}
                spaceName={spaceName}
                first={index === 0}
                last={index === accounts.length - 1}
                onMove={(by) => move(index, by)}
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
  const modelList = models
    .split(/[\s,]+/u)
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
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
  readonly onMove: (by: -1 | 1) => Promise<void>;
  readonly onChanged: () => Promise<void>;
}) {
  const { account, commands, environmentId } = props;
  const details = account.details;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [allowedSpaces, setAllowedSpaces] = useState<ReadonlyArray<string>>(
    details?.allowances.spaceIds ?? [],
  );
  const [allowedUsers, setAllowedUsers] = useState<ReadonlyArray<string>>(
    details?.allowances.userIds ?? [],
  );

  const act = async (work: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await work();
      await props.onChanged();
      return true;
    } catch (cause) {
      setError(errorMessageOf(cause, "That did not work."));
      return false;
    } finally {
      setPending(false);
    }
  };
  const toggle = (list: ReadonlyArray<string>, id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((item) => item !== id);

  return (
    <SettingsSection id={`ai-account-${account.id}`} title={account.name}>
      <SettingsRow
        title={providerLabel(account.provider)}
        description={
          details === null
            ? `Usable in ${account.usableIn.map(props.spaceName).join(", ")}.`
            : [
                `Priority ${account.priority}.`,
                details.keyHint === null ? null : `Key ending in …${details.keyHint}.`,
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
              variant={account.status === "error" ? "destructive" : "secondary"}
            >
              {account.disabled ? "Disabled" : STATUS_LABELS[account.status]}
            </Badge>
          </span>
        }
        status={
          error !== null ? (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          ) : account.statusMessage === null ? null : (
            <span>{account.statusMessage}</span>
          )
        }
      />
      {props.canManage && details !== null ? (
        <div className="flex flex-col gap-3 px-4 pb-4">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending || props.first}
              aria-label={`Move ${account.name} up`}
              onClick={() => void props.onMove(-1)}
            >
              Up
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || props.last}
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
              onClick={() =>
                void act(() =>
                  settle(
                    commands.update({
                      environmentId,
                      input: { accountId: account.id, disabled: !account.disabled },
                    }),
                  ),
                )
              }
            >
              {account.disabled ? "Enable" : "Disable"}
            </Button>
            {confirmDelete ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                aria-label={`Confirm delete ${account.name}`}
                onClick={() =>
                  void act(() =>
                    settle(commands.remove({ environmentId, input: { accountId: account.id } })),
                  )
                }
              >
                Delete for good
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
          <form
            aria-label={`Replace credential of ${account.name}`}
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void act(() =>
                settle(
                  commands.update({
                    environmentId,
                    input: { accountId: account.id, apiKey: Redacted.make(newKey.trim()) },
                  }),
                ),
              ).then((saved) => {
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
          <form
            aria-label={`Who may use ${account.name}`}
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void act(() =>
                settle(
                  commands.allow({
                    environmentId,
                    input: {
                      accountId: account.id,
                      spaceIds: allowedSpaces as ReadonlyArray<SpaceId>,
                      userIds: allowedUsers as ReadonlyArray<UserId>,
                    },
                  }),
                ),
              );
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
                    disabled={pending}
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
                    disabled={pending}
                    onChange={(event) =>
                      setAllowedUsers(toggle(allowedUsers, person.id, event.currentTarget.checked))
                    }
                  />
                  {person.name}
                </label>
              ))}
            </fieldset>
            <div>
              <Button size="sm" type="submit" disabled={pending}>
                Save who may use it
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </SettingsSection>
  );
}
