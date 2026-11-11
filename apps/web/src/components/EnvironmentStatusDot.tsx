import {
  ENVIRONMENT_STATUS_TONES,
  type EnvironmentStatusTone,
  environmentStatusLabel,
  environmentStatusPulses,
} from "@t3tools/client-runtime/environment/hub-environments";
import type { HubEnvironmentKind, HubEnvironmentStatus } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { Badge } from "./ui/badge";

// The tones every client shares (client-runtime), as this app's colours.
const DOT_CLASS: Record<EnvironmentStatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

const BADGE_VARIANT = {
  success: "success",
  warning: "warning",
  danger: "error",
  muted: "outline",
} as const satisfies Record<EnvironmentStatusTone, string>;

/** An Active environment's live status as a dot; the words go in the accessible name nearby. */
export function EnvironmentStatusDot({
  status,
  className,
}: {
  status: HubEnvironmentStatus;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-1.5 shrink-0 rounded-full",
        DOT_CLASS[ENVIRONMENT_STATUS_TONES[status]],
        environmentStatusPulses(status) && "animate-pulse",
        className,
      )}
    />
  );
}

/** A machine's status in words and colour, as Settings → Environments lists it. */
export function EnvironmentStatusBadge({
  status,
  kind,
}: {
  status: HubEnvironmentStatus;
  kind: HubEnvironmentKind;
}) {
  return (
    <Badge
      size="sm"
      variant={BADGE_VARIANT[ENVIRONMENT_STATUS_TONES[status]]}
      data-environment-status={status}
    >
      {environmentStatusLabel(status, kind)}
    </Badge>
  );
}
