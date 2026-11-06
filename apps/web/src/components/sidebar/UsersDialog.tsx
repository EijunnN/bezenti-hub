import {
  fetchInstallationUsers,
  INSTALLATION_PERMISSION_LABELS,
  setInstallationPermission,
} from "@t3tools/client-runtime/spaces/space-directory";
import type { InstallationPermission, InstallationUser } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useEffect, useId, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { errorMessageOf as messageOf } from "../../lib/errorMessage";
import { runPrimaryHttp } from "../../lib/runtime";
import { loadSpaces, useCurrentSpace } from "../../state/currentSpace";
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
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

const PERMISSIONS: ReadonlyArray<InstallationPermission> = [
  "personalSpace.create",
  "environments.registerOwn",
];

const fetchUsers = () =>
  runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(fetchInstallationUsers)));

/** The Owner's list of Users, with the Installation permissions each one holds. */
export function UsersDialog({ onClose }: { readonly onClose: () => void }) {
  const id = useId();
  const [users, setUsers] = useState<ReadonlyArray<InstallationUser> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the Installation's Users from the server when the dialog opens
  useEffect(() => {
    let cancelled = false;
    void fetchUsers().then(
      (list) => {
        if (!cancelled) setUsers(list.users);
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause, "Could not load the Users."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async (
    user: InstallationUser,
    permission: InstallationPermission,
    granted: boolean,
  ) => {
    const key = `${user.id}:${permission}`;
    setPending(key);
    setError(null);
    try {
      const updated = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            setInstallationPermission(client, user.id, permission, granted),
          ),
        ),
      );
      setUsers((current) =>
        current === null
          ? current
          : current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      );
      // The Owner's selector lists every Personal space; keep it in step with the grant.
      const { environmentId } = useCurrentSpace.getState();
      if (environmentId !== null) void loadSpaces(environmentId);
    } catch (cause) {
      setError(messageOf(cause, "Could not change the permission."));
    }
    setPending(null);
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
          <DialogTitle>Users</DialogTitle>
          <DialogDescription>
            Installation permissions apply outside any Organization and take effect at once. You can
            always see every Personal space.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {users === null ? (
              error === null ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : null
            ) : (
              <ul className="flex flex-col gap-3" aria-label="Users">
                {users.map((user) => (
                  <li key={user.id} className="flex flex-col gap-2">
                    <div className="min-w-0 text-sm">
                      <span className="font-medium">{user.displayName}</span>
                      {user.loginName !== null ? (
                        <span className="text-muted-foreground"> · {user.loginName}</span>
                      ) : null}
                    </div>
                    {user.isOwner ? (
                      <p className="text-xs text-muted-foreground">
                        Owner: holds every permission.
                      </p>
                    ) : (
                      PERMISSIONS.map((permission) => {
                        const switchId = `${id}-${user.id}-${permission}`;
                        return (
                          <div key={permission} className="flex items-center gap-2">
                            <Switch
                              id={switchId}
                              size="sm"
                              aria-label={`${INSTALLATION_PERMISSION_LABELS[permission]}: ${user.displayName}`}
                              checked={user.installationPermissions.includes(permission)}
                              disabled={pending !== null}
                              onCheckedChange={(checked) => void toggle(user, permission, checked)}
                            />
                            <Label htmlFor={switchId}>
                              {INSTALLATION_PERMISSION_LABELS[permission]}
                            </Label>
                          </div>
                        );
                      })
                    )}
                  </li>
                ))}
              </ul>
            )}
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
