import type { VaultEntryId, VaultId } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";

import { request, type StepUp, toReauth, UserSignInError } from "./userAccounts";

/**
 * A secret's value, for the Owner, confirmed with the strong factor. Over HTTP only: the value
 * never passes through the socket's subscriptions or a client cache.
 */
export async function revealVaultSecret(
  stepUp: StepUp,
  vaultId: VaultId,
  entryId: VaultEntryId,
): Promise<string> {
  const reauth = await toReauth(stepUp);
  if (reauth === undefined) {
    throw new UserSignInError({
      message: "Confirm with your passkey, or with your password and a code from your app.",
    });
  }
  const revealed = await request((client) =>
    client.vaults.reveal({ headers: {}, payload: { vaultId, entryId, reauth } }),
  );
  return Redacted.value(revealed.value);
}
