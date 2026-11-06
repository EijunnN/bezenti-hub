import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("hides what the Role does not allow on someone else's Thread", () => {
    const ids = (role: ThreadActionMenuState["role"]) =>
      buildThreadActionMenuItems(role === undefined ? baseState : { ...baseState, role }).map(
        (item) => item.id,
      );
    // A Member reading a teammate's Thread keeps only reading, copying and navigating.
    expect(
      ids({ canContinue: false, canArchive: false, canDelete: false, canCreateGuestLink: false }),
    ).toEqual(["copy", "project-settings"]);
    // An Admin also archives and deletes it, but still cannot change it.
    expect(
      ids({ canContinue: false, canArchive: true, canDelete: true, canCreateGuestLink: true }),
    ).toEqual(["copy", "project-settings", "archive", "delete"]);
    // The creator keeps every action.
    expect(
      ids({ canContinue: true, canArchive: true, canDelete: false, canCreateGuestLink: false }),
    ).toEqual(ids(undefined).filter((id) => id !== "delete"));
  });

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});
