/**
 * The Windows app catalogue (tier 0's open_app): the Start Menu's shortcuts and a curated table of packaged apps
 * that have none, and launching one through explorer.exe. Listing reads every .lnk with lnk.ts (pure TypeScript, so
 * no COM call stalls Electron's main thread); launching asks the running shell to open the shortcut, the way
 * gtk-launch asks the desktop on Linux, so the app starts with Explorer's environment and integrity level: Ember's
 * tokens and EMBER_* variables never reach it, and an app Ember opens is never elevated even when Ember is. Ember
 * never calls ShellExecute, shell.openPath or `cmd /c start` itself, and never offers a shortcut whose program is
 * missing (Explorer would ask "Do you want to delete this shortcut?", a destructive prompt Ember caused).
 *
 * Plain Node: the file system, spawn and Windows' folders are injected, so every rule is unit-tested on Linux.
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesktopApp } from "../../../hands/system";
import type { Logger } from "../../../logger";
import type { AppCatalog, AppIdentity } from "../../types";
import { splitWindowsArgs } from "./argv";
import { appEnv, findApp, hasBuiltInShell, isTerminalApp, LAUNCHERS, programsOf } from "./interim";
import type { KnownFolders } from "./known-folders";
import { expandEnvironmentStrings, LnkError, parseShellLink, type ShellLink } from "./lnk";

const wpath = path.win32;

/** A packaged (UWP/MSIX) app with no Start Menu shortcut, opened as shell:AppsFolder\<AUMID>. */
export interface PackagedApp {
  name: string;
  /** Its AppUserModelId ("<package family>!<app id>"). */
  aumid: string;
  /** Lower-case program names its windows report (port/win32 names a UWP frame after the hosted app's program). */
  programs: string[];
  generic?: string;
  /** Offered without asking whether its package is installed (Settings is part of Windows). */
  always?: boolean;
}

/**
 * Packaged apps people ask for by name that have no .lnk (§9.2). Each is offered only when GetPackagesByPackageFamily
 * says its package is installed for this user: opening an unregistered AUMID makes Explorer show an error dialog.
 * Where Windows 10 and 11 name the program differently both names are listed (Calculator.exe / CalculatorApp.exe,
 * ScreenSketch.exe / SnippingTool.exe), and Photos' program is Microsoft.Photos.exe.
 */
