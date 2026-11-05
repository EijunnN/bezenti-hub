import * as Duration from "effect/Duration";

const FREE_FAILURES = 5;
const BASE_DELAY_MS = Duration.toMillis(Duration.seconds(30));
const MAX_DELAY_MS = Duration.toMillis(Duration.minutes(15));
// A quiet hour forgives earlier failures.
const FORGET_AFTER_MS = Duration.toMillis(Duration.hours(1));
const CAPACITY = 10_000;

interface Entry {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}

/**
 * Failure counters for password and TOTP attempts, keyed by account and by client address. After
 * five failures on a key, each further failure locks it for twice as long as the last, from 30
 * seconds up to 15 minutes. In memory: a restart forgives everyone.
 */
export const makeSignInThrottle = () => {
  const entries = new Map<string, Entry>();
  return {
    /** Epoch millis until which any of `keys` is locked, or undefined. */
    lockedUntil: (keys: ReadonlyArray<string>, nowMillis: number) => {
      let until: number | undefined;
      for (const key of keys) {
        const entry = entries.get(key);
        if (entry !== undefined && entry.lockedUntil > nowMillis) {
          until = Math.max(until ?? 0, entry.lockedUntil);
        }
      }
      return until;
    },
    recordFailure: (keys: ReadonlyArray<string>, nowMillis: number) => {
      for (const key of keys) {
        const previous = entries.get(key);
        const failures =
          previous === undefined || nowMillis - previous.lastFailureAt > FORGET_AFTER_MS
            ? 1
            : previous.failures + 1;
        const lockedUntil =
          failures < FREE_FAILURES
            ? 0
            : nowMillis + Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (failures - FREE_FAILURES));
        // Re-insert so the map's order stays least recently failed first.
        entries.delete(key);
        entries.set(key, { failures, lastFailureAt: nowMillis, lockedUntil });
      }
      for (const key of entries.keys()) {
        if (entries.size <= CAPACITY) break;
        entries.delete(key);
      }
    },
    reset: (keys: ReadonlyArray<string>) => {
      for (const key of keys) entries.delete(key);
    },
  };
};
