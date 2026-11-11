import * as NodeEvents from "node:events";

import { chromium, type Browser, type BrowserContext, type BrowserType } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { type ProfilePlace, ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const launches = vi.hoisted(() => ({
  launch: vi.fn<BrowserType["launch"]>(),
  persistent: vi.fn<BrowserType["launchPersistentContext"]>(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  utimes: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
}));
vi.spyOn(chromium, "launch").mockImplementation(launches.launch);
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);
vi.mock("node:fs/promises", () => ({
  mkdir: launches.mkdir,
  rm: launches.rm,
  writeFile: launches.writeFile,
  utimes: launches.utimes,
  readdir: launches.readdir,
}));

const USER = "1".repeat(32);
const SPACE = "2".repeat(32);
/** Folder names as `PreviewProfiles` makes them: 32 hex digits. */
const FOLDERS: Record<string, string> = {
  "work/team": "3".repeat(32),
  "never-opened": "4".repeat(32),
};
const place = (profile: string, user = USER): ProfilePlace => ({
  owner: { userId: "alice", spaceId: "acme" },
  userFolder: user,
  spaceFolder: SPACE,
  profileFolder: FOLDERS[profile]!,
});
const directoryOf = (profile: string) => `/test/profiles/${USER}/${SPACE}/${FOLDERS[profile]}`;
const folderEntry = (name: string) => ({ name, isDirectory: () => true });

const makeContext = () => {
  const events = new NodeEvents.EventEmitter();
  let closed = false;
  return {
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    pages: vi.fn(() => []),
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
};

const makeBrowser = () => {
  const events = new NodeEvents.EventEmitter();
  const contexts: ReturnType<typeof makeContext>[] = [];
  return {
    contexts,
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    newContext: vi.fn(async () => {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }),
    close: vi.fn(async () => {
      for (const context of contexts) await context.close();
      events.emit("disconnected");
    }),
  };
};

const options = () => ({
  profilesDir: "/test/profiles",
  executable: vi.fn(async () => "/test/chromium"),
  env: {},
});

const withLauncher = () => {
  const release = vi.fn(async () => {});
  return {
    release,
    configuration: {
      ...options(),
      launcher: vi.fn(async (executable: string) => ({ path: `${executable}-launcher`, release })),
    },
  };
};

beforeEach(() => {
  launches.launch.mockReset();
  launches.persistent.mockReset();
  launches.mkdir.mockClear();
  launches.rm.mockReset().mockResolvedValue(undefined);
  launches.writeFile.mockClear();
  launches.utimes.mockClear();
  launches.readdir.mockReset().mockResolvedValue([]);
});

describe("ServerBrowserContexts", () => {
  it("lazily shares one browser across concurrent isolated sessions and reuses each context", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    const started = Promise.withResolvers<void>();
    launches.launch.mockImplementation(() => {
      started.resolve();
      return launch.promise;
    });
    const { configuration, release } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    expect(configuration.executable).not.toHaveBeenCalled();
    const first = pool.contextFor(null, "agent-a");
    const again = pool.contextFor(null, "agent-a");
    const second = pool.contextFor(null, "agent-b");
    const incognito = pool.contextFor(place("work/team"), "incognito-tab");
    await started.promise;
    // Playwright may retry the same path until the launch settles.
    expect(release).not.toHaveBeenCalled();
    launch.resolve(browser as unknown as Browser);
    const [a, reused, b, privateContext] = await Promise.all([first, again, second, incognito]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(a).toBe(reused);
    expect(new Set([a, b, privateContext]).size).toBe(3);
    expect(launches.launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ executablePath: "/test/chromium-launcher" }),
    );
    expect(launches.persistent).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    for (const context of browser.contexts) expect(context.close).toHaveBeenCalled();
  });

  it("keeps human profiles persistent without sharing their storage with agents", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const { configuration, release } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    const persistent = await pool.contextFor(place("work/team"));
    expect(await pool.contextFor(place("work/team"))).toBe(persistent);
    expect(await pool.contextFor(place("work/team"), "agent")).not.toBe(persistent);
    // Another User's profile of the same id is another profile.
    launches.persistent.mockResolvedValueOnce(makeContext() as unknown as BrowserContext);
    expect(await pool.contextFor(place("work/team", "5".repeat(32)))).not.toBe(persistent);
    expect(launches.persistent).toHaveBeenCalledWith(
      directoryOf("work/team"),
      expect.objectContaining({
        chromiumSandbox: true,
        executablePath: "/test/chromium-launcher",
        args: expect.arrayContaining([expect.stringMatching(/^--disk-cache-size=\d+$/)]),
      }),
    );
    expect(launches.persistent).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(3);
    expect(launches.mkdir).toHaveBeenCalledWith(directoryOf("work/team"), { recursive: true });
    expect(launches.writeFile).toHaveBeenCalledWith(
      `/test/profiles/${USER}/${SPACE}/owner.json`,
      JSON.stringify({ userId: "alice", spaceId: "acme" }),
    );
    await pool.close();
    expect(human.close).toHaveBeenCalledTimes(1);
  });

  it("never gives a tab with no owner a shared persistent profile", async () => {
    const pool = new ServerBrowserContexts(options());
    await expect(pool.contextFor(null)).rejects.toThrow("needs a profile of its own");
    expect(launches.persistent).not.toHaveBeenCalled();
    await pool.close();
  });

  it("removes a User's profiles in one Space, closing them first", async () => {
    const human = makeContext();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor(place("work/team"));
    await pool.removeProfiles(USER, SPACE);
    expect(human.close).toHaveBeenCalledTimes(1);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith(`/test/profiles/${USER}/${SPACE}`, {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("diagnoses a launcher failure against the real executable", async () => {
    const diagnosed = new Error("diagnosed");
    const diagnose = vi.fn(async () => diagnosed);
    const pool = new ServerBrowserContexts({
      ...options(),
      diagnose,
      launcher: vi.fn(async () => {
        throw new Error("EACCES");
      }),
    });
    await expect(pool.contextFor(null, "agent")).rejects.toBe(diagnosed);
    expect(diagnose).toHaveBeenCalledExactlyOnceWith("/test/chromium", expect.any(Error));
    expect(launches.launch).not.toHaveBeenCalled();
  });

  it("creates no launcher for a profile whose storage cannot be created", async () => {
    launches.mkdir.mockRejectedValueOnce(new Error("EACCES"));
    const { configuration } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    await expect(pool.contextFor(place("work/team"))).rejects.toThrow("EACCES");
    expect(configuration.launcher).not.toHaveBeenCalled();
  });

  it("clears a profile by closing its open context before deleting its storage", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const persistent = await pool.contextFor(place("work/team"));
    const agent = await pool.contextFor(place("work/team"), "agent");
    launches.readdir.mockResolvedValue([folderEntry(SPACE)]);
    launches.rm.mockImplementationOnce(async () => {
      expect(human.close).toHaveBeenCalledTimes(1);
    });
    await pool.clearProfile(USER, FOLDERS["work/team"]!);
    expect(onContextClose).toHaveBeenCalledExactlyOnceWith(persistent);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith(directoryOf("work/team"), {
      recursive: true,
      force: true,
    });
    expect(await pool.contextFor(place("work/team"), "agent")).toBe(agent);
    expect(browser.contexts[0]?.close).not.toHaveBeenCalled();
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    expect(await pool.contextFor(place("work/team"))).not.toBe(persistent);
    await pool.clearProfile(USER, FOLDERS["never-opened"]!);
    expect(launches.rm).toHaveBeenLastCalledWith(directoryOf("never-opened"), {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("waits for the context to close when the same profile is cleared concurrently", async () => {
    const human = makeContext();
    const closed = Promise.withResolvers<void>();
    human.close.mockImplementation(async () => closed.promise);
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor(place("work/team"));
    launches.readdir.mockResolvedValue([folderEntry(SPACE)]);

    const first = pool.clearProfile(USER, FOLDERS["work/team"]!);
    const second = pool.clearProfile(USER, FOLDERS["work/team"]!);
    const deletionsBeforeClose = launches.rm.mock.calls.length;
    closed.resolve();
    await Promise.all([first, second]);

    expect(deletionsBeforeClose).toBe(0);
    expect(human.close).toHaveBeenCalledTimes(1);
    // The second clear found it already closed and removed the folder again, harmlessly.
    expect(launches.rm).toHaveBeenCalledWith(directoryOf("work/team"), {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("opens a profile requested during its clear only after the storage is deleted", async () => {
    launches.persistent.mockImplementation(async () => makeContext() as unknown as BrowserContext);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    await pool.contextFor(place("work/team"));
    launches.readdir.mockResolvedValue([folderEntry(SPACE)]);
    const removing = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    let deleted = false;
    launches.rm.mockImplementationOnce(async () => {
      removing.resolve();
      await removed.promise;
      deleted = true;
    });
    const launchedAfterDelete: Array<boolean> = [];
    configuration.executable.mockImplementation(async () => {
      launchedAfterDelete.push(deleted);
      return "/test/chromium";
    });
    const clearing = pool.clearProfile(USER, FOLDERS["work/team"]!);
    const reopening = pool.contextFor(place("work/team"));
    await removing.promise;
    removed.resolve();
    await Promise.all([clearing, reopening]);
    expect(launchedAfterDelete).toEqual([true]);
    await pool.close();
  });

  it.each([undefined, "default"])(
    "never retries a failed %s launch with the sandbox disabled",
    async (profile) => {
      const launch = profile ? launches.persistent : launches.launch;
      launch.mockRejectedValue(new Error("sandbox unavailable"));
      const pool = new ServerBrowserContexts(options());
      await expect(
        profile ? pool.contextFor(place("work/team")) : pool.contextFor(null, "incognito-tab"),
      ).rejects.toThrow("sandbox unavailable");
      expect(launch).toHaveBeenCalledTimes(1);
      expect(
        profile ? launches.persistent.mock.calls[0]?.[1] : launches.launch.mock.calls[0]?.[0],
      ).toMatchObject({ chromiumSandbox: true });
      await pool.close();
    },
  );

  it("allows only an explicit sandbox opt-out", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({
      ...options(),
      env: { T3CODE_SERVER_BROWSER_SANDBOX: "0" },
    });
    await pool.contextFor(null, "incognito-tab");
    expect(launches.launch).toHaveBeenCalledWith(
      expect.objectContaining({ chromiumSandbox: false }),
    );
    await pool.close();
  });

  it("retries a failed startup on a later request with sandboxing still enabled", async () => {
    const browser = makeBrowser();
    launches.launch
      .mockRejectedValueOnce(new Error("executable unavailable"))
      .mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await expect(pool.contextFor(null, "agent")).rejects.toThrow("executable unavailable");
    await pool.contextFor(null, "agent");
    expect(launches.launch).toHaveBeenCalledTimes(2);
    expect(launches.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ chromiumSandbox: true }),
    );
    await pool.close();
  });

  it("cleans up a browser whose launch finishes during shutdown and rejects future work", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const pool = new ServerBrowserContexts(options());
    const opening = expect(pool.contextFor(null, "agent")).rejects.toThrow("closed");
    const closing = pool.close();
    launch.resolve(browser as unknown as Browser);
    await Promise.all([opening, closing]);
    await expect(pool.contextFor(null, "agent")).rejects.toThrow("closed");
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.contexts[0]?.close).toHaveBeenCalled();
  });
});