export const PACKAGED_APPS: readonly PackagedApp[] = [
  { name: "Settings", aumid: "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel", programs: ["systemsettings"], generic: "settings", always: true },
  { name: "Calculator", aumid: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", programs: ["calculatorapp", "calculator"], generic: "calculator" },
  { name: "Notepad", aumid: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App", programs: ["notepad"], generic: "text editor" },
  { name: "Paint", aumid: "Microsoft.Paint_8wekyb3d8bbwe!App", programs: ["mspaint"], generic: "image editor" },
  { name: "Photos", aumid: "Microsoft.Windows.Photos_8wekyb3d8bbwe!App", programs: ["photos", "microsoft.photos"] },
  { name: "Snipping Tool", aumid: "Microsoft.ScreenSketch_8wekyb3d8bbwe!App", programs: ["snippingtool", "screensketch"] },
  // Listed so "open Terminal" is refused by name (isTerminalApp), never launched.
  { name: "Terminal", aumid: "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", programs: ["windowsterminal"] },
  { name: "Outlook", aumid: "Microsoft.OutlookForWindows_8wekyb3d8bbwe!Microsoft.OutlookforWindows", programs: ["olk"], generic: "email" },
  { name: "Clock", aumid: "Microsoft.WindowsAlarms_8wekyb3d8bbwe!App", programs: ["time"] },
  { name: "Microsoft Store", aumid: "Microsoft.WindowsStore_8wekyb3d8bbwe!App", programs: ["winstore.app"] },
];

/**
 * File Explorer when no Start Menu shortcut provides it (the "File Explorer" shortcut lives in the user's own Start
 * Menu, which a fresh or managed profile may lack): explorer.exe opens This PC.
 */
export const FILE_EXPLORER: Readonly<DesktopApp> = {
  id: "File Explorer", name: "File Explorer", file: "shell:MyComputerFolder", keywords: ["file manager"], generic: "file manager",
  argv: [], programs: ["explorer"],
};

/** Everyday names of well-known programs, so "open the web browser" finds Edge (findApp's GenericName tiers). */
const GENERIC: Readonly<Record<string, string>> = {
  explorer: "file manager", notepad: "text editor", msedge: "web browser", chrome: "web browser", firefox: "web browser",
  outlook: "email", olk: "email", winword: "word processor", excel: "spreadsheet", powerpnt: "presentation", mspaint: "image editor",
};

/** How deep the Start Menu folders are walked, and how many shortcuts are read at most. */
export const MAX_DEPTH = 4;
export const MAX_SHORTCUTS = 2000;
/** A .lnk larger than this isn't a shortcut anyone made by hand (they are a few kilobytes). */
const MAX_LNK_BYTES = 1024 * 1024;
/** How long a listing is kept (dropped earlier when a Start Menu folder changes). */
export const CACHE_MS = 5 * 60_000;

/** The file system the catalogue reads (injected for tests). */
export interface AppsFs {
  /** A folder's entries; throws when it can't be read. Symbolic links and junctions are neither files nor folders. */
  readdir(dir: string): { name: string; isFile: boolean; isDirectory: boolean }[];
  mtimeMs(p: string): number | null;
  /** The file's bytes, or null when unreadable or larger than `max`. */
  readFile(p: string, max: number): Buffer | null;
  exists(p: string): boolean;
}

/** The real file system. */
export const NODE_FS: AppsFs = {
  readdir: dir => fs.readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() })),
  mtimeMs: p => { try { return fs.statSync(p).mtimeMs; } catch { return null; } },
  readFile(p, max) {
    try {
      if (fs.statSync(p).size > max) return null;
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  },
  exists: p => fs.existsSync(p),
};

/** What the catalogue needs from Windows and Ember. */
export interface Win32AppsDeps {
  env: NodeJS.ProcessEnv;
  /** Ember's own program (process.execPath): its own shortcut is never offered. */
  execPath: string;
  folders: Pick<KnownFolders, "programs" | "commonPrograms" | "windowsDirectory">;
  /** Is a package of this family installed for this user? (null: can't tell, so it isn't offered.) */
  packageInstalled: (family: string) => boolean | null;
  fs?: AppsFs;
  spawn?: (command: string, args: string[], options: SpawnOptions) => { on(event: "error", fn: (err: Error) => void): unknown; unref(): void };
  homedir?: () => string;
  now?: () => number;
  log?: () => Logger | null;
}

const lower = (s: string) => s.toLowerCase();
/** Two Windows paths name the same file (case-insensitive, normalised). */
export const samePath = (a: string, b: string) => lower(wpath.normalize(a)) === lower(wpath.normalize(b));
/** A program's name as windows report it: the file name, lower case, without ".exe". */
const programName = (target: string) => lower(wpath.basename(target)).replace(/\.exe$/, "");

/** Uninstallers: never offered (opening one is a step towards removing the app). */
export function isUninstaller(name: string, target: string): boolean {
  return /\buninstall\b|^remove\b/i.test(name) || /^(unins\d*|uninst\w*|msiexec)\.exe$/i.test(wpath.basename(target));
}

/** Why a shortcut isn't offered, or the app it opens. */
export type ShortcutVerdict = { app: DesktopApp } | { skip: "no-target" | "not-a-program" | "missing" | "uninstaller" | "ember" | "elevated" };

/**
 * The app a parsed shortcut opens, or why it is skipped: no program target (a shell item), a target that isn't an
 * .exe, one that isn't there (after %VARIABLE% expansion), an uninstaller, Ember itself, or a shortcut ticked "Run as
 * administrator" (Ember never starts an elevated app). `id` is the path below the Start Menu's Programs folder
 * without ".lnk", with "/" separators; an advertised (MSI) shortcut gets no program names (its window is matched by
 * title, as on Linux).
 */
