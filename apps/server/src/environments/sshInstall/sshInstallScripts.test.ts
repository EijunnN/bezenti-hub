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

/** Runs the check step with a `podman` that answers as given (and warns on standard error). */
const runCheckWithPodman = (rootless: string) => {
  const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-check-"));
  try {
    NodeFS.writeFileSync(
      NodePath.join(bin, "podman"),
      `#!/bin/sh\ncase "$1" in\n  --version) echo "podman version 3.4.4" ;;\n  info) echo 'level=warning msg="/ is not a shared mount"' >&2; echo ${rootless} ;;\nesac\n`,
    );
    NodeFS.chmodSync(NodePath.join(bin, "podman"), 0o755);
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

  it("never open SSH to link-local, unspecified or multicast addresses; loopback and private are the Owner's", () => {
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
      expect(forbiddenSshAddress(address), address).toBeDefined();
    }
    for (const address of ["127.0.0.1", "::1", "10.1.2.3", "192.168.1.10", "203.0.113.7"]) {
      expect(forbiddenSshAddress(address), address).toBeUndefined();
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
});
