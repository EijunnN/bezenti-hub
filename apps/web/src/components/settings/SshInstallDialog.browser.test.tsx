import type { SpaceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SshInstallDialog } from "./SshInstallDialog";

const acme = "space-acme-77aa" as SpaceId;

const dialog = (organizations: ReadonlyArray<{ id: SpaceId; name: string }>) => (
  <SshInstallDialog
    organizations={organizations}
    onClose={() => undefined}
    onInstalled={() => undefined}
  />
);

describe("SshInstallDialog «Dedicated to»", () => {
  it("says an Organization is needed while none is listed", async () => {
    await using _screen = await render(dialog([]));
    const trigger = page.getByRole("combobox", { name: "Dedicated to" });
    await expect.element(trigger).toHaveTextContent("Create an Organization first");
    await expect.element(trigger).toBeDisabled();
  });

  it("picks the first Organization once they load after the dialog opened", async () => {
    await using screen = await render(dialog([]));
    await screen.rerender(dialog([{ id: acme, name: "Acme" }]));
    const trigger = page.getByRole("combobox", { name: "Dedicated to" });
    await expect.element(trigger).toHaveTextContent("Everyone in Acme");
    await expect.element(trigger).toBeEnabled();
    expect(document.body.textContent).not.toContain(acme);
  });
});
