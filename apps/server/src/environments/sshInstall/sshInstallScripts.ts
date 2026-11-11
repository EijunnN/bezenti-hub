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

/**
 * The address's bytes, however it is written: 4 for IPv4, also written as IPv6 (IPv4-mapped, dotted
 * or hex, and the old IPv4-compatible form); 16 for any other IPv6 (its zone dropped). Undefined
 * when it is no IP address.
 */
const addressBytes = (address: string): ReadonlyArray<number> | undefined => {
  const text = address.trim().toLowerCase().replace(/%.*$/u, "");
  if (NodeNet.isIPv4(text)) return text.split(".").map(Number);
  if (!NodeNet.isIPv6(text)) return undefined;
  // A dotted IPv4 tail as its two groups.
  const hex = text.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/u, (_, a, b, c, d) =>
    [(Number(a) << 8) | Number(b), (Number(c) << 8) | Number(d)]
      .map((n) => n.toString(16))
      .join(":"),
  );
  const [left = "", right] = hex.split("::");
  const groupsOf = (part: string) => (part === "" ? [] : part.split(":"));
  const groups =
    right === undefined
      ? groupsOf(left)
      : [
          ...groupsOf(left),
          ...Array.from<string>({
            length: 8 - groupsOf(left).length - groupsOf(right).length,
          }).fill("0"),
          ...groupsOf(right),
        ];
  if (groups.length !== 8) return undefined;
  const bytes = groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  const mapped = zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
  // `::a.b.c.d`, but not `::` or `::1`.
  const compatible = zeros(0, 12) && !zeros(12, 15);
  return mapped || compatible ? bytes.slice(12) : bytes;
};

const sameAddress = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * Where the Hub never opens SSH (docs/internals/sandboxes.md, «Installing over SSH»): link-local,
 * unspecified, multicast and broadcast addresses, and the Hub's own machine (loopback, or one of
 * `hubHost.ownAddresses`) unless `hubHost` is undefined (development only). Judged by the address's
 * bytes, so no way of writing it gets past. Undefined when allowed.
 */
