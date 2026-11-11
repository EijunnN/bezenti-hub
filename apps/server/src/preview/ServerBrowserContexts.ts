// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Owns Playwright resources and profile folders outside the Effect runtime.
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

/**
 * Where one persistent profile lives: `<profilesDir>/<user>/<space>/<profile>`, folders named by
 * `PreviewProfiles` (unguessable, never shared by two Users, two Spaces or two profiles).
 */
export interface ProfilePlace {
  readonly owner: { readonly userId: string; readonly spaceId: string };
  readonly userFolder: string;
  readonly spaceFolder: string;
  readonly profileFolder: string;
}

/** Whose a Space folder is, written in it so a sweep can tell whom it holds. */
const OWNER_FILE = "owner.json";
/** Touched whenever its profile opens or closes; an old one marks a profile nobody uses. */
const LAST_USED_FILE = ".t3-last-used";
/** Chromium's caches, which a profile over its size limit loses first. */
const CACHE_FOLDERS = [
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "Default/Service Worker/CacheStorage",
  "Default/Service Worker/ScriptCache",
  "GrShaderCache",
  "ShaderCache",
  "GraphiteDawnCache",
];
/** Chromium's HTTP cache per profile; the rest of a profile is cookies and site storage. */
const DISK_CACHE_BYTES = 64 * 1024 * 1024;
/** Folder names `PreviewProfiles` makes; anything else in the profiles folder is not ours. */
const FOLDER_NAME = /^[0-9a-f]{32}$/;

