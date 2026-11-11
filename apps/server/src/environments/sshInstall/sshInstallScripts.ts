// @effect-diagnostics nodeBuiltinImport:off -- address checks and the host key's digest.
/**
 * What «Add a machine over SSH» sends to the machine and what it checks first: the address, user
 * and name it accepts, the shell scripts of each step (everything from the Owner single-quoted),
 * the host key's fingerprint, and the scrubber every line of output passes through.
 * See docs/internals/sandboxes.md, «Installing over SSH».
 */
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import type { SshInstallStepId } from "@t3tools/contracts";

/** Every value from the Owner that reaches a remote shell goes through here. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/u;
/** A POSIX login name; never one an `ssh` option or a shell could read otherwise. */
const USERNAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** A host as typed: a DNS name or an IP address (`[v6]` too); undefined when it is neither. */
export const normalizeSshHost = (host: string): string | undefined => {
  const trimmed = host.trim();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (NodeNet.isIP(unbracketed) !== 0) return unbracketed.toLowerCase();
  return HOSTNAME.test(trimmed) ? trimmed.toLowerCase().replace(/\.$/u, "") : undefined;
};

export const sshUsernameRefusal = (username: string): string | undefined => {
  if (!USERNAME.test(username)) return "That is not a user name SSH accepts here.";
  if (username === "root") {
    return "Connect as a non-root user: the machine runs its work in rootless Podman.";
  }
  return undefined;
};

export const machineNameRefusal = (name: string): string | undefined =>
  CONTROL.test(name) ? "The machine's name cannot hold control characters." : undefined;

const ipv4Bytes = (address: string) => address.split(".").map((part) => Number(part));

/**
 * Where the Hub never opens SSH (docs/internals/sandboxes.md, «Installing over SSH»): link-local
 * addresses (cloud metadata services live there), unspecified, multicast and broadcast ones. The
 * Owner's own loopback and private networks are allowed: they are where a Hub's machines and its
 * tests are. Undefined when the address may be used.
 */
export const forbiddenSshAddress = (address: string): string | undefined => {
  let ip = address.toLowerCase();
  // An IPv4 address written as IPv6 is judged as IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(ip);
  if (mapped?.[1] !== undefined) ip = mapped[1];
  const family = NodeNet.isIP(ip);
  if (family === 4) {
    const [a, b] = ipv4Bytes(ip);
    if (a === 169 && b === 254) return "a link-local address";
    if (a === 0) return "an unspecified address";
    if (a !== undefined && a >= 224) return "a multicast or reserved address";
    return undefined;
  }
  if (family === 6) {
    if (ip === "::") return "an unspecified address";
    if (/^fe[89ab]/u.test(ip)) return "a link-local address";
    if (ip.startsWith("ff")) return "a multicast address";
    return undefined;
  }
  return "not an IP address";
};

/** `SHA256:<base64 without padding>` of the key's wire blob, as `ssh-keygen -lf` prints it. */
export const hostKeyFingerprint = (blob: Uint8Array): string =>
  `SHA256:${NodeCrypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "")}`;

/** The key's algorithm: the blob's first string. */
export const hostKeyAlgorithm = (blob: Uint8Array): string => {
  if (blob.length < 4) return "unknown";
  const length = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0);
  if (length > 64 || blob.length < 4 + length) return "unknown";
  return new TextDecoder().decode(blob.subarray(4, 4 + length));
};

const REDACTED = "[redacted]";
const PRIVATE_KEY_MARKER = /-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/u;
/** Key lines shorter than this are too common to be telling (and too short to leak a key). */
const MIN_KEY_FRAGMENT = 16;

/**
 * Removes from a line of the machine's output anything of the run's secrets: the private key (any
 * of its lines, or a PEM marker of any key), its passphrase and the run's grant. The key never
 * reaches the machine; this is in case it is there anyway, or something echoes it.
 */
export const makeScrubber = (secrets: {
  readonly privateKey?: string | undefined;
  readonly passphrase?: string | undefined;
  readonly grant?: string | undefined;
}) => {
  const fragments = new Set<string>();
  if (secrets.privateKey !== undefined) {
    for (const line of secrets.privateKey.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed.length >= MIN_KEY_FRAGMENT) fragments.add(trimmed);
    }
    const body = secrets.privateKey
      .split(/\r?\n/u)
      .filter((line) => !line.startsWith("-----"))
      .join("")
      .trim();
    if (body.length >= MIN_KEY_FRAGMENT) fragments.add(body);
  }
  if (secrets.passphrase !== undefined && secrets.passphrase.length > 0) {
    fragments.add(secrets.passphrase);
  }
  if (secrets.grant !== undefined && secrets.grant.length > 0) fragments.add(secrets.grant);
  // Longest first, so a whole body goes before the lines it is made of.
  const ordered = [...fragments].toSorted((a, b) => b.length - a.length);
  return (line: string): string => {
    if (PRIVATE_KEY_MARKER.test(line)) return REDACTED;
    let scrubbed = line;
    for (const fragment of ordered) scrubbed = scrubbed.replaceAll(fragment, REDACTED);
    return scrubbed;
  };
};

/** The first line of each step's script names it, so a reader of the machine's logs knows. */
const header = (step: SshInstallStepId) => `# T3 Code: add a machine over SSH (${step})`;

/** Where the Hub puts its runner of the T3 version on the machine. */
const RUNNER_DIR = '"$HOME/.t3/ssh-install"';
const RUNNER = '"$HOME/.t3/ssh-install/t3"';

/**
 * 1. The system and Podman: Linux, not root, rootless Podman; installed with passwordless sudo when
 * missing, otherwise it stops with what to do. Exit codes 10-14 say which check refused.
 */