export function appFromShortcut(link: ShellLink, o: { file: string; id: string; env: NodeJS.ProcessEnv; execPath: string; exists: (p: string) => boolean }): ShortcutVerdict {
  const name = wpath.basename(o.file).replace(/\.lnk$/i, "");
  if (!link.target) return { skip: "no-target" };
  const target = expandEnvironmentStrings(link.target, o.env);
  if (!/\.exe$/i.test(target)) return { skip: "not-a-program" };
  if (link.runAsUser) return { skip: "elevated" };
  if (isUninstaller(name, target)) return { skip: "uninstaller" };
  if (samePath(target, o.execPath)) return { skip: "ember" };
  if (!wpath.isAbsolute(target) || !o.exists(target)) return { skip: "missing" };
  const program = programName(target);
  const generic = link.advertised ? undefined : GENERIC[program];
  const description = link.description.trim();
  const keywords = [...new Set([generic, description].filter((k): k is string => !!k).map(lower))];
  return {
    app: {
      id: o.id, name, file: o.file, keywords, ...(generic ? { generic } : {}),
      argv: [target, ...splitWindowsArgs(link.arguments)],
      programs: link.advertised ? [] : [program],
    },
  };
}

/** A packaged app's DesktopApp. */
export function packagedApp(p: PackagedApp): DesktopApp {
  return {
    id: p.aumid, name: p.name, file: `shell:AppsFolder\\${p.aumid}`, keywords: p.generic ? [p.generic] : [], ...(p.generic ? { generic: p.generic } : {}),
    argv: [], programs: [...p.programs],
  };
}

/** The package family of an AUMID ("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" → "Microsoft.WindowsCalculator_8wekyb3d8bbwe"). */
export const packageFamily = (aumid: string) => aumid.slice(0, Math.max(0, aumid.indexOf("!")));

interface Listing { apps: DesktopApp[]; at: number; folders: Map<string, number | null> }

