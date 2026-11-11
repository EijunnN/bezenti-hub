import type { MasterKeyBackupResult, MasterKeyStatus } from "@t3tools/contracts";

import { request, type StepUp, toReauth, UserSignInError } from "./userAccounts";

/** The master key that encrypts the Hub's secrets: where it is and whether it has a backup. */
export function fetchMasterKeyStatus(): Promise<MasterKeyStatus> {
  return request((client) => client.vaults.masterKeyStatus({ headers: {} }));
}

/** The Owner's backup of the master key, confirmed with the strong factor. */
export async function downloadMasterKeyBackup(stepUp: StepUp): Promise<MasterKeyBackupResult> {
  const reauth = await toReauth(stepUp);
  if (reauth === undefined) {
    throw new UserSignInError({
      message: "Confirm with your passkey, or with your password and a code from your app.",
    });
  }
  return request((client) => client.vaults.masterKeyBackup({ headers: {}, payload: { reauth } }));
}