interface Options {
  readonly profilesDir: string;
  readonly executable: () => Promise<string>;
  /**
   * A path that starts `executable`, such as one that moves Chrome out of the server's cgroup.
   * Released after the whole launch call, since Playwright retries the same path after a glibc race.
   */
  readonly launcher?: (
    executable: string,
  ) => Promise<{ readonly path: string; readonly release: () => Promise<void> } | undefined>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onContextClose?: (context: BrowserContext) => void;
}

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** Change user agent and Sec-CH-UA together; sites block mismatches. */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  /**
   * Work on profile folders, one step at a time: preparing a profile to open, removing profiles,
   * marking one used. A profile asked for after a removal opens after it.
   */
  private queue: Promise<void> = Promise.resolve();
  /** Persistent profiles whose preparing step has not run: a queued step never waits on them. */
  private readonly preparing = new Set<string>();
  private browser: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions() {
    const executable = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executable,
      env,
      args: [
        "--disable-gpu",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(executable: string, start: (executablePath: string) => Promise<A>) {
    let release: (() => Promise<void>) | undefined;
    try {
      const launcher = await this.options.launcher?.(executable);
      release = launcher?.release;
      return await start(launcher?.path ?? executable);
    } catch (cause) {
      throw (await this.options.diagnose?.(executable, cause)) ?? cause;
    } finally {
      await release?.().catch(constVoid);
    }
  }

  private sharedBrowser() {
    if (!this.browser) {
      const launched = this.launchOptions().then(async ({ executable, ...options }) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(executable, (executablePath) =>
          chromium.launch({ ...options, executablePath }),
        );
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  private enqueue<A>(step: () => Promise<A>): Promise<A> {
    const run = this.queue.then(step);
    this.queue = run.then(constVoid, constVoid);
    return run;
  }

  /**
   * The context of a persistent profile (`place`), or with `isolationKey` a throwaway one of its
   * own (incognito, an agent's tab, a tab whose owner is unknown). Never one shared otherwise.
   */
  contextFor(place: ProfilePlace | null, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const persistent = isolationKey === undefined ? place : null;
    if (persistent === null && isolationKey === undefined) {
      return Promise.reject(new Error("A preview tab needs a profile of its own."));
    }
    const key = persistent === null ? isolatedKey(isolationKey!) : placeKey(persistent);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    let created: Promise<BrowserContext>;
    if (persistent === null) {
      created = this.sharedBrowser().then((browser) => browser.newContext(CONTEXT_OPTIONS));
    } else {
      this.preparing.add(key);
      created = this.enqueue(async () => {
        try {
          await this.prepare(persistent);
        } finally {
          this.preparing.delete(key);
        }
      }).then(() => this.launchPersistent(persistent));
    }
    const pending = created.then(async (context) => {
      context.on("close", () => {
        // A removal took it out first and deletes its folder: only one that simply closed is used.
        const simplyClosed = this.contexts.get(key) === pending;
        if (simplyClosed) this.contexts.delete(key);
        if (persistent !== null && simplyClosed) {
          void this.enqueue(() => this.touch(persistent)).catch(constVoid);
        }
        this.options.onContextClose?.(context);
      });
      for (const page of context.pages()) await page.close().catch(constVoid);
      if (this.closing) {
        await context.close().catch(constVoid);
        throw new Error("The preview browser is closed.");
      }
      return context;
    });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  /** Whose the Space folder is goes in first, so no profile folder exists without it. */
  private async prepare(place: ProfilePlace) {
    const spaceDir = NodePath.join(this.options.profilesDir, place.userFolder, place.spaceFolder);
    await NodeFSP.mkdir(spaceDir, { recursive: true });
    const ownerFile = NodePath.join(spaceDir, OWNER_FILE);
    const written = `${ownerFile}.${process.pid}-${(this.writes += 1)}.tmp`;
    await NodeFSP.writeFile(written, JSON.stringify(place.owner));
    await NodeFSP.rename(written, ownerFile);
    await NodeFSP.mkdir(this.profileDirectory(place), { recursive: true });
    await this.touch(place);
  }

  private writes = 0;

  private async launchPersistent(place: ProfilePlace) {
    const { executable, args, ...options } = await this.launchOptions();
    const { chromium } = loadPlaywright();
    return this.launch(executable, (executablePath) =>
      chromium.launchPersistentContext(this.profileDirectory(place), {
        ...options,
        args: [...args, `--disk-cache-size=${DISK_CACHE_BYTES}`],
        ...CONTEXT_OPTIONS,
        executablePath,
      }),
    );
  }

  private profileDirectory(place: ProfilePlace) {
    return NodePath.join(
      this.options.profilesDir,
      place.userFolder,
      place.spaceFolder,
      place.profileFolder,
    );
  }

  /** Marks a profile used; never makes a folder a removal deleted. */
  private async touch(place: ProfilePlace) {
    const marker = NodePath.join(this.profileDirectory(place), LAST_USED_FILE);
    const now = Date.now() / 1000;
    await NodeFSP.utimes(marker, now, now).catch(() => NodeFSP.writeFile(marker, ""));
  }

  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await (await this.sharedBrowser()).newContext();
    const page = await context.newPage();
    page.once("close", () => void context.close().catch(constVoid));
    return page;
  }

  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  /** Closes the open contexts of every profile whose folders `matches`, then runs `remove`. */
  private removeWhere(
    matches: (folders: ReadonlyArray<string>) => boolean,
    remove: () => Promise<void>,
  ) {
    // Taken now, so a request right after this call opens a new context, after the removal.
    const open = this.takeOpen(matches);
    return this.enqueue(async () => {
      await closeContexts(open);
      await remove();
    });
  }

  /** Takes the contexts of profiles whose folders `matches` out of the pool, to close. */
  private takeOpen(matches: (folders: ReadonlyArray<string>) => boolean) {
    const open = [...this.contexts.entries()].filter(([key]) => {
      const folders = foldersOfKey(key);
      return folders !== null && matches(folders);
    });
    for (const [key] of open) this.contexts.delete(key);
    return open.map(([, pending]) => pending);
  }

  /** One profile of one User, in every Space they have it. */
  clearProfile(userFolder: string, profileFolder: string) {
    return this.removeWhere(
      ([user, , profile]) => user === userFolder && profile === profileFolder,
      async () => {
        const userDir = NodePath.join(this.options.profilesDir, userFolder);
        for (const space of await readFolders(userDir)) {
          await NodeFSP.rm(NodePath.join(userDir, space, profileFolder), {
            recursive: true,
            force: true,
          });
        }
      },
    );
  }

  /** Every profile of a User, or only those of one of their Spaces. */
  removeProfiles(userFolder: string, spaceFolder?: string) {
    return this.removeWhere(
      ([user, space]) =>
        user === userFolder && (spaceFolder === undefined || space === spaceFolder),
      () =>
        NodeFSP.rm(
          NodePath.join(
            this.options.profilesDir,
            userFolder,
            ...(spaceFolder === undefined ? [] : [spaceFolder]),
          ),
          { recursive: true, force: true },
        ),
    );
  }

  /** Every User's profiles: the Owner's explicit action. */
  clearAll() {
    return this.removeWhere(
      () => true,
      async () => {
        for (const user of await readFolders(this.options.profilesDir)) {
          await NodeFSP.rm(NodePath.join(this.options.profilesDir, user), {
            recursive: true,
            force: true,
          });
        }
      },
    );
  }

  /**
   * In one step, so no profile opens halfway through it: each Space folder (of `userFolder`, or
   * every one) whose owner `keep` refuses goes, its open profiles closed first. A folder that does
   * not say whose it is gets `owner` null. Profiles asked for after this call are left alone.
   */
  reconcile(keep: (entry: SpaceFolder) => Promise<boolean>, userFolder?: string) {
    return this.enqueue(async () => {
      for (const entry of await this.spaceFolders(userFolder)) {
        if (await keep(entry)) continue;
        const open = this.takeOpen(
          (folders) =>
            folders[0] === entry.userFolder &&
            folders[1] === entry.spaceFolder &&
            !this.preparing.has(placeKeyOf(folders)),
        );
        await closeContexts(open);
        await NodeFSP.rm(
          NodePath.join(this.options.profilesDir, entry.userFolder, entry.spaceFolder),
          { recursive: true, force: true },
        );
      }
    });
  }

  private async spaceFolders(onlyUser?: string) {
    const found: Array<SpaceFolder> = [];
    const users = onlyUser === undefined ? await readFolders(this.options.profilesDir) : [onlyUser];
    for (const userFolder of users) {
      const userDir = NodePath.join(this.options.profilesDir, userFolder);
      for (const spaceFolder of await readFolders(userDir)) {
        const owner = await NodeFSP.readFile(
          NodePath.join(userDir, spaceFolder, OWNER_FILE),
          "utf8",
        )
          .then(parseOwner)
          .catch(() => null);
        found.push({ userFolder, spaceFolder, owner });
      }
    }
    return found;
  }

  /**
   * Bounds what profiles keep: a closed one unused for `maxIdleMs` goes; one over `maxBytes`
   * loses its caches, then everything if that is not enough. Sizes are read outside the queue;
   * each deletion takes it only briefly, and only for a profile still closed then.
   */
  async sweep(limits: ProfileLimits) {
    for (const userFolder of await readFolders(this.options.profilesDir)) {
      const userDir = NodePath.join(this.options.profilesDir, userFolder);
      for (const spaceFolder of await readFolders(userDir)) {
        const spaceDir = NodePath.join(userDir, spaceFolder);
        for (const profileFolder of await readFolders(spaceDir)) {
          const key = placeKeyOf([userFolder, spaceFolder, profileFolder]);
          const directory = NodePath.join(spaceDir, profileFolder);
          if (this.contexts.has(key)) continue;
          const whileClosed = (step: () => Promise<void>) =>
            this.enqueue(async () => {
              if (!this.contexts.has(key)) await step();
            });
          if (await idle(directory, limits)) {
            // Used since? Then it stays.
            await whileClosed(async () => {
              if (await idle(directory, limits)) await removeDirectory(directory);
            });
            continue;
          }
          if ((await sizeOf(directory)) <= limits.maxBytes) continue;
          await whileClosed(async () => {
            for (const cache of CACHE_FOLDERS) {
              await removeDirectory(NodePath.join(directory, cache));
            }
          });
          if ((await sizeOf(directory)) > limits.maxBytes) {
            await whileClosed(() => removeDirectory(directory));
          }
        }
      }
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => (await pending).close()),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    this.contexts.clear();
  }
}

/** A Space folder of the profiles, and whose it says it is: null when it does not say. */
export interface SpaceFolder {
  readonly userFolder: string;
  readonly spaceFolder: string;
  readonly owner: { readonly userId: string; readonly spaceId: string } | null;
}

export interface ProfileLimits {
  readonly now: number;
  readonly maxIdleMs: number;
  readonly maxBytes: number;
}

const isolatedKey = (isolationKey: string) => JSON.stringify(["isolated", isolationKey]);
const placeKeyOf = (folders: ReadonlyArray<string>) => JSON.stringify(folders);
const placeKey = (place: ProfilePlace) =>
  placeKeyOf([place.userFolder, place.spaceFolder, place.profileFolder]);
const CONTEXT_OPTIONS = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };

const closeContexts = (open: ReadonlyArray<Promise<BrowserContext>>) =>
  Promise.all(
    open.map(async (pending) => {
      const context = await pending.catch(() => undefined);
      await context?.close();
    }),
  );

const removeDirectory = (directory: string) =>
  NodeFSP.rm(directory, { recursive: true, force: true });

/** Whether nobody opened the profile in `directory` for `maxIdleMs`; never marked counts. */
const idle = async (directory: string, limits: ProfileLimits) => {
  const used = await NodeFSP.stat(NodePath.join(directory, LAST_USED_FILE)).catch(() => null);
  return used === null || limits.now - used.mtimeMs > limits.maxIdleMs;
};
/** The folders of a persistent profile's key; null for an isolated context's. */
const foldersOfKey = (key: string): ReadonlyArray<string> | null => {
  const parsed = JSON.parse(key) as ReadonlyArray<string>;
  return parsed[0] === "isolated" ? null : parsed;
};

const parseOwner = (text: string) => {
  const parsed = JSON.parse(text) as { readonly userId?: unknown; readonly spaceId?: unknown };
  return typeof parsed.userId === "string" && typeof parsed.spaceId === "string"
    ? { userId: parsed.userId, spaceId: parsed.spaceId }
    : null;
};

/** The folders in `directory` named as `PreviewProfiles` names them; none when it is missing. */
const readFolders = async (directory: string) => {
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && FOLDER_NAME.test(entry.name))
    .map((entry) => entry.name);
};

const sizeOf = async (path: string): Promise<number> => {
  const stat = await NodeFSP.lstat(path).catch(() => null);
  if (stat === null) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of await NodeFSP.readdir(path).catch(() => [])) {
    total += await sizeOf(NodePath.join(path, entry));
  }
  return total;
};
