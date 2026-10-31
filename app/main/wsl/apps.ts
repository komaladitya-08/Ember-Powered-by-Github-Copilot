/**
 * Launching WSLg's Linux apps from their Start Menu shortcuts (§4.8; owned by package WB). WSLg puts a shortcut to its
 * wslg.exe for every Linux app with a .desktop file; the Windows catalogue lists them but never starts one (wslg is a
 * refused program: it hands the rest of its command line to the distro's shell). Here such a shortcut is judged by what
 * it really runs: wslg.exe's own options are read strictly (wslgLaunch), every word after "--" must be a plain token (the
 * shell would read anything else as code: critique wsl-23), its distro must be a set-up WSL 2 distro not run as root, and
 * the Linux command it starts is judged with the Linux terminal vocabulary (wrappers and inline code followed). A
 * shortcut that passes is opened as the user would open it: explorer.exe with the .lnk (fixed argv), never wslg.exe
 * itself. Everything else is the Windows catalogue's own answer. Plain Node.
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import wpath from "node:path/win32";
import { DISTRO_NAME } from "../../shared/targets";
import { appEnv, isTerminalApp, type DesktopApp } from "../hands/system";
import { LAUNCHERS } from "../hands/terminals";
import type { Logger } from "../logger";
import type { AppCatalog, AppIdentity } from "../platform/types";
import { splitWindowsArgs } from "../platform/win32/system/argv";
import { expandEnvironmentStrings, LnkError, parseShellLink } from "../platform/win32/system/lnk";
import type { WslDistro, WslFacts, WslService } from "./types";

/** A word after "--" that no shell reads as anything but itself (no quote, $, `, ;&|<>(){}*?[]~!#, or blank inside). */
const TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** A shell variable assignment (NAME=value): before the command's first word, the shell sets it and runs what follows. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The words the distro's shell runs as the command (pure): `argv` without its leading NAME=value assignments, which
 * the shell reads as variables for the command, not as its program ("GDK_BACKEND=x11 gnome-terminal" runs
 * gnome-terminal). Empty when there are only assignments.
 */
export function commandWords(argv: readonly string[]): string[] {
  let i = 0;
  while (i < argv.length && ASSIGNMENT.test(argv[i])) i++;
  return argv.slice(i);
}
/** wslg.exe's program name. */
const WSLG = /^wslg(?:\.exe)?$/i;

/**
 * What a wslg.exe command line runs, read strictly (pure): only `wslg.exe [-d|--distribution <name>] [--cd <dir>|~] --
 * <argv…>` with a non-empty argv of plain tokens that runs a command (not only NAME=value assignments). -u/--user,
 * -e/--exec, --system, --shell-type, any other option, a missing "--" and any token with shell syntax give null ("Ember
 * can't tell exactly what this shortcut runs"). The
 * older shape (wslg.exe ~ -d D <cmd>) is not accepted until the wslg-probe job has recorded it. `argv[0]` is wslg.exe.
 */
export function wslgLaunch(argv: string[]): { distro: string | null; cwd: string | null; argv: string[] } | null {
  if (!Array.isArray(argv) || !argv.length || !WSLG.test(wpath.basename(argv[0] ?? ""))) return null;
  let distro: string | null = null, cwd: string | null = null;
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (a === "-d" || a === "--distribution") {
      const v = argv[++i];
      if (distro !== null || v === undefined || !DISTRO_NAME.test(v)) return null;
      distro = v;
    } else if (a === "--cd") {
      const v = argv[++i];
      if (cwd !== null || v === undefined || !v || v === "--" || /\p{Cc}/u.test(v)) return null;
      cwd = v;
    } else {
      return null;
    }
  }
  if (argv[i] !== "--") return null;
  const rest = argv.slice(i + 1);
  if (!rest.length || !rest.every(t => typeof t === "string" && TOKEN.test(t)) || !commandWords(rest).length) return null;
  return { distro, cwd, argv: rest };
}

/** Is `path` WSL's own wslg.exe (its install folder, or the Store WSL's package folder)? */
export function isWslLauncher(path: string): boolean {
  return /^[A-Za-z]:\\program files\\wsl\\wslg\.exe$/i.test(path.trim())
    || /^[A-Za-z]:\\program files\\windowsapps\\microsoftcorporationii\.windowssubsystemforlinux_[^\\]*\\(?:[^\\]+\\)*wslg\.exe$/i.test(path.trim());
}

/** A catalogue app opened by a shortcut to wslg.exe (whose, is checked on launch). */
export function isWslgShortcut(app: Pick<DesktopApp, "file" | "argv">): boolean {
  return /\.lnk$/i.test(app.file ?? "") && !!app.argv?.length && WSLG.test(wpath.basename(app.argv[0]));
}

