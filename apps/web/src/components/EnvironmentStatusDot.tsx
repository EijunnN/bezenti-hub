import type { EnvironmentConnectionStatus } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

const DOT_CLASS: Record<EnvironmentConnectionStatus, string> = {
  online: "bg-success",
  reconnecting: "bg-warning",
  offline: "bg-muted-foreground/50",
};

/** An Active environment's live status as a dot; the words go in the accessible name nearby. */
export function EnvironmentStatusDot({
  status,
  className,
}: {
  status: EnvironmentConnectionStatus;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-1.5 shrink-0 rounded-full", DOT_CLASS[status], className)}
    />
  );
}
