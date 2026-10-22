/**
 * Installed apps on macOS: the .app bundles in the Applications folders (and Finder), read from each bundle's
 * Info.plist with plist.ts, and opened through LaunchServices (`/usr/bin/open -a <bundle>`). LaunchServices starts
 * the app with launchd's environment, never open's, so Ember's sign-in and keys can't reach it, and the app isn't
 * Ember's child. The list is cached for 5 minutes and dropped early when a source folder changes, and each bundle's
 * parse is kept by its Info.plist's mtime, so a warm list costs a directory walk only. Agents and background-only
 * bundles (LSUIElement, LSBackgroundOnly) aren't apps a user opens, so they aren't listed. Terminals are refused
 * before anything runs (hands/system.ts isTerminalApp with the macOS vocabulary).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppCatalog, AppIdentity } from "../../types";
import { appEnv, findApp, hasBuiltInShell, isTerminalApp, programsOf, type DesktopApp } from "../../../hands/system";
import { LAUNCHERS } from "../../../hands/terminals";
import { isPlistDict, parsePlist, type PlistDict, type PlistValue } from "./plist";
import { execRun, type Run } from "./exec";

/** How long a listed catalogue is trusted when no source folder changed. */
export const CACHE_MS = 5 * 60_000;
/** At most this many bundles are read (a Mac has a few hundred). */
export const MAX_BUNDLES = 2000;
/** An Info.plist larger than this isn't read (they are a few KiB; a huge one is not an app's). */
const MAX_PLIST_BYTES = 1 << 20;

/** What a generic request ("open the text editor") means on a Mac, by the bundle's file name. */
export const GENERIC: Readonly<Record<string, string>> = {
  "Finder": "file manager", "TextEdit": "text editor", "Safari": "web browser", "Mail": "email", "System Settings": "settings",
  "Numbers": "spreadsheet", "Pages": "word processor", "Keynote": "presentation", "Preview": "document viewer", "Calculator": "calculator",
};

/** The folders apps are listed from, in order (an earlier bundle with the same bundle id wins). */
export function appRoots(home: string): { dir: string; vendors?: boolean }[] {
  return [
    { dir: "/Applications", vendors: true },
    { dir: "/Applications/Utilities" },
    { dir: "/System/Applications" },
    { dir: "/System/Applications/Utilities" },
    // A macOS path whatever OS runs this (the unit tests run on Windows too).
    { dir: path.posix.join(home, "Applications") },
  ];
}

/** Bundles listed by path beside the folders (Finder lives in CoreServices). */
export const EXTRA_BUNDLES: readonly string[] = ["/System/Library/CoreServices/Finder.app"];

/** The file-system calls the catalogue makes (injected for the tests). */
export interface BundleFs {
  /** Entry names of a folder; throws when it can't be read. */
  readdir(dir: string): string[];
  /** stat (following links: /Applications/Safari.app is a link into a cryptex), or null when it isn't there. */
  stat(p: string): { isDirectory(): boolean; mtimeMs: number; size: number } | null;
  readFile(p: string): Buffer;
}

const realFs: BundleFs = {
  readdir: dir => fs.readdirSync(dir),
  stat: p => {
    try {
      return fs.statSync(p);
    } catch {
      return null; // not there (or not readable): the caller skips it
    }
  },
  readFile: p => fs.readFileSync(p),
};

/** What darwinApps() takes; everything has a real default. */
export interface DarwinAppsDeps {
  fs?: BundleFs;
  home?: () => string;
  env?: NodeJS.ProcessEnv;
  run?: Run;
  now?: () => number;
  /** Folders to list instead of appRoots(home) and EXTRA_BUNDLES (tests). */
  roots?: { dir: string; vendors?: boolean }[];
  extraBundles?: readonly string[];
  /** Told when `open` fails after the launch call returned (the worker notices no window appeared). */
  onLaunchError?: (err: { code: number | null; stderr: string; failure?: string }) => void;
}

const truthy = (v: PlistValue | undefined): boolean => v === true || v === 1 || (typeof v === "string" && /^(1|yes|true)$/i.test(v.trim()));
const text = (v: PlistValue | undefined): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const uniqueLower = (xs: (string | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => !!x).map(x => x.toLowerCase()))];

/**
 * The DesktopApp for a bundle's Info.plist, or null when it isn't an app a user opens (no executable, an agent or a
 * background-only bundle).
 */
export function bundleApp(bundle: string, info: PlistDict): DesktopApp | null {
  const exe = text(info.CFBundleExecutable);
  if (!exe || exe.includes("/") || truthy(info.LSUIElement) || truthy(info.LSBackgroundOnly)) return null;
  const name = path.basename(bundle).replace(/\.app$/i, "");
  const id = text(info.CFBundleIdentifier) ?? bundle;
  const bundleName = text(info.CFBundleName);
  const generic = GENERIC[name];
  const category = text(info.LSApplicationCategoryType);
  return {
    id, name, file: bundle,
    // GenericName leads the keywords on Linux; the same here, so findApp ranks alike.
    keywords: uniqueLower([generic, text(info.CFBundleDisplayName), bundleName]),
    ...(generic ? { generic } : {}),
    ...(category ? { categories: [category] } : {}),
    argv: [path.join(bundle, "Contents", "MacOS", exe)],
    // The sidecar's `app` is the localized name (the file name for most apps); the window list's owner the same.
    programs: uniqueLower([name, bundleName, exe, text(info.CFBundleIdentifier)]),
  };
}

