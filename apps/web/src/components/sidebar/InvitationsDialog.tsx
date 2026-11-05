import {
  createInvitation,
  invitationLink,
  listInvitations,
  revokeInvitation,
} from "@t3tools/client-runtime/spaces/invitations";
import type {
  InvitationStatus,
  InvitationSummary,
  SpaceRole,
  SpaceSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { useEffect, useId, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { runPrimaryHttp } from "../../lib/runtime";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

const ROLE_LABELS: Record<SpaceRole, string> = { admin: "Admin", member: "Member", guest: "Guest" };
const STATUS_LABELS: Record<InvitationStatus, string> = {
  pending: "Pending",
  accepted: "Accepted",
  expired: "Expired",
  revoked: "Revoked",
};

const messageOf = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

const formatDay = (date: DateTime.Utc) => DateTime.toDate(date).toLocaleDateString();

function describe(invitation: InvitationSummary) {
  switch (invitation.status) {
    case "accepted":
      return `Accepted by ${invitation.acceptedByName ?? "a removed User"}`;
    case "revoked":
      return "Revoked";
    case "expired":
      return `Expired ${formatDay(invitation.expiresAt)}`;
    case "pending":
      return `Expires ${formatDay(invitation.expiresAt)}`;
  }
}

/** The Owner's Invitations for one Organization: create a link, copy it, see and revoke them. */
export function InvitationsDialog({
  space,
  onClose,
}: {
  readonly space: SpaceSummary;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [role, setRole] = useState<SpaceRole>("member");
  const [link, setLink] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<ReadonlyArray<InvitationSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "invitation link" });

  const fetchList = () =>
    runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => listInvitations(client, space.id)),
      ),
    );
  const reload = async () => {
    try {
      setInvitations((await fetchList()).invitations);
    } catch (cause) {
      setError(messageOf(cause, "Could not load the invitations."));
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this Organization's Invitations from the server when the dialog opens
  useEffect(() => {
    let cancelled = false;
    void runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => listInvitations(client, space.id)),
      ),
    ).then(
      (list) => {
        if (!cancelled) setInvitations(list.invitations);
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause, "Could not load the invitations."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [space.id]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) => createInvitation(client, space.id, role)),
        ),
      );
      setLink(invitationLink(window.location.origin, created.token));
      await reload();
    } catch (cause) {
      setError(messageOf(cause, "Could not create the invitation."));
    }
    setBusy(false);
  };

  const revoke = async (invitation: InvitationSummary) => {
    setBusy(true);
    setError(null);
    try {
      await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) => revokeInvitation(client, invitation.id)),
        ),
      );
      await reload();
    } catch (cause) {
      setError(messageOf(cause, "Could not revoke the invitation."));
    }
    setBusy(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite people to {space.name}</DialogTitle>
          <DialogDescription>
            Each link works once and expires in 7 days. Send it over any chat app.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex items-end gap-2">
              <div className="flex flex-1 flex-col gap-2">
                <Label htmlFor={`${id}-role`}>Role</Label>
                <select
                  id={`${id}-role`}
                  className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                  disabled={busy}
                  value={role}
                  onChange={(event) => setRole(event.currentTarget.value as SpaceRole)}
                >
                  <option value="member">Member</option>
                  <option value="guest">Guest</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <Button disabled={busy} size="sm" onClick={() => void create()}>
                Create invite link
              </Button>
            </div>

            {link !== null ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-link`}>Invitation link</Label>
                <div className="flex gap-2">
                  <Input id={`${id}-link`} readOnly value={link} className="flex-1" />
                  <Button size="sm" variant="outline" onClick={() => copyToClipboard(link)}>
                    {isCopied ? "Copied" : "Copy link"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Shown only now: the server keeps no copy of the link.
                </p>
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Invitations</h3>
              {invitations === null ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : invitations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No invitations yet.</p>
              ) : (
                <ul className="flex flex-col gap-1" aria-label="Invitations">
                  {invitations.map((invitation) => (
                    <li
                      key={invitation.id}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        {ROLE_LABELS[invitation.role]} · {STATUS_LABELS[invitation.status]} ·{" "}
                        <span className="text-muted-foreground">{describe(invitation)}</span>
                      </span>
                      {invitation.status === "pending" ? (
                        <Button
                          disabled={busy}
                          size="xs"
                          variant="ghost"
                          onClick={() => void revoke(invitation)}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
