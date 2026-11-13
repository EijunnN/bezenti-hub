import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AiGatewayKeyListResult,
  AiGatewayUserKey,
  EnvironmentId,
  SpaceId,
} from "@t3tools/contracts";
import { gatewayOrigin, localCliSetup } from "@t3tools/shared/aiGatewayLocalCli";
import { useAtomValue } from "@effect/atom-react";
import * as Redacted from "effect/Redacted";
import { useEffect, useEffectEvent, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { readHubLinkOrigin } from "../../hubLinks";
import { errorMessageOf } from "../../lib/errorMessage";
import { aiGatewayEnvironment } from "../../state/aiGateway";
import { useCurrentSpace } from "../../state/currentSpace";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type Tool = "claude-code" | "codex";
const TOOLS: ReadonlyArray<readonly [Tool, string]> = [
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
];
const SETUP_HINTS: Readonly<Record<Tool, string>> = {
  "claude-code": "Put this in ~/.claude/settings.json (merge it into the env of a file you have).",
  codex: "Put this in ~/.codex/config.toml; the key goes in your shell's environment, not there.",
};

type ListAnswer = AtomCommandResult<AiGatewayKeyListResult, unknown>;
/** What a list answer shows: the keys, or why they could not be read. */
const listedOutcome = (result: ListAnswer) =>
  result._tag === "Success"
    ? ({ listed: result.value, error: null } as const)
    : ({
        listed: null,
        error: errorMessageOf(
          squashAtomCommandFailure(result),
          "Could not read your local CLI keys.",
        ),
      } as const);

function useKeyCommands() {
  return {
    list: useAtomCommand(aiGatewayEnvironment.listKeys, "list your local CLI keys"),
    create: useAtomCommand(aiGatewayEnvironment.createKey, "make a local CLI key"),
    revoke: useAtomCommand(aiGatewayEnvironment.revokeKey, "revoke a local CLI key"),
  };
}

const formatWhen = (iso: string | null) =>
  iso === null
    ? "Never"
    : new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Settings → AI accounts → «Local CLI keys» (spec 4 ticket 10): a User's own gateway keys for
 * Claude Code or Codex on their machine, each for one Space they work in. A key is shown once,
 * right after it is made; the Hub keeps only its hash. The Owner sees and revokes everyone's.
 */
export function LocalCliKeysSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const commands = useKeyCommands();
  const spaceView = useCurrentSpace((state) => state.view);
  // The session may hand out credentials at all (access:write); the Hub decides the rest.
  const mayCreate = useAtomValue(aiGatewayEnvironment.createKey.permissionAtom(environmentId));
  const mayRevoke = useAtomValue(aiGatewayEnvironment.revokeKey.permissionAtom(environmentId));
  const [listed, setListed] = useState<AiGatewayKeyListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("claude-code");
  const [made, setMade] = useState<{
    readonly key: AiGatewayUserKey;
    readonly secret: string;
  } | null>(null);
  const [revoking, setRevoking] = useState<AiGatewayUserKey | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>({
    onError: (cause) => setError(errorMessageOf(cause, "Could not copy it.")),
  });
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (what: string, text: string) => {
    setCopied(what);
    copyToClipboard(text, what);
  };

  const origin = gatewayOrigin(readHubLinkOrigin(environmentId) ?? "");

  const showListed = (result: ListAnswer) => {
    const outcome = listedOutcome(result);
    if (outcome.listed !== null) setListed(outcome.listed);
    setError(outcome.error);
  };
  const applyListed = useEffectEvent(showListed);
  const loadKeys = useEffectEvent((target: EnvironmentId) =>
    commands.list({ environmentId: target, input: {} }),
  );
  const load = async (target: EnvironmentId) =>
    showListed(await commands.list({ environmentId: target, input: {} }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the signed-in User's local CLI keys from the Hub when the section opens.
  useEffect(() => {
    let cancelled = false;
    void loadKeys(environmentId).then((result) => {
      if (!cancelled) applyListed(result);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  // The Spaces the User works in: where they may start Threads (the Hub checks again).
  const spaces = (spaceView?.spaces ?? [])
    .filter((space) => space.canCreateThreads && space.archived !== true && space.frozen !== true)
    .map((space) => ({
      value: space.id,
      label: space.kind === "personal" ? `${space.name} (personal)` : space.name,
    }));

  const setupFor = (secret: string | null) => {
    if (origin === null) return null;
    const setup = localCliSetup(origin, secret);
    return tool === "claude-code"
      ? { file: setup.claudeCode, shell: null }
      : { file: setup.codex, shell: setup.codexShell };
  };

  const revoke = async (key: AiGatewayUserKey) => {
    setRevokePending(true);
    const result = await commands.revoke({ environmentId, input: { keyId: key.keyId } });
    setRevokePending(false);
    setRevoking(null);
    if (result._tag === "Success") {
      setListed(result.value);
      if (made?.key.keyId === key.keyId) setMade(null);
      setError(null);
    } else {
      setError(errorMessageOf(squashAtomCommandFailure(result), "Could not revoke the key."));
    }
  };

  const madeSetup = made === null ? null : setupFor(made.secret);
  return (
    <SettingsSection id="local-cli-keys" title="Local CLI keys">
      <SettingsRow
        title="Your keys for local CLIs"
        description={
          listed?.everyone === true
            ? "Point Claude Code or Codex on your own machine at this Hub's AI gateway. Each key is for one Space and uses the AI accounts allowed to you there; its use counts as yours. You see and may revoke every User's keys."
            : "Point Claude Code or Codex on your own machine at this Hub's AI gateway. Each key is for one Space and uses the AI accounts allowed to you there; its use counts as yours. A key is shown once, when you make it."
        }
        status={
          error === null ? null : (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          )
        }
      />
      <div className="flex flex-col gap-1 px-4 pb-2 text-xs font-medium">
        Setup for
        <ToggleGroup
          aria-label="Setup for"
          value={[tool]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "claude-code" || value === "codex") setTool(value);
          }}
        >
          {TOOLS.map(([value, label]) => (
            <Toggle key={value} value={value}>
              {label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      {mayCreate ? (
        <NewKeyForm
          environmentId={environmentId}
          spaces={spaces}
          defaultSpaceId={spaceView?.personalSpaceId ?? null}
          create={commands.create}
          onMade={(key, secret) => {
            setMade({ key, secret });
            void load(environmentId);
          }}
        />
      ) : null}
      {made === null ? null : (
        <section
          aria-label="New key"
          className="mx-4 mb-4 flex flex-col gap-2 rounded-md border border-border p-3 text-sm"
        >
          <p className="font-medium">
            Copy «{made.key.name}» now: it is not shown again. Anyone with it uses your AI accounts
            in {made.key.spaceName ?? "its Space"}.
          </p>
          <code aria-label="Key" className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
            {made.secret}
          </code>
          {madeSetup === null ? null : (
            <>
              <p className="text-xs text-muted-foreground">{SETUP_HINTS[tool]}</p>
              <pre
                aria-label="Setup"
                className="overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs"
              >
                {madeSetup.file}
              </pre>
              {madeSetup.shell === null ? null : (
                <pre
                  aria-label="Shell line"
                  className="overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs"
                >
                  {madeSetup.shell}
                </pre>
              )}
            </>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => copy("key", made.secret)}>
              {isCopied && copied === "key" ? "Copied" : "Copy key"}
            </Button>
            {madeSetup === null ? null : (
              <Button size="sm" variant="outline" onClick={() => copy("setup", madeSetup.file)}>
                {isCopied && copied === "setup" ? "Copied" : "Copy setup"}
              </Button>
            )}
            {madeSetup?.shell == null ? null : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => copy("shell", madeSetup.shell ?? "")}
              >
                {isCopied && copied === "shell" ? "Copied" : "Copy shell line"}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setMade(null)}>
              Done
            </Button>
          </div>
        </section>
      )}
      {listed === null ? null : listed.keys.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">No local CLI key yet.</p>
      ) : (
        <ul aria-label="Local CLI keys" className="flex flex-col gap-2 px-4 pb-4">
          {listed.keys.map((key) => {
            const setup = setupFor(null);
            return (
              <li
                key={key.keyId}
                aria-label={key.name}
                className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-medium">{key.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {[
                      listed.everyone ? (key.userName ?? key.userId) : null,
                      key.spaceName ?? "A Space that no longer exists",
                      `Created ${formatWhen(key.createdAt)}`,
                      `Last used ${formatWhen(key.lastUsedAt)}`,
                    ]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {setup === null ? null : (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Copy setup for ${key.name}`}
                      onClick={() => copy(key.keyId, setup.file)}
                    >
                      {isCopied && copied === key.keyId ? "Copied" : "Copy setup"}
                    </Button>
                  )}
                  {mayRevoke ? (
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      aria-label={`Revoke ${key.name}`}
                      onClick={() => setRevoking(key)}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !revokePending) setRevoking(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke «{revoking?.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Any CLI using it stops at its next request. This cannot be undone: make a new key to
              use the gateway again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={revokePending}
              render={<Button variant="outline" disabled={revokePending} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={revokePending || revoking === null}
              onClick={() => {
                if (revoking !== null) void revoke(revoking);
              }}
            >
              Revoke key
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

function NewKeyForm(props: {
  readonly environmentId: EnvironmentId;
  readonly spaces: ReadonlyArray<{ readonly value: SpaceId; readonly label: string }>;
  readonly defaultSpaceId: SpaceId | null;
  readonly create: ReturnType<typeof useKeyCommands>["create"];
  readonly onMade: (key: AiGatewayUserKey, secret: string) => void;
}) {
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<SpaceId | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fallback =
    props.spaces.find((space) => space.value === props.defaultSpaceId)?.value ??
    props.spaces[0]?.value ??
    null;
  const spaceId = chosen ?? fallback;
  const ready = name.trim().length > 0 && spaceId !== null;
  return (
    <form
      aria-label="Create a local CLI key"
      className="flex flex-col gap-2 px-4 pb-4 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        if (spaceId === null) return;
        setPending(true);
        setError(null);
        void props
          .create({ environmentId: props.environmentId, input: { name: name.trim(), spaceId } })
          .then((result) => {
            if (result._tag === "Success") {
              setName("");
              props.onMade(result.value.created, Redacted.value(result.value.key));
            } else {
              setError(errorMessageOf(squashAtomCommandFailure(result), "Could not make the key."));
            }
          })
          .finally(() => setPending(false));
      }}
    >
      <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
        Key name
        <Input
          aria-label="Key name"
          nativeInput
          disabled={pending}
          maxLength={80}
          placeholder="Work laptop"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium sm:w-64">
        Space
        <Select
          disabled={pending || props.spaces.length === 0}
          items={[...props.spaces]}
          value={spaceId}
          onValueChange={(value) => {
            if (value !== null) setChosen(value as SpaceId);
          }}
        >
          <SelectTrigger aria-label="Space">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {props.spaces.map((space) => (
              <SelectItem key={space.value} value={space.value}>
                {space.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>
      <div className="flex items-center gap-2">
        <Button disabled={pending || !ready} size="sm" type="submit">
          Create key
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
