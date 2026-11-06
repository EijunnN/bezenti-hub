import {
  AUDIT_ACTION_LABELS,
  fetchAuditLog,
  fetchInstallationUsers,
} from "@t3tools/client-runtime/spaces/space-directory";
import {
  AuditAction,
  type AuditEntry,
  type AuditLogQuery,
  type InstallationUser,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { useEffect, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { errorMessageOf as messageOf } from "../../lib/errorMessage";
import { runPrimaryHttp } from "../../lib/runtime";
import { useCurrentSpace } from "../../state/currentSpace";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const ANY = "any";

interface Filters {
  readonly action: AuditAction | typeof ANY;
  readonly actorUserId: string;
  readonly spaceId: string;
}

const queryOf = (filters: Filters, before: string | null): AuditLogQuery => ({
  ...(filters.action === ANY ? {} : { action: filters.action }),
  ...(filters.actorUserId === ANY ? {} : { actorUserId: UserId.make(filters.actorUserId) }),
  ...(filters.spaceId === ANY ? {} : { spaceId: SpaceId.make(filters.spaceId) }),
  ...(before === null ? {} : { before }),
});

const fetchPage = (query: AuditLogQuery) =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(Effect.flatMap((client) => fetchAuditLog(client, query))),
  );

const actorOf = (entry: AuditEntry) =>
  entry.actor.source === "cli"
    ? "The Hub's shell"
    : entry.actor.source === "system"
      ? "T3 Code"
      : (entry.actor.displayName ?? "Unknown User");

/** The Owner's audit log: who did what in the sensitive actions, newest first. */
export function AuditLogDialog({ onClose }: { readonly onClose: () => void }) {
  const spaces = useCurrentSpace((state) => state.view?.spaces ?? []);
  const [users, setUsers] = useState<ReadonlyArray<InstallationUser>>([]);
  const [filters, setFilters] = useState<Filters>({ action: ANY, actorUserId: ANY, spaceId: ANY });
  const [entries, setEntries] = useState<ReadonlyArray<AuditEntry> | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the Users to filter by from the server when the dialog opens
  useEffect(() => {
    let cancelled = false;
    void runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(fetchInstallationUsers)))
      .then((list) => {
        if (!cancelled) setUsers(list.users);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the first page from the server whenever the filters change
  useEffect(() => {
    let cancelled = false;
    void fetchPage(queryOf(filters, null)).then(
      (page) => {
        if (cancelled) return;
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause, "Could not load the audit log."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const changeFilters = (next: Filters) => {
    setFilters(next);
    setEntries(null);
    setError(null);
  };

  const loadOlder = async () => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(queryOf(filters, nextCursor));
      setEntries((current) => [...(current ?? []), ...page.entries]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(messageOf(cause, "Could not load older entries."));
    }
    setLoadingMore(false);
  };

  const userName = (userId: string) =>
    users.find((user) => user.id === userId)?.displayName ?? "Unknown User";
  const spaceName = (spaceId: string) =>
    spaces.find((space) => space.id === spaceId)?.name ?? "Unknown Space";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Audit log</DialogTitle>
          <DialogDescription>
            Invitations, Role changes, permanent deletions, Users turned off or removed, and the
            sign-ins you approved. Entries are kept for good.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Select
                value={filters.action}
                onValueChange={(value) =>
                  changeFilters({
                    ...filters,
                    action: (value as Filters["action"] | null) ?? ANY,
                  })
                }
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Filter by action">
                  <SelectValue>
                    {filters.action === ANY ? "Any action" : AUDIT_ACTION_LABELS[filters.action]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value={ANY}>
                    Any action
                  </SelectItem>
                  {AuditAction.literals.map((action) => (
                    <SelectItem hideIndicator key={action} value={action}>
                      {AUDIT_ACTION_LABELS[action]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Select
                value={filters.actorUserId}
                onValueChange={(value) =>
                  changeFilters({
                    ...filters,
                    actorUserId: value ?? ANY,
                  })
                }
              >
                <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Filter by User">
                  <SelectValue>
                    {filters.actorUserId === ANY ? "Anyone" : userName(filters.actorUserId)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value={ANY}>
                    Anyone
                  </SelectItem>
                  {users.map((user) => (
                    <SelectItem hideIndicator key={user.id} value={user.id}>
                      {user.displayName}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Select
                value={filters.spaceId}
                onValueChange={(value) =>
                  changeFilters({
                    ...filters,
                    spaceId: value ?? ANY,
                  })
                }
              >
                <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Filter by Space">
                  <SelectValue>
                    {filters.spaceId === ANY ? "Any Space" : spaceName(filters.spaceId)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value={ANY}>
                    Any Space
                  </SelectItem>
                  {spaces.map((space) => (
                    <SelectItem hideIndicator key={space.id} value={space.id}>
                      {space.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {entries === null ? (
              error === null ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : null
            ) : entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
            ) : (
              <ul className="flex flex-col divide-y" aria-label="Audit entries">
                {entries.map((entry) => (
                  <li key={entry.id} className="flex flex-col gap-0.5 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium">{AUDIT_ACTION_LABELS[entry.action]}</span>
                      {entry.target.name !== null ? <span>: {entry.target.name}</span> : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {[
                        actorOf(entry),
                        ...(entry.space === null ? [] : [entry.space.name ?? "Deleted Space"]),
                        DateTime.toDate(entry.at).toLocaleString(),
                      ].join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {nextCursor !== null && entries !== null ? (
              <Button
                type="button"
                size="compact"
                variant="outline"
                disabled={loadingMore}
                onClick={() => void loadOlder()}
              >
                Load older entries
              </Button>
            ) : null}
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
