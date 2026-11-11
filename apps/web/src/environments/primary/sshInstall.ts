import type { SpaceId, SshInstallRun } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";

import { request } from "./userAccounts";

/** What the Owner types into «Add a machine over SSH». The key never leaves this request. */
export interface SshInstallForm {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly auth:
    | { readonly kind: "key"; readonly privateKey: string; readonly passphrase: string }
    | { readonly kind: "agent" };
  readonly spaceId: SpaceId;
  readonly name: string;
  readonly hubUrl: string;
  readonly keepForUpdates: boolean;
}

/** The Hub reads the machine's host key; the run waits for the Owner to confirm it. */
export function startSshInstall(form: SshInstallForm): Promise<SshInstallRun> {
  return request((client) =>
    client.environments.sshInstallStart({
      headers: {},
      payload: {
        host: form.host,
        port: form.port,
        username: form.username,
        auth:
          form.auth.kind === "agent"
            ? { kind: "agent" }
            : {
                kind: "key",
                privateKey: Redacted.make(form.auth.privateKey),
                ...(form.auth.passphrase === ""
                  ? {}
                  : { passphrase: Redacted.make(form.auth.passphrase) }),
              },
        spaceId: form.spaceId,
        name: form.name,
        hubUrl: form.hubUrl,
        keepForUpdates: form.keepForUpdates,
      },
    }),
  );
}

/** Trusts the host key shown (by its fingerprint): the steps start on the Hub. */
export function confirmSshInstall(runId: string, fingerprint: string): Promise<SshInstallRun> {
  return request((client) =>
    client.environments.sshInstallConfirm({ headers: {}, payload: { runId, fingerprint } }),
  );
}

/** Stops the run and undoes what it did, as a failure does. */
export function cancelSshInstall(runId: string): Promise<SshInstallRun> {
  return request((client) =>
    client.environments.sshInstallCancel({ headers: {}, payload: { runId } }),
  );
}

/** The run and each step's output so far. */
export function fetchSshInstall(runId: string): Promise<SshInstallRun> {
  return request((client) =>
    client.environments.sshInstallStatus({ headers: {}, payload: { runId } }),
  );
}
