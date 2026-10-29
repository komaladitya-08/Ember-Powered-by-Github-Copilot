/**
 * Installed apps on macOS: the .app bundles in the Applications folders (and Finder), read from each bundle's
 * Info.plist with plist.ts, with their names in the user's language too (a German Mac's window list calls Calculator
 * "Rechner": its localized InfoPlist.strings or InfoPlist.loctable says so), and opened through LaunchServices (`/usr/bin/open -a <bundle>`). LaunchServices starts
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
import { isPlistDict, parsePlist, parseStringsFile, type PlistDict, type PlistValue } from "./plist";
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
  /**
   * The user's preferred languages, most preferred first (Electron's app.getPreferredSystemLanguages(): "de-DE",
   * "zh-Hans-CN"): an app's localized names come from the first of them it has. None (the default): no localized names.
   */
  languages?: () => readonly string[];
}

const truthy = (v: PlistValue | undefined): boolean => v === true || v === 1 || (typeof v === "string" && /^(1|yes|true)$/i.test(v.trim()));
const text = (v: PlistValue | undefined): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/**
 * A name as it is compared: lower case, without invisible format characters (Apple's German name for System Settings is
 * "System\u00ADeinstellungen", a soft hyphen where the Dock may break it; nobody types or says one).
 */
const fold = (s: string): string => s.replace(/\p{Cf}/gu, "").toLowerCase();
const uniqueLower = (xs: (string | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => !!x).map(fold))];

/** Language folders older bundles are named by (English.lproj), by language code. */
const LEGACY_LPROJ: Readonly<Record<string, string>> = {
  en: "English", de: "German", fr: "French", ja: "Japanese", es: "Spanish", it: "Italian", nl: "Dutch",
};
/** Regions whose Chinese is written in traditional characters. */
const HANT_REGIONS = new Set(["TW", "HK", "MO"]);

/**
 * The names a language (a BCP 47 tag, "de-DE", "zh-Hans-CN", "es-419") may be kept under in a bundle, most specific
 * first: its .lproj folder names (without ".lproj") and its keys in an InfoPlist.loctable. Only letters, digits, "-"
 * and "_" ever come out (a tag can't name a path). [] for something that isn't a language tag.
 */
export function localeKeys(tag: string): string[] {
  const all = tag.trim().split(/[-_]/);
  // Extensions and private use ("-u-…", "-x-…") start at the first one-letter part.
  const end = all.findIndex((p, i) => i > 0 && p.length === 1);
  const parts = end < 0 ? all : all.slice(0, end);
  if (!/^[a-z]{2,3}$/i.test(parts[0] ?? "")) return [];
  const l = parts[0]!.toLowerCase();
  const script = parts.slice(1).find(p => /^[a-z]{4}$/i.test(p));
  const region = parts.slice(1).find(p => /^([a-z]{2}|\d{3})$/i.test(p));
  const S = script ? script[0]!.toUpperCase() + script.slice(1).toLowerCase() : undefined;
  const R = region?.toUpperCase();
  const out: string[] = [];
  if (S && R) out.push(`${l}-${S}-${R}`, `${l}_${S}_${R}`);
  if (S) out.push(`${l}-${S}`, `${l}_${S}`);
  if (R) out.push(`${l}_${R}`, `${l}-${R}`);
  if (l === "zh" && !S && R) out.push(HANT_REGIONS.has(R) ? "zh-Hant" : "zh-Hans");
  if (l === "zh" && S && !R) out.push(S === "Hant" ? "zh_TW" : "zh_CN");
  out.push(l);
  if (LEGACY_LPROJ[l]) out.push(LEGACY_LPROJ[l]!);
  return [...new Set(out)];
}

/** The display and bundle names in a localized InfoPlist dictionary. */
const namesIn = (d: PlistValue | undefined): string[] =>
  isPlistDict(d) ? [text(d.CFBundleDisplayName), text(d.CFBundleName)].filter((x): x is string => !!x) : [];

/**
 * An app's names in the first of `languages` it is localized for, as the window list and the accessibility helper
 * name it on that Mac ("Rechner" for Calculator in German): from Contents/Resources/InfoPlist.loctable (every
 * language in one file, macOS 14 and later) and <language>.lproj/InfoPlist.strings, both where a bundle has both (one
 * may hold only the language's usage descriptions). [] when it has none, or when the files can't be read (only the
 * localized names are lost).
 */
