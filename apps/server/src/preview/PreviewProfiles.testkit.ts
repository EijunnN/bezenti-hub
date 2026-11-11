import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as PreviewProfiles from "./PreviewProfiles.ts";

/** The key tests name folders with. */
const TEST_KEY = new Uint8Array(32).fill(7);

/** The folder names `layerTest` gives. */
export const testFolders = PreviewProfiles.folderNames(TEST_KEY);

/**
 * Profiles whose owners a test names: `ownerOf` answers for each Thread (undefined: unknown, as
 * a draft). Everyone keeps their profiles unless `keeps` says otherwise.
 */
export const layerTest = (
  ownerOf: (threadId: string) => PreviewProfiles.ProfileOwner | undefined,
  options: {
    readonly keeps?: PreviewProfiles.PreviewProfiles["Service"]["keeps"];
    readonly accessChanges?: PreviewProfiles.PreviewProfiles["Service"]["accessChanges"];
  } = {},
) =>
  Layer.succeed(
    PreviewProfiles.PreviewProfiles,
    PreviewProfiles.make({
      key: TEST_KEY,
      ownerOfThread: (threadId) => Effect.succeed(Option.fromNullishOr(ownerOf(threadId))),
      keeps: options.keeps ?? (() => Effect.succeed(true)),
      accessChanges: options.accessChanges ?? Effect.succeed(Stream.never),
    }),
  );
