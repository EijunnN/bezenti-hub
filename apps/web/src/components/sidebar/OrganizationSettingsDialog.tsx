import {
  createInvitation,
  INVITATION_STATUS_LABELS,
  invitationLink,
  listInvitations,
  revokeInvitation,
  SPACE_ROLE_LABELS,
} from "@t3tools/client-runtime/spaces/invitations";
import {
  changeMemberRole,
  issueMemberResetLink,
  leaveOrganization,
  listMembers,
  removeMember,
  resetLink,
} from "@t3tools/client-runtime/spaces/memberships";
import type {
  InvitationSummary,
  MemberList,
  MemberSummary,
  SpaceRole,
  SpaceSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { useEffect, useId, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { errorMessageOf as messageOf } from "../../lib/errorMessage";
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

type Client = Effect.Success<typeof PrimaryEnvironmentHttpClient>;
const withClient = <A, E>(use: (client: Client) => Effect.Effect<A, E>) =>
  runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(use)));

const formatDay = (date: DateTime.Utc) => DateTime.toDate(date).toLocaleDateString();

const confirmDestructive = async (message: string) =>
  (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);

function describeInvitation(invitation: InvitationSummary) {
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

/** A link shown once, with a button to copy it. */
function OneTimeLink({ label, link, note }: { label: string; link: string; note: string }) {
  const id = useId();
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: label.toLowerCase() });
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} readOnly value={link} className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => copyToClipboard(link)}>
          {isCopied ? "Copied" : "Copy link"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

/**
 * An Organization's Members, Roles and Invitations. What each viewer may change comes from the
 * server's answers; the server refuses the rest anyway.
 */
export function OrganizationSettingsDialog({
  space,
  onClose,
  onLeft,
}: {
  readonly space: SpaceSummary;
  readonly onClose: () => void;
  /** After the viewer left the Organization. */
  readonly onLeft: () => void;
}) {
  const [members, setMembers] = useState<MemberList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<{ readonly name: string; readonly url: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>, failure: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(messageOf(cause, failure));
    }
    setBusy(false);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this Organization's Members from the server when the dialog opens
  useEffect(() => {
    let cancelled = false;
    void withClient((client) => listMembers(client, space.id)).then(
      (list) => {
        if (!cancelled) setMembers(list);
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause, "Could not load the members."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [space.id]);

  const reload = async () =>
    setMembers(await withClient((client) => listMembers(client, space.id)));

  const changeRole = (member: MemberSummary, role: SpaceRole) =>
    run(async () => {
      const result = await withClient((client) =>
        changeMemberRole(client, space.id, member.userId, role),
      );
      await reload();
      if (result.mustSetUpStrongSignIn) {
        setNotice(
          `${member.displayName} was signed out. Their next sign-in asks for a passkey, or sets up an authenticator app for their password.`,
        );
      }
    }, "Could not change the Role.");

  const remove = async (member: MemberSummary) => {
    const confirmed = await confirmDestructive(
      `Remove ${member.displayName} from ${space.name}?\nWhat they created stays in the Organization. They can come back with a new invitation.`,
    );
    if (!confirmed) return;
    await run(async () => {
      setMembers(await withClient((client) => removeMember(client, space.id, member.userId)));
    }, "Could not remove them.");
  };

  const issueResetLink = (member: MemberSummary) =>
    run(async () => {
      const issued = await withClient((client) =>
        issueMemberResetLink(client, space.id, member.userId),
      );
      setLink({ name: member.displayName, url: resetLink(window.location.origin, issued.token) });
    }, "Could not create the reset link.");

  const leave = async () => {
    const confirmed = await confirmDestructive(
      `Leave ${space.name}?\nWhat you created stays in the Organization. To come back you need a new invitation.`,
    );
    if (!confirmed) return;
    await run(async () => {
      await withClient((client) => leaveOrganization(client, space.id));
      onLeft();
    }, "Could not leave the Organization.");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Organization settings</DialogTitle>
          <DialogDescription>Members, Roles and Invitations of {space.name}.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-2" aria-labelledby="organization-members">
              <h3 id="organization-members" className="text-sm font-medium">
                Members
              </h3>
              {members === null ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : members.members.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nobody has joined yet.</p>
              ) : (
                <ul className="flex flex-col gap-1" aria-label="Members">
                  {members.members.map((member) => (
                    <MemberRow
                      key={member.userId}
                      member={member}
                      assignableRoles={members.assignableRoles}
                      busy={busy}
                      onChangeRole={(role) => void changeRole(member, role)}
                      onRemove={() => void remove(member)}
                      onResetLink={() => void issueResetLink(member)}
                    />
                  ))}
                </ul>
              )}
              {link !== null ? (
                <OneTimeLink
                  label={`Reset link for ${link.name}`}
                  link={link.url}
                  note="Works once and expires in an hour. It lets them register a new passkey and signs out their other devices. Shown only now."
                />
              ) : null}
              {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
            </section>

            {space.canInvite ? (
              <InvitationsSection
                space={space}
                assignableRoles={members?.assignableRoles ?? ["member", "guest"]}
              />
            ) : null}

            {error ? <p className="text-destructive text-sm">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {members?.canLeave ? (
            <Button
              type="button"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void leave()}
            >
              Leave organization
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function MemberRow({
  member,
  assignableRoles,
  busy,
  onChangeRole,
  onRemove,
  onResetLink,
}: {
  readonly member: MemberSummary;
  readonly assignableRoles: ReadonlyArray<SpaceRole>;
  readonly busy: boolean;
  readonly onChangeRole: (role: SpaceRole) => void;
  readonly onRemove: () => void;
  readonly onResetLink: () => void;
}) {
  const roles = assignableRoles.includes(member.role)
    ? assignableRoles
    : [member.role, ...assignableRoles];
  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <span className="min-w-0 truncate">
        {member.displayName}
        {member.isYou ? <span className="text-muted-foreground"> (you)</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {member.canChangeRole ? (
          <select
            aria-label={`Role for ${member.displayName}`}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs"
            disabled={busy}
            value={member.role}
            onChange={(event) => onChangeRole(event.currentTarget.value as SpaceRole)}
          >
            {roles.map((role) => (
              <option key={role} value={role}>
                {SPACE_ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-muted-foreground">{SPACE_ROLE_LABELS[member.role]}</span>
        )}
        {member.canIssueResetLink ? (
          <Button
            aria-label={`Create a reset link for ${member.displayName}`}
            disabled={busy}
            size="xs"
            variant="ghost"
            onClick={onResetLink}
          >
            Reset link
          </Button>
        ) : null}
        {member.canRemove ? (
          <Button
            aria-label={`Remove ${member.displayName}`}
            disabled={busy}
            size="xs"
            variant="ghost"
            onClick={onRemove}
          >
            Remove
          </Button>
        ) : null}
      </span>
    </li>
  );
}

const fetchInvitations = (spaceId: SpaceSummary["id"]) =>
  withClient((client) => listInvitations(client, spaceId));

/** Create a link, copy it, see and revoke the Organization's Invitations. */
function InvitationsSection({
  space,
  assignableRoles,
}: {
  readonly space: SpaceSummary;
  readonly assignableRoles: ReadonlyArray<SpaceRole>;
}) {
  const id = useId();
  const [role, setRole] = useState<SpaceRole>("member");
  const [link, setLink] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<ReadonlyArray<InvitationSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      setInvitations((await fetchInvitations(space.id)).invitations);
    } catch (cause) {
      setError(messageOf(cause, "Could not load the invitations."));
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this Organization's Invitations from the server when the dialog opens
  useEffect(() => {
    let cancelled = false;
    void fetchInvitations(space.id).then(
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
      const created = await withClient((client) => createInvitation(client, space.id, role));
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
      await withClient((client) => revokeInvitation(client, invitation.id));
      await reload();
    } catch (cause) {
      setError(messageOf(cause, "Could not revoke the invitation."));
    }
    setBusy(false);
  };

  return (
    <section className="flex flex-col gap-4" aria-labelledby={`${id}-heading`}>
      <div className="flex flex-col gap-1">
        <h3 id={`${id}-heading`} className="text-sm font-medium">
          Invitations
        </h3>
        <p className="text-xs text-muted-foreground">
          Each link works once and expires in 7 days. Send it over any chat app.
        </p>
      </div>
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
            {assignableRoles.map((option) => (
              <option key={option} value={option}>
                {SPACE_ROLE_LABELS[option]}
              </option>
            ))}
          </select>
        </div>
        <Button disabled={busy} size="sm" onClick={() => void create()}>
          Create invite link
        </Button>
      </div>

      {link !== null ? (
        <OneTimeLink
          label="Invitation link"
          link={link}
          note="Shown only now: the server keeps no copy of the link."
        />
      ) : null}

      {invitations === null ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : invitations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No invitations yet.</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Invitations">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                {SPACE_ROLE_LABELS[invitation.role]} · {INVITATION_STATUS_LABELS[invitation.status]}{" "}
                · <span className="text-muted-foreground">{describeInvitation(invitation)}</span>
              </span>
              {invitation.status === "pending" &&
              (invitation.role !== "admin" || assignableRoles.includes("admin")) ? (
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
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </section>
  );
}
