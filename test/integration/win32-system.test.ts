/**
 * Windows system integration (app/main/platform/win32/system and win32/platform.ts) on a real Windows desktop: the
 * system API binds and reads Windows' folders, the screen-reader flag, elevation and the session; every Start Menu
 * shortcut reads as WScript.Shell reads it; the catalogue lists Settings and File Explorer (Calculator only when its
 * package is registered, asked independently of Ember with Get-AppxPackage); Notepad opens through explorer.exe and
 * its window appears; an app opened through a shortcut gets Explorer's environment, never Ember's tokens or EMBER_*
 * variables; dark mode for apps goes round and is put back; no HKLM policy reads as "no policy"; autostart writes the
 * Run value named after the AUMID through real Electron and removes it again; the doctor's helper row names a real
 * PowerShell; and systemDialogOpen is false at rest.
 *
 * Skipped off Windows; with EMBER_WINSYS_TEST=1 it fails instead of skipping when Windows, koffi, Electron or Windows
 * PowerShell is missing. What this runner can't show (windows-2022 is Windows Server, elevated, UAC off, one screen)
 * is printed as "not testable on this runner: <reason>" from the facts CI exports (EMBER_CI_ELEVATED, EMBER_CI_LUA,
 * EMBER_CI_SERVER), never passed vacuously.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { DesktopApp } from "../../app/main/hands/system";
import type { ElectronParts, PlatformDeps, ScreenLike, SystemPlatform } from "../../app/main/platform/types";
import { openWin32Windows } from "../../app/main/platform/win32";
import { win32Platform } from "../../app/main/platform/win32/platform";
import { win32System } from "../../app/main/platform/win32/system";
import { appFromShortcut, MAX_DEPTH, packageFamily, PACKAGED_APPS } from "../../app/main/platform/win32/system/apps";
import { loadWin32System, win32SystemError, type Win32SysApi } from "../../app/main/platform/win32/system/ffi";
import { FOLDERID } from "../../app/main/platform/win32/system/known-folders";
import { expandEnvironmentStrings, parseShellLink, type ShellLink } from "../../app/main/platform/win32/system/lnk";
import { AUMID } from "../../app/main/platform/win32/system/lifecycle";
import { loginItem } from "../../app/main/platform/win32/system/autostart";
import { HKEY, readDword, readString, writeDword } from "../../app/main/platform/win32/system/registry";
import { APPS_USE_LIGHT_THEME, PERSONALIZE } from "../../app/main/platform/win32/system/settings";
import { POLICY_KEY } from "../../app/main/platform/win32/system/admin-policy";

const required = process.env.EMBER_WINSYS_TEST === "1";
const onWindows = process.platform === "win32";
const root = fileURLToPath(new URL("../../", import.meta.url));
const powershell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const RUN_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const same = (a: string, b: string) => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
const notTestable = (what: string, reason: string) => console.log(`not testable on this runner: ${what}: ${reason}`);
/** A runner fact CI exports (EMBER_CI_ELEVATED, EMBER_CI_LUA, EMBER_CI_SERVER): true, false, or null when not given. */
const ciFlag = (name: string): boolean | null => {
  const v = process.env[name] ?? "";
  return /^(1|true|yes)$/i.test(v) ? true : /^(0|false|no)$/i.test(v) ? false : null;
};