/** Why a wslg.exe command line can't be opened with these facts, or null when it can (§4.8). */
export function wslgRefusal(argv: string[], facts: WslFacts | null): string | null {
  const p = wslgLaunch(argv);
  if (!p) return "Ember can't tell exactly what this shortcut runs";
  if (!facts?.installed) return "WSL isn't installed";
  const d = p.distro ? facts.distros.find(x => x.name.toLowerCase() === p.distro!.toLowerCase()) : facts.distros.find(x => x.isDefault);
  if (!d) return p.distro ? `the Linux distro ${p.distro} isn't installed` : "WSL has no default Linux distro Ember can use";
  if (d.tool) return `${d.name} is a tool's own distro`;
  if (d.needsSetup) return `Set up ${d.name} first: open it from the Start menu once.`;
  if (d.version !== 2) return `${d.name} runs on WSL 1, which can't show Linux apps`;
  if (d.defaultUid === 0) return "Ember doesn't use Linux apps of a distro that runs as root.";
  if (!facts.wslg.available) return facts.wslg.disabledByUser ? "WSLg is turned off (guiApplications=false)" : "Update WSL to use Linux apps with Ember: run `wsl --update` in PowerShell.";
  return null;
}

/**
 * Is the Linux command a terminal, a shell or an app with one built in (the Linux vocabulary, wrappers followed)? Judged
 * as the distro's shell runs it (its leading assignments skipped), and as written too (an extra refusal only).
 */
function linuxTerminal(app: Pick<DesktopApp, "id" | "name">, argv: string[]): boolean {
  return isTerminalApp({ id: app.id, name: app.name, argv: commandWords(argv) }, "linux") || isTerminalApp({ id: app.id, name: app.name, argv }, "linux");
}

/** The Linux program a window of this command reports (§4.5's app: an interpreter's script, else the program). */
function linuxProgram(all: string[]): string | null {
  const argv = commandWords(all);
  const prog = (argv[0] ?? "").slice((argv[0] ?? "").lastIndexOf("/") + 1).toLowerCase();
  const script = argv[1] && !argv[1].startsWith("-") ? argv[1].slice(argv[1].lastIndexOf("/") + 1).toLowerCase() : "";
  return (prog && LAUNCHERS.linux.test(prog) && script ? script : prog) || null;
}

/**
 * Whether the distro's default user is root, as the distro itself reports it (WslDistro.defaultUid is only what was
 * learned from inside it; the registry's hint never counts); null when it can't be told. A running distro is asked
 * without starting anything (WslService.defaultUid); a stopped one is started to read its set-up, as opening its app
 * would start it anyway (§4.8).
 */
export async function runsAsRoot(wsl: Pick<WslService, "defaultUid" | "runner">, d: Pick<WslDistro, "name" | "defaultUid" | "running">): Promise<boolean | null> {
  if (d.defaultUid !== null) return d.defaultUid === 0;
  try {
    if (d.running) {
      const uid = await wsl.defaultUid(d.name);
      if (uid !== null) return uid === 0;
    }
    const f = await wsl.runner(d.name).facts();
    return typeof f?.privileged === "boolean" ? f.privileged : null;
  } catch {
    return null; // couldn't read it (a timeout, no job host): not opened
  }
}

type SpawnLike = (command: string, args: string[], options: SpawnOptions) => { on(event: "error", fn: (err: Error) => void): unknown; unref(): void };

/** What withWslApps needs (main's are the defaults; tests pass their own). */
export interface WslAppsOptions {
  wsl: () => WslService | null;
  log: Logger;
  /** The user turned WSL on (default: yes when there is a WSL service). */
  on?: () => boolean;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => Buffer | null;
  spawn?: SpawnLike;
  homedir?: () => string;
}

