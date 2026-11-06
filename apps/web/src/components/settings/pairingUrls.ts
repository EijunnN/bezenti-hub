import { setPairingTokenOnUrl } from "@t3tools/shared/remote";

/** The endpoint's own `/pair` page: the Hub serves the web app that finishes pairing. */
export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}
