/**
 * The Windows app catalogue (win32/system/apps.ts) over an in-memory Start Menu: what is offered (shortcuts to
 * programs that exist, with their ids, names, words, argv and program names; packaged apps only when installed;
 * File Explorer always), what never is (shell items, non-programs, missing targets, uninstallers, Ember itself,
 * "Run as administrator" shortcuts, broken files), which source wins a clash, the walk's limits, the cache and its
 * early refresh, and launching: always through explorer.exe with the shortcut, the allowlisted environment and the
 * home folder, after checking again that the target is there and isn't a terminal.
 */

import { describe, expect, it } from "vitest";
import type { SpawnOptions } from "node:child_process";
import type { DesktopApp } from "../../app/main/hands/system";
import {
  appFromShortcut, CACHE_MS, FILE_EXPLORER, isUninstaller, MAX_DEPTH, MAX_SHORTCUTS, PACKAGED_APPS, packageFamily, packagedApp, win32Apps,
  type Win32AppsDeps,
} from "../../app/main/platform/win32/system/apps";
import { parseShellLink } from "../../app/main/platform/win32/system/lnk";
import { buildLnk, FakeFs, type LnkSpec } from "./win32-system-fakes";

const USER = "C:\\Users\\Ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs";
const COMMON = "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs";
const EXE = "C:\\Program Files\\Ember\\Ember.exe";

interface Spawned { command: string; args: string[]; options: SpawnOptions; unref: boolean; onError?: (err: Error) => void }

function setup(o: { packages?: Record<string, boolean | null>; env?: NodeJS.ProcessEnv; windows?: string | null } = {}) {
  const fs = new FakeFs();
  const spawned: Spawned[] = [];
  const warnings: { msg: string; fields?: unknown }[] = [];
  let clock = 1_000_000;
  const deps: Win32AppsDeps = {
    env: o.env ?? { SystemRoot: "C:\\Windows", windir: "C:\\Windows", Path: "C:\\Windows\\system32", GH_TOKEN: "secret", EMBER_LOG_LEVEL: "debug" },
    execPath: EXE,
    folders: { programs: () => USER, commonPrograms: () => COMMON, windowsDirectory: () => (o.windows === undefined ? "C:\\Windows" : o.windows) },
    packageInstalled: family => (o.packages ?? {})[family] ?? null,
    fs,
    spawn: (command, args, options) => {
      const s: Spawned = { command, args, options, unref: false };
      spawned.push(s);
      return { on: (_e: "error", fn: (err: Error) => void) => { s.onError = fn; }, unref: () => { s.unref = true; } };
    },
    homedir: () => "C:\\Users\\Ana",
    now: () => clock,
    log: () => ({ warn: (msg: string, fields?: unknown) => warnings.push({ msg, fields }) }) as never,
  };
  const lnk = (path: string, spec: LnkSpec, mtime = 1) => { fs.add(path, buildLnk(spec), mtime); if (spec.target && !spec.envTarget) fs.add(spec.target, "MZ"); return path; };
  return { fs, deps, spawned, warnings, lnk, tick: (ms: number) => { clock += ms; }, apps: () => win32Apps(deps) };
}

const byName = (apps: DesktopApp[], name: string) => apps.find(a => a.name === name);

describe("appFromShortcut", () => {
  const opts = { file: `${USER}\\Mozilla Firefox.lnk`, id: "Mozilla Firefox", env: { ProgramFiles: "C:\\Program Files" }, execPath: EXE, exists: () => true };

  it("makes a DesktopApp with argv, program and everyday words", () => {
    const link = parseShellLink(buildLnk({ target: "C:\\Program Files\\Mozilla Firefox\\firefox.exe", args: "-P \"work\" -no-remote", description: "Browse the Web" }));
    expect(appFromShortcut(link, opts)).toEqual({
      app: {
        id: "Mozilla Firefox", name: "Mozilla Firefox", file: `${USER}\\Mozilla Firefox.lnk`, keywords: ["web browser", "browse the web"], generic: "web browser",
        argv: ["C:\\Program Files\\Mozilla Firefox\\firefox.exe", "-P", "work", "-no-remote"], programs: ["firefox"],
      },
    });
  });

  it("expands a %VARIABLE% target", () => {
    const link = parseShellLink(buildLnk({ target: "C:\\Program Files\\App\\app.exe", envTarget: "%ProgramFiles%\\App\\app.exe" }));
    expect(appFromShortcut(link, opts)).toMatchObject({ app: { argv: ["C:\\Program Files\\App\\app.exe"], programs: ["app"] } });
  });

  it("gives an advertised shortcut no program names (its window is matched by title)", () => {
    const link = parseShellLink(buildLnk({ target: "C:\\Windows\\Installer\\{GUID}\\wordicon.exe", description: "Word", advertised: true }));
    expect(appFromShortcut(link, opts)).toMatchObject({ app: { programs: [], keywords: ["word"] } });
  });

  it("says why a shortcut isn't offered", () => {
    const v = (spec: LnkSpec, exists = true, name = "App.lnk") => {
      const r = appFromShortcut(parseShellLink(buildLnk(spec)), { ...opts, file: `${USER}\\${name}`, exists: () => exists });
      return "skip" in r ? r.skip : "offered";
    };
    expect(v({ description: "a shell item" })).toBe("no-target");
    expect(v({ target: "C:\\Docs\\readme.txt" })).toBe("not-a-program");
    expect(v({ target: "C:\\Gone\\gone.exe" }, false)).toBe("missing");
    expect(v({ target: "C:\\Program Files\\App\\unins000.exe" })).toBe("uninstaller");
    expect(v({ target: "C:\\Windows\\System32\\msiexec.exe", args: "/x {GUID}" })).toBe("uninstaller");
    expect(v({ target: "C:\\Program Files\\App\\app.exe" }, true, "Uninstall App.lnk")).toBe("uninstaller");
    expect(v({ target: "c:\\program files\\ember\\EMBER.EXE" })).toBe("ember");
    expect(v({ target: "C:\\Program Files\\App\\app.exe", runAsUser: true })).toBe("elevated");
    expect(v({ envTarget: "%NOPE%\\app.exe" })).toBe("missing");
    expect(v({ target: "relative\\app.exe" })).toBe("missing");
  });
});

