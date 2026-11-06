import { pipe } from "effect/Function";
import { ChevronsLeftRightEllipsisIcon, GlobeIcon, PlusIcon, TerminalIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  type DesktopDiscoveredSshHost,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { normalizeHubUrl, startAppSignIn } from "@t3tools/client-runtime/authorization";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { cn } from "../../lib/utils";
import { formatDesktopSshTarget } from "./EnvironmentRow";
import { Input } from "../ui/input";
import { CommandShortcut } from "../ui/command";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { AnimatedHeight } from "../AnimatedHeight";
import {
  connectAppSignIn as connectAppSignInAtom,
  connectPairing as connectPairingAtom,
  connectSshEnvironment as connectSshEnvironmentAtom,
} from "~/connection/onboarding";
import { useEnvironmentQuery } from "~/state/query";
import { desktopSshHostsStateAtom, filterDiscoveredSshHosts } from "~/state/desktopSshHosts";
import type { EnvironmentPresentation } from "~/state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { primaryServerKeybindingsAtom } from "~/state/server";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
} from "../../keybindings";
import {
  parseManualDesktopSshTarget,
  parsePairingUrlFields,
  parseRemotePairingFields,
  formatDesktopSshConnectionError,
} from "./ConnectionsSettings.logic";

const EMPTY_DISCOVERED_SSH_HOSTS: ReadonlyArray<DesktopDiscoveredSshHost> = [];
const APP_SIGN_IN_CRYPTO = Layer.merge(SecureRandom.layerWebCrypto, Digest.layerWebCrypto);

type ConnectionMode = "hub" | "remote" | "ssh";