/** The catalogue with WSLg's shortcuts judged by the Linux command they run, and opened through explorer.exe. */
export function withWslApps(apps: AppCatalog, o: { wsl: () => WslService | null; log: Logger } & Partial<WslAppsOptions>): AppCatalog {
  const env = o.env ?? process.env;
  const readFile = o.readFile ?? ((p: string) => { try { return fs.readFileSync(p); } catch { return null; } });
  const spawn = o.spawn ?? (nodeSpawn as unknown as SpawnLike);
  const homedir = o.homedir ?? os.homedir;
  let facts: WslFacts | null = null;
  let watching: WslService | null = null;
  const service = (): WslService | null => {
    let wsl: WslService | null;
    try {
      wsl = o.wsl();
    } catch {
      wsl = null;
    }
    if (wsl && wsl !== watching) {
      watching = wsl;
      try {
        wsl.onChange(f => { facts = f; });
      } catch { /* facts are asked for again on the next launch */ }
      wsl.facts().then(f => { facts = f; }, err => o.log.warn("wsl.apps_facts_failed", { err }));
    }
    return wsl;
  };
  const on = () => {
    try {
      return (o.on ? o.on() : true) && service() !== null;
    } catch {
      return false;
    }
  };
  /** The Linux command of a WSLg shortcut app, from the catalogue's argv (null: not one Ember can tell). */
  const parsed = (app: Pick<DesktopApp, "argv">) => (app.argv ? wslgLaunch(app.argv) : null);

  const isTerminal = (app: AppIdentity): boolean => {
    const full = app as AppIdentity & Partial<Pick<DesktopApp, "file">>;
    if (!full.argv || !isWslgShortcut({ file: full.file ?? "", argv: full.argv }) || !on()) return apps.isTerminalApp(app);
    const p = parsed(full);
    // A shortcut Ember can't read exactly, or whose distro it knows can't be used, is refused like a terminal.
    if (!p || (facts && wslgRefusal(full.argv, facts))) return true;
    // By the Linux command, and by the shortcut's name and id as Windows would read them (an extra refusal only).
    return linuxTerminal(app, p.argv) || apps.isTerminalApp({ id: app.id, name: app.name });
  };

  /** Starts a WSLg shortcut after checking it again from the file (never what the listing said). */
  const launchWslg = async (app: DesktopApp): Promise<void> => {
    const wsl = service();
    if (!wsl) throw new Error("Ember can't open Linux apps: WSL isn't available.");
    const bytes = readFile(app.file);
    if (!bytes) throw new Error("That app's shortcut isn't there any more.");
    let link;
    try {
      link = parseShellLink(bytes);
    } catch (err) {
      if (err instanceof LnkError) throw new Error("Ember can't open that shortcut.", { cause: err });
      throw err;
    }
    // Elevated, or an MSI-advertised one (Windows Installer, not the target read here, decides what it starts): never.
    if (!link.target || link.runAsUser || link.advertised) throw new Error("Ember can't open that shortcut.");
    const target = expandEnvironmentStrings(link.target, env);
    if (!isWslLauncher(target)) throw new Error("Ember can't open that shortcut: it doesn't start WSL's own launcher.");
    const argv = [target, ...splitWindowsArgs(link.arguments)];
    const fresh = await wsl.facts();
    facts = fresh;
    const why = wslgRefusal(argv, fresh);
    if (why) throw new Error(/[.!?]$/.test(why) ? why : `Ember can't open that app: ${why}.`);
    const p = wslgLaunch(argv)!;
    if (linuxTerminal(app, p.argv) || apps.isTerminalApp({ id: app.id, name: app.name })) throw new Error("Ember doesn't run terminals, on its desk or anywhere else");
    // Its default user as the distro itself says (L17, critique wsl-7): a uid not learned yet is asked for now (after the
    // checks that need nothing from the distro, so a stopped one is never started only to refuse its app).
    const d = (p.distro ? fresh.distros.find(x => x.name.toLowerCase() === p.distro!.toLowerCase()) : fresh.distros.find(x => x.isDefault))!;
    const root = await runsAsRoot(wsl, d);
    if (root === null) throw new Error(`Ember couldn't tell which user ${d.name} runs apps as, so it didn't open that app.`);
    if (root) throw new Error("Ember doesn't use Linux apps of a distro that runs as root.");
    const explorer = expandEnvironmentStrings("%SystemRoot%\\explorer.exe", env);
    if (!wpath.isAbsolute(explorer) || explorer.includes("%")) throw new Error("Ember couldn't find Windows' own folder, so it can't open apps.");
    // The shortcut as the Start menu would open it: Ember never starts wslg.exe (or the distro's shell) itself.
    const child = spawn(explorer, [app.file], { detached: true, stdio: "ignore", windowsHide: true, cwd: homedir(), env: appEnv(env, { os: "win32" }) });
    child.on("error", err => o.log.warn("wsl.apps_launch_failed", { err }));
    child.unref();
  };

  return {
    list: () => { if (on()) service(); return apps.list(); },
    find: (list, query) => apps.find(list, query),
    // A WSLg shortcut's launch returns a promise the worker waits for (its refusal is the tool's answer); every other
    // app is the catalogue's own, synchronous as before.
    launch: (app: DesktopApp) => (isWslgShortcut(app) && on() ? launchWslg(app) : apps.launch(app)),
    isTerminalApp: isTerminal,
    hasBuiltInShell: app => apps.hasBuiltInShell(app),
    programsOf: app => {
      const p = isWslgShortcut(app) && on() ? parsed(app) : null;
      if (!p) return apps.programsOf(app);
      const prog = linuxProgram(p.argv);
      const d = p.distro ?? facts?.distros.find(x => x.isDefault)?.name ?? null;
      // The windows it opens are named "wsl:<distro>:<program>" once identified (§4.5).
      return new Set(prog && d ? [apps.appKey(`wsl:${d}:${prog}`)] : []);
    },
    appKey: s => apps.appKey(s),
  };
}