/** The Windows AppCatalog. */
export function win32Apps(d: Win32AppsDeps): AppCatalog & { /** Drops the cached listing (tests, and after a fix). */ forget(): void } {
  const files = d.fs ?? NODE_FS;
  const spawn = d.spawn ?? nodeSpawn;
  const now = d.now ?? Date.now;
  const homedir = d.homedir ?? os.homedir;
  /** Parsed shortcuts by path, kept while their modification time stays the same. */
  const parsed = new Map<string, { mtime: number; link: ShellLink | null }>();
  let cache: Listing | null = null;

  const readLink = (file: string): ShellLink | null => {
    const mtime = files.mtimeMs(file);
    if (mtime === null) return null;
    const known = parsed.get(file);
    if (known && known.mtime === mtime) return known.link;
    let link: ShellLink | null = null;
    const bytes = files.readFile(file, MAX_LNK_BYTES);
    if (bytes) {
      try {
        link = parseShellLink(bytes);
      } catch (err) {
        if (!(err instanceof LnkError)) throw err;
        link = null; // not a shortcut Ember can read: skipped
      }
    }
    parsed.set(file, { mtime, link });
    return link;
  };

  /** Every .lnk under `root`, shallower ones first, each folder's entries in name order. */
  const walk = (root: string, seen: Map<string, number | null>, budget: { left: number }): { file: string; id: string }[] => {
    const out: { file: string; id: string }[] = [];
    let level = [root];
    for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        seen.set(dir, files.mtimeMs(dir));
        let entries: ReturnType<AppsFs["readdir"]>;
        try {
          entries = files.readdir(dir);
        } catch {
          continue; // unreadable: nothing from it
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          const p = wpath.join(dir, e.name);
          if (e.isDirectory) next.push(p);
          else if (e.isFile && /\.lnk$/i.test(e.name) && budget.left > 0) {
            budget.left--;
            out.push({ file: p, id: wpath.relative(root, p).replace(/\.lnk$/i, "").split("\\").join("/") });
          }
        }
      }
      level = next;
    }
    return out;
  };

  const build = (): Listing => {
    const folders = new Map<string, number | null>();
    const budget = { left: MAX_SHORTCUTS };
    const byName = new Map<string, DesktopApp>();
    const add = (app: DesktopApp) => { if (!byName.has(lower(app.name))) byName.set(lower(app.name), app); };
    for (const root of [d.folders.programs(), d.folders.commonPrograms()]) {
      if (!root) continue;
      for (const s of walk(root, folders, budget)) {
        const link = readLink(s.file);
        if (!link) continue;
        const v = appFromShortcut(link, { file: s.file, id: s.id, env: d.env, execPath: d.execPath, exists: p => files.exists(p) });
        if ("app" in v) add(v.app);
      }
    }
    for (const p of PACKAGED_APPS) {
      if (byName.has(lower(p.name))) continue;
      if (p.always || d.packageInstalled(packageFamily(p.aumid)) === true) add(packagedApp(p));
    }
    const apps = [...byName.values()];
    if (!apps.some(a => a.programs?.includes("explorer")) && !byName.has(lower(FILE_EXPLORER.name))) apps.push({ ...FILE_EXPLORER, argv: [], programs: ["explorer"], keywords: [...FILE_EXPLORER.keywords] });
    return { apps, at: now(), folders };
  };

  const fresh = (c: Listing) => now() - c.at < CACHE_MS && [...c.folders].every(([dir, mtime]) => files.mtimeMs(dir) === mtime);

  /** Throws when `app` must not be opened now (rechecked right before launching, whatever the listing said). */
  const check = (app: DesktopApp): void => {
    const terminal = "Ember doesn't run terminals, on its desk or anywhere else";
    if (isTerminalApp(app, "win32")) throw new Error(terminal);
    if (/\.lnk$/i.test(app.file)) {
      const link = files.exists(app.file) ? readLink(app.file) : null;
      if (!link) throw new Error("That app's shortcut isn't there any more.");
      const v = appFromShortcut(link, { file: app.file, id: app.id, env: d.env, execPath: d.execPath, exists: p => files.exists(p) });
      if (!("app" in v)) throw new Error(v.skip === "missing" || v.skip === "no-target" ? "That app's shortcut points at a program that isn't there any more." : "Ember can't open that shortcut.");
      if (isTerminalApp(v.app, "win32")) throw new Error(terminal);
      return;
    }
    if (app.file.startsWith("shell:AppsFolder\\")) {
      const p = PACKAGED_APPS.find(e => e.aumid === app.id && `shell:AppsFolder\\${e.aumid}` === app.file);
      if (!p) throw new Error("Ember can't open that app.");
      if (!p.always && d.packageInstalled(packageFamily(p.aumid)) !== true) throw new Error("That app isn't installed any more.");
      return;
    }
    if (app.file === FILE_EXPLORER.file && app.id === FILE_EXPLORER.id) return;
    throw new Error("Ember can't open that app.");
  };

  return {
    list() {
      if (!cache || !fresh(cache)) cache = build();
      return cache.apps;
    },
    find: (apps, query) => findApp(apps, query),
    launch(app) {
      check(app);
      const windows = d.folders.windowsDirectory();
      if (!windows) throw new Error("Ember couldn't find Windows' own folder, so it can't open apps.");
      // No windowsHide: explorer.exe has no console window to hide, and SW_HIDE in its STARTUPINFO could reach the
      // ShellExecute it makes for the shortcut, starting the app invisible (the integration test opens Notepad and
      // waits for its visible window).
      const child = spawn(wpath.join(windows, "explorer.exe"), [app.file], {
        detached: true, stdio: "ignore", cwd: homedir(), env: appEnv(d.env, { os: "win32" }),
      });
      // explorer.exe hands the request to the running shell and exits (exit code 1 is normal); a failure to start is logged.
      child.on("error", err => d.log?.()?.warn("apps.launch_failed", { err }));
      child.unref();
    },
    isTerminalApp: (app: AppIdentity) => isTerminalApp(app, "win32"),
    hasBuiltInShell: (app: AppIdentity) => hasBuiltInShell(app, "win32"),
    programsOf: app => programsOf(app, LAUNCHERS.win32),
    appKey: s => lower(s).replace(/\.exe$/, ""),
    forget() {
      cache = null;
    },
  };
}