export function AddEnvironmentDialog({
  open,
  routeTarget,
  error,
  savedEnvironments,
  onOpenChange,
  onErrorChange,
}: {
  readonly open: boolean;
  readonly routeTarget: EnvironmentPresentation | null;
  readonly error: string | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onErrorChange: (error: string | null) => void;
}) {
  const desktopBridge = window.desktopBridge;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const connectAppSignIn = useAtomCommand(connectAppSignInAtom, { reportFailure: false });
  // The desktop app adds a Hub by its address and signs in in the system browser. A pairing
  // code stays for the web app, which cannot receive the browser's answer.
  const defaultMode: ConnectionMode = desktopBridge ? "hub" : "remote";
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });
  const savedDesktopSshEnvironmentKeys = (() => {
    const keys = new Set<string>();
    for (const environment of savedEnvironments) {
      const profile = environment.entry.profile;
      if (
        environment.entry.target._tag !== "SshConnectionTarget" ||
        Option.isNone(profile) ||
        profile.value._tag !== "SshConnectionProfile"
      ) {
        continue;
      }
      const target = profile.value.target;
      keys.add(target.alias);
      keys.add(formatDesktopSshTarget(target));
    }
    return keys;
  })();
  const [savedBackendMode, setSavedBackendMode] = useState<ConnectionMode>(defaultMode);
  const [hubAddress, setHubAddress] = useState("");
  const hubSignInStateRef = useRef<string | null>(null);
  const [savedBackendHost, setSavedBackendHost] = useState("");
  const [savedBackendPairingCode, setSavedBackendPairingCode] = useState("");
  const [savedBackendSshHost, setSavedBackendSshHost] = useState("");
  const [savedBackendSshUsername, setSavedBackendSshUsername] = useState("");
  const [savedBackendSshPort, setSavedBackendSshPort] = useState("");
  const [sshHostSuggestionsOpen, setSshHostSuggestionsOpen] = useState(false);
  const highlightedSshHostRef = useRef<DesktopDiscoveredSshHost | undefined>(undefined);
  const [isAddingSavedBackend, setIsAddingSavedBackend] = useState(false);
  const savedBackendSessionRef = useRef(0);
  const isSshDiscoveryActive = desktopBridge !== undefined && open && savedBackendMode === "ssh";
  const desktopSshHosts = useEnvironmentQuery(
    isSshDiscoveryActive ? desktopSshHostsStateAtom : null,
  );
  // The discovery atom is kept alive across dialog opens, so re-read SSH config
  // each time the SSH tab is shown; stale hosts stay visible while it refreshes.
  const refreshDesktopSshHosts = desktopSshHosts.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rereads desktop SSH config through the bridge each time the SSH tab is shown
  useEffect(() => {
    if (isSshDiscoveryActive) refreshDesktopSshHosts();
  }, [isSshDiscoveryActive, refreshDesktopSshHosts]);
  const discoveredSshHosts = desktopSshHosts.data ?? EMPTY_DISCOVERED_SSH_HOSTS;
  const unsavedDiscoveredSshHosts = discoveredSshHosts.filter((target) => {
    const address = formatDesktopSshTarget(target);
    return (
      !savedDesktopSshEnvironmentKeys.has(target.alias) &&
      (target.source === "ssh-config" || !savedDesktopSshEnvironmentKeys.has(address))
    );
  });
  const filteredDiscoveredSshHosts = filterDiscoveredSshHosts(
    unsavedDiscoveredSshHosts,
    savedBackendSshHost,
  );
  const isLoadingDiscoveredSshHosts = desktopSshHosts.isPending && desktopSshHosts.data === null;
  const discoveredSshHostsError = desktopSshHosts.error;
  const hasSshHostSuggestionContent =
    desktopBridge !== undefined &&
    (isLoadingDiscoveredSshHosts || unsavedDiscoveredSshHosts.length > 0);
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      savedBackendSessionRef.current += 1;
      setSavedBackendMode(defaultMode);
      setHubAddress("");
      if (hubSignInStateRef.current !== null) {
        void desktopBridge?.cancelSignInToHub(hubSignInStateRef.current).catch(() => undefined);
        hubSignInStateRef.current = null;
      }
      setSavedBackendHost("");
      setSavedBackendPairingCode("");
      setSavedBackendSshHost("");
      setSavedBackendSshUsername("");
      setSavedBackendSshPort("");
    }
    onOpenChange(nextOpen);
  };
  const connectSavedBackendSshTarget = async (target: DesktopSshEnvironmentTarget) => {
    const session = savedBackendSessionRef.current;
    setIsAddingSavedBackend(true);
    onErrorChange(null);
    const result = await connectSshEnvironment({
      target,
      label: "",
      ...(routeTarget ? { expectedEnvironmentId: routeTarget.environmentId } : {}),
    });
    if (result._tag === "Failure") {
      if (session === savedBackendSessionRef.current && !isAtomCommandInterrupted(result)) {
        pipe(squashAtomCommandFailure(result), formatDesktopSshConnectionError, onErrorChange);
      }
      setIsAddingSavedBackend(false);
      return;
    }

    handleOpenChange(false);
    toastManager.add({
      type: "success",
      title: routeTarget ? "Route added" : "Environment connected",
      description: routeTarget
        ? `${routeTarget.label} can now be reached over SSH ${target.alias}.`
        : `${target.alias} is ready over an SSH-managed tunnel.`,
    });
    setIsAddingSavedBackend(false);
  };

  const reportAddFailure = (message: string) => {
    onErrorChange(message);
    toastManager.add(
      stackedThreadToast({ type: "error", title: "Could not add backend", description: message }),
    );
  };

  const finishAdding = () => {
    handleOpenChange(false);
    toastManager.add(
      routeTarget
        ? {
            type: "success",
            title: "Route added",
            description: `${routeTarget.label} now has another way to connect.`,
          }
        : {
            type: "success",
            title: "Hub added",
            description: "You are signed in. It reconnects on app startup.",
          },
    );
  };

  const handleAddHub = async () => {
    if (!desktopBridge) return;
    // A pasted pairing link (or the QR's link) still pairs, without a separate code field.
    const pairing = parsePairingUrlFields(hubAddress);
    if (pairing) {
      setSavedBackendHost(pairing.host);
      setSavedBackendPairingCode(pairing.pairingCode);
    }
    const session = savedBackendSessionRef.current;
    setIsAddingSavedBackend(true);
    onErrorChange(null);
    try {
      if (pairing) {
        const paired = await connectPairing({
          ...parseRemotePairingFields({ host: pairing.host, pairingCode: pairing.pairingCode }),
          ...(routeTarget ? { expectedEnvironmentId: routeTarget.environmentId } : {}),
        });
        if (paired._tag === "Failure") {
          if (!isAtomCommandInterrupted(paired)) {
            const error = squashAtomCommandFailure(paired);
            reportAddFailure(error instanceof Error ? error.message : "Failed to add backend.");
          }
          return;
        }
        finishAdding();
        return;
      }
      const hubUrl = normalizeHubUrl(hubAddress);
      const attempt = await Effect.runPromise(
        startAppSignIn(hubUrl).pipe(Effect.provide(APP_SIGN_IN_CRYPTO)),
      );
      hubSignInStateRef.current = attempt.state;
      const received = await desktopBridge.signInToHub({
        hubUrl,
        codeChallenge: attempt.codeChallenge,
        state: attempt.state,
        clientLabel: "T3 Code desktop",
      });
      hubSignInStateRef.current = null;
      if (session !== savedBackendSessionRef.current) return;
      const result = await connectAppSignIn({
        hubUrl,
        code: received.code,
        codeVerifier: attempt.codeVerifier,
        redirectUri: received.redirectUri,
        ...(routeTarget ? { expectedEnvironmentId: routeTarget.environmentId } : {}),
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          reportAddFailure(error instanceof Error ? error.message : "Failed to add the Hub.");
        }
        return;
      }
      finishAdding();
    } catch (error) {
      hubSignInStateRef.current = null;
      if (session === savedBackendSessionRef.current) {
        reportAddFailure(error instanceof Error ? error.message : "Failed to add the Hub.");
      }
    } finally {
      setIsAddingSavedBackend(false);
    }
  };

  const handleAddSavedBackend = async () => {
    if (savedBackendMode === "hub") {
      await handleAddHub();
      return;
    }
    if (savedBackendMode === "ssh") {
      let target: DesktopSshEnvironmentTarget;
      try {
        target = parseManualDesktopSshTarget({
          host: savedBackendSshHost,
          username: savedBackendSshUsername,
          port: savedBackendSshPort,
        });
      } catch (error) {
        onErrorChange(formatDesktopSshConnectionError(error));
        return;
      }

      await connectSavedBackendSshTarget(target);
      return;
    }

    setIsAddingSavedBackend(true);
    onErrorChange(null);
    let remotePairingInput: ReturnType<typeof parseRemotePairingFields>;
    try {
      remotePairingInput = parseRemotePairingFields({
        host: savedBackendHost,
        pairingCode: savedBackendPairingCode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add backend.";
      onErrorChange(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not add backend",
          description: message,
        }),
      );
      setIsAddingSavedBackend(false);
      return;
    }

    const result = await connectPairing({
      ...remotePairingInput,
      ...(routeTarget ? { expectedEnvironmentId: routeTarget.environmentId } : {}),
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message = error instanceof Error ? error.message : "Failed to add backend.";
        onErrorChange(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not add backend",
            description: message,
          }),
        );
      }
      setIsAddingSavedBackend(false);
      return;
    }

    handleOpenChange(false);
    toastManager.add(
      routeTarget
        ? {
            type: "success",
            title: "Route added",
            description: `${routeTarget.label} now has another way to connect.`,
          }
        : {
            type: "success",
            title: "Backend added",
            description: "The environment is saved and will reconnect on app startup.",
          },
    );
    setIsAddingSavedBackend(false);
  };

  const handleSavedBackendSshFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && savedBackendSshHost.trim().length > 0) {
      event.preventDefault();
      void handleAddSavedBackend();
    }
  };

  const handleSelectSshHostSuggestion = async (target: DesktopDiscoveredSshHost) => {
    if (isAddingSavedBackend || !desktopBridge) return;

    const session = savedBackendSessionRef.current;
    setIsAddingSavedBackend(true);
    onErrorChange(null);
    setSavedBackendSshHost(target.alias);
    let resolved: DesktopSshEnvironmentTarget;
    try {
      resolved = await desktopBridge.resolveSshHost(target.alias);
    } catch (error) {
      if (session === savedBackendSessionRef.current) {
        onErrorChange(formatDesktopSshConnectionError(error));
      }
      setIsAddingSavedBackend(false);
      return;
    }
    if (session !== savedBackendSessionRef.current) {
      setIsAddingSavedBackend(false);
      return;
    }
    setSavedBackendSshUsername(resolved.username ?? "");
    setSavedBackendSshPort(resolved.port === null ? "" : String(resolved.port));
    await connectSavedBackendSshTarget(resolved);
  };

  const handleSavedBackendSshHostKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    const isSshHostPopupVisible = sshHostSuggestionsOpen && hasSshHostSuggestionContent;
    if (isSshHostPopupVisible) {
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: { modelPickerOpen: false },
      });
      const index = threadJumpIndexFromCommand(command ?? "");
      const target = index === null ? undefined : filteredDiscoveredSshHosts[index];
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        setSshHostSuggestionsOpen(false);
        void handleSelectSshHostSuggestion(target);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    const hasHighlightedSshHost =
      isSshHostPopupVisible && highlightedSshHostRef.current !== undefined;
    if (
      !event.defaultPrevented &&
      !hasHighlightedSshHost &&
      event.key === "Enter" &&
      savedBackendSshHost.trim().length > 0
    ) {
      event.preventDefault();
      void handleAddSavedBackend();
    }
  };

  const handleSavedBackendHostChange = (value: string) => {
    const parsedPairingUrl = parsePairingUrlFields(value);
    if (parsedPairingUrl) {
      setSavedBackendHost(parsedPairingUrl.host);
      setSavedBackendPairingCode(parsedPairingUrl.pairingCode);
      return;
    }
    setSavedBackendHost(value);
  };
  const renderConnectionModeCard = (input: {
    readonly mode: ConnectionMode;
    readonly title: string;
    readonly description: string;
    readonly icon?: ReactNode;
  }) => {
    const selected = savedBackendMode === input.mode;
    return (
      <button
        type="button"
        aria-pressed={selected}
        className={cn(
          "group flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left",
          selected ? "border-primary/50 bg-primary/5" : "border-border/60 hover:bg-muted/40",
        )}
        disabled={isAddingSavedBackend}
        onClick={() => {
          setSavedBackendMode(input.mode);
        }}
      >
        {input.icon ? (
          <span
            className={cn(
              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
              selected
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border/70 bg-background text-muted-foreground group-hover:text-foreground",
            )}
          >
            {input.icon}
          </span>
        ) : null}
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{input.title}</span>
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {input.description}
          </span>
        </span>
      </button>
    );
  };

  const renderRemoteFields = () => (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Host</span>
          <Input
            value={savedBackendHost}
            onChange={(event) => handleSavedBackendHostChange(event.target.value)}
            placeholder="backend.example.com"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Pairing code</span>
          <Input
            value={savedBackendPairingCode}
            onChange={(event) => setSavedBackendPairingCode(event.target.value)}
            placeholder="PAIRCODE"
            disabled={isAddingSavedBackend}
            spellCheck={false}
          />
        </label>
      </div>
      <div>
        <span className="mt-1 block text-2xs text-muted-foreground">
          Paste a full pairing URL here to fill both fields automatically.
        </span>
      </div>
    </div>
  );
  const renderRemoteModeBody = () => (
    <div className="space-y-4">
      {renderRemoteFields()}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button
        variant="outline"
        className="w-full"
        disabled={isAddingSavedBackend}
        onClick={() => void handleAddSavedBackend()}
      >
        <PlusIcon className="size-3.5" />
        {isAddingSavedBackend ? "Adding…" : routeTarget ? "Add route" : "Add environment"}
      </Button>
    </div>
  );
  const renderHubModeBody = () => (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-foreground">Hub address</span>
        <Input
          value={hubAddress}
          onChange={(event) => setHubAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && hubAddress.trim().length > 0) {
              event.preventDefault();
              void handleAddSavedBackend();
            }
          }}
          placeholder="hub.example.com"
          disabled={isAddingSavedBackend}
          spellCheck={false}
        />
        <span className="mt-1 block text-2xs text-muted-foreground">
          Your browser opens the Hub to sign in with your passkey or password, then returns here.
        </span>
      </label>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button
        variant="outline"
        className="w-full"
        disabled={isAddingSavedBackend || hubAddress.trim().length === 0}
        onClick={() => void handleAddSavedBackend()}
      >
        <GlobeIcon className="size-3.5" />
        {isAddingSavedBackend ? "Waiting for the browser…" : "Sign in in browser"}
      </Button>
    </div>
  );
  const renderSshFields = () => (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="block">
          <label
            htmlFor="saved-backend-ssh-host"
            className="mb-1.5 block text-xs font-medium text-foreground"
          >
            SSH host or alias
          </label>
          <Autocomplete
            items={filteredDiscoveredSshHosts}
            itemToStringValue={(target) => target.alias}
            mode="none"
            openOnInputClick
            open={sshHostSuggestionsOpen}
            onOpenChange={setSshHostSuggestionsOpen}
            onItemHighlighted={(target) => {
              highlightedSshHostRef.current = target;
            }}
            value={savedBackendSshHost}
            onValueChange={(value, eventDetails) => {
              setSavedBackendSshHost(value);
              if (eventDetails.reason !== "item-press") return;

              const target = filteredDiscoveredSshHosts.find((host) => host.alias === value);
              if (target) void handleSelectSshHostSuggestion(target);
            }}
          >
            <AutocompleteInput
              id="saved-backend-ssh-host"
              onKeyDown={handleSavedBackendSshHostKeyDown}
              placeholder="Search hosts or type devbox"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
            {hasSshHostSuggestionContent ? (
              <AutocompletePopup>
                {isLoadingDiscoveredSshHosts ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">Loading hosts…</div>
                ) : filteredDiscoveredSshHosts.length > 0 ? (
                  <AutocompleteList className="max-h-72">
                    {filteredDiscoveredSshHosts.map((target, index) => {
                      const address = formatDesktopSshTarget(target);
                      const shortcutCommand = index < 9 ? threadJumpCommandForIndex(index) : null;
                      const shortcutLabel = shortcutCommand
                        ? shortcutLabelForCommand(keybindings, shortcutCommand, navigator.platform)
                        : null;
                      return (
                        <AutocompleteItem
                          key={`${target.alias}:${target.hostname}:${target.port ?? ""}`}
                          value={target}
                          className="h-8 min-h-8 whitespace-nowrap"
                        >
                          <span className="min-w-0 truncate text-sm font-medium">
                            {target.alias}
                          </span>
                          {address !== target.alias ? (
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                              {address}
                            </span>
                          ) : (
                            <span className="flex-1" />
                          )}
                          {shortcutLabel ? (
                            <CommandShortcut className="shrink-0">{shortcutLabel}</CommandShortcut>
                          ) : null}
                        </AutocompleteItem>
                      );
                    })}
                  </AutocompleteList>
                ) : (
                  <AutocompleteEmpty className="break-all">
                    No hosts match "{savedBackendSshHost.trim()}".
                  </AutocompleteEmpty>
                )}
              </AutocompletePopup>
            ) : null}
          </Autocomplete>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Username</span>
            <Input
              value={savedBackendSshUsername}
              onChange={(event) => setSavedBackendSshUsername(event.target.value)}
              onKeyDown={handleSavedBackendSshFieldKeyDown}
              placeholder="root"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Port</span>
            <Input
              value={savedBackendSshPort}
              onChange={(event) => setSavedBackendSshPort(event.target.value)}
              onKeyDown={handleSavedBackendSshFieldKeyDown}
              placeholder="22"
              inputMode="numeric"
              disabled={isAddingSavedBackend}
              spellCheck={false}
            />
          </label>
        </div>
        {error || discoveredSshHostsError ? (
          <Alert variant="error">
            <AlertDescription>{error ?? discoveredSshHostsError}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          variant="outline"
          className="w-full"
          disabled={isAddingSavedBackend}
          onClick={() => void handleAddSavedBackend()}
        >
          <PlusIcon className="size-3.5" />
          {isAddingSavedBackend ? "Adding…" : routeTarget ? "Add route" : "Add environment"}
        </Button>
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <Button size="xs" variant="ghost-muted" aria-label="Add environment">
                  <PlusIcon className="size-3" />
                  <span>Add environment</span>
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="top">Add environment</TooltipPopup>
      </Tooltip>
      <DialogPopup className="max-h-[80dvh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {routeTarget ? `Add a route to ${routeTarget.label}` : "Add Environment"}
          </DialogTitle>
          <DialogDescription>
            {routeTarget
              ? "Pair this machine again over another address, such as its Tailscale name. It joins the existing routes instead of adding a second machine."
              : desktopBridge
                ? "Add your team's Hub and sign in to it, or reach another machine over SSH."
                : "Pair another environment to this client."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {desktopBridge
                ? renderConnectionModeCard({
                    mode: "hub",
                    title: "Hub",
                    description: "Enter the Hub's address and sign in in your browser.",
                    icon: <GlobeIcon aria-hidden className="size-4" />,
                  })
                : renderConnectionModeCard({
                    mode: "remote",
                    title: "Remote link",
                    description: "Enter a backend host and pairing code.",
                    icon: <ChevronsLeftRightEllipsisIcon aria-hidden className="size-4" />,
                  })}
              {desktopBridge
                ? renderConnectionModeCard({
                    mode: "ssh",
                    title: "SSH",
                    description: "Use local SSH config, agent, and tunnels for the backend.",
                    icon: <TerminalIcon aria-hidden className="size-4" />,
                  })
                : null}
            </div>
            <AnimatedHeight>
              {savedBackendMode === "ssh"
                ? renderSshFields()
                : savedBackendMode === "hub"
                  ? renderHubModeBody()
                  : renderRemoteModeBody()}
            </AnimatedHeight>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
