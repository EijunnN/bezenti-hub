import { useAtomValue } from "@effect/atom-react";
import type { SpaceId } from "@t3tools/contracts";
import {
  BuildingIcon,
  ChevronsUpDownIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  ShieldIcon,
  UserIcon,
  UserPlusIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import {
  createAndSelectOrganization,
  loadSpaces,
  selectSpace,
  useCurrentSpace,
  useShellGeneration,
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
import { Label } from "../ui/label";
import { OrganizationSettingsDialog } from "./OrganizationSettingsDialog";
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
  const [managing, setManaging] = useState(false);
  // A fresh shell snapshot follows a reconnect, as after the User's Memberships changed.
  const shellGeneration = useShellGeneration(environmentId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the signed-in User's Spaces from the server, again after each fresh shell snapshot
  useEffect(() => {
    if (environmentId !== null && shellGeneration >= 0) void loadSpaces(environmentId);
  }, [environmentId, shellGeneration]);
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

  return (
    <SidebarMenu>
      {current?.pendingAdmin === true ? (
        <SidebarMenuItem>
          <SidebarMenuButton render={<Link to="/settings/access" />}>
            <ShieldIcon />
            <span className="min-w-0 flex-1 truncate">
              Set up an authenticator app to become Admin
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : null}
      <SidebarMenuItem>
        <Menu
          onOpenChange={(open) => {
            if (open) reload();
          }}
        >
          <MenuTrigger render={<SidebarMenuButton aria-label="Switch Space" />}>
            <CurrentIcon />
            <span className="min-w-0 flex-1 truncate">{current?.name ?? "Personal"}</span>
            <ChevronsUpDownIcon />
          </MenuTrigger>
          <MenuPopup align="start" side="top">
            <MenuGroup>
              <MenuGroupLabel>Spaces</MenuGroupLabel>
              <MenuRadioGroup
                value={current?.id}
                onValueChange={(value) => selectSpace(value as SpaceId)}
              >
                {view.spaces.map((space) => (
                  <MenuRadioItem key={space.id} value={space.id} closeOnClick>
                    {space.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            {loadFailed ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={reload}>
                  <RefreshCwIcon />
                  Couldn't refresh Spaces. Retry
                </MenuItem>
              </>
            ) : null}
            {current?.kind === "organization" ? (
              <>
                <MenuSeparator />
                {current.canInvite ? (
                  <MenuItem onClick={() => setManaging(true)}>
                    <UserPlusIcon />
                    Invite people
                  </MenuItem>
                ) : null}
                <MenuItem onClick={() => setManaging(true)}>
                  <SettingsIcon />
                  Organization settings
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
          </MenuPopup>
        </Menu>
        {creating ? <CreateOrganizationDialog onClose={() => setCreating(false)} /> : null}
        {managing && current?.kind === "organization" ? (
          <OrganizationSettingsDialog
            space={current}
            onClose={() => setManaging(false)}
            onLeft={() => {
              setManaging(false);
              reload();
            }}
          />
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
