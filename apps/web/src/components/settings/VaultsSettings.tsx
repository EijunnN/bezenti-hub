import { useAtomValue } from "@effect/atom-react";
import {
  type AuthAccount,
  type EnvironmentId,
  MAIN_VAULT_ID,
  secretNameRisk,
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
import { SpaceDefaultVaults, VaultAllowances } from "./VaultChoices";
import { SELECT_CLASS, settle } from "./vaultCommands";

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
/** A revealed value stays on screen this long, at most. */
const REVEAL_MS = 60_000;
const CONFIRM_DANGEROUS = "This value changes how tools run";

const nameHint = (name: string, isOwner: boolean) => {
  if (name.length === 0) return null;
  switch (secretNameRisk(name)) {
    case "invalid":
      return "Capital letters, digits and _, not starting with a digit.";
    case "gateway":
      return "Reserved: the Hub sets it.";
    case "dangerous":
      return isOwner
        ? "It changes how the agent's tools run or whom they trust: confirm to save it."
        : "It changes how the agent's tools run or whom they trust: only the Owner sets it.";
    default:
      return null;
  }
};
const isDangerous = (name: string) => secretNameRisk(name) === "dangerous";

/** The Owner's explicit confirmation for a name that changes how tools run. */
function ConfirmDangerous(props: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs font-medium text-destructive">
      <input
        type="checkbox"
        aria-label={CONFIRM_DANGEROUS}
        checked={props.checked}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      {CONFIRM_DANGEROUS}
    </label>
  );
}

function useVaultCommands() {
  return {
    list: useAtomCommand(serverEnvironment.listVaults, "list Vaults"),
    create: useAtomCommand(serverEnvironment.createVault, "create a Vault"),
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
}
type VaultCommands = ReturnType<typeof useVaultCommands>;

/**
 * Settings → Vaults: named sets of secrets, each under an environment-variable name. The Owner
 * manages them and reveals values; an Organization's Admins add, replace and delete its secrets
 * without seeing them; Members and Guests see names only. See docs/internals/secrets.md.
 */
export function VaultsSettings() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId === null ? null : <VaultsPage environmentId={environmentId} />}
    </SettingsPageContainer>
  );
}

