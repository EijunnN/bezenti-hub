import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";

export const primaryEnvironmentIdAtom = Atom.make((get) => {
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (entry.target._tag === "PrimaryConnectionTarget") {
      return environmentId;
    }
  }
  return null;
}).pipe(Atom.withLabel("web-primary-environment-id"));

/**
 * The one connection web and desktop hold, the Hub's: the platform's primary connection, or, on a
 * desktop whose local environment is off, the Hub it signed in to.
 */
export const hubEnvironmentIdAtom = Atom.make((get) => {
  const primary = get(primaryEnvironmentIdAtom);
  if (primary !== null) return primary;
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    return environmentId;
  }
  return null;
}).pipe(Atom.withLabel("web-hub-environment-id"));
