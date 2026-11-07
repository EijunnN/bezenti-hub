import type { EnvironmentConnectionStatus } from "@t3tools/contracts";

import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";

/** An Environment's live status as a dot; the words go in the accessible name nearby. */
export function EnvironmentStatusDot(props: {
  readonly status: EnvironmentConnectionStatus;
  readonly size?: number;
}) {
  return (
    <ConnectionStatusDot
      state={
        props.status === "online"
          ? "connected"
          : props.status === "reconnecting"
            ? "reconnecting"
            : "offline"
      }
      pulse={false}
      size={props.size ?? 6}
    />
  );
}