/** The macOS app catalogue (design §9.2). */
export function darwinApps(d: DarwinAppsDeps = {}): AppCatalog {
  const bfs = d.fs ?? realFs;
  const home = d.home ?? os.homedir;
  const run = d.run ?? execRun;
  const now = d.now ?? Date.now;
  const parsed = new Map<string, { mtimeMs: number; app: DesktopApp | null }>();
  let cache: { at: number; stamps: Map<string, number>; apps: DesktopApp[] } | null = null;

  const roots = () => d.roots ?? appRoots(home());
  const mtime = (dir: string) => bfs.stat(dir)?.mtimeMs ?? -1;

  /** The folders bundles are listed from: the roots and the vendor folders inside them. Their mtimes say whether the list changed. */
  const folders = (): string[] => {
    const out: string[] = [];
    for (const r of roots()) {
      out.push(r.dir);
      if (r.vendors) out.push(...vendorFolders(r.dir));
    }
    return out;
  };

  const vendorFolders = (dir: string): string[] => {
    let names: string[];
    try {
      names = bfs.readdir(dir);
    } catch {
      return []; // no such folder on this Mac
    }
    return names.filter(n => !n.startsWith(".") && !/\.app$/i.test(n)).map(n => path.join(dir, n)).filter(p => bfs.stat(p)?.isDirectory());
  };

  const bundlesIn = (dir: string): string[] => {
    try {
      return bfs.readdir(dir).filter(n => /\.app$/i.test(n) && !n.startsWith(".")).sort((a, b) => a.localeCompare(b)).map(n => path.join(dir, n));
    } catch {
      return [];
    }
  };

  const read = (bundle: string): DesktopApp | null => {
    const plist = path.join(bundle, "Contents", "Info.plist");
    const st = bfs.stat(plist);
    if (!st || st.isDirectory() || st.size > MAX_PLIST_BYTES) return null;
    const known = parsed.get(bundle);
    if (known && known.mtimeMs === st.mtimeMs) return known.app;
    let app: DesktopApp | null;
    try {
      const info = parsePlist(bfs.readFile(plist));
      app = isPlistDict(info) ? bundleApp(bundle, info) : null;
    } catch {
      app = null; // unreadable or not a property list: not listed
    }
    parsed.set(bundle, { mtimeMs: st.mtimeMs, app });
    return app;
  };

  const scan = (dirs: readonly string[]): DesktopApp[] => {
    const candidates = [...dirs.flatMap(bundlesIn), ...(d.extraBundles ?? EXTRA_BUNDLES)];
    const seenPath = new Set<string>(), seenId = new Set<string>();
    const out: DesktopApp[] = [];
    for (const bundle of candidates) {
      if (out.length >= MAX_BUNDLES) break;
      if (seenPath.has(bundle)) continue;
      seenPath.add(bundle);
      if (!bfs.stat(bundle)?.isDirectory()) continue;
      const app = read(bundle);
      if (!app || seenId.has(app.id)) continue;
      seenId.add(app.id);
      out.push(app);
    }
    return out;
  };

  return {
    list() {
      const dirs = folders();
      const fresh = cache && now() - cache.at < CACHE_MS && cache.stamps.size === dirs.length && dirs.every(f => cache!.stamps.get(f) === mtime(f));
      if (!fresh) {
        const stamps = new Map(dirs.map(f => [f, mtime(f)] as const));
        cache = { at: now(), stamps, apps: scan(dirs) };
      }
      return [...cache!.apps];
    },

    find: findApp,

    launch(app: DesktopApp) {
      if (isTerminalApp(app, "darwin")) throw new Error("Ember doesn't run terminals, on its desk or anywhere else");
      // Only a bundle from the catalogue: `open -a` given a bare program would start it in Terminal.
      if (!path.isAbsolute(app.file) || !/\.app$/i.test(app.file)) throw new Error("Ember only opens installed apps.");
      if (!bfs.stat(app.file)?.isDirectory()) throw new Error("That app isn't installed any more.");
      void run("/usr/bin/open", ["-a", app.file], { env: appEnv(d.env ?? process.env), cwd: home(), timeout: 10_000 }).then(r => {
        if (r.code !== 0) d.onLaunchError?.({ code: r.code, stderr: r.stderr.trim().slice(0, 300), ...(r.failure ? { failure: r.failure } : {}) });
      });
    },

    isTerminalApp: (a: AppIdentity) => isTerminalApp(a, "darwin"),
    hasBuiltInShell: (a: AppIdentity) => hasBuiltInShell(a, "darwin"),
    programsOf: (app: DesktopApp) => programsOf(app, LAUNCHERS.darwin),
    appKey: (s: string) => s.toLowerCase(),
  };
}
