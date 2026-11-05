import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/**
 * Whether the Installation has an Owner, readable synchronously by the listener's connection
 * filter. Once there is an Owner every request needs a User session, so the private-network
 * listener accepts any peer; before then it stays closed to public addresses. The Owner is never
 * removed, so the flag only turns on.
 */
export interface OwnerPresenceCell {
  readonly exists: () => boolean;
  readonly markExists: () => void;
}

export class OwnerPresence extends Context.Reference<OwnerPresenceCell>("t3/auth/OwnerPresence", {
  // Without the server's cell nothing opens: the filter keeps today's restriction.
  defaultValue: () => ({ exists: () => false, markExists: () => {} }),
}) {}

const make = (): OwnerPresenceCell => {
  let exists = false;
  return {
    exists: () => exists,
    markExists: () => {
      exists = true;
    },
  };
};

export const layer = Layer.sync(OwnerPresence, make);
