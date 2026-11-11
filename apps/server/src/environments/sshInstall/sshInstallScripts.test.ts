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
    const scrub = makeScrubber({
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
    "run each step in a process group of its own that a second step waits on and stop ends",
    async () => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-step-"));
      const env = { HOME: home, PATH: "/usr/bin:/bin" };
      const run = (script: string, input = "") =>
        NodeChildProcess.spawnSync("sh", ["-c", stepCommand(script)], {
          env,
          input,
          encoding: "utf8",
        });
      try {
        // Its standard input reaches the step, and its exit code comes back.
        const echoed = run("cat; exit 3", "the runner");
        expect(echoed.stdout).toBe("the runner");
        expect(echoed.status).toBe(3);
        // A step still running (its SSH channel gone) holds the machine.
        const long = NodeChildProcess.spawn(
          "sh",
          ["-c", stepCommand("sleep 60 & sleep 60; echo never")],
          { env, stdio: "ignore" },
        );
        const exited = new Promise<void>((resolve) => long.on("exit", () => resolve()));
        const pidfile = NodePath.join(home, ".t3", "ssh-install", "step.pid");
        for (let i = 0; i < 100 && !NodeFS.existsSync(pidfile); i++) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
        const group = NodeFS.readFileSync(pidfile, "utf8").trim();
        const second = run("echo second");
        expect(second.status).toBe(75);
        expect(second.stderr).toContain("Another installation is still running");
        expect(second.stdout).not.toContain("second");
        // Stopping ends the whole group, its children too.
        const stopped = NodeChildProcess.spawnSync("sh", ["-c", stopStepScript()], {
          env,
          encoding: "utf8",
        });
        expect(stopped.status).toBe(0);
        await exited;
        const alive = NodeChildProcess.spawnSync("sh", ["-c", `kill -0 -${group}`]);
        expect(alive.status).not.toBe(0);
        expect(run("echo again").stdout).toBe("again\n");
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

  it("scrub any long piece of the key or the grant, not only whole lines", () => {
    const pair = SshUtils.generateKeyPairSync("ed25519");
    const grant = "Gq3ZyX0vWk2LmN8pRt5UaB7cDe9FgHiJ4kLmNoPqRsT";
    const scrub = makeScrubber({ privateKey: pair.private, grant });
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
