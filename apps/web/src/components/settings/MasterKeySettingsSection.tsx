import type { AuthAccount, MasterKeyStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import {
  confirmMasterKeyBackup,
  downloadMasterKeyBackup,
  fetchMasterKeyStatus,
} from "../../environments/primary/masterKey";
import { fetchAccount } from "../../environments/primary/userAccounts";
import { errorMessageOf } from "../../lib/errorMessage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { emptyStepUp, StepUpFields, toStepUp } from "./AccountSettingsSection";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** How long the browser keeps the download's URL: long enough for it to start saving. */
const DOWNLOAD_URL_LIFETIME_MS = 60_000;

/** Hands the backup to the browser as a file; the key is in no other place on this page. */
function saveAsFile(text: string, keyId: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `t3-master-key-${keyId}.txt`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}

type Stage =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "step-up";
      readonly account: AuthAccount;
      readonly stepUp: ReturnType<typeof emptyStepUp>;
    }
  /** Downloaded; a backup only once the Owner types the start of the key from the saved file. */
  | { readonly _tag: "confirm"; readonly keyId: string; readonly proof: string };

/**
 * The Owner's master key: every secret the Hub stores is encrypted with it. Warns until this key
 * has a backup the Owner confirmed holding (docs/internals/secrets.md).
 */
export function MasterKeySettingsSection() {
  const session = usePrimarySessionState();
  const isOwner = session.data?.authenticated === true && session.data.isOwner === true;
  const [status, setStatus] = useState<MasterKeyStatus | null>(null);
  const [stage, setStage] = useState<Stage>({ _tag: "idle" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the master key's backup status from the Hub for the signed-in Owner.
  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    void fetchMasterKeyStatus().then(
      (next) => {
        if (!cancelled) setStatus(next);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorMessageOf(cause, "Could not read the master key's status."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [isOwner]);

  if (!isOwner || (status === null && error === null)) return null;

  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessageOf(cause, "That did not work. Try again."));
    } finally {
      setPending(false);
    }
  };

  const begin = () =>
    run(async () => {
      const account = await fetchAccount();
      setStage({ _tag: "step-up", account, stepUp: emptyStepUp(account) });
    });

  const download = (account: AuthAccount, stepUp: ReturnType<typeof emptyStepUp>) =>
    run(async () => {
      const result = await downloadMasterKeyBackup(toStepUp(account, stepUp));
      saveAsFile(result.key, result.keyId);
      setStage({ _tag: "confirm", keyId: result.keyId, proof: "" });
    });

  const confirm = (keyId: string, proof: string) =>
    run(async () => {
      setStatus(await confirmMasterKeyBackup(keyId, proof.trim()));
      setStage({ _tag: "idle" });
    });

  const backedUp = status?.backedUpAt ?? null;
  return (
    <SettingsSection id="master-key" title="Master key">
      <SettingsRow
        title={backedUp === null ? "Back up the master key" : "Master key"}
        description={
          backedUp === null
            ? "Every secret this Hub stores is encrypted with it. Without a backup, losing this server's disk loses them all and signs everyone out. Keep the backup off this server."
            : `Backed up ${new Date(backedUp).toLocaleString()}. Key ${status?.keyId ?? ""} in ${status?.keyFile ?? ""}.`
        }
        status={
          error === null ? null : (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          )
        }
        control={
          stage._tag === "idle" ? (
            <Button
              disabled={pending}
              size="xs"
              variant={backedUp === null ? "default" : "outline"}
              onClick={() => void begin()}
            >
              Download master key backup
            </Button>
          ) : null
        }
      />
      {stage._tag === "step-up" ? (
        <form
          className="mt-3 flex max-w-sm flex-col gap-2 px-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault();
            void download(stage.account, stage.stepUp);
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
              {pending ? "Downloading…" : "Download"}
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
        </form>
      ) : null}
      {stage._tag === "confirm" ? (
        <form
          className="mt-3 flex max-w-sm flex-col gap-2 px-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault();
            void confirm(stage.keyId, stage.proof);
          }}
        >
          <label className="text-xs font-medium" htmlFor="master-key-proof">
            To confirm you saved it, open the file and type the first 8 characters after{" "}
            <code>t3-master-key-v1:</code>
          </label>
          <Input
            id="master-key-proof"
            autoComplete="off"
            disabled={pending}
            nativeInput
            maxLength={8}
            onChange={(event) => setStage({ ...stage, proof: event.currentTarget.value })}
            spellCheck={false}
            value={stage.proof}
          />
          <div className="flex gap-2">
            <Button disabled={pending || stage.proof.trim().length !== 8} size="sm" type="submit">
              Confirm backup
            </Button>
            <Button
              disabled={pending}
              size="sm"
              variant="ghost"
              onClick={() => setStage({ _tag: "idle" })}
            >
              Not now
            </Button>
          </div>
        </form>
      ) : null}
    </SettingsSection>
  );
}
