import { isLocalEnvironmentDisabled } from "../localEnvironment";

/**
 * Web and desktop connect only to the Hub, never to the machines Threads run on. A browser's Hub
 * is the page's server, so nothing is saved; the desktop app either is the Hub (its local
 * environment) or, with that turned off, saves the one Hub it signs in to.
 */
export function savedConnectionSlots(): 0 | 1 {
  if (typeof window === "undefined" || window.desktopBridge === undefined) return 0;
  return isLocalEnvironmentDisabled() ? 1 : 0;
}

export const SINGLE_HUB_REFUSAL =
  "This app connects to one Hub only. Remove the Hub it uses, or turn off this computer's local environment, first.";
