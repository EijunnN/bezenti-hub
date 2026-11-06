import { GlobeIcon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { normalizeHubUrl, startAppSignIn } from "@t3tools/client-runtime/authorization";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Input } from "../ui/input";
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
import { Button } from "../ui/button";
import { connectAppSignIn as connectAppSignInAtom } from "~/connection/onboarding";
import type { EnvironmentPresentation } from "~/state/environments";
import { useAtomCommand } from "../../state/use-atom-command";

const APP_SIGN_IN_CRYPTO = Layer.merge(SecureRandom.layerWebCrypto, Digest.layerWebCrypto);

/**
 * The desktop app's one Hub, when this computer is not the Hub itself: added by its address, with
 * a sign-in in the system browser. With `routeTarget`, another address for the same Hub (its
 * Tailscale name, say), which joins its routes instead of adding a second connection.
 */
export function AddEnvironmentDialog({
  open,
  routeTarget,
  error,
  onOpenChange,
  onErrorChange,
}: {
  readonly open: boolean;
  readonly routeTarget: EnvironmentPresentation | null;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onErrorChange: (error: string | null) => void;
}) {
  const desktopBridge = window.desktopBridge;
  const connectAppSignIn = useAtomCommand(connectAppSignInAtom, { reportFailure: false });
  const [hubAddress, setHubAddress] = useState("");
  const hubSignInStateRef = useRef<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const sessionRef = useRef(0);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      sessionRef.current += 1;
      setHubAddress("");
      if (hubSignInStateRef.current !== null) {
        void desktopBridge?.cancelSignInToHub(hubSignInStateRef.current).catch(() => undefined);
        hubSignInStateRef.current = null;
      }
    }
    onOpenChange(nextOpen);
  };

  const reportAddFailure = (message: string) => {
    onErrorChange(message);
    toastManager.add(
      stackedThreadToast({ type: "error", title: "Could not add the Hub", description: message }),
    );
  };

  const handleAddHub = async () => {
    if (!desktopBridge) return;
    const session = sessionRef.current;
    setIsAdding(true);
    onErrorChange(null);
    try {
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
      if (session !== sessionRef.current) return;
      const result = await connectAppSignIn({
        hubUrl,
        code: received.code,
        codeVerifier: attempt.codeVerifier,
        redirectUri: received.redirectUri,
        ...(routeTarget ? { expectedEnvironmentId: routeTarget.environmentId } : {}),
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          reportAddFailure(failure instanceof Error ? failure.message : "Failed to add the Hub.");
        }
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
              title: "Hub added",
              description: "You are signed in. It reconnects on app startup.",
            },
      );
    } catch (cause) {
      hubSignInStateRef.current = null;
      if (session === sessionRef.current) {
        reportAddFailure(cause instanceof Error ? cause.message : "Failed to add the Hub.");
      }
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <Button size="xs" variant="ghost-muted" aria-label="Add Hub">
                  <PlusIcon className="size-3" />
                  <span>Add Hub</span>
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="top">Add Hub</TooltipPopup>
      </Tooltip>
      <DialogPopup className="max-h-[80dvh] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {routeTarget ? `Add a route to ${routeTarget.label}` : "Add your Hub"}
          </DialogTitle>
          <DialogDescription>
            {routeTarget
              ? "Sign in to the same Hub over another address, such as its Tailscale name."
              : "This app connects to one Hub and sees every Thread there, whichever machine runs it."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
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
                    void handleAddHub();
                  }
                }}
                placeholder="hub.example.com"
                disabled={isAdding}
                spellCheck={false}
              />
              <span className="mt-1 block text-2xs text-muted-foreground">
                Your browser opens the Hub to sign in with your passkey or password, then returns
                here.
              </span>
            </label>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <Button
              variant="outline"
              className="w-full"
              disabled={isAdding || hubAddress.trim().length === 0}
              onClick={() => void handleAddHub()}
            >
              <GlobeIcon className="size-3.5" />
              {isAdding ? "Waiting for the browser…" : "Sign in in browser"}
            </Button>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
