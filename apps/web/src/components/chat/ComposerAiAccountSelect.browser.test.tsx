import type { AiAccountId, AiAccountPickerAccount } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ComposerAiAccountSelect } from "./ComposerAiAccountSelect";

const accounts: ReadonlyArray<AiAccountPickerAccount> = [
  {
    id: "acct-a" as AiAccountId,
    name: "Acme Claude",
    type: "subscription",
    provider: "claude",
    priority: 1,
    models: ["claude-sonnet-5-5"],
  },
  {
    id: "acct-b" as AiAccountId,
    name: "Acme Router",
    type: "api-key",
    provider: "openai-compatible",
    priority: 2,
    models: ["claude-sonnet-5-5"],
  },
];

describe("ComposerAiAccountSelect", () => {
  it("shows the account in use and switches to another allowed one", async () => {
    const onChange = vi.fn();
    await using screen = await render(
      <ComposerAiAccountSelect
        accounts={accounts}
        value={"acct-a" as AiAccountId}
        size="sm"
        onChange={onChange}
      />,
      { router: false },
    );
    const trigger = screen.getByRole("combobox", { name: "AI account" });
    await expect.element(trigger).toHaveTextContent("Acme Claude");
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("option", { name: "Acme Router" }));
    expect(onChange).toHaveBeenCalledWith("acct-b");
  });

  it("is disabled while a send is busy", async () => {
    await using screen = await render(
      <ComposerAiAccountSelect
        accounts={accounts}
        value={"acct-a" as AiAccountId}
        size="sm"
        disabled
        onChange={vi.fn()}
      />,
      { router: false },
    );
    await expect.element(screen.getByRole("combobox", { name: "AI account" })).toBeDisabled();
  });
});
