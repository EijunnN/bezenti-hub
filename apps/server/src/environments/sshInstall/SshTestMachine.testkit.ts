// @effect-diagnostics nodeBuiltinImport:off -- a real SSH server on loopback, for the Hub's client.
/**
 * A machine to add over SSH, in the test's process: a real SSH server (ssh2's) on loopback with a
 * host key of its own, accepting one user's public key, that runs each step's script by handing it
 * to the test. It records what it saw: authentications, each step and its standard input.
 */
import * as NodeCrypto from "node:crypto";
import type * as NodeNet from "node:net";

import * as Effect from "effect/Effect";
import ssh2, { type Connection } from "ssh2";

import { hostKeyFingerprint } from "./sshInstallScripts.ts";

const { Server, utils: SshUtils } = ssh2;
type Server = InstanceType<typeof Server>;

export interface StepRequest {
  /** `check`, `install`, `register`, `service` or `undo`, from the script's first line. */
  readonly step: string;
  readonly script: string;
  readonly stdin: string;
  /** Writes to the command's output. */
  readonly write: (text: string) => void;
}

/** The step's exit code; it never ends, as a hung command, with `Effect.never`. */
export type StepHandler = (request: StepRequest) => Effect.Effect<number>;

export interface TestMachine {
  readonly port: number;
  /** `SHA256:…` of its host key. */
  readonly fingerprint: string;
  readonly username: string;
  /** The private key it accepts, OpenSSH format (with `passphrase`, when asked for). */
  readonly privateKey: string;
  readonly passphrase: string | undefined;
  /** Each step run, in order. */
  readonly steps: Array<{ readonly step: string; readonly stdin: string; readonly script: string }>;
  /** Each authentication attempt's method. */
  readonly authentications: Array<string>;
  /** Drops every connection at once, as a network failure. */
  readonly drop: () => void;
  readonly setHandler: (handler: StepHandler) => void;
}

const stepOf = (command: string) =>
  /add a machine over SSH \((\w+)\)/u.exec(command)?.[1] ?? "unknown";

const newHostKey = () => SshUtils.generateKeyPairSync("ed25519").private;

/** One machine; `hostKey` and `port` to stand in for the same machine with another key. */
export const makeTestMachine = (
  options: {
    readonly handler?: StepHandler;
    readonly hostKey?: string;
    readonly port?: number;
    readonly username?: string;
    readonly passphrase?: string;
    readonly clientKey?: { readonly privateKey: string; readonly passphrase?: string };
  } = {},
) =>
  Effect.acquireRelease(
    Effect.flatMap(Effect.context<never>(), (context) =>
      Effect.callback<TestMachine & { readonly server: Server; readonly hostKey: string }>(
        (resume) => {
          // Each step runs with the test's services, as the machine's answer to that command.
          const runStep = Effect.runPromiseWith(context);
          const hostKey = options.hostKey ?? newHostKey();
          const parsedHost = SshUtils.parseKey(hostKey);
          if (parsedHost instanceof Error) throw parsedHost;
          const hostPublic = (Array.isArray(parsedHost) ? parsedHost[0] : parsedHost)!;
          const client =
            options.clientKey ??
            (() => {
              const pair = SshUtils.generateKeyPairSync(
                "ed25519",
                options.passphrase === undefined
                  ? {}
                  : { passphrase: options.passphrase, cipher: "aes256-ctr", rounds: 4 },
              );
              return {
                privateKey: pair.private,
                ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
              };
            })();
          const parsedClient = SshUtils.parseKey(client.privateKey, client.passphrase);
          if (parsedClient instanceof Error) throw parsedClient;
          const clientPublic = (Array.isArray(parsedClient) ? parsedClient[0] : parsedClient)!;
          const allowedData = clientPublic.getPublicSSH();
          const username = options.username ?? "deploy";
          const connections = new Set<Connection>();
          let handler: StepHandler = options.handler ?? (() => Effect.succeed(0));
          const machine = {
            steps: [] as Array<{ step: string; stdin: string; script: string }>,
            authentications: [] as Array<string>,
          };
          const server = new Server({ hostKeys: [hostKey] }, (connection) => {
            connections.add(connection);
            connection.on("close", () => connections.delete(connection));
            connection.on("error", () => undefined);
            connection.on("authentication", (context) => {
              machine.authentications.push(context.method);
              if (
                context.method === "publickey" &&
                context.username === username &&
                context.key.algo === clientPublic.type &&
                NodeCrypto.timingSafeEqual(
                  Buffer.from(context.key.data),
                  Buffer.from(allowedData),
                ) &&
                (context.signature === undefined ||
                  clientPublic.verify(context.blob!, context.signature, context.hashAlgo) === true)
              ) {
                context.accept();
                return;
              }
              context.reject(["publickey"]);
            });
            connection.on("ready", () => {
              connection.on("session", (acceptSession) => {
                const session = acceptSession();
                session.on("exec", (accept, _reject, info) => {
                  const stream = accept();
                  const step = stepOf(info.command);
                  let stdin = "";
                  stream.on("data", (chunk: Buffer) => {
                    stdin += chunk.toString("utf8");
                  });
                  stream.on("error", () => undefined);
                  stream.on("end", () => {
                    machine.steps.push({ step, stdin, script: info.command });
                    void runStep(
                      handler({
                        step,
                        script: info.command,
                        stdin,
                        write: (text) => {
                          if (stream.writable) stream.write(text);
                        },
                      }),
                    ).then(
                      (code) => {
                        if (!stream.writable) return;
                        stream.exit(code);
                        stream.end();
                      },
                      () => {
                        if (!stream.writable) return;
                        stream.exit(1);
                        stream.end();
                      },
                    );
                  });
                });
              });
            });
          });
          server.listen(options.port ?? 0, "127.0.0.1", () => {
            resume(
              Effect.succeed({
                server,
                hostKey,
                port: (server.address() as NodeNet.AddressInfo).port,
                fingerprint: hostKeyFingerprint(hostPublic.getPublicSSH()),
                username,
                privateKey: client.privateKey,
                passphrase: client.passphrase,
                steps: machine.steps,
                authentications: machine.authentications,
                drop: () => {
                  for (const connection of connections) connection.end();
                },
                setHandler: (next: StepHandler) => {
                  handler = next;
                },
              }),
            );
          });
        },
      ),
    ),
    (machine) =>
      Effect.callback<void>((resume) => {
        machine.drop();
        machine.server.close(() => resume(Effect.void));
      }),
  );
