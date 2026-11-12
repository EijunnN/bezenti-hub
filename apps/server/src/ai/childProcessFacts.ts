// @effect-diagnostics nodeBuiltinImport:off -- reads /proc (Linux) or asks ps/lsof (macOS) about one PID.
/**
 * What the Hub can tell about one process it started, without trusting the process: the TCP
 * sockets it listens on, and an identity (start time and executable) that a reused PID cannot
 * fake. Linux reads /proc; macOS asks `ps` and `lsof`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

/** `127.0.0.1:8317`, `0.0.0.0:8317` or `[::]:8317`. */
export type ListenAddress = string;

const hexIpv4 = (hex: string) =>
  [6, 4, 2, 0].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)).join(".");

const hexIpv6 = (hex: string) => {
  // Four little-endian 32-bit words.
  const bytes: Array<string> = [];
  for (let word = 0; word < 4; word += 1) {
    const chunk = hex.slice(word * 8, word * 8 + 8);
    for (let index = 6; index >= 0; index -= 2) bytes.push(chunk.slice(index, index + 2));
  }
  const groups: Array<string> = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(Number.parseInt(bytes[index]! + bytes[index + 1]!, 16).toString(16));
  }
  const text = groups.join(":");
  return text === "0:0:0:0:0:0:0:0" ? "::" : text === "0:0:0:0:0:0:0:1" ? "::1" : text;
};

/** Sockets in LISTEN state from /proc/net/tcp{,6}, by inode. */
const linuxListeningSockets = () => {
  const byInode = new Map<string, ListenAddress>();
  for (const [file, v6] of [
    ["/proc/net/tcp", false],
    ["/proc/net/tcp6", true],
  ] as const) {
    let text = "";
    try {
      text = NodeFS.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 10 || fields[3] !== "0A") continue;
      const [addressHex, portHex] = fields[1]!.split(":") as [string, string];
      const port = Number.parseInt(portHex, 16);
      const address = v6 ? `[${hexIpv6(addressHex)}]` : hexIpv4(addressHex);
      byInode.set(fields[9]!, `${address}:${port}`);
    }
  }
  return byInode;
};

/**
 * The TCP addresses `pid` itself listens on (its own open sockets, not another process's on the
 * same port). Undefined when that cannot be read.
 */
export const listeningAddressesOf = (
  pid: number,
  os: NodeJS.Platform,
): ReadonlyArray<ListenAddress> | undefined => {
  if (os === "linux") {
    let fds: Array<string>;
    try {
      fds = NodeFS.readdirSync(`/proc/${pid}/fd`);
    } catch {
      return undefined;
    }
    const sockets = linuxListeningSockets();
    const found: Array<ListenAddress> = [];
    for (const fd of fds) {
      try {
        const match = /^socket:\[(\d+)\]$/u.exec(NodeFS.readlinkSync(`/proc/${pid}/fd/${fd}`));
        const address = match === null ? undefined : sockets.get(match[1]!);
        if (address !== undefined) found.push(address);
      } catch {
        // Closed meanwhile.
      }
    }
    return found;
  }
  if (os === "darwin") {
    const result = NodeChildProcess.spawnSync(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result.status !== 0 && result.stdout.length === 0)
      return result.status === 1 ? [] : undefined;
    return result.stdout
      .split("\n")
      .filter((line) => line.startsWith("n"))
      .map((line) => line.slice(1).replace(/^\*:/u, "0.0.0.0:"));
  }
  return undefined;
};

/** Only `127.0.0.1`: not `0.0.0.0`, not IPv6, not another address of the machine. */
export const onlyLoopback = (addresses: ReadonlyArray<ListenAddress>) =>
  addresses.every((address) => address.startsWith("127.0.0.1:"));

/** When `pid` started and what it runs: both must match before the Hub stops a leftover. */
export interface ProcessIdentity {
  readonly startTime: string;
  readonly executable: string;
}

export const identityOf = (pid: number, os: NodeJS.Platform): ProcessIdentity | undefined => {
  try {
    if (os === "linux") {
      const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Fields after the command (which may hold spaces) start after its closing parenthesis.
      const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const executable = NodeFS.readlinkSync(`/proc/${pid}/exe`);
      return startTime === undefined ? undefined : { startTime, executable };
    }
    if (os === "darwin") {
      const run = (field: string) =>
        NodeChildProcess.spawnSync("/bin/ps", ["-o", `${field}=`, "-p", String(pid)], {
          encoding: "utf8",
          timeout: 5_000,
        }).stdout.trim();
      const startTime = run("lstart");
      const executable = run("comm");
      return startTime === "" || executable === "" ? undefined : { startTime, executable };
    }
  } catch {
    // Gone, or not ours to read.
  }
  return undefined;
};

/** The start time alone: known right after spawn, before the child has exec'd its binary. */
export const startTimeOf = (pid: number, os: NodeJS.Platform) => identityOf(pid, os)?.startTime;