/** Polls `fn` until it gives something truthy, or fails after `ms` saying what was awaited. */
async function waitFor<T>(fn: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Runs a Windows PowerShell script (UTF-8 out) and returns its stdout. */
function ps(script: string, timeout = 60_000): string {
  return execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`], { encoding: "utf8", timeout, windowsHide: true });
}

const screen: ScreenLike = { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1 }), getAllDisplays: () => [] };

describe.skipIf(!onWindows && !required)("Windows system integration on a real desktop", () => {
  let api: Win32SysApi;
  let system: SystemPlatform;
  let tmp = "";
  const userData = () => path.join(tmp, "userData");
  const electron = {
    app: {
      isPackaged: false, getPath: (name: string) => (name === "userData" ? userData() : os.tmpdir()), getAppPath: () => root, getVersion: () => "0.0.0",
      isAccessibilitySupportEnabled: () => false, setLoginItemSettings: () => undefined, getLoginItemSettings: () => ({ openAtLogin: false }), focus: () => undefined,
    },
    screen, desktopCapturer: {}, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }), getMediaAccessStatus: () => "granted" },
    shell: { openExternal: async () => undefined }, powerMonitor: { on: () => undefined }, browserWindow: { getFocusedWindow: () => null },
  } as unknown as ElectronParts;
  const deps = (): PlatformDeps => ({
    electron, packaged: false, execPath: "C:\\NotEmber\\Ember.exe", appPath: root, resourcesPath: path.join(root, "resources"), env: process.env,
  });

  beforeAll(() => {
    if (!onWindows) throw new Error("EMBER_WINSYS_TEST=1, but this isn't Windows");
    const a = loadWin32System();
    if (!a) throw new Error(`the Windows system API didn't bind: ${String(win32SystemError)}`);
    api = a;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-winsys-"));
    system = win32System(deps());
    console.log(`runner facts: elevated=${process.env.EMBER_CI_ELEVATED ?? "?"} lua=${process.env.EMBER_CI_LUA ?? "?"} server=${process.env.EMBER_CI_SERVER ?? "?"} os=${os.release()}`);
  });

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads Windows' folders from Windows, not from the environment", () => {
    expect(same(api.windowsDirectory()!, process.env.SystemRoot!)).toBe(true);
    expect(same(api.systemDirectory()!, path.win32.join(process.env.SystemRoot!, "System32"))).toBe(true);
    for (const id of [FOLDERID.Programs, FOLDERID.CommonPrograms, FOLDERID.ProgramData]) {
      const dir = api.knownFolder(id);
      expect(dir, id).toBeTruthy();
      expect(fs.statSync(dir!).isDirectory(), dir!).toBe(true);
    }
  });

  it("reads the screen-reader flag, elevation and the session", () => {
    expect(typeof api.screenReader()).toBe("boolean");
    const elevated = api.elevated();
    expect(typeof elevated).toBe("boolean");
    if (ciFlag("EMBER_CI_ELEVATED") !== null) expect(elevated).toBe(ciFlag("EMBER_CI_ELEVATED"));
    const inputs = system.environment({ windows: undefined }) as ReturnType<SystemPlatform["environment"]> & { windows: { build: number; session: string; elevated: boolean; powershell: string } };
    console.log(`environment: ${JSON.stringify(inputs.windows)}`);
    expect(inputs.platform).toBe("win32");
    expect(inputs.windows.build).toBeGreaterThanOrEqual(17763);
    expect(inputs.windows.session).not.toBe("service"); // the desktop tests in this job prove the session is interactive
    expect(inputs.windows.elevated).toBe(elevated);
  });

  it("reads every Start Menu shortcut as WScript.Shell reads it", () => {
    const links: { file: string; link: ShellLink | null }[] = [];
    const walk = (dir: string, depth: number) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < MAX_DEPTH) walk(p, depth + 1);
        else if (e.isFile() && /\.lnk$/i.test(e.name)) {
          let link: ShellLink | null;
          try { link = parseShellLink(fs.readFileSync(p)); } catch { link = null; } // unreadable: counted as unread below
          links.push({ file: p, link });
        }
      }
    };
    for (const id of [FOLDERID.Programs, FOLDERID.CommonPrograms]) walk(api.knownFolder(id)!, 0);
    expect(links.length).toBeGreaterThan(0);
    const list = path.join(tmp, "links.txt");
    fs.writeFileSync(list, links.map(l => l.file).join("\n"), "utf8");
    const shell = JSON.parse(ps(`$s = New-Object -ComObject WScript.Shell; $o = @(Get-Content -Encoding UTF8 -LiteralPath '${list}' | ForEach-Object { $l = $s.CreateShortcut($_); [pscustomobject]@{ file = [string]$_; target = $l.TargetPath; args = $l.Arguments } }); ConvertTo-Json -Compress -InputObject $o`)) as { file: string; target: string; args: string }[];
    const mismatched: string[] = [], unread: string[] = [];
    for (const s of shell) {
      const mine = links.find(l => l.file === s.file)?.link ?? null;
      if (mine?.advertised) continue; // Windows Installer resolves those at launch: WScript and the file disagree by design
      if (!s.target) continue; // a shell item (Run, Control Panel): no file target either way
      if (!mine?.target) { unread.push(`${s.file} → ${s.target}`); continue; }
      const target = expandEnvironmentStrings(mine.target, process.env);
      if (!same(target, s.target) || mine.arguments !== s.args) mismatched.push(`${s.file}: lnk.ts ${target} ${mine.arguments} | WScript ${s.target} ${s.args}`);
    }
    console.log(`${shell.length} shortcuts compared; ${unread.length} without a target lnk.ts could read`);
    for (const u of unread) console.log(`unread: ${u}`);
    expect(mismatched).toEqual([]);
    expect(unread.filter(u => /\.exe$/i.test(u))).toEqual([]);
  });

  it("lists Settings and File Explorer, and Calculator only when its package is registered", () => {
    const apps = system.apps.list();
    console.log(`${apps.length} apps: ${apps.map(a => a.name).sort().join(", ")}`);
    expect(apps.find(a => a.name === "Settings")).toBeTruthy();
    expect(apps.find(a => a.programs?.includes("explorer"))).toBeTruthy();
    let registered: boolean | null = null;
    try {
      registered = ps("@(Get-AppxPackage -Name Microsoft.WindowsCalculator).Count").trim() !== "0";
    } catch (err) {
      notTestable("Calculator's registration", `Get-AppxPackage failed: ${String(err)}`);
    }
    if (registered !== null) expect(!!apps.find(a => a.name === "Calculator" && a.file.startsWith("shell:AppsFolder\\"))).toBe(registered);
    if (registered === false) notTestable("opening a packaged Calculator", "its package isn't registered (Windows Server has the classic one)");
    for (const p of PACKAGED_APPS) console.log(`package ${packageFamily(p.aumid)}: ${String(api.packageFamilyInstalled(packageFamily(p.aumid)))}`);
    expect(api.packageFamilyInstalled(packageFamily(PACKAGED_APPS[0].aumid))).toBe(true); // Settings is part of Windows
  });

  it("opens Notepad through explorer.exe and its window appears", async () => {
    const notepad = system.apps.list().find(a => a.name === "Notepad");
    if (!notepad) throw new Error("no Notepad in the catalogue");
    const ws = openWin32Windows({ screen });
    if (!ws) throw new Error("port/win32's window system didn't open");
    const before = new Set(ws.clientWindows().filter(w => w.wmClass === "notepad").map(w => w.pid));
    system.apps.launch(notepad);
    const opened = await waitFor(() => ws.clientWindows().find(w => w.wmClass === "notepad" && w.pid !== null && !before.has(w.pid)), 20_000, "Notepad's window");
    console.log(`Notepad opened: pid ${opened.pid}, "${opened.title}"`);
    try { process.kill(opened.pid!); } catch { /* already closed */ }
    ws.close();
    if (ciFlag("EMBER_CI_ELEVATED") === true || ciFlag("EMBER_CI_LUA") === false) notTestable("an app opened while Ember is elevated starts non-elevated", "the runner runs elevated with UAC off, so Explorer is elevated too");
  }, 60_000);

  it("gives an app opened through a shortcut Explorer's environment, never Ember's tokens or EMBER_* variables", async () => {
    const script = path.join(tmp, "probe.cjs");
    const out = path.join(tmp, "env.json");
    fs.writeFileSync(script, `require("fs").writeFileSync(process.argv[2], JSON.stringify(Object.keys(process.env)));`);
    const lnk = path.join(tmp, "Ember Environment Probe.lnk");
    ps(`$l = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}'); $l.TargetPath = '${process.execPath}'; $l.Arguments = '"${script}" "${out}"'; $l.Save()`);
    const verdict = appFromShortcut(parseShellLink(fs.readFileSync(lnk)), { file: lnk, id: "probe", env: process.env, execPath: "C:\\NotEmber\\Ember.exe", exists: fs.existsSync });
    if (!("app" in verdict)) throw new Error(`the probe shortcut wasn't offered: ${verdict.skip}`);
    const marker = process.env.EMBER_WINSYS_MARKER, token = process.env.GH_TOKEN;
    process.env.EMBER_WINSYS_MARKER = "1";
    process.env.GH_TOKEN = "gho_ember_test_token";
    try {
      win32System(deps()).apps.launch(verdict.app as DesktopApp);
    } finally {
      if (marker === undefined) delete process.env.EMBER_WINSYS_MARKER; else process.env.EMBER_WINSYS_MARKER = marker;
      if (token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = token;
    }
    await waitFor(() => fs.existsSync(out) && fs.statSync(out).size > 0, 30_000, "the probe's environment");
    const keys = JSON.parse(fs.readFileSync(out, "utf8")) as string[];
    expect(keys.filter(k => /^(EMBER_|GH_|GITHUB_|COPILOT_)|_TOKEN$/i.test(k))).toEqual([]);
    expect(keys.some(k => k.toUpperCase() === "PATH")).toBe(true);
  }, 60_000);

  it("turns dark mode for apps on and off and puts it back", async () => {
    const original = readDword(api, HKEY.CURRENT_USER, PERSONALIZE, APPS_USE_LIGHT_THEME);
    if (!original.ok) {
      expect(original.error).toBe("not-found");
      await expect(system.settings.change("dark_style", "on")).rejects.toThrow("Dark mode for apps is not available on this computer");
      notTestable("the dark mode round trip", "AppsUseLightTheme isn't set for this user");
      return;
    }
    const dark = original.value === 0;
    try {
      expect(await system.settings.change("dark_style", dark ? "off" : "on")).toEqual({ before: String(dark), after: String(!dark) });
      expect(readDword(api, HKEY.CURRENT_USER, PERSONALIZE, APPS_USE_LIGHT_THEME)).toEqual({ ok: true, value: dark ? 1 : 0 });
      expect(await system.settings.change("dark_style", dark ? "on" : "off")).toEqual({ before: String(!dark), after: String(dark) });
    } finally {
      writeDword(api, HKEY.CURRENT_USER, PERSONALIZE, APPS_USE_LIGHT_THEME, original.value);
    }
    expect(readDword(api, HKEY.CURRENT_USER, PERSONALIZE, APPS_USE_LIGHT_THEME)).toEqual({ ok: true, value: original.value });
  });

  it("reads no HKLM policy as no policy", () => {
    const present = readString(api, HKEY.LOCAL_MACHINE, POLICY_KEY, "PolicyJson");
    if (present.ok || present.error !== "not-found") {
      notTestable("the absent policy", `HKLM\\${POLICY_KEY} PolicyJson is ${present.ok ? "set" : present.error} here`);
      return;
    }
    const loaded = system.adminPolicy.load();
    expect(loaded.source).toBeNull();
    expect(loaded.error).toBeUndefined();
  });

  it("writes the Run value named after the AUMID through Electron, and removes it again", async () => {
    const require = createRequire(import.meta.url);
    const electronExe = require("electron") as unknown as string;
    if (!fs.existsSync(electronExe)) throw new Error(`Electron isn't installed (${electronExe})`);
    const { build } = await import("esbuild");
    const bundle = path.join(tmp, "autostart.cjs");
    await build({ entryPoints: [path.join(root, "app/main/platform/win32/system/autostart.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" });
    const appPath = path.join(tmp, "Ember Test App");
    fs.mkdirSync(appPath, { recursive: true });
    const main = path.join(tmp, "autostart-main.cjs");
    fs.writeFileSync(main, `
const { app } = require("electron");
const fs = require("fs");
const [mode, out, bundle, appPath, aumid] = process.argv.slice(-5);
app.setAppUserModelId(aumid);
app.whenReady().then(() => {
  const { win32Autostart, loginItem } = require(bundle);
  const o = { app, packaged: false, execPath: process.execPath, appPath };
  const item = loginItem(o);
  // "read" only asks, as Ember does at start (the settings window's note); "on" and "off" sync as Ember does.
  const changed = mode === "read" ? null : win32Autostart(o).sync(mode === "on");
  fs.writeFileSync(out, JSON.stringify({ changed, settings: app.getLoginItemSettings({ path: item.path, args: item.args }) }));
  app.exit(0);
});`);
    /** Each Electron start in order, with how it ended: a crash (an exit code like 0xC0000005) is evidence, kept. */
    const steps: string[] = [];
    const once = (mode: "on" | "off" | "read") => new Promise<{ changed: boolean | null; settings: { openAtLogin: boolean } }>((resolve, reject) => {
      const out = path.join(tmp, `autostart-${mode}-${Date.now()}.json`);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE; // Electron itself, not Node
      const child = spawn(electronExe, [main, mode, out, bundle, appPath, AUMID], { stdio: "inherit", env });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Electron (${mode}) didn't finish within 60 s`)); }, 60_000);
      child.on("exit", code => {
        clearTimeout(timer);
        steps.push(`${mode}: exit ${code === null ? "signal" : `0x${(code >>> 0).toString(16)}`}`);
        if (code !== 0 || !fs.existsSync(out)) reject(new Error(`Electron (${mode}) exited with 0x${((code ?? 0) >>> 0).toString(16)}`));
        else resolve(JSON.parse(fs.readFileSync(out, "utf8")));
      });
    });
    /** A start that crashed is tried once more after 3 s, so the log tells a crash at start-up from one in the call. */
    const run = async (mode: "on" | "off" | "read") => {
      try {
        return await once(mode);
      } catch (err) {
        await sleep(3_000);
        const again = await once(mode).then(r => `then worked: ${JSON.stringify(r)}`, (e: Error) => `then failed again: ${e.message}`);
        throw new Error(`${(err as Error).message}, ${again}; steps: ${steps.join(", ")}`, { cause: err });
      }
    };
    const runValue = () => readString(api, HKEY.CURRENT_USER, RUN_KEY, AUMID);
    try {
      expect(await run("on")).toEqual({ changed: true, settings: expect.objectContaining({ openAtLogin: true }) });
      const value = runValue();
      expect(value.ok).toBe(true);
      const item = loginItem({ packaged: false, execPath: electronExe, appPath });
      console.log(`Run\\${AUMID} = ${value.ok ? value.value : "?"}`);
      if (value.ok) {
        expect(value.value.toLowerCase()).toContain(electronExe.toLowerCase());
        // Electron quotes an argument with a space itself: the app folder appears once, quoted once.
        expect(value.value).toContain(item.args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" "));
        expect(value.value).not.toContain('\\"');
      }
      // A new Ember asks first (the settings window's note): it reads the value another Ember wrote.
      expect(await run("read")).toEqual({ changed: null, settings: expect.objectContaining({ openAtLogin: true }) });
      expect((await run("on")).changed).toBe(false); // in step: not written again
      expect(await run("off")).toEqual({ changed: true, settings: expect.objectContaining({ openAtLogin: false }) });
      expect(runValue()).toMatchObject({ ok: false, error: "not-found" });
      expect((await run("off")).changed).toBe(false);
    } finally {
      console.log(`autostart steps: ${steps.join(", ")}`);
      if (runValue().ok) await once("off").catch(() => undefined);
    }
  }, 300_000);

  it("names a real PowerShell and the helper's script in the doctor's helper row", async () => {
    const probes = await system.doctorProbes();
    for (const r of probes.extra) console.log(`doctor: ${r.status} ${r.label}: ${r.detail}`);
    const row = probes.extra.find(r => r.id === "helper-command");
    expect(row).toBeTruthy();
    expect(fs.existsSync(powershell)).toBe(true);
    expect(row!.detail.toLowerCase()).toContain(powershell.toLowerCase());
    expect(row!.detail).toContain(path.win32.join(root, "sidecar", "uia", "ember_uia.ps1"));
  });

  it("says no system dialog is open on the desktop at rest", () => {
    const platform = win32Platform(deps());
    const log = { debug() {}, info() {}, warn() {}, error(msg: string, f?: unknown) { throw new Error(`${msg} ${JSON.stringify(f)}`); }, child() { return log; }, file: "" } as never;
    const ws = platform.openWindows(log);
    if (!ws) throw new Error("the window system didn't open");
    try {
      const active = ws.activeWindow();
      if (active) expect(api.monitorRect(active.id)?.width ?? 0).toBeGreaterThan(0);
      expect(ws.systemDialogOpen?.()).toBe(false);
    } finally {
      ws.close();
    }
  });
});
