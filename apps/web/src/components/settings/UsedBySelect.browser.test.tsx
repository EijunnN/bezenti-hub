import type { SpaceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { UsedBySelect } from "./UsedBySelect";

const acme = "space-acme" as SpaceId;
const archived = "space-archived-0f3a" as SpaceId;
const spaces = [{ id: acme, name: "Acme" }];

describe("UsedBySelect", () => {
  it("names the choice, never its id", async () => {
    await using _screen = await render(
      <UsedBySelect
        id="used-by"
        spaces={spaces}
        value={acme}
        disabled={false}
        onChange={() => undefined}
      />,
    );
    const trigger = page.getByRole("combobox");
    await expect.element(trigger).toHaveTextContent("Everyone in Acme (dedicated)");
  });

  it("shows an archived Organization as unavailable, not as its raw id", async () => {
    await using _screen = await render(
      <UsedBySelect
        id="used-by"
        spaces={spaces}
        value={archived}
        disabled={false}
        onChange={() => undefined}
      />,
    );
    const trigger = page.getByRole("combobox");
    await expect.element(trigger).toHaveTextContent("An Organization that is no longer available");
    expect(document.body.textContent).not.toContain(archived);
  });

  it("picks another choice and reports it", async () => {
    const onChange = vi.fn();
    await using _screen = await render(
      <UsedBySelect
        id="used-by"
        spaces={spaces}
        value="personal"
        disabled={false}
        onChange={onChange}
      />,
    );
    await userEvent.click(page.getByRole("combobox"));
    await userEvent.click(page.getByRole("option", { name: "Everyone in Acme (dedicated)" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(acme);
  });
});