function VaultsPage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const session = usePrimarySessionState();
  const isOwner = session.data?.authenticated === true && session.data.isOwner === true;
  const commands = useVaultCommands();
  // The session may change secrets at all (access:write); each Vault then says what is allowed.
  const mayWrite = useAtomValue(serverEnvironment.putVaultEntry.permissionAtom(environmentId));
  const mayCreate = useAtomValue(serverEnvironment.createVault.permissionAtom(environmentId));
  const spaceView = useCurrentSpace((state) => state.view);
  const organizations = (spaceView?.spaces ?? []).filter((space) => space.kind === "organization");
  const [vaults, setVaults] = useState<ReadonlyArray<VaultSummary> | null>(null);
  const [entries, setEntries] = useState<Readonly<Record<string, ReadonlyArray<VaultEntry>>>>({});
  const [error, setError] = useState<string | null>(null);

  const listVaults = () => settle(commands.list({ environmentId, input: {} }));
  const listEntries = (vaultId: VaultSummary["id"]) =>
    settle(commands.entries({ environmentId, input: { vaultId } })).then(
      (result) => [vaultId, result.entries] as const,
    );

  /** Every Vault the User sees, their names read in parallel. */
  const fetchAll = useEffectEvent(async (target: EnvironmentId) => {
    const listed = await settle(commands.list({ environmentId: target, input: {} }));
    const loaded = await Promise.all(
      listed.vaults.map(async (vault) => {
        const result = await settle(
          commands.entries({ environmentId: target, input: { vaultId: vault.id } }),
        );
        return [vault.id, result.entries] as const;
      }),
    );
    return { vaults: listed.vaults, entries: Object.fromEntries(loaded) };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the Vaults the signed-in User sees from the Hub when the page opens.
  useEffect(() => {
    let cancelled = false;
    void fetchAll(environmentId).then(
      (loaded) => {
        if (cancelled) return;
        setVaults(loaded.vaults);
        setEntries(loaded.entries);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessageOf(cause, "Could not read the Vaults."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  /** After a change: the list (counts) and the one Vault that changed; every Vault for `all`. */
  const refresh = async (changed: VaultSummary["id"] | "all") => {
    try {
      const listed = await listVaults();
      const targets =
        changed === "all"
          ? listed.vaults.map((vault) => vault.id)
          : listed.vaults.filter((vault) => vault.id === changed).map((vault) => vault.id);
      const loaded = await Promise.all(targets.map(listEntries));
      setVaults(listed.vaults);
      setEntries((previous) => ({ ...previous, ...Object.fromEntries(loaded) }));
      setError(null);
    } catch (cause) {
      setError(errorMessageOf(cause, "Could not read the Vaults."));
    }
  };

  const mainEntries = (entries[MAIN_VAULT_ID] ?? []).filter((entry) => entry.kind !== "link");

  return (
    <>
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
        {isOwner && mayCreate ? (
          <NewVaultForm
            organizations={organizations.map((space) => ({ id: space.id, name: space.name }))}
            onCreate={async (input) => {
              await settle(commands.create({ environmentId, input }));
              await refresh("all");
            }}
          />
        ) : null}
      </SettingsSection>
      {vaults === null ? null : vaults.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">No Vault is shared with you.</p>
      ) : (
        vaults.map((vault) => (
          <VaultSection
            key={vault.id}
            environmentId={environmentId}
            commands={commands}
            vault={vault}
            mayWrite={mayWrite}
            isOwner={isOwner}
            entries={entries[vault.id] ?? []}
            mainEntries={vault.isMain ? [] : mainEntries}
            onChanged={(all) => refresh(all ? "all" : vault.id)}
          />
        ))
      )}
      <SpaceDefaultVaults environmentId={environmentId} />
    </>
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

/** Runs a change: resolves true once it is saved, false when it failed (and says why). */
type Act = (work: () => Promise<string | null>, all?: boolean) => Promise<boolean>;

function VaultSection(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: VaultCommands;
  readonly vault: VaultSummary;
  readonly mayWrite: boolean;
  readonly isOwner: boolean;
  readonly entries: ReadonlyArray<VaultEntry>;
  readonly mainEntries: ReadonlyArray<VaultEntry>;
  readonly onChanged: (all: boolean) => Promise<void>;
}) {
  const { vault, commands, environmentId } = props;
  const canEdit = vault.canEdit && props.mayWrite;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const act: Act = async (work, all = false) => {
    setError(null);
    setNotice(null);
    try {
      const message = await work();
      if (message !== null) setNotice(message);
      await props.onChanged(all);
      return true;
    } catch (cause) {
      setError(errorMessageOf(cause, "That did not work."));
      return false;
    }
  };
  const savedMessage = (name: string, verb: string, warnings: ReadonlyArray<string>) =>
    warnings.includes("short-value")
      ? `${name} ${verb}. Shorter than 6 characters: it won't be masked in the history.`
      : `${name} ${verb}.`;
  const owner = vault.isMain
    ? "Yours alone; reaches Organizations only through links or copies"
    : vault.spaceName === null
      ? "Yours alone"
      : `${vault.spaceName}'s`;
  return (
    <SettingsSection id={`vault-${vault.id}`} title={vault.name}>
      <SettingsRow
        title={`${vault.entryCount} ${vault.entryCount === 1 ? "secret" : "secrets"}`}
        description={`${owner}.${vault.archived ? " Archived." : ""}${canEdit && !vault.canReveal ? " You can add, replace and delete secrets, never see them." : ""}`}
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
          vault.canManage && props.mayWrite && !vault.isMain ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Delete Vault ${vault.name}`}
              onClick={() => {
                if (!window.confirm(`Delete ${vault.name} and its secrets?`)) return;
                void act(async () => {
                  await settle(commands.remove({ environmentId, input: { vaultId: vault.id } }));
                  return null;
                }, true);
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
            canEdit={canEdit}
            isOwner={props.isOwner}
            entry={entry}
            onReplace={(value, confirmDangerous) =>
              act(async () => {
                const result = await settle(
                  commands.put({
                    environmentId,
                    input: {
                      vaultId: vault.id,
                      entryId: entry.id,
                      name: entry.name,
                      value: Redacted.make(value),
                      ...(confirmDangerous ? { confirmDangerous } : {}),
                    },
                  }),
                );
                return savedMessage(entry.name, "replaced", result.warnings);
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
              }, vault.isMain)
            }
          />
        ))}
      </ul>
      {canEdit ? (
        <AddSecretForm
          vaultName={vault.name}
          isOwner={props.isOwner}
          onAdd={(name, value, confirmDangerous) =>
            act(async () => {
              const result = await settle(
                commands.put({
                  environmentId,
                  input: {
                    vaultId: vault.id,
                    name,
                    value: Redacted.make(value),
                    ...(confirmDangerous ? { confirmDangerous } : {}),
                  },
                }),
              );
              return savedMessage(name, "saved", result.warnings);
            })
          }
        />
      ) : null}
      {canEdit && props.isOwner && props.mainEntries.length > 0 ? (
        <FromMainForm
          vaultName={vault.name}
          mainEntries={props.mainEntries}
          onAdd={(kind, sourceEntryId, name, confirmDangerous) =>
            act(async () => {
              const input = {
                vaultId: vault.id,
                sourceEntryId,
                ...(name.length > 0 ? { name } : {}),
                ...(confirmDangerous ? { confirmDangerous } : {}),
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
      {vault.canManage && props.mayWrite && !vault.isMain && vault.spaceId === null ? (
        <VaultAllowances
          environmentId={environmentId}
          vault={vault}
          onChanged={() => props.onChanged(false)}
        />
      ) : null}
    </SettingsSection>
  );
}

function EntryRow(props: {
  readonly vault: VaultSummary;
  readonly canEdit: boolean;
  readonly isOwner: boolean;
  readonly entry: VaultEntry;
  readonly onReplace: (value: string, confirmDangerous: boolean) => Promise<boolean>;
  readonly onDelete: () => Promise<boolean>;
}) {
  const { vault, entry } = props;
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const dangerous = isDangerous(entry.name);
  // Someone else's dangerous name: replacing it is the Owner's alone.
  const mayReplace = props.canEdit && entry.kind !== "link" && (!dangerous || props.isOwner);
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
        {dangerous ? <Badge variant="outline">changes how tools run</Badge> : null}
        {entry.description === null ? null : (
          <span className="text-xs text-muted-foreground">{entry.description}</span>
        )}
        <span className="ms-auto flex gap-1">
          {mayReplace ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Replace value of ${entry.name}`}
              onClick={() => setReplacing((open) => !open)}
            >
              Replace value
            </Button>
          ) : null}
          {props.canEdit ? (
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
          className="flex max-w-md flex-col gap-2"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void props.onReplace(value, confirmed).then((saved) => {
              // A failed save keeps what was typed.
              if (!saved) return;
              setValue("");
              setConfirmed(false);
              setReplacing(false);
            });
          }}
        >
          <div className="flex gap-2">
            <Input
              aria-label={`New value of ${entry.name}`}
              nativeInput
              {...VALUE_INPUT_PROPS}
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
            <Button
              disabled={value.length === 0 || (dangerous && !confirmed)}
              size="sm"
              type="submit"
            >
              Save value
            </Button>
          </div>
          {dangerous ? <ConfirmDangerous checked={confirmed} onChange={setConfirmed} /> : null}
        </form>
      ) : null}
      {vault.canReveal && !entry.broken ? (
        // A new version hides a value revealed before it.
        <RevealControl key={`${entry.id}:${entry.version}`} vault={vault} entry={entry} />
      ) : null}
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

/** «Reveal»: the Owner's, after their strong factor; shown for a minute at most, then hidden. */
function RevealControl(props: { readonly vault: VaultSummary; readonly entry: VaultEntry }) {
  const { entry } = props;
  const [stage, setStage] = useState<RevealStage>({ _tag: "idle" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = stage._tag === "shown";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hides a revealed value after REVEAL_MS, so it does not stay on an unattended screen.
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setStage({ _tag: "idle" }), REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);
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
  readonly isOwner: boolean;
  readonly onAdd: (name: string, value: string, confirmDangerous: boolean) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const hint = nameHint(name, props.isOwner);
  const dangerous = isDangerous(name);
  const blocked =
    secretNameRisk(name) === "invalid" ||
    secretNameRisk(name) === "gateway" ||
    (dangerous && (!props.isOwner || !confirmed));
  return (
    <form
      aria-label={`Add a secret to ${props.vaultName}`}
      className="flex flex-col gap-2 px-4 py-3"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        void props
          .onAdd(name, value, dangerous && confirmed)
          .then((saved) => {
            // A failed save keeps what was typed.
            if (!saved) return;
            setName("");
            setValue("");
            setConfirmed(false);
          })
          .finally(() => setPending(false));
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
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
          disabled={pending || blocked || name.length === 0 || value.length === 0}
          size="sm"
          type="submit"
        >
          Add secret
        </Button>
      </div>
      {hint === null ? null : <span className="text-xs text-destructive">{hint}</span>}
      {dangerous && props.isOwner ? (
        <ConfirmDangerous checked={confirmed} onChange={setConfirmed} />
      ) : null}
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
    confirmDangerous: boolean,
  ) => Promise<boolean>;
}) {
  const [source, setSource] = useState<string>(props.mainEntries[0]?.id ?? "");
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const effectiveName =
    name.length > 0 ? name : (props.mainEntries.find((entry) => entry.id === source)?.name ?? "");
  const dangerous = isDangerous(effectiveName);
  const add = (kind: "link" | "copy") => {
    if (source === "") return;
    setPending(true);
    void props
      .onAdd(kind, source as VaultEntryId, name, dangerous && confirmed)
      .then((saved) => {
        if (!saved) return;
        setName("");
        setConfirmed(false);
      })
      .finally(() => setPending(false));
  };
  const disabled = pending || source === "" || (dangerous && !confirmed);
  return (
    <div
      role="group"
      aria-label={`From the Main vault into ${props.vaultName}`}
      className="flex flex-col gap-2 px-4 pb-4"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
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
        <Button disabled={disabled} size="sm" variant="outline" onClick={() => add("link")}>
          Add Secret link
        </Button>
        <Button disabled={disabled} size="sm" variant="outline" onClick={() => add("copy")}>
          Add copy
        </Button>
      </div>
      {dangerous ? <ConfirmDangerous checked={confirmed} onChange={setConfirmed} /> : null}
    </div>
  );
}
