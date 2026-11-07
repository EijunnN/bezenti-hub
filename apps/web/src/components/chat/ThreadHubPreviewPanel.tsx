import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { previewEnvironment } from "../../state/preview";
import { readPreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

interface ThreadHubPreviewPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const isPort = (value: number) => Number.isInteger(value) && value > 0 && value < 65_536;

/** The Hub's address as this client reaches it: absolute from the Hub, else on its own origin. */
const absoluteUrl = (environmentId: EnvironmentId, address: { path: string; url?: string }) => {
  if (address.url !== undefined) return address.url;
  const base = readPreparedConnection(environmentId)?.httpBaseUrl ?? window.location.origin;
  return new URL(address.path, base).toString();
};

/**
 * A dev server on the Thread's machine (its Sandbox, a joined machine), opened through the Hub at
 * an address only this User's session can use. It opens in a new tab, sandboxed from the Hub.
 */
export function ThreadHubPreviewPanel(props: ThreadHubPreviewPanelProps) {
  const canOpen = useAtomValue(previewEnvironment.proxyUrl.permissionAtom(props.environmentId));
  const proxyUrl = useAtomCommand(previewEnvironment.proxyUrl, { reportFailure: false });
  const [port, setPort] = useState("");
  const [opening, setOpening] = useState(false);
  const [opened, setOpened] = useState<{ port: number; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const portId = useId();
  if (!canOpen) return null;
  const parsed = Number(port);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isPort(parsed) || opening) return;
    setOpening(true);
    setError(null);
    const result = await proxyUrl({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, port: parsed },
    });
    setOpening(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
      return;
    }
    const url = absoluteUrl(props.environmentId, result.value);
    setOpened({ port: parsed, url });
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <ThreadDetailsSection headingId="thread-details-hub-preview-heading" title="Preview">
      <form className="flex items-center gap-1.5 px-1" onSubmit={(event) => void submit(event)}>
        <label htmlFor={portId} className="text-xs text-muted-foreground">
          Port
        </label>
        <input
          id={portId}
          inputMode="numeric"
          placeholder="5173"
          value={port}
          onChange={(event) => setPort(event.target.value.trim())}
          className="h-7 w-20 min-w-0 rounded-md border border-input bg-transparent px-2 text-sm"
        />
        <ThreadDetailsControl
          type="submit"
          size="sm"
          variant="ghost"
          part="row"
          disabled={!isPort(parsed) || opening}
        >
          {opening ? (
            <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
          ) : (
            <ExternalLinkIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          )}
          Open preview
        </ThreadDetailsControl>
      </form>
      {opened !== null ? (
        <a
          href={opened.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate px-1 pt-1 text-xs text-muted-foreground underline"
        >
          Open port {opened.port} through the Hub
        </a>
      ) : null}
      {error !== null ? (
        <p role="alert" className="px-1 pt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </ThreadDetailsSection>
  );
}
