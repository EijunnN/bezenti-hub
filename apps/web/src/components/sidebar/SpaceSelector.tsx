import { useAtomValue } from "@effect/atom-react";
import type { SpaceId } from "@t3tools/contracts";
import {
  BuildingIcon,
  ChevronsUpDownIcon,
  PlusIcon,
  RefreshCwIcon,
  UserIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";

import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useEnvironmentShellGeneration } from "../../state/shell";
import {
  createAndSelectOrganization,
  loadSpaces,
  selectSpace,
  useCurrentSpace,
} from "../../state/currentSpace";
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
import { InvitationsDialog } from "./InvitationsDialog";
import { UsersDialog } from "./UsersDialog";
import { Label } from "../ui/label";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

/** Picks the Space that new Projects and Threads on this Installation go to. */
export function SpaceSelector() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const view = useCurrentSpace((state) => state.view);
  const currentSpaceId = useCurrentSpace((state) => state.currentSpaceId);
  const loadFailed = useCurrentSpace((state) => state.loadFailed);
  const [creating, setCreating] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [managingUsers, setManagingUsers] = useState(false);
  const shellGeneration = useEnvironmentShellGeneration(environmentId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the signed-in User's Spaces from the server
  useEffect(() => {
    if (environmentId !== null) void loadSpaces(environmentId);
  }, [
    environmentId,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- An access change (a granted or revoked Installation permission) sends a fresh shell snapshot, so the Spaces are read again.
    shellGeneration,
  ]);
  const reload = () => {
    if (environmentId !== null) void loadSpaces(environmentId);
  };

  if (view === null) {
    if (!loadFailed) return null;
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={reload}>
            <RefreshCwIcon />
            <span className="min-w-0 flex-1 truncate">Couldn't load Spaces. Retry</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }
  const current = view.spaces.find((space) => space.id === currentSpaceId) ?? view.spaces[0];
  const CurrentIcon = current?.kind === "organization" ? BuildingIcon : UserIcon;
  // Only the Owner lists other Users' Personal spaces, to read them.
  const ownSpaces = view.spaces.filter((space) => space.kind === "organization" || space.isOwn);
  const othersPersonal = view.spaces.filter((space) => space.kind === "personal" && !space.isOwn);
  const notice =
    current === undefined
      ? "Nothing to work in yet. The Owner can turn on your Personal space or invite you to an Organization."
      : current.kind === "personal" && current.isOwn && view.isOwner !== true
        ? "The Owner can see everything in your Personal space."
        : current.kind === "personal" && !current.isOwn
          ? `Reading ${current.name}'s Personal space. New Threads can't start here.`
          : null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Menu
          onOpenChange={(open) => {
            if (open) reload();
          }}
        >
          <MenuTrigger render={<SidebarMenuButton aria-label="Switch Space" />}>
            <CurrentIcon />
            <span className="min-w-0 flex-1 truncate">{current?.name ?? "No Space"}</span>
            <ChevronsUpDownIcon />
          </MenuTrigger>
          <MenuPopup align="start" side="top">
            <MenuGroup>
              <MenuGroupLabel>Spaces</MenuGroupLabel>
              <MenuRadioGroup
                value={current?.id}
                onValueChange={(value) => selectSpace(value as SpaceId)}
              >
                {ownSpaces.map((space) => (
                  <MenuRadioItem key={space.id} value={space.id} closeOnClick>
                    {space.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            {othersPersonal.length > 0 ? (
              <>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>Personal spaces (read only)</MenuGroupLabel>
                  <MenuRadioGroup
                    value={current?.id}
                    onValueChange={(value) => selectSpace(value as SpaceId)}
                  >
                    {othersPersonal.map((space) => (
                      <MenuRadioItem key={space.id} value={space.id} closeOnClick>
                        {space.name}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
              </>
            ) : null}
            {loadFailed ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={reload}>
                  <RefreshCwIcon />
                  Couldn't refresh Spaces. Retry
                </MenuItem>
              </>
            ) : null}
            {current?.canInvite ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => setInviting(true)}>
                  <UserPlusIcon />
                  Invite people
                </MenuItem>
              </>
            ) : null}
            {view.canCreateOrganization ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => setCreating(true)}>
                  <PlusIcon />
                  Create organization
                </MenuItem>
              </>
            ) : null}
            {view.isOwner === true ? (
              <MenuItem onClick={() => setManagingUsers(true)}>
                <UsersIcon />
                Users and permissions
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
        {creating ? <CreateOrganizationDialog onClose={() => setCreating(false)} /> : null}
        {inviting && current?.canInvite ? (
          <InvitationsDialog space={current} onClose={() => setInviting(false)} />
        ) : null}
        {managingUsers ? <UsersDialog onClose={() => setManagingUsers(false)} /> : null}
        {notice !== null ? (
          <p className="px-2 pt-1 text-muted-foreground text-xs">{notice}</p>
        ) : null}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function CreateOrganizationDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await createAndSelectOrganization(name.trim());
      onClose();
    } catch {
      setError("Could not create the organization. Try again.");
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create organization</DialogTitle>
            <DialogDescription>
              A Space your team shares. New Projects and Threads go to the Space you pick here.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                autoFocus
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              {error ? <p className="text-destructive text-sm">{error}</p> : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim().length === 0}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
