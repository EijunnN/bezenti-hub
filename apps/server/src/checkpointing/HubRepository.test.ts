import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, VcsProcessExitError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
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

it("a remote URL that does not decode keeps no password, nor the user that hides it", () => {
  for (const remote of [
    "https://user%ZZ:s3cret@git.example.com/a/b.git",
    "https://%E0%A4%A:s3cret@git.example.com/a/b.git",
    "ssh://git%ZZ:s3cret@git.example.com/a/b.git",
  ]) {
    const named = HubRepository.remoteWithoutCredentials(remote);
    assert.notInclude(named, "s3cret", remote);
    assert.include(named, "git.example.com/a/b.git", remote);
  }
});

/**
 * The Hub's repositories over a real disk and git, with the copy's fetch (`fetch --prune`) handed
 * to `onCopy` instead: it may take its time or fail.
 */
const withRepositories = <A, E>(
  onCopy: (attempt: number) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsProcessExitError>,
  body: (
    repositories: HubRepository.HubRepositories["Service"],
    checkout: string,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hub-checkout-" });
    const real = yield* VcsProcess.VcsProcess;
    const git = (...args: ReadonlyArray<string>) =>
      real.run({ operation: "HubRepository.test", command: "git", cwd: checkout, args });
    yield* git("init", "--quiet", "--initial-branch=main");
    yield* git(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "One",
    );
    let attempt = 0;
    const fake = VcsProcess.VcsProcess.of({
      run: (input) => (input.args.includes("--prune") ? onCopy(attempt++) : real.run(input)),
    });
    const repositories = yield* Layer.build(
      HubRepository.layer.pipe(
        Layer.provide(Layer.succeed(VcsProcess.VcsProcess, fake)),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hub-repositories-" })),
      ),
    ).pipe(Effect.map((context) => Context.get(context, HubRepository.HubRepositories)));
    // Not at the epoch: a copy recorded at 0 would look like one made before anyone asked.
    yield* TestClock.adjust("1 second");
    return yield* body(repositories, checkout);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        VcsProcess.layer.pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  );

const copied: VcsProcess.VcsProcessOutput = {
  exitCode: 0 as VcsProcess.VcsProcessOutput["exitCode"],
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};
const projectId = ProjectId.make("project:copied");

it.effect("a copy of the Hub's checkout that takes minutes is not cut off", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let finished = 0;
    yield* withRepositories(
      () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.sleep("5 minutes")),
          Effect.andThen(Effect.sync(() => void (finished += 1))),
          Effect.as(copied),
        ),
      (repositories, checkout) =>
        Effect.gen(function* () {
          const copy = yield* repositories
            .mirrorCheckout(projectId, checkout)
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* TestClock.adjust("5 minutes");
          yield* Fiber.join(copy);
        }),
    );
    assert.equal(finished, 1);
  }),
);

it.effect("a failed copy counts for no clone: the next one copies again", () =>
  Effect.gen(function* () {
    let copies = 0;
    yield* withRepositories(
      (attempt) =>
        Effect.sync(() => void (copies += 1)).pipe(
          Effect.andThen(
            attempt === 0
              ? Effect.fail(
                  new VcsProcessExitError({
                    operation: "test",
                    command: "git",
                    cwd: "/",
                    exitCode: 1,
                    detail: "the copy failed",
                  }),
                )
              : Effect.succeed(copied),
          ),
        ),
      (repositories, checkout) =>
        Effect.gen(function* () {
          // The clock stands still: both clones ask at the same moment.
          yield* repositories.mirrorCheckout(projectId, checkout);
          yield* repositories.mirrorCheckout(projectId, checkout);
        }),
    ).pipe(Effect.asVoid);
    assert.equal(copies, 2);
  }),
);
