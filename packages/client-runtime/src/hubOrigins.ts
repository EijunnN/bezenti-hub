import { addHubOrigin } from "@t3tools/shared/threadLinks";

/**
 * Remembers the addresses a connected environment's links can carry, so they read as thread
 * links when pasted back: its Hub's public URL and the address this client reaches it on, which
 * is what `hubLinkOrigin` puts in a copied link when there is no public URL.
 */
export function registerEnvironmentHubOrigins(environment: {
  readonly publicUrl?: string | null | undefined;
  readonly httpBaseUrl?: string | null | undefined;
}): void {
  addHubOrigin(environment.publicUrl);
  addHubOrigin(environment.httpBaseUrl);
}
