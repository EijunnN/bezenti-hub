/**
 * Which secret-store entries are replay markers and how long one matters: shared by the markers'
 * writer (dpop.ts), their pruning and the store's startup, which drops expired ones.
 */
import * as Duration from "effect/Duration";

export const DPOP_REPLAY_MARKER_PREFIX = "dpop-proof-";

/**
 * A marker only matters while its proof can pass the time check (about 10 minutes for DPoP).
 * After that, the time check rejects a replay by itself.
 */
export const REPLAY_MARKER_MAX_AGE = Duration.days(1);

export const isReplayMarker = (name: string) => name.startsWith(DPOP_REPLAY_MARKER_PREFIX);