export const checkScript = (): string =>
  `${header("check")}
set -u
os="$(uname -s)"
printf 'System: %s %s\\n' "$os" "$(uname -m)"
if [ -r /etc/os-release ]; then
  (. /etc/os-release && printf 'Distribution: %s\\n' "\${PRETTY_NAME:-unknown}")
fi
if [ "$os" != Linux ]; then
  printf 'Only Linux machines can be dedicated over SSH; this one runs %s.\\n' "$os" >&2
  exit 10
fi
if [ "$(id -u)" = 0 ]; then
  printf 'Connect as a non-root user: the machine runs its work in rootless Podman.\\n' >&2
  exit 11
fi
if ! command -v podman >/dev/null 2>&1; then
  if ! sudo -n true >/dev/null 2>&1; then
    printf 'Podman is not installed, and %s cannot use sudo without a password to install it.\\n' "$(id -un)" >&2
    printf 'Install rootless Podman on the machine (Debian or Ubuntu: sudo apt-get install -y podman uidmap slirp4netns; Fedora: sudo dnf install -y podman), then add it again.\\n' >&2
    exit 12
  fi
  printf 'Podman is missing; installing it with sudo...\\n'
  if command -v apt-get >/dev/null 2>&1; then
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -q &&
      sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -q podman uidmap slirp4netns
  elif command -v dnf >/dev/null 2>&1; then
    sudo -n dnf install -y podman
  elif command -v yum >/dev/null 2>&1; then
    sudo -n yum install -y podman
  elif command -v zypper >/dev/null 2>&1; then
    sudo -n zypper --non-interactive install podman
  else
    printf 'No package manager the Hub knows (apt-get, dnf, yum, zypper) is here: install rootless Podman yourself, then add the machine again.\\n' >&2
    exit 12
  fi || { printf 'Installing Podman failed.\\n' >&2; exit 13; }
fi
podman --version || exit 14
rootless="$(podman info --format '{{.Host.Security.Rootless}}' 2>&1)" || {
  printf 'podman info failed: %s\\n' "$rootless" >&2
  exit 14
}
if [ "$rootless" != true ]; then
  printf 'Podman does not run rootless for %s.\\n' "$(id -un)" >&2
  exit 14
fi
printf 'Rootless Podman is ready.\\n'
`;

/**
 * 2. T3 of the Hub's version: its runner (from the release source, or a checkout in development)
 * comes on standard input; then the Sandbox image, which a dedicated machine builds for itself,
 * unless it is there already or the machine runs its work as a process (development only).
 */
export const installScript = (input: { readonly version: string }): string =>
  `${header("install")}
set -eu
mkdir -p ${RUNNER_DIR}
cat > ${RUNNER_DIR}/t3.next
chmod 700 ${RUNNER_DIR}/t3.next
mv ${RUNNER_DIR}/t3.next ${RUNNER}
printf 'T3 Code: '
${RUNNER} --version
if [ "\${T3CODE_SANDBOX_RUNTIME:-}" = process ]; then
  printf 'T3CODE_SANDBOX_RUNTIME=process here: no Sandbox image (development only).\\n'
elif podman image exists ${shellQuote(`localhost/t3code-sandbox:${input.version}`)}; then
  printf 'The Sandbox image is already built.\\n'
else
  printf 'Building the Sandbox image (the first build takes several minutes)...\\n'
  ${RUNNER} sandbox image build
fi
`;

/**
 * 3. `t3 join --grant-on-stdin`: the machine makes its credential and registers with the grant,
 * which comes on standard input, never in its arguments.
 */
export const registerScript = (input: {
  readonly hubUrl: string;
  readonly spaceId: string;
  readonly name: string;
}): string =>
  `${header("register")}
set -eu
exec ${RUNNER} join --dedicated ${shellQuote(input.spaceId)} --name ${shellQuote(input.name)} --grant-on-stdin ${shellQuote(input.hubUrl)}
`;

/**
 * 4. Its user service: `t3 service install` with a systemd user manager (or launchd); without one
 * (a container, a minimal VM), `t3 serve` in the background, which does not come back after a
 * reboot, and says so.
 */
export const serviceScript = (): string =>
  `${header("service")}
set -eu
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  ${RUNNER} service install
else
  printf 'No systemd user manager here: starting t3 serve in the background instead. It will not start again after a reboot; run "t3 service install" once the machine has one.\\n'
  if [ -f ${RUNNER_DIR}/serve.pid ] && kill -0 "$(cat ${RUNNER_DIR}/serve.pid)" 2>/dev/null; then
    kill "$(cat ${RUNNER_DIR}/serve.pid)" || true
  fi
  nohup ${RUNNER} serve > ${RUNNER_DIR}/serve.log 2>&1 < /dev/null &
  printf '%s\\n' "$!" > ${RUNNER_DIR}/serve.pid
  printf 'Started (pid %s); its log is ~/.t3/ssh-install/serve.log.\\n' "$!"
fi
`;

/**
 * After a failure past registering: the Hub has already revoked the machine; this stops what the
 * run started there and forgets the credential (`t3 leave`). Best effort.
 */
export const undoScript = (): string =>
  `# T3 Code: add a machine over SSH (undo)
set +e
if [ -f ${RUNNER_DIR}/serve.pid ]; then
  kill "$(cat ${RUNNER_DIR}/serve.pid)" 2>/dev/null
  rm -f ${RUNNER_DIR}/serve.pid
fi
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  ${RUNNER} service uninstall >/dev/null 2>&1
fi
${RUNNER} leave
exit 0
`;
