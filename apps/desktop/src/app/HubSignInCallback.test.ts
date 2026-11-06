// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Tests exercise the real native loopback listener.
import * as NodeNet from "node:net";
import { describe, expect, it } from "vite-plus/test";

import { receiveHubSignIn } from "./HubSignInCallback.ts";

const CHALLENGE = "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c";
const STATE = "state-from-the-app-0123";

/** Sends a raw request line, which `fetch` would normalize before it left. */
const rawRequest = (port: number, target: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = NodeNet.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let answer = "";
    socket.on("data", (chunk) => (answer += String(chunk)));
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
  });

describe("desktop Hub sign-in callback", () => {
  it("answers a malformed request with 400 and keeps waiting for the real callback", async () => {
    const received = await receiveHubSignIn(
      { hubUrl: "https://hub.example.com/", codeChallenge: CHALLENGE, state: STATE },
      async (pageUrl) => {
        const redirectUri = new URL(pageUrl).searchParams.get("redirect_uri")!;
        const port = Number(new URL(redirectUri).port);
        expect(await rawRequest(port, "//[")).toMatch(/^HTTP\/1\.1 400/);
        const response = await fetch(`${redirectUri}?code=the-code&state=${STATE}`);
        expect(response.status).toBe(200);
        return true;
      },
    );
    expect(received.code).toBe("the-code");
  });

  it("refuses a Hub reached over plain HTTP outside this machine and private networks", async () => {
    await expect(
      receiveHubSignIn(
        { hubUrl: "http://hub.example.com/", codeChallenge: CHALLENGE, state: STATE },
        async () => true,
      ),
    ).rejects.toThrow(/https/);
  });
});
