import type { SpaceDirectoryView, SpaceSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { runPrimaryHttp } from "../../lib/runtime";
import { PrimaryEnvironmentHttpClient } from "./httpClient";

/** The Spaces the signed-in User can switch to on this Installation. */
export function fetchSpaces(): Promise<SpaceDirectoryView> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.spaces.list({ headers: {} })),
    ),
  );
}

/** Only the Owner may; the server refuses anyone else. */
export function createOrganization(name: string): Promise<SpaceSummary> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.spaces.createOrganization({ headers: {}, payload: { name } }),
      ),
    ),
  );
}