export const forbiddenSshAddress = (
  address: string,
  hubHost: { readonly ownAddresses: ReadonlyArray<string> } | undefined,
): string | undefined => {
  const bytes = addressBytes(address);
  if (bytes === undefined) return "not an IP address";
  const [a = 0, b = 0] = bytes;
  if (bytes.length === 4) {
    if (a === 169 && b === 254) return "a link-local address";
    if (a === 0) return "an unspecified address";
    if (a >= 224) return "a multicast or reserved address";
    if (hubHost !== undefined && a === 127) return "the Hub's own machine";
  } else {
    if (bytes.every((byte) => byte === 0)) return "an unspecified address";
    if (a === 0xfe && (b & 0xc0) === 0x80) return "a link-local address";
    if (a === 0xff) return "a multicast address";
    const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
    if (hubHost !== undefined && loopback) return "the Hub's own machine";
  }
  const own = hubHost?.ownAddresses.some((other) => {
    const otherBytes = addressBytes(other);
    return otherBytes !== undefined && sameAddress(otherBytes, bytes);
  });
  return own === true ? "the Hub's own machine" : undefined;
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
/**
 * Any run of this many characters of a secret is redacted wherever it shows, so a piece of it (cut
 * by a chunk, a line or a column) goes too.
 */
export const SECRET_WINDOW = 12;
/** A passphrase shorter than this is not scrubbed: it would redact common text, and is weak. */
const MIN_PASSPHRASE_SCRUBBED = 4;

export interface Scrubber {
  /** The line with every piece of a secret redacted. */
  readonly scrub: (line: string) => string;
  /**
   * Which characters of `text` belong to a secret (1), with `carried` the coverage of its first
   * characters known from text before it. For a line cut before its end (`redact` its head).
   */
  readonly mask: (text: string, carried?: Uint8Array) => Uint8Array;
  /** `text` with each run of covered characters as one `[redacted]`. */
  readonly redact: (text: string, mask: Uint8Array) => string;
}

/**
 * Removes from the machine's output anything of the run's secrets, in one pass over the text as it
 * came: any piece of at least 12 characters of the private key's body, its passphrase or the run's
 * grant, a passphrase of 4 to 11 characters whole, and a line with a PEM private-key marker. The
 * key never reaches the machine; this is in case it is there anyway, or something echoes it.
 */
export const makeScrubber = (secrets: {
  readonly privateKey?: string | undefined;
  readonly passphrase?: string | undefined;
  readonly grant?: string | undefined;
}): Scrubber => {
  const windows = new Set<string>();
  const whole: Array<string> = [];
  const add = (secret: string) => {
    if (secret.length < SECRET_WINDOW) {
      if (secret.length >= MIN_PASSPHRASE_SCRUBBED) whole.push(secret);
      return;
    }
    for (let index = 0; index + SECRET_WINDOW <= secret.length; index++) {
      windows.add(secret.slice(index, index + SECRET_WINDOW));
    }
  };
  if (secrets.privateKey !== undefined) {
    const lines = secrets.privateKey.split(/\r?\n/u).map((line) => line.trim());
    add(lines.filter((line) => !line.startsWith("-----")).join(""));
  }
  if (secrets.passphrase !== undefined) add(secrets.passphrase);
  if (secrets.grant !== undefined) add(secrets.grant);
  const mask = (text: string, carried?: Uint8Array) => {
    const covered = new Uint8Array(text.length);
    if (carried !== undefined) covered.set(carried.subarray(0, text.length));
    for (let index = 0; index + SECRET_WINDOW <= text.length; index++) {
      if (windows.has(text.slice(index, index + SECRET_WINDOW))) {
        covered.fill(1, index, index + SECRET_WINDOW);
      }
    }
    for (const fragment of whole) {
      for (let at = text.indexOf(fragment); at !== -1; at = text.indexOf(fragment, at + 1)) {
        covered.fill(1, at, at + fragment.length);
      }
    }
    return covered;
  };
  const redact = (text: string, covered: Uint8Array) => {
    if (PRIVATE_KEY_MARKER.test(text)) return REDACTED;
    let scrubbed = "";
    for (let index = 0; index < text.length; index++) {
      if (covered[index] === 0) scrubbed += text[index];
      else if (index === 0 || covered[index - 1] === 0) scrubbed += REDACTED;
    }
    return scrubbed;
  };
  return { scrub: (line) => redact(line, mask(line)), mask, redact };
};

/** The first line of each step's script names it, so a reader of the machine's logs knows. */
const header = (step: SshInstallStepId) => `# T3 Code: add a machine over SSH (${step})`;

/** Where the Hub puts its runner of the T3 version on the machine. */
const RUNNER_DIR = '"$HOME/.t3/ssh-install"';
const RUNNER = '"$HOME/.t3/ssh-install/t3"';

/**
 * 1. The system and Podman: Linux, not root, rootless Podman; installed with passwordless sudo when
 * missing, otherwise it stops with what to do; with a systemd user manager, lingering (turned on
 * when allowed). Exit codes 10-15 say which check refused.
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
# With a systemd user manager its service is a user unit: without lingering it stops at logout.
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  user="$(id -un)"
  lingering() { loginctl show-user "$user" -p Linger 2>/dev/null | sed -n 's/^Linger=//p'; }
  if [ "$(lingering)" != yes ]; then
    loginctl enable-linger "$user" >/dev/null 2>&1 || sudo -n loginctl enable-linger "$user" >/dev/null 2>&1
  fi
  if [ "$(lingering)" != yes ]; then
    printf 'Lingering is off for %s, so its T3 Code service would stop when they log out, and could not be turned on.\\n' "$user" >&2
    printf 'As root on the machine: loginctl enable-linger %s; then add the machine again.\\n' "$user" >&2
    exit 15
  fi
  printf 'Lingering is on: its service runs without anyone logged in.\\n'
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
# Only its answer: Podman warns on standard error (a mount that is not shared, …), shown as is.
rootless="$(podman info --format '{{.Host.Security.Rootless}}')" || {
  printf 'podman info failed.\\n' >&2
  exit 14
}
if [ "$(printf '%s' "$rootless" | tail -n 1)" != true ]; then
  printf 'Podman does not run rootless for %s.\\n' "$(id -un)" >&2
  exit 14
fi
printf 'Rootless Podman is ready.\\n'
`;

/** A step's exit code when another step holds the machine; busy only with `STEP_BUSY_MARKER`. */
export const STEP_BUSY_EXIT = 75;
/** What only the step wrapper prints when another step holds the machine's step lock. */
export const STEP_BUSY_MARKER = "its T3 Code step lock is held";

const STEP_LOCK = '"$HOME/.t3/ssh-install/step.lock"';

/**
 * Runs a step in a process group of its own (`setsid`) that holds `~/.t3/ssh-install/step.lock`
 * (`flock`) for its life, with its group id and `token` written in it; stdin passed on. A later
 * step (of «Try again» too) refuses while it is held. The check step leaves no directory it made.
 */
export const stepCommand = (
  script: string,
  options: { readonly token: string; readonly step: SshInstallStepId },
): string =>
  `# T3 Code: add a machine over SSH, its step in a process group of its own
for tool in setsid flock; do
  command -v "$tool" >/dev/null 2>&1 || { printf '%s (util-linux) is missing on the machine.\\n' "$tool" >&2; exit 1; }
done
dir="$HOME/.t3/ssh-install"
made=
if [ ! -d "$dir" ]; then
  mkdir -p "$dir" || exit 1
  made=1
fi
chmod 700 "$dir" || exit 1
exec 3<&0
setsid sh -c '
lock="$1"
exec 9<>"$lock" || exit 1
if ! flock -n 9; then
  printf "Another installation is still running on this machine (${STEP_BUSY_MARKER}, process group %s). Wait for it to end, or stop it there with: kill -- -%s\\n" "$(cut -d " " -f 1 "$lock")" "$(cut -d " " -f 1 "$lock")" >&2
  exit ${STEP_BUSY_EXIT}
fi
printf "%s %s\\n" "$$" "$2" > "$lock"
if [ -e "$lock.cancel.$2" ]; then
  rm -f "$lock.cancel.$2"
  printf "Cancelled before it began.\\n" >&2
  exit 130
fi
sh -c "$3" 9>&-
' t3-step "$dir/step.lock" ${shellQuote(options.token)} ${shellQuote(script)} <&3 3<&- &
child=$!
exec 3<&-
wait "$child"
code=$?
${options.step === "check" ? 'if [ -n "$made" ]; then rm -rf "$dir"; fi\n' : ""}exit "$code"
`;

/**
 * Stops the step of `token`, its whole process group, and only when the lock proves it is that
 * step's: held, with that token. A step that has not taken the lock yet finds a cancel marker for
 * its token and does not begin; the stop waits a moment for one taking it meanwhile.
 */
export const stopStepScript = (token: string): string =>
  `# T3 Code: add a machine over SSH (stop)
lock=${STEP_LOCK}
token=${shellQuote(token)}
[ -d "$HOME/.t3/ssh-install" ] || exit 0
command -v flock >/dev/null 2>&1 || exit 0
held_by_step() {
  [ -e "$lock" ] || return 1
  (
    exec 9<"$lock" || exit 1
    if flock -n 9; then exit 1; fi
    set -- $(cat "$lock")
    [ "\${2:-}" = "$token" ] || exit 1
    case "\${1:-}" in '' | *[!0-9]*) exit 1 ;; esac
    printf '%s\\n' "$1"
  )
}
: > "$lock.cancel.$token"
group=
i=0
while [ "$i" -lt 12 ]; do
  group="$(held_by_step)" && break
  group=
  sleep 0.25
  i=$((i + 1))
done
[ -n "$group" ] || exit 0
rm -f "$lock.cancel.$token"
kill -TERM "-$group" 2>/dev/null
i=0
while [ "$i" -lt 20 ] && kill -0 "-$group" 2>/dev/null; do
  sleep 0.25
  i=$((i + 1))
done
kill -KILL "-$group" 2>/dev/null
printf 'Stopped what the step was still doing on the machine.\\n'
exit 0
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
