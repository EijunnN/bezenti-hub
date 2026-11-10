import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as HubRepository from "./HubRepository.ts";

const CREDENTIAL = "t3env_hub_secret";

/** What git's credential machinery answers for a URL, with the Hub remote's environment. */
const fill = (url: string) =>
  Effect.gen(function* () {
    const vcs = yield* VcsProcess.VcsProcess;
    const remote = HubRepository.withEnvironmentCredential(
      "http://127.0.0.1:7123/api/git/project",
      CREDENTIAL,
    );
    const target = new URL(url);
    const output = yield* vcs.run({
      operation: "HubRepository.test.credential",
      command: "git",
      cwd: process.cwd(),
      args: ["credential", "fill"],
      env: { ...remote.env },
      stdin: `protocol=${target.protocol.slice(0, -1)}\nhost=${target.host}\npath=${target.pathname.slice(1)}\n\n`,
      allowNonZeroExit: true,
    });
    return output.stdout;
  }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))));

it.live("the credential helper answers the Hub only, not a host git is sent to", () =>
  Effect.gen(function* () {
    assert.include(yield* fill("http://127.0.0.1:7123/api/git/project"), `password=${CREDENTIAL}`);
    // A redirect or another remote on the same command line never gets the credential.
    assert.notInclude(yield* fill("https://evil.example/api/git/project"), CREDENTIAL);
    assert.notInclude(yield* fill("http://127.0.0.1:7124/api/git/project"), CREDENTIAL);
    assert.notInclude(yield* fill("https://127.0.0.1:7123/api/git/project"), CREDENTIAL);
  }),
);

it("a remote another machine's checkout names keeps no password or token of the Hub's", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    // The password goes; the user stays, unless it is itself a token.
    ["https://t3:s3cret@git.example.com/acme/web.git", "https://t3@git.example.com/acme/web.git"],
    ["https://alice@git.example.com/a/b.git", "https://alice@git.example.com/a/b.git"],
    [
      "https://ghp_0123456789abcdefghijABCDEFGHIJ012345@github.com/a/b.git",
      "https://github.com/a/b.git",
    ],
    ["https://glpat-AbCdEf0123456789xyzW@gitlab.com/a/b.git", "https://gitlab.com/a/b.git"],
    // A secret query parameter goes; the others stay.
    ["https://git.example.com/a/b.git?token=s3cret", "https://git.example.com/a/b.git"],
    [
      "https://git.example.com/a/b.git?ref=main&private_token=s3cret",
      "https://git.example.com/a/b.git?ref=main",
    ],
    ["ssh://git:s3cret@git.example.com/a/b.git", "ssh://git@git.example.com/a/b.git"],
    ["ssh://git@git.example.com/a/b.git", "ssh://git@git.example.com/a/b.git"],
    ["git@git.example.com:a/b.git", "git@git.example.com:a/b.git"],
    ["https://git.example.com/a/b.git", "https://git.example.com/a/b.git"],
    ["/srv/repos/acme", "/srv/repos/acme"],
  ];
  for (const [remote, named] of cases) {
    assert.equal(HubRepository.remoteWithoutCredentials(remote), named, remote);
  }
});
