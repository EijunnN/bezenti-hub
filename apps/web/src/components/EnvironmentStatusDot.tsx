import type { HubEnvironmentStatus } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

const DOT_CLASS: Record<HubEnvironmentStatus, string> = {
  online: "bg-success",
  reconnecting: "bg-warning",
  offline: "bg-muted-foreground/50",
  stopped: "bg-muted-foreground/50",
  starting: "bg-warning animate-pulse",
  failed: "bg-destructive",
};

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
      className={cn("inline-flex size-1.5 shrink-0 rounded-full", DOT_CLASS[status], className)}
    />
  );
}
