import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type AuthAccount,
  type EnvironmentId,
  MAIN_VAULT_ID,
  secretNameProblem,
  type SpaceId,
  type VaultEntry,
  type VaultEntryId,
  type VaultSummary,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { useEffect, useEffectEvent, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import { fetchAccount } from "../../environments/primary/userAccounts";
import { revealVaultSecret } from "../../environments/primary/vaults";
import { errorMessageOf } from "../../lib/errorMessage";
import { useCurrentSpace } from "../../state/currentSpace";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { emptyStepUp, StepUpFields, toStepUp } from "./AccountSettingsSection";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const SELECT_CLASS = "h-8 w-full rounded-md border border-input bg-background px-2 text-sm";
const VALUE_INPUT_PROPS = {
  // Not a login: no password manager prompt, but hidden as typed.
  type: "text",
  className: "[-webkit-text-security:disc]",
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  "data-1p-ignore": true,
  "data-lpignore": "true",
} as const;

/** The command's answer, or its error's own message (a Vault's errors name secrets, never values). */
async function settle<A, E>(pending: Promise<AtomCommandResult<A, E>>): Promise<A> {
  const result = await pending;
  if (result._tag === "Success") return result.value;
  throw new Error(errorMessageOf(squashAtomCommandFailure(result), "That did not work."));
}

const nameHint = (name: string) => {
  if (name.length === 0) return null;
  switch (secretNameProblem(name)) {
    case "invalid":
      return "Capital letters, digits and _, not starting with a digit.";
    case "reserved":
      return "Reserved: the Hub sets it, or it changes how tools run.";
    default:
      return null;
  }
};

function useVaultCommands() {
  const environmentId = usePrimaryEnvironmentId();
  const commands = {
    list: useAtomCommand(serverEnvironment.listVaults, "list Vaults"),
    create: useAtomCommand(serverEnvironment.createVault, "create a Vault"),
    update: useAtomCommand(serverEnvironment.updateVault, "change a Vault"),
    remove: useAtomCommand(serverEnvironment.deleteVault, "delete a Vault"),
    entries: useAtomCommand(serverEnvironment.listVaultEntries, "list a Vault's secrets"),
    // The input holds a value: keep failures (and their causes) out of the console.
    put: useAtomCommand(serverEnvironment.putVaultEntry, {
      label: "save a secret",
      reportFailure: false,
      reportDefect: false,
    }),
    deleteEntry: useAtomCommand(serverEnvironment.deleteVaultEntry, "delete a secret"),
    link: useAtomCommand(serverEnvironment.linkVaultEntry, "link a secret"),
    copy: useAtomCommand(serverEnvironment.copyVaultEntry, "copy a secret"),
  };
  return { environmentId, commands };
}
type VaultCommands = ReturnType<typeof useVaultCommands>["commands"];

/**
 * Settings → Vaults: named sets of secrets, each under an environment-variable name. The Owner
 * manages them and reveals values; an Organization's Admins add, replace and delete its secrets
 * without seeing them; Members and Guests see names only. See docs/internals/secrets.md.
 */
export function VaultsSettings() {
  const session = usePrimarySessionState();
  const isOwner = session.data?.authenticated === true && session.data.isOwner === true;
  const { environmentId, commands } = useVaultCommands();
  const spaceView = useCurrentSpace((state) => state.view);
  const organizations = (spaceView?.spaces ?? []).filter((space) => space.kind === "organization");
  const [vaults, setVaults] = useState<ReadonlyArray<VaultSummary> | null>(null);
  const [entries, setEntries] = useState<Readonly<Record<string, ReadonlyArray<VaultEntry>>>>({});
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = () => setRevision((value) => value + 1);

  /** Every Vault the User sees, with its names; `_revision` is the change it follows. */
  const fetchVaults = useEffectEvent(async (target: EnvironmentId, _revision: number) => {
    const listed = await settle(commands.list({ environmentId: target, input: {} }));
    const loaded: Record<string, ReadonlyArray<VaultEntry>> = {};
    for (const vault of listed.vaults) {
      const result = await settle(
        commands.entries({ environmentId: target, input: { vaultId: vault.id } }),
      );
      loaded[vault.id] = result.entries;
    }
    return { vaults: listed.vaults, entries: loaded };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the Vaults the signed-in User sees from the Hub, again after each change.
  useEffect(() => {
    if (environmentId === null) return;
    let cancelled = false;
    void fetchVaults(environmentId, revision).then(
      (loaded) => {
        if (cancelled) return;
        setVaults(loaded.vaults);
        setEntries(loaded.entries);
        setError(null);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessageOf(cause, "Could not read the Vaults."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId, revision]);

  const mainEntries = (entries[MAIN_VAULT_ID] ?? []).filter((entry) => entry.kind !== "link");

  return (
    <SettingsPageContainer>
      <SettingsSection id="vaults" title="Vaults">
        <SettingsRow
          title="Secrets for your agents"
          description={
            isOwner
              ? "Each secret reaches agents as an environment variable. Only you reveal values; an Organization's Admins add, replace and delete its secrets without seeing them; Members and Guests see names only."
              : "The secrets your Organizations' agents receive, by name. Values are never shown here."
          }
          status={
            error === null ? null : (
              <span className="text-destructive" role="alert">
                {error}
              </span>
            )
          }
        />
        {isOwner && environmentId !== null ? (
          <NewVaultForm
            organizations={organizations.map((space) => ({ id: space.id, name: space.name }))}
            onCreate={async (input) => {
              await settle(commands.create({ environmentId, input }));
              reload();
            }}
          />
        ) : null}
      </SettingsSection>
      {vaults === null || environmentId === null ? null : vaults.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">No Vault is shared with you.</p>
      ) : (
        vaults.map((vault) => (
          <VaultSection
            key={vault.id}
            environmentId={environmentId}
            commands={commands}
            vault={vault}
            entries={entries[vault.id] ?? []}
            mainEntries={vault.isMain ? [] : mainEntries}
            canUseMain={isOwner}
            onChanged={reload}
          />
        ))
      )}
    </SettingsPageContainer>
  );
}

function NewVaultForm(props: {
  readonly organizations: ReadonlyArray<{ readonly id: SpaceId; readonly name: string }>;
  readonly onCreate: (input: {
    readonly name: string;
    readonly spaceId: SpaceId | null;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [spaceId, setSpaceId] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-2 px-4 pb-4 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        void props
          .onCreate({ name: name.trim(), spaceId: spaceId === "" ? null : (spaceId as SpaceId) })
          .then(
            () => setName(""),
            (cause: unknown) => setError(errorMessageOf(cause, "Could not create the Vault.")),
          )
          .finally(() => setPending(false));
      }}
    >
      <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
        Vault name
        <Input
          aria-label="Vault name"
          nativeInput
          disabled={pending}
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium sm:w-56">
        Organization
        <select
          aria-label="Organization"
          className={SELECT_CLASS}
          disabled={pending}
          value={spaceId}
          onChange={(event) => setSpaceId(event.currentTarget.value)}
        >
          <option value="">Only you (not an Organization's)</option>
          {props.organizations.map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
            </option>
          ))}
        </select>
      </label>
      <Button disabled={pending || name.trim().length === 0} size="sm" type="submit">
        Create Vault
      </Button>
      {error === null ? null : (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

function VaultSection(props: {
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  readonly commands: VaultCommands;
  readonly vault: VaultSummary;
  readonly entries: ReadonlyArray<VaultEntry>;
  readonly mainEntries: ReadonlyArray<VaultEntry>;
  readonly canUseMain: boolean;
  readonly onChanged: () => void;
}) {
  const { vault, commands, environmentId } = props;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const act = (work: () => Promise<string | null | void>) => {
    setError(null);
    setNotice(null);
    return work().then(
      (message) => {
        if (typeof message === "string") setNotice(message);
        props.onChanged();
      },
      (cause: unknown) => setError(errorMessageOf(cause, "That did not work.")),
    );
  };
  const owner = vault.isMain
    ? "Yours alone; reaches Organizations only through links or copies"
    : vault.spaceName === null
      ? "Yours alone"
      : `${vault.spaceName}'s`;
  return (
    <SettingsSection id={`vault-${vault.id}`} title={vault.name}>
      <SettingsRow
        title={`${vault.entryCount} ${vault.entryCount === 1 ? "secret" : "secrets"}`}
        description={`${owner}.${vault.archived ? " Archived." : ""}${vault.canEdit && !vault.canReveal ? " You can add, replace and delete secrets, never see them." : ""}`}
        status={
          error !== null ? (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          ) : notice !== null ? (
            <span className="text-muted-foreground" role="status">
              {notice}
            </span>
          ) : null
        }
        control={
          vault.canManage && !vault.isMain ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Delete Vault ${vault.name}`}
              onClick={() => {
                if (!window.confirm(`Delete ${vault.name} and its secrets?`)) return;
                void act(() =>
                  settle(commands.remove({ environmentId, input: { vaultId: vault.id } })).then(
                    () => null,
                  ),
                );
              }}
            >
              Delete Vault
            </Button>
          ) : null
        }
      />
      <ul
        className="flex flex-col divide-y divide-border/60"
        aria-label={`Secrets in ${vault.name}`}
      >
        {props.entries.map((entry) => (
          <EntryRow
            key={entry.id}
            vault={vault}
            entry={entry}
            onReplace={(value) =>
              act(async () => {
                const result = await settle(
                  commands.put({
                    environmentId,
                    input: {
                      vaultId: vault.id,
                      entryId: entry.id,
                      name: entry.name,
                      value: Redacted.make(value),
                    },
                  }),
                );
                return result.warnings.includes("short-value")
                  ? `${entry.name} replaced. Shorter than 6 characters: it won't be masked in the history.`
                  : `${entry.name} replaced.`;
              })
            }
            onDelete={() =>
              act(async () => {
                const input = { vaultId: vault.id, entryId: entry.id };
                const asked = await settle(commands.deleteEntry({ environmentId, input }));
                if (asked.deleted) return null;
                const names = asked.brokenLinks
                  .map((link) => `${link.vaultName} → ${link.name}`)
                  .join(", ");
                if (!window.confirm(`Deleting ${entry.name} breaks these Secret links: ${names}`)) {
                  return null;
                }
                await settle(
                  commands.deleteEntry({ environmentId, input: { ...input, breakLinks: true } }),
                );
                return null;
              })
            }
          />
        ))}
      </ul>
      {vault.canEdit ? (
        <AddSecretForm
          vaultName={vault.name}
          onAdd={(name, value) =>
            act(async () => {
              const result = await settle(
                commands.put({
                  environmentId,
                  input: { vaultId: vault.id, name, value: Redacted.make(value) },
                }),
              );
              return result.warnings.includes("short-value")
                ? `${name} saved. Shorter than 6 characters: it won't be masked in the history.`
                : `${name} saved.`;
            })
          }
        />
      ) : null}
      {vault.canEdit && props.canUseMain && props.mainEntries.length > 0 ? (
        <FromMainForm
          vaultName={vault.name}
          mainEntries={props.mainEntries}
          onAdd={(kind, sourceEntryId, name) =>
            act(async () => {
              const input = {
                vaultId: vault.id,
                sourceEntryId,
                ...(name.length > 0 ? { name } : {}),
              };
              await settle(
                kind === "link"
                  ? commands.link({ environmentId, input })
                  : commands.copy({ environmentId, input }),
              );
              return null;
            })
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function EntryRow(props: {
  readonly vault: VaultSummary;
  readonly entry: VaultEntry;
  readonly onReplace: (value: string) => Promise<void>;
  readonly onDelete: () => Promise<void>;
}) {
  const { vault, entry } = props;
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState("");
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-sm font-medium">{entry.name}</code>
        {entry.kind === "link" ? (
          entry.broken ? (
            <Badge variant="destructive">broken</Badge>
          ) : (
            <Badge variant="outline">
              linked from Main vault{entry.linkedFrom === null ? "" : ` (${entry.linkedFrom.name})`}
            </Badge>
          )
        ) : entry.kind === "copy" ? (
          <Badge variant="outline">copy</Badge>
        ) : null}
        {entry.unmasked ? <Badge variant="outline">not masked</Badge> : null}
        {entry.description === null ? null : (
          <span className="text-xs text-muted-foreground">{entry.description}</span>
        )}
        <span className="ms-auto flex gap-1">
          {vault.canEdit && entry.kind !== "link" ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Replace value of ${entry.name}`}
              onClick={() => setReplacing((open) => !open)}
            >
              Replace value
            </Button>
          ) : null}
          {vault.canEdit ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Delete ${entry.name}`}
              onClick={() => void props.onDelete()}
            >
              Delete
            </Button>
          ) : null}
        </span>
      </div>
      {replacing ? (
        <form
          className="flex max-w-md gap-2"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void props.onReplace(value).then(() => {
              setValue("");
              setReplacing(false);
            });
          }}
        >
          <Input
            aria-label={`New value of ${entry.name}`}
            nativeInput
            {...VALUE_INPUT_PROPS}
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          <Button disabled={value.length === 0} size="sm" type="submit">
            Save value
          </Button>
        </form>
      ) : null}
      {vault.canReveal && !entry.broken ? <RevealControl vault={vault} entry={entry} /> : null}
    </li>
  );
}

type RevealStage =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "step-up";
      readonly account: AuthAccount;
      readonly stepUp: ReturnType<typeof emptyStepUp>;
    }
  | { readonly _tag: "shown"; readonly value: string };

/** «Reveal»: the Owner's, after their strong factor; the value lives only in this row until hidden. */
function RevealControl(props: { readonly vault: VaultSummary; readonly entry: VaultEntry }) {
  const { entry } = props;
  const [stage, setStage] = useState<RevealStage>({ _tag: "idle" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<void>) => {
    setPending(true);
    setError(null);
    void work()
      .catch((cause: unknown) => setError(errorMessageOf(cause, "Could not reveal it.")))
      .finally(() => setPending(false));
  };
  if (stage._tag === "idle") {
    return (
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Reveal ${entry.name}`}
          disabled={pending}
          onClick={() =>
            run(async () => {
              const account = await fetchAccount();
              setStage({ _tag: "step-up", account, stepUp: emptyStepUp(account) });
            })
          }
        >
          Reveal
        </Button>
        {error === null ? null : (
          <span className="text-xs text-destructive" role="alert">
            {error}
          </span>
        )}
      </div>
    );
  }
  if (stage._tag === "shown") {
    return (
      <div className="flex items-center gap-2">
        <code
          aria-label={`Value of ${entry.name}`}
          className="rounded bg-muted px-2 py-1 text-xs break-all"
        >
          {stage.value}
        </code>
        <Button size="xs" variant="ghost" onClick={() => setStage({ _tag: "idle" })}>
          Hide
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex max-w-sm flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        run(async () => {
          const value = await revealVaultSecret(
            toStepUp(stage.account, stage.stepUp),
            props.vault.id,
            entry.id,
          );
          setStage({ _tag: "shown", value });
        });
      }}
    >
      <StepUpFields
        account={stage.account}
        disabled={pending}
        value={stage.stepUp}
        onChange={(stepUp) => setStage({ ...stage, stepUp })}
      />
      <div className="flex gap-2">
        <Button disabled={pending} size="sm" type="submit">
          {pending ? "Revealing…" : `Confirm and reveal ${entry.name}`}
        </Button>
        <Button
          disabled={pending}
          size="sm"
          variant="ghost"
          onClick={() => setStage({ _tag: "idle" })}
        >
          Cancel
        </Button>
      </div>
      {error === null ? null : (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

function AddSecretForm(props: {
  readonly vaultName: string;
  readonly onAdd: (name: string, value: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const hint = nameHint(name);
  return (
    <form
      aria-label={`Add a secret to ${props.vaultName}`}
      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-end"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        void props
          .onAdd(name, value)
          .then(() => {
            setName("");
            setValue("");
          })
          .finally(() => setPending(false));
      }}
    >
      <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
        Variable name
        <Input
          aria-label="Variable name"
          nativeInput
          disabled={pending}
          maxLength={128}
          spellCheck={false}
          value={name}
          onChange={(event) => setName(event.currentTarget.value.toUpperCase())}
        />
        {hint === null ? null : <span className="font-normal text-destructive">{hint}</span>}
      </label>
      <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
        Value
        <Input
          aria-label="Value"
          nativeInput
          disabled={pending}
          {...VALUE_INPUT_PROPS}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </label>
      <Button
        disabled={pending || hint !== null || name.length === 0 || value.length === 0}
        size="sm"
        type="submit"
      >
        Add secret
      </Button>
    </form>
  );
}

function FromMainForm(props: {
  readonly vaultName: string;
  readonly mainEntries: ReadonlyArray<VaultEntry>;
  readonly onAdd: (
    kind: "link" | "copy",
    sourceEntryId: VaultEntryId,
    name: string,
  ) => Promise<void>;
}) {
  const [source, setSource] = useState<string>(props.mainEntries[0]?.id ?? "");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const add = (kind: "link" | "copy") => {
    if (source === "") return;
    setPending(true);
    void props
      .onAdd(kind, source as VaultEntryId, name)
      .then(() => setName(""))
      .finally(() => setPending(false));
  };
  return (
    <div
      role="group"
      aria-label={`From the Main vault into ${props.vaultName}`}
      className="flex flex-col gap-2 px-4 pb-4 sm:flex-row sm:items-end"
    >
      <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
        Main vault secret
        <select
          aria-label="Main vault secret"
          className={SELECT_CLASS}
          disabled={pending}
          value={source}
          onChange={(event) => setSource(event.currentTarget.value)}
        >
          {props.mainEntries.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
        Name here (optional)
        <Input
          aria-label="Name here"
          nativeInput
          disabled={pending}
          maxLength={128}
          value={name}
          onChange={(event) => setName(event.currentTarget.value.toUpperCase())}
        />
      </label>
      <Button
        disabled={pending || source === ""}
        size="sm"
        variant="outline"
        onClick={() => add("link")}
      >
        Add Secret link
      </Button>
      <Button
        disabled={pending || source === ""}
        size="sm"
        variant="outline"
        onClick={() => add("copy")}
      >
        Add copy
      </Button>
    </div>
  );
}
