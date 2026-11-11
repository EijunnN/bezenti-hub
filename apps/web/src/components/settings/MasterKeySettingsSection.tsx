import type { AuthAccount, MasterKeyStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import {
  downloadMasterKeyBackup,
  fetchMasterKeyStatus,
} from "../../environments/primary/masterKey";
import { fetchAccount } from "../../environments/primary/userAccounts";
import { errorMessageOf } from "../../lib/errorMessage";
import { Button } from "../ui/button";
import { emptyStepUp, StepUpFields, toStepUp } from "./AccountSettingsSection";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Hands the backup to the browser as a file; the key is in no other place on this page. */
function saveAsFile(text: string, keyId: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `t3-master-key-${keyId}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The Owner's master key: every secret the Hub stores is encrypted with it. Warns until this key
 * has a backup and downloads one after the strong factor (docs/internals/secrets.md).
 */
export function MasterKeySettingsSection() {
  const session = usePrimarySessionState();
  const isOwner = session.data?.authenticated === true && session.data.isOwner === true;
  const [status, setStatus] = useState<MasterKeyStatus | null>(null);
  const [account, setAccount] = useState<AuthAccount | null>(null);
  const [stepUp, setStepUp] = useState<ReturnType<typeof emptyStepUp> | null>(null);
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
        if (!cancelled) setError(errorMessageOf(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [isOwner]);

  if (!isOwner || (status === null && error === null)) return null;

  const begin = async () => {
    setError(null);
    try {
      const loaded = account ?? (await fetchAccount());
      setAccount(loaded);
      setStepUp(emptyStepUp(loaded));
    } catch (cause) {
      setError(errorMessageOf(cause));
    }
  };

  const confirm = async () => {
    if (account === null || stepUp === null) return;
    setPending(true);
    setError(null);
    try {
      const result = await downloadMasterKeyBackup(toStepUp(account, stepUp));
      saveAsFile(result.key, result.status.keyId);
      setStatus(result.status);
      setStepUp(null);
    } catch (cause) {
      setError(errorMessageOf(cause));
    } finally {
      setPending(false);
    }
  };

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
          stepUp === null ? (
            <Button
              size="xs"
              variant={backedUp === null ? "default" : "outline"}
              onClick={() => void begin()}
            >
              Download master key backup
            </Button>
          ) : null
        }
      />
      {account !== null && stepUp !== null ? (
        <form
          className="mt-3 flex max-w-sm flex-col gap-2 px-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <StepUpFields account={account} disabled={pending} value={stepUp} onChange={setStepUp} />
          <div className="flex gap-2">
            <Button disabled={pending} size="sm" type="submit">
              {pending ? "Downloading…" : "Download"}
            </Button>
            <Button disabled={pending} size="sm" variant="ghost" onClick={() => setStepUp(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </SettingsSection>
  );
}
