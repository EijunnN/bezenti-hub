// @effect-diagnostics nodeBuiltinImport:off -- runs the generated scripts with a real `sh`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import ssh2 from "ssh2";

import {
  checkScript,
  forbiddenSshAddress,
  hostKeyAlgorithm,
  hostKeyFingerprint,
  machineNameRefusal,
  makeScrubber,
  normalizeSshHost,
  registerScript,
  shellQuote,
  sshUsernameRefusal,
  SECRET_WINDOW,
  STEP_BUSY_EXIT,
  STEP_BUSY_MARKER,
  stepCommand,
  stopStepScript,
} from "./sshInstallScripts.ts";

const SshUtils = ssh2.utils;

/** Runs a step's script under `sh -c`, as the machine does, with a `t3` that prints its args. */
const runWithFakeT3 = (script: string) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-script-"));
  try {
    NodeFS.mkdirSync(NodePath.join(home, ".t3", "ssh-install"), { recursive: true });
    const t3 = NodePath.join(home, ".t3", "ssh-install", "t3");
    NodeFS.writeFileSync(t3, '#!/bin/sh\nfor arg in "$@"; do printf "<%s>\\n" "$arg"; done\n');
    NodeFS.chmodSync(t3, 0o755);
    const output = NodeChildProcess.execFileSync("sh", ["-c", script], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    const pwned = NodeFS.existsSync(NodePath.join(home, "pwned"));
    return { args: output.trimEnd().split("\n"), pwned };
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
};

/**
 * Runs the check step with a `podman` that answers as given (and warns on standard error), no
 * systemd user manager and no sudo unless `fakes` adds commands of its own.
 */
const runCheckWithPodman = (rootless: string, fakes: Record<string, string> = {}) => {
  const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-check-"));
  try {
    const commands: Record<string, string> = {
      podman: `case "$1" in\n  --version) echo "podman version 3.4.4" ;;\n  info) echo 'level=warning msg="/ is not a shared mount"' >&2; echo ${rootless} ;;\nesac`,
      systemctl: "exit 1",
      loginctl: "exit 1",
      sudo: "exit 1",
      ...fakes,
    };
    for (const [name, body] of Object.entries(commands)) {
      NodeFS.writeFileSync(NodePath.join(bin, name), `#!/bin/sh\n${body}\n`);
      NodeFS.chmodSync(NodePath.join(bin, name), 0o755);
    }
    const result = NodeChildProcess.spawnSync("sh", ["-c", checkScript()], {
      env: { HOME: bin, PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    NodeFS.rmSync(bin, { recursive: true, force: true });
  }
};

describe("SSH install scripts", () => {
  it.skipIf(HostProcess.Platform.defaultValue() !== "linux" || process.getuid?.() === 0)(
    "check: rootless Podman passes even when podman warns on standard error",
    () => {
      const ready = runCheckWithPodman("true");
      expect(ready.output).toContain("Rootless Podman is ready.");
      expect(ready.output).toContain("is not a shared mount");
      expect(ready.code).toBe(0);
      const rootful = runCheckWithPodman("false");
      expect(rootful.code).toBe(14);
    },
  );

  it("pass a hostile name, Space and Hub address to `t3 join` as single arguments", () => {
    const name = `Acme'; touch "$HOME/pwned"; echo '$(id) \`id\` \\ "quoted"`;
    const spaceId = "space-1'$(touch $HOME/pwned)'";
    const hubUrl = "https://hub.example.com";
    const { args, pwned } = runWithFakeT3(registerScript({ hubUrl, spaceId, name }));
    expect(pwned).toBe(false);
    expect(args).toEqual([
      "<join>",
      "<--dedicated>",
      `<${spaceId}>`,
      "<--name>",
      `<${name}>`,
      "<--grant-on-stdin>",
      `<${hubUrl}>`,
    ]);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("accept host names and IP addresses only, and plain login names other than root", () => {
    expect(normalizeSshHost("VPS-1.Example.com.")).toBe("vps-1.example.com");
    expect(normalizeSshHost("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeSshHost("10.0.0.5")).toBe("10.0.0.5");
    for (const host of ["-oProxyCommand=sh", "a b", "host;id", "$(id)", "", "a".repeat(254)]) {
      expect(normalizeSshHost(host), host).toBeUndefined();
    }
    expect(sshUsernameRefusal("deploy")).toBeUndefined();
    for (const user of ["root", "-oProxyCommand=x", "a b", "$(id)", "x".repeat(33)]) {
      expect(sshUsernameRefusal(user), user).toBeDefined();
    }
    expect(machineNameRefusal("Acme VPS")).toBeUndefined();
    expect(machineNameRefusal("Acme\nVPS")).toBeDefined();
  });

  it("never open SSH to link-local, unspecified or multicast addresses, nor to the Hub's own machine", () => {
    const hubHost = { ownAddresses: ["192.168.1.5", "fe80::5%eth0", "2001:db8::5"] };
    for (const address of [
      "169.254.169.254",
      "::ffff:169.254.169.254",
      "fe80::1",
      "0.0.0.0",
      "::",
      "224.0.0.1",
      "255.255.255.255",
      "ff02::1",
    ]) {
      expect(forbiddenSshAddress(address, hubHost), address).toBeDefined();
      expect(forbiddenSshAddress(address, undefined), address).toBeDefined();
    }
    for (const address of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1", "192.168.1.5"]) {
      expect(forbiddenSshAddress(address, hubHost), address).toBe("the Hub's own machine");
    }
    expect(forbiddenSshAddress("2001:DB8::5", hubHost)).toBe("the Hub's own machine");
    for (const address of ["10.1.2.3", "192.168.1.10", "203.0.113.7", "2001:db8::6"]) {
      expect(forbiddenSshAddress(address, hubHost), address).toBeUndefined();
    }
    // Development and tests only: the Hub's own machine is allowed.
    for (const address of ["127.0.0.1", "::1", "192.168.1.5"]) {
      expect(forbiddenSshAddress(address, undefined), address).toBeUndefined();
    }
  });

  it("scrub the key, its passphrase and the grant out of the machine's output", () => {
    const pair = SshUtils.generateKeyPairSync("ed25519");
    const { scrub } = makeScrubber({
      privateKey: pair.private,
      passphrase: "correct horse",
      grant: "grant-0123456789abcdef",
    });
    const body = pair.private.split("\n").filter((line) => line !== "" && !line.startsWith("-"));
    for (const line of [...pair.private.split("\n"), body.join("")]) {
      if (line.trim().length < 16 && !line.startsWith("-----")) continue;
      const scrubbed = scrub(`echo ${line}`);
      for (const fragment of body) expect(scrubbed).not.toContain(fragment);
    }
    expect(scrub("-----BEGIN RSA PRIVATE KEY-----")).toBe("[redacted]");
    expect(scrub("passphrase: correct horse!")).toBe("passphrase: [redacted]!");
    expect(scrub("got grant-0123456789abcdef")).toBe("got [redacted]");
    expect(scrub("Rootless Podman is ready.")).toBe("Rootless Podman is ready.");
  });

  it("print a host key's fingerprint as ssh-keygen does", () => {
    const parsed = SshUtils.parseKey(SshUtils.generateKeyPairSync("ed25519").public);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("no key");
    const blob = parsed.getPublicSSH();
    expect(hostKeyAlgorithm(blob)).toBe("ssh-ed25519");
    expect(hostKeyFingerprint(blob)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/u);
  });

  it.skipIf(HostProcess.Platform.defaultValue() !== "linux" || process.getuid?.() === 0)(
    "check: with a systemd user manager, lingering is on or turned on, or it stops at once",
    () => {
      const systemd = { systemctl: "exit 0" };
      const lingering = runCheckWithPodman("true", {
        ...systemd,
        loginctl: 'case "$1" in show-user) echo Linger=yes ;; *) exit 1 ;; esac',
      });
      expect(lingering.code).toBe(0);
      expect(lingering.output).toContain("Lingering is on");
      const enabled = runCheckWithPodman("true", {
        ...systemd,
        loginctl:
          'case "$1" in show-user) [ -f "$HOME/on" ] && echo Linger=yes || echo Linger=no ;; enable-linger) touch "$HOME/on" ;; esac',
      });
      expect(enabled.code).toBe(0);
      expect(enabled.output).toContain("Lingering is on");
      const refused = runCheckWithPodman("true", {
        ...systemd,
        loginctl: 'case "$1" in show-user) echo Linger=no ;; *) exit 1 ;; esac',
      });
      expect(refused.code).toBe(15);
      expect(refused.output).toContain("loginctl enable-linger");
      // It stops before Podman is installed or anything else is done.
      expect(refused.output).not.toContain("Rootless Podman is ready.");
      // No systemd user manager: the service runs in the background, lingering does not matter.
      expect(runCheckWithPodman("true").code).toBe(0);
    },
  );

  it.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "run each step under a lock of its own process group, which only that step's stop ends",
    async () => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-step-"));
      const env = { HOME: home, PATH: "/usr/bin:/bin" };
      const dir = NodePath.join(home, ".t3", "ssh-install");
      const lock = NodePath.join(dir, "step.lock");
      const sh = (command: string, input = "") =>
        NodeChildProcess.spawnSync("sh", ["-c", command], { env, input, encoding: "utf8" });
      const run = (script: string, token: string, input = "") =>
        sh(stepCommand(script, { token, step: "install" }), input);
      const waitUntil = (done: () => boolean) => {
        for (let i = 0; i < 200 && !done(); i++) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
      };
      try {
        // The check step leaves no directory it made; later steps make it.
        expect(sh(stepCommand("echo checked", { token: "c", step: "check" })).stdout).toBe(
          "checked\n",
        );
        expect(NodeFS.existsSync(dir)).toBe(false);
        // Its standard input reaches the step, and its exit code comes back.
        const echoed = run("cat; exit 3", "a", "the runner");
        expect(echoed.stdout).toBe("the runner");
        expect(echoed.status).toBe(3);

        // A step still running (its SSH channel gone) holds the lock.
        const long = NodeChildProcess.spawn(
          "sh",
          [
            "-c",
            stepCommand("sleep 60 & sleep 60; echo never", { token: "long", step: "install" }),
          ],
          { env, stdio: "ignore" },
        );
        const exited = new Promise<void>((resolve) => long.on("exit", () => resolve()));
        waitUntil(
          () => NodeFS.existsSync(lock) && NodeFS.readFileSync(lock, "utf8").includes("long"),
        );
        const group = NodeFS.readFileSync(lock, "utf8").split(" ")[0]!;
        const second = run("echo second", "b");
        expect(second.status).toBe(STEP_BUSY_EXIT);
        expect(second.stderr).toContain(STEP_BUSY_MARKER);
        expect(second.stdout).not.toContain("second");
        // Another step's stop leaves it alone; its own stop ends the whole group.
        expect(sh(stopStepScript("someone-else")).stdout).toBe("");
        expect(sh(`kill -0 -${group}`).status).toBe(0);
        expect(sh(stopStepScript("long")).status).toBe(0);
        await exited;
        expect(sh(`kill -0 -${group}`).status).not.toBe(0);

        // A lock its holder left (it died): the next step takes it, nothing stale stops it.
        expect(run("echo again", "c").stdout).toBe("again\n");

        // A lock file naming a live group it does not hold: no stop kills that group.
        const bystander = NodeChildProcess.spawn("setsid", ["sleep", "60"], { stdio: "ignore" });
        const bystanderExited = new Promise<void>((resolve) =>
          bystander.on("exit", () => resolve()),
        );
        waitUntil(() => sh(`kill -0 -${bystander.pid}`).status === 0);
        NodeFS.writeFileSync(lock, `${bystander.pid} stale\n`);
        sh(stopStepScript("stale"));
        expect(sh(`kill -0 -${bystander.pid}`).status).toBe(0);
        bystander.kill("SIGKILL");
        await bystanderExited;

        // A stop that comes before its step takes the lock: the step does not begin.
        sh(stopStepScript("early"));
        const early = run("echo began", "early");
        expect(early.stdout).not.toContain("began");
        expect(early.status).toBe(130);
        expect(run("echo later", "later").stdout).toBe("later\n");
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("judge every way of writing an address by its bytes", () => {
    const hubHost = { ownAddresses: ["192.168.1.5", "2001:db8::5"] };
    for (const address of [
      "0:0:0:0:0:0:0:1",
      "0000:0000:0000:0000:0000:0000:0000:0001",
      "::0:1",
      "::ffff:7f00:1",
      "::ffff:127.0.0.1",
      "0:0:0:0:0:ffff:127.0.0.1",
      "::FFFF:7F00:0001",
      "::127.0.0.1",
      "::ffff:c0a8:105",
      "::ffff:192.168.1.5",
      "2001:0db8:0000:0000:0000:0000:0000:0005",
      "2001:db8:0:0::5",
    ]) {
      expect(forbiddenSshAddress(address, hubHost), address).toBe("the Hub's own machine");
    }
    for (const address of ["0:0:0:0:0:0:0:0", "::ffff:0.0.0.0", "::ffff:0:0"]) {
      expect(forbiddenSshAddress(address, hubHost), address).toBe("an unspecified address");
    }
    for (const address of ["::ffff:a9fe:a9fe", "FE80:0:0::1", "fe80::1%eth0"]) {
      expect(forbiddenSshAddress(address, hubHost), address).toBe("a link-local address");
    }
    // The Hub's own addresses in any form too.
    expect(forbiddenSshAddress("192.168.1.5", { ownAddresses: ["::ffff:c0a8:105"] })).toBe(
      "the Hub's own machine",
    );
    expect(forbiddenSshAddress("2001:db8::6", hubHost)).toBeUndefined();
    expect(forbiddenSshAddress("::ffff:c0a8:106", hubHost)).toBeUndefined();
    expect(forbiddenSshAddress("not-an-ip", hubHost)).toBe("not an IP address");
  });

  it("scrub in one pass: a short passphrase never breaks a redaction, a tiny one is left", () => {
    const pair = SshUtils.generateKeyPairSync("ed25519");
    const body = pair.private
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("-"))
      .join("");
    // The passphrase is also inside the marker text a window pass leaves: replacing it afterwards
    // would cut into `[redacted]`.
    const { scrub } = makeScrubber({ privateKey: pair.private, passphrase: "dact" });
    expect(scrub(`${body.slice(0, 20)} then dact`)).toBe("[redacted] then [redacted]");
    expect(makeScrubber({ passphrase: "ab" }).scrub("tab and cab")).toBe("tab and cab");
  });

  it("carry a cut line's coverage, so no piece of a secret escapes at the cut", () => {
    const grant = "Gq3ZyX0vWk2LmN8pRt5UaB7cDe9FgHiJ4kLmNoPqRsT";
    const scrubber = makeScrubber({ grant });
    const text = `xx${grant.slice(0, 30)}`;
    const cut = text.length - (SECRET_WINDOW - 1);
    const mask = scrubber.mask(text);
    const head = scrubber.redact(text.slice(0, cut), mask.subarray(0, cut));
    const tail = `${text.slice(cut)}${grant.slice(30, 33)} after`;
    const rest = scrubber.redact(tail, scrubber.mask(tail, mask.subarray(cut)));
    expect(head).toBe("xx[redacted]");
    expect(rest).toBe("[redacted] after");
  });

  it("scrub any long piece of the key or the grant, not only whole lines", () => {
    const pair = SshUtils.generateKeyPairSync("ed25519");
    const grant = "Gq3ZyX0vWk2LmN8pRt5UaB7cDe9FgHiJ4kLmNoPqRsT";
    const { scrub } = makeScrubber({ privateKey: pair.private, grant });
    const body = pair.private
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("-"))
      .join("");
    for (const piece of [body.slice(30, 50), body.slice(65, 85), grant.slice(5, 20)]) {
      expect(scrub(`before ${piece} after`), piece).toBe("before [redacted] after");
    }
    // Glued to other text, a piece of it still goes, and the rest of the line stays.
    expect(scrub(`x=${body.slice(100, 130)}!`)).toBe("x=[redacted]!");
    expect(scrub("podman version 3.4.4")).toBe("podman version 3.4.4");
  });
});