export function localizedNames(bundle: string, languages: readonly string[], bfs: BundleFs): string[] {
  if (!languages.length) return [];
  const resources = path.join(bundle, "Contents", "Resources");
  const small = (p: string) => {
    const st = bfs.stat(p);
    return !!st && !st.isDirectory() && st.size <= MAX_PLIST_BYTES;
  };
  let table: PlistDict | null = null;
  try {
    const loctable = path.join(resources, "InfoPlist.loctable");
    if (small(loctable)) {
      const t = parsePlist(bfs.readFile(loctable));
      if (isPlistDict(t)) table = t;
    }
  } catch {
    table = null; // unreadable: the .lproj folders may still have them
  }
  for (const tag of languages) {
    for (const key of localeKeys(tag)) {
      const inTable = !!table && Object.prototype.hasOwnProperty.call(table, key) && isPlistDict(table[key]);
      const names = inTable ? namesIn(table![key]) : [];
      const strings = path.join(resources, `${key}.lproj`, "InfoPlist.strings");
      if (!small(strings)) {
        if (inTable) return names;
        continue;
      }
      try {
        return [...new Set([...names, ...namesIn(parseStringsFile(bfs.readFile(strings)))])];
      } catch {
        return names; // this language's file is broken: only what the table has
      }
    }
  }
  return [];
}

/**
 * The DesktopApp for a bundle's Info.plist, or null when it isn't an app a user opens (no executable, an agent or a
 * background-only bundle). `localized`: its names in the user's language (localizedNames), found by and matched as.
 */
export function bundleApp(bundle: string, info: PlistDict, localized: readonly string[] = []): DesktopApp | null {
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
    keywords: uniqueLower([generic, text(info.CFBundleDisplayName), bundleName, ...localized]),
    ...(generic ? { generic } : {}),
    ...(category ? { categories: [category] } : {}),
    argv: [path.join(bundle, "Contents", "MacOS", exe)],
    // The sidecar's `app` is the localized name (the file name for most apps); the window list's owner the same.
    programs: uniqueLower([name, bundleName, exe, text(info.CFBundleIdentifier), ...localized]),
  };
}

/** The macOS app catalogue (design §9.2). */
export function darwinApps(d: DarwinAppsDeps = {}): AppCatalog {
  const bfs = d.fs ?? realFs;
  const home = d.home ?? os.homedir;
  const run = d.run ?? execRun;
  const now = d.now ?? Date.now;
  const parsed = new Map<string, { mtimeMs: number; langs: string; app: DesktopApp | null }>();
  const languages = (): readonly string[] => {
    try {
      return d.languages?.() ?? [];
    } catch {
      return []; // not known (yet): the names without localization
    }
  };
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

  const read = (bundle: string, langs: readonly string[]): DesktopApp | null => {
    const plist = path.join(bundle, "Contents", "Info.plist");
    const st = bfs.stat(plist);
    if (!st || st.isDirectory() || st.size > MAX_PLIST_BYTES) return null;
    const known = parsed.get(bundle);
    const langKey = langs.join(",");
    if (known && known.mtimeMs === st.mtimeMs && known.langs === langKey) return known.app;
    let app: DesktopApp | null;
    try {
      const info = parsePlist(bfs.readFile(plist));
      app = isPlistDict(info) ? bundleApp(bundle, info, localizedNames(bundle, langs, bfs)) : null;
    } catch {
      app = null; // unreadable or not a property list: not listed
    }
    parsed.set(bundle, { mtimeMs: st.mtimeMs, langs: langKey, app });
    return app;
  };

  const scan = (dirs: readonly string[]): DesktopApp[] => {
    const candidates = [...dirs.flatMap(bundlesIn), ...(d.extraBundles ?? EXTRA_BUNDLES)];
    const langs = languages();
    const seenPath = new Set<string>(), seenId = new Set<string>();
    const out: DesktopApp[] = [];
    for (const bundle of candidates) {
      if (out.length >= MAX_BUNDLES) break;
      if (seenPath.has(bundle)) continue;
      seenPath.add(bundle);
      if (!bfs.stat(bundle)?.isDirectory()) continue;
      const app = read(bundle, langs);
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

    // findApp's tie-break demotes terminals by the vocabulary it is given (Linux's by default): the Mac's here, the
    // same one launch() refuses by.
    find: (apps: DesktopApp[], query: string) => findApp(apps, query, "darwin"),

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
    appKey: fold,
  };
}