describe("isUninstaller and packageFamily", () => {
  it("know uninstallers by name and by program", () => {
    expect(isUninstaller("Uninstall Foo", "C:\\Foo\\foo.exe")).toBe(true);
    expect(isUninstaller("Remove Foo", "C:\\Foo\\foo.exe")).toBe(true);
    expect(isUninstaller("Foo", "C:\\Foo\\uninst.exe")).toBe(true);
    expect(isUninstaller("Foo", "C:\\Foo\\Unins001.exe")).toBe(true);
    expect(isUninstaller("Foo Remover Pro", "C:\\Foo\\foo.exe")).toBe(false);
  });

  it("splits an AUMID's package family", () => {
    expect(packageFamily("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App")).toBe("Microsoft.WindowsCalculator_8wekyb3d8bbwe");
    expect(packageFamily("no-bang")).toBe("");
  });
});

describe("listing the Start Menu and packaged apps", () => {
  it("lists both Start Menus with ids below Programs, '/' separators and the user's own copy winning a clash", () => {
    const t = setup();
    t.lnk(`${USER}\\Accessories\\Notepad.lnk`, { target: "C:\\Windows\\System32\\notepad.exe", description: "Edit text" });
    t.lnk(`${COMMON}\\Notepad.lnk`, { target: "C:\\Other\\notepad.exe" });
    t.lnk(`${COMMON}\\Microsoft Edge.lnk`, { target: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" });
    const apps = t.apps().list();
    expect(byName(apps, "Notepad")).toMatchObject({ id: "Accessories/Notepad", file: `${USER}\\Accessories\\Notepad.lnk`, programs: ["notepad"], generic: "text editor" });
    expect(byName(apps, "Microsoft Edge")).toMatchObject({ id: "Microsoft Edge", generic: "web browser", keywords: ["web browser"] });
    expect(apps.filter(a => a.name === "Notepad")).toHaveLength(1);
  });

  it("reads shallower shortcuts first, so a top-level shortcut wins over a nested one of the same name", () => {
    const t = setup();
    t.lnk(`${USER}\\A\\Tool.lnk`, { target: "C:\\Nested\\tool.exe" });
    t.lnk(`${USER}\\Tool.lnk`, { target: "C:\\Top\\tool.exe" });
    expect(byName(t.apps().list(), "Tool")?.argv).toEqual(["C:\\Top\\tool.exe"]);
  });

  it("walks folders to depth 4 only and skips other files and broken shortcuts", () => {
    const t = setup();
    const deep = (n: number) => `${USER}${"\\D".repeat(n)}\\Depth${n}.lnk`;
    t.lnk(deep(MAX_DEPTH), { target: "C:\\A\\a.exe" });
    t.lnk(deep(MAX_DEPTH + 1), { target: "C:\\B\\b.exe" });
    t.fs.add(`${USER}\\desktop.ini`, "[.ShellClassInfo]");
    t.fs.add(`${USER}\\Broken.lnk`, Buffer.from("not a shortcut"));
    t.fs.add(`${USER}\\Huge.lnk`, Buffer.alloc(2 * 1024 * 1024));
    const names = t.apps().list().map(a => a.name);
    expect(names).toContain(`Depth${MAX_DEPTH}`);
    expect(names).not.toContain(`Depth${MAX_DEPTH + 1}`);
    expect(names).not.toContain("Broken");
    expect(names).not.toContain("Huge");
  });

  it(`reads at most ${MAX_SHORTCUTS} shortcuts`, () => {
    const t = setup();
    t.fs.add("C:\\Many\\many.exe", "MZ");
    for (let i = 0; i < MAX_SHORTCUTS + 5; i++) t.fs.add(`${USER}\\App ${String(i).padStart(4, "0")}.lnk`, buildLnk({ target: "C:\\Many\\many.exe" }));
    const apps = t.apps().list();
    expect(apps.filter(a => a.name.startsWith("App "))).toHaveLength(MAX_SHORTCUTS);
  });

  it("offers Settings always and other packaged apps only when their package is installed for this user", () => {
    const t = setup({ packages: { "Microsoft.WindowsCalculator_8wekyb3d8bbwe": true, "Microsoft.Paint_8wekyb3d8bbwe": false } });
    const apps = t.apps().list();
    expect(byName(apps, "Settings")).toEqual(packagedApp(PACKAGED_APPS[0]));
    expect(byName(apps, "Settings")).toMatchObject({
      id: "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel",
      file: "shell:AppsFolder\\windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel", argv: [], programs: ["systemsettings"],
    });
    expect(byName(apps, "Calculator")).toMatchObject({ programs: ["calculatorapp", "calculator"], generic: "calculator" });
    expect(byName(apps, "Paint")).toBeUndefined(); // not installed
    expect(byName(apps, "Photos")).toBeUndefined(); // can't tell: not offered
  });

  it("prefers a Start Menu shortcut to the packaged entry of the same name", () => {
    const t = setup({ packages: { "Microsoft.WindowsNotepad_8wekyb3d8bbwe": true } });
    t.lnk(`${USER}\\Notepad.lnk`, { target: "C:\\Windows\\notepad.exe" });
    expect(byName(t.apps().list(), "Notepad")?.file).toBe(`${USER}\\Notepad.lnk`);
  });

  it("adds File Explorer when no shortcut opens explorer.exe, and not otherwise", () => {
    const t = setup();
    expect(byName(t.apps().list(), "File Explorer")).toEqual(FILE_EXPLORER);
    const u = setup();
    u.lnk(`${USER}\\System Tools\\File Explorer.lnk`, { target: "C:\\Windows\\explorer.exe" });
    const apps = u.apps().list();
    expect(apps.filter(a => a.programs?.includes("explorer"))).toHaveLength(1);
    expect(byName(apps, "File Explorer")?.file).toBe(`${USER}\\System Tools\\File Explorer.lnk`);
  });

  it("copes with a Start Menu Windows won't name", () => {
    const t = setup();
    t.deps.folders = { programs: () => null, commonPrograms: () => null, windowsDirectory: () => "C:\\Windows" };
    expect(t.apps().list().map(a => a.name).sort()).toEqual(["File Explorer", "Settings"]);
  });
});

describe("the catalogue's cache", () => {
  it("keeps a listing until a Start Menu folder changes, reading only changed shortcuts again", () => {
    const t = setup();
    t.lnk(`${USER}\\One.lnk`, { target: "C:\\One\\one.exe" });
    const apps = t.apps();
    const first = apps.list();
    const reads = t.fs.reads.length;
    expect(apps.list()).toBe(first);
    expect(t.fs.reads.length).toBe(reads);
    t.lnk(`${USER}\\Two.lnk`, { target: "C:\\Two\\two.exe" });
    t.fs.touch(USER, 2);
    const second = apps.list();
    expect(second.map(a => a.name)).toContain("Two");
    expect(t.fs.reads.slice(reads)).toEqual([`${USER}\\Two.lnk`]);
  });

  it("lists again after five minutes", () => {
    const t = setup();
    const apps = t.apps();
    const first = apps.list();
    t.tick(CACHE_MS - 1);
    expect(apps.list()).toBe(first);
    t.tick(1);
    expect(apps.list()).not.toBe(first);
  });
});

describe("launching an app", () => {
  it("asks explorer.exe to open the shortcut, detached, from the home folder, with the allowlisted environment", () => {
    const t = setup();
    t.lnk(`${USER}\\Notepad.lnk`, { target: "C:\\Windows\\System32\\notepad.exe" });
    const apps = t.apps();
    apps.launch(byName(apps.list(), "Notepad")!);
    expect(t.spawned).toHaveLength(1);
    const s = t.spawned[0];
    expect(s.command).toBe("C:\\Windows\\explorer.exe");
    expect(s.args).toEqual([`${USER}\\Notepad.lnk`]);
    expect(s.options).toMatchObject({ detached: true, stdio: "ignore", cwd: "C:\\Users\\Ana" });
    expect(s.options.windowsHide).toBeUndefined(); // a GUI program: SW_HIDE could reach the app it opens
    expect(s.options.env).toEqual({ SystemRoot: "C:\\Windows", windir: "C:\\Windows", Path: "C:\\Windows\\system32" });
    expect(s.unref).toBe(true);
    s.onError!(new Error("spawn failed"));
    expect(t.warnings.map(w => w.msg)).toEqual(["apps.launch_failed"]);
  });

  it("opens a packaged app as shell:AppsFolder\\<AUMID>, and File Explorer as This PC", () => {
    const t = setup({ packages: { "Microsoft.WindowsCalculator_8wekyb3d8bbwe": true } });
    const apps = t.apps();
    const list = apps.list();
    apps.launch(byName(list, "Calculator")!);
    apps.launch(byName(list, "File Explorer")!);
    expect(t.spawned.map(s => s.args)).toEqual([["shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"], ["shell:MyComputerFolder"]]);
  });

  it("refuses terminals synchronously, by program, by name and by window class", () => {
    const t = setup({ packages: { "Microsoft.WindowsTerminal_8wekyb3d8bbwe": true } });
    t.lnk(`${USER}\\System Tools\\Command Prompt.lnk`, { target: "C:\\Windows\\System32\\cmd.exe" });
    t.lnk(`${USER}\\Windows PowerShell\\Windows PowerShell.lnk`, { target: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" });
    t.lnk(`${USER}\\Dev.lnk`, { target: "C:\\Windows\\System32\\cmd.exe", args: "/k vsdevcmd.bat" });
    const apps = t.apps();
    const list = apps.list();
    for (const name of ["Command Prompt", "Windows PowerShell", "Dev", "Terminal"]) {
      expect(() => apps.launch(byName(list, name)!), name).toThrow("Ember doesn't run terminals, on its desk or anywhere else");
    }
    expect(t.spawned).toEqual([]);
    expect(apps.isTerminalApp({ id: "x", name: "python", windowClass: "ConsoleWindowClass" })).toBe(true);
    expect(apps.isTerminalApp({ id: "x", name: "Notepad" })).toBe(false);
  });

  it("checks the shortcut again right before launching", () => {
    const t = setup();
    t.lnk(`${USER}\\Tool.lnk`, { target: "C:\\Tools\\tool.exe" });
    const apps = t.apps();
    const tool = byName(apps.list(), "Tool")!;
    t.fs.remove("C:\\Tools\\tool.exe");
    expect(() => apps.launch(tool)).toThrow("That app's shortcut points at a program that isn't there any more.");
    t.fs.add("C:\\Tools\\tool.exe", "MZ");
    t.fs.add(`${USER}\\Tool.lnk`, buildLnk({ target: "C:\\Windows\\System32\\cmd.exe" }), 2); // replaced by a shortcut to a terminal
    t.fs.add("C:\\Windows\\System32\\cmd.exe", "MZ");
    expect(() => apps.launch(tool)).toThrow("Ember doesn't run terminals");
    t.fs.remove(`${USER}\\Tool.lnk`);
    expect(() => apps.launch(tool)).toThrow("That app's shortcut isn't there any more.");
    expect(t.spawned).toEqual([]);
  });

  it("refuses a packaged app that was uninstalled, an app it doesn't know, and launching without Windows' folder", () => {
    const packages: Record<string, boolean | null> = { "Microsoft.Paint_8wekyb3d8bbwe": true };
    const t = setup({ packages });
    const apps = t.apps();
    const paint = byName(apps.list(), "Paint")!;
    packages["Microsoft.Paint_8wekyb3d8bbwe"] = false;
    expect(() => apps.launch(paint)).toThrow("That app isn't installed any more.");
    expect(() => apps.launch({ id: "x", name: "X", file: "C:\\Tools\\x.exe", keywords: [] })).toThrow("Ember can't open that app.");
    expect(() => apps.launch({ id: "Evil!App", name: "Evil", file: "shell:AppsFolder\\Evil!App", keywords: [] })).toThrow("Ember can't open that app.");
    const u = setup({ windows: null });
    const settings = byName(u.apps().list(), "Settings")!;
    expect(() => u.apps().launch(settings)).toThrow("Ember couldn't find Windows' own folder, so it can't open apps.");
    expect([...t.spawned, ...u.spawned]).toEqual([]);
  });
});

describe("matching windows to apps", () => {
  it("compares app names in lower case without .exe, and drops launcher programs", () => {
    const apps = setup().apps();
    expect(apps.appKey("Notepad.EXE")).toBe("notepad");
    expect(apps.appKey("ApplicationFrameHost")).toBe("applicationframehost");
    expect([...apps.programsOf({ id: "a", name: "A", file: "f", keywords: [], programs: ["javaw", "myapp"] })]).toEqual(["myapp"]);
  });
});
