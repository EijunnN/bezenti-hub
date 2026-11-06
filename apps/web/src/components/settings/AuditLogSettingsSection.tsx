import { useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import { AuditLogDialog } from "../sidebar/AuditLogDialog";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** The Owner's way into the audit log from Settings → Access; the Space selector has the other. */
export function AuditLogSettingsSection() {
  const session = usePrimarySessionState();
  const [open, setOpen] = useState(false);
  if (session.data?.authenticated !== true || session.data.isOwner !== true) return null;
  return (
    <SettingsSection id="audit-log" title="Audit log">
      <SettingsRow
        title="Audit log"
        description="Who invited, changed Roles, deleted for good, turned Users off or approved sign-ins, and when."
        control={
          <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
            Open audit log
          </Button>
        }
      />
      {open ? <AuditLogDialog onClose={() => setOpen(false)} /> : null}
    </SettingsSection>
  );
}
