import {
  ENVIRONMENT_STATUS_TONES,
  type EnvironmentStatusTone,
  environmentStatusPulses,
} from "@t3tools/client-runtime/environment/hub-environments";
import type { HubEnvironmentStatus } from "@t3tools/contracts";

import {
  ConnectionStatusDot,
  type ConnectionStatusDotState,
} from "../connection/ConnectionStatusDot";

// The tones every client shares (client-runtime), as this app's dot colours: green, amber, red
// and grey, as web shows them.
const DOT_STATE: Record<EnvironmentStatusTone, ConnectionStatusDotState> = {
  success: "connected",
  warning: "reconnecting",
  danger: "error",
  muted: "available",
};

/** An Environment's live status as a dot; the words go in the accessible name nearby. */
export function EnvironmentStatusDot(props: {
  readonly status: HubEnvironmentStatus;
  readonly size?: number;
}) {
  return (
    <ConnectionStatusDot
      state={DOT_STATE[ENVIRONMENT_STATUS_TONES[props.status]]}
      pulse={environmentStatusPulses(props.status)}
      size={props.size ?? 6}
    />
  );
}
