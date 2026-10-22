/**
 * The smaller Windows pieces: where data lives and how the settings window names it, the runtime's ids, which() and
 * the gh lookup (PATH read case-insensitively, quotes stripped, .exe/.com only, winget/Scoop/Chocolatey folders after
 * PATH, kept a minute), the bundled speech-model folders, the screen-reader probe (asked once a minute, never
 * Chromium's own flag), reduced motion, the life cycle, and the Start Menu shortcut toasts need. Also the interim
 * copies of Phase 1's helpers the composition uses (withSystemDialog, hostEnv, hoverShaper, the clipboard row).
 */

import { describe, expect, it } from "vitest";
import type { WindowSystem } from "../../app/main/platform/types";
import { SCREEN_READER_MS, win32A11y } from "../../app/main/platform/win32/system/a11y";
import { AUMID, ensureShortcut, win32Lifecycle, type ShortcutDeps } from "../../app/main/platform/win32/system/lifecycle";
import { bundledModelDirs, defaultUserData, GH_CACHE_MS, ghCandidates, win32Paths, win32Which } from "../../app/main/platform/win32/system/paths";
import { cleanEnv, CLIPBOARD_FORMATS_WIN32, hostEnv, hoverShaper, which, withSystemDialog } from "../../app/main/platform/win32/system/interim";
import { buildLnk, FakeFs, fakeApi } from "./win32-system-fakes";

const ENV = { LOCALAPPDATA: "C:\\Users\\Ana\\AppData\\Local", ProgramFiles: "C:\\Program Files", USERPROFILE: "C:\\Users\\Ana", Path: "C:\\Windows\\system32;\"C:\\Tools\\bin\";relative\\dir" };

describe("Windows paths", () => {
  it("keeps data in %LOCALAPPDATA%\\ember, not the roaming profile", () => {
    const p = win32Paths({ env: ENV, arch: "x64" });
    expect(p.userData("C:\\Users\\Ana\\AppData\\Roaming", "C:\\Users\\Ana")).toBe("C:\\Users\\Ana\\AppData\\Local\\ember");
    expect(defaultUserData({}, "C:\\Users\\Bo")).toBe("C:\\Users\\Bo\\AppData\\Local\\ember");
    expect(defaultUserData({ localappdata: "D:\\Local" }, "C:\\Users\\Bo")).toBe("D:\\Local\\ember");
  });

  it("names the default data folder %LOCALAPPDATA%\\ember and any other by its path", () => {
    const p = win32Paths({ env: ENV });
    expect(p.dataDirLabel("C:\\Users\\Ana\\AppData\\Local\\ember")).toBe("%LOCALAPPDATA%\\ember");
    expect(p.dataDirLabel("c:\\users\\ana\\appdata\\local\\EMBER", "settings.json")).toBe("%LOCALAPPDATA%\\ember\\settings.json");
    expect(p.dataDirLabel("D:\\Throwaway", "settings.json")).toBe("D:\\Throwaway\\settings.json");
  });

  it("uses the Windows runtime and retries renames refused by antivirus or sync locks", () => {
    const p = win32Paths({ env: ENV, arch: "arm64" });
    expect([p.runtimeId, p.runtimeExe, p.renameRetries]).toEqual(["win32-arm64", "copilot-runtime.exe", 5]);
  });

  it("looks for bundled speech models beside Ember, then in ProgramData", () => {
    expect(bundledModelDirs("C:\\Ember\\resources", "C:\\ProgramData")).toEqual(["C:\\Ember\\resources\\voice-models", "C:\\ProgramData\\Ember\\voice-models"]);
    expect(bundledModelDirs("C:\\Ember\\resources", null)).toEqual(["C:\\Ember\\resources\\voice-models"]);
  });
});

describe("which and the gh lookup on Windows", () => {
  it("finds .exe then .com on PATH (case-insensitive name, quotes stripped, relative entries ignored), never .cmd or .bat", () => {
    const files = new Set(["C:\\Tools\\bin\\gh.exe", "C:\\Windows\\system32\\tool.com", "C:\\Windows\\system32\\npm.cmd", "relative\\dir\\evil.exe"]);
    const isFile = (p: string) => files.has(p);
    expect(which("gh", { os: "win32", env: ENV, isExecutable: isFile })).toBe("C:\\Tools\\bin\\gh.exe");
    expect(which("tool", { os: "win32", env: ENV, isExecutable: isFile })).toBe("C:\\Windows\\system32\\tool.com");
    expect(which("npm", { os: "win32", env: ENV, isExecutable: isFile })).toBeNull();
    expect(which("evil", { os: "win32", env: ENV, isExecutable: isFile })).toBeNull();
    expect(which("gh.exe", { os: "win32", env: { PATH: "C:\\Tools\\bin" }, isExecutable: isFile })).toBe("C:\\Tools\\bin\\gh.exe");
  });

  it("tries winget, Scoop and Chocolatey after PATH, in order", () => {
    expect(ghCandidates(ENV, "C:\\ProgramData")).toEqual([
      "C:\\Program Files\\GitHub CLI\\gh.exe", "C:\\Users\\Ana\\AppData\\Local\\Microsoft\\WinGet\\Links\\gh.exe",
      "C:\\Users\\Ana\\scoop\\shims\\gh.exe", "C:\\ProgramData\\chocolatey\\bin\\gh.exe",
    ]);
    expect(ghCandidates({}, null)).toEqual([]);
  });

  it("keeps the gh answer for a minute (the sign-in loop asks every 3 s)", () => {
    const files = new Set(["C:\\Users\\Ana\\scoop\\shims\\gh.exe"]);
    let clock = 0;
    let asked = 0;
    const w = win32Which({ env: { ...ENV, Path: "" }, programData: () => "C:\\ProgramData", isFile: p => { asked++; return files.has(p); }, now: () => clock });
    expect(w.ghCliPath()).toBe("C:\\Users\\Ana\\scoop\\shims\\gh.exe");
    const n = asked;
    files.clear();
    clock = GH_CACHE_MS - 1;
    expect(w.ghCliPath()).toBe("C:\\Users\\Ana\\scoop\\shims\\gh.exe");
    expect(asked).toBe(n);
    clock = GH_CACHE_MS;
    expect(w.ghCliPath()).toBeNull();
  });
});

describe("Windows accessibility probes", () => {
  it("asks SPI_GETSCREENREADER at most once a minute, and says no when it can't ask", () => {
    let on: boolean | null = true;
    let calls = 0;
    let clock = 0;
    const a = win32A11y({ api: () => fakeApi(undefined, { screenReader: () => { calls++; return on; } }), systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) }, now: () => clock });
    expect(a.screenReaderOn()).toBe(true);
    on = false;
    clock = SCREEN_READER_MS - 1;
    expect(a.screenReaderOn()).toBe(true);
    clock = SCREEN_READER_MS;
    expect(a.screenReaderOn()).toBe(false);
    expect(calls).toBe(2);
    on = null;
    clock *= 3;
    expect(a.screenReaderOn()).toBe(false);
    expect(win32A11y({ api: () => null, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: true }) } }).screenReaderOn()).toBe(false);
  });

  it("reads reduced motion from Windows' animation setting, false when Electron can't say", () => {
    expect(win32A11y({ api: () => null, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: true }) } }).systemReducedMotion()).toBe(true);
    expect(win32A11y({ api: () => null, systemPreferences: { getAnimationSettings: () => { throw new Error("no"); } } }).systemReducedMotion()).toBe(false);
  });
});

describe("the Windows life cycle", () => {
  it("has Ember's AppUserModelId, hears the session end on its windows, and activates its windows through input", () => {
    const l = win32Lifecycle({ packaged: true, execPath: "C:\\Ember\\Ember.exe", programs: () => null, shell: {} });
    expect(l).toMatchObject({
      appUserModelId: "io.github.komaladitya08.ember", appMenu: false, reopenShowsSettings: false, sessionEnd: "window-session-end",
      activateOwnWithInput: true, activateForAsk: true,
    });
    expect(l.askMicrophone).toBeUndefined();
    expect(() => l.focusOwnApp()).not.toThrow();
  });
});

describe("ensureShortcut", () => {
  const PROGRAMS = "C:\\Users\\Ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs";
  const EXE = "C:\\Ember\\Ember.exe";
  const run = (o: { packaged?: boolean; existing?: Buffer; writes?: boolean; programs?: string | null; writer?: boolean; throws?: boolean } = {}) => {
    const fs = new FakeFs();
    if (o.existing) fs.add(`${PROGRAMS}\\Ember.lnk`, o.existing);
    const written: unknown[][] = [];
    const warned: unknown[] = [];
    const d: ShortcutDeps = {
      packaged: o.packaged ?? true, execPath: EXE, programs: () => (o.programs === undefined ? PROGRAMS : o.programs), fs,
      shell: o.writer === false ? {} : { writeShortcutLink: (...a: unknown[]) => { if (o.throws) throw new Error("COM failed"); written.push(a); return o.writes ?? true; } },
      log: () => ({ warn: (msg: string, fields: unknown) => warned.push([msg, fields]) }) as never,
    };
    expect(() => ensureShortcut(d)).not.toThrow();
    return { written, warned };
  };

  it("creates Ember.lnk with Ember's AUMID when there is none (packaged only)", () => {
    expect(run().written).toEqual([[`${PROGRAMS}\\Ember.lnk`, "create", { target: EXE, appUserModelId: AUMID, description: "Ember" }]]);
    expect(run({ packaged: false }).written).toEqual([]);
  });

  it("leaves a shortcut that already opens this Ember with its AUMID, and replaces one that doesn't", () => {
    expect(run({ existing: buildLnk({ target: "c:\\ember\\EMBER.exe", aumid: AUMID }) }).written).toEqual([]);
    expect(run({ existing: buildLnk({ target: "C:\\Old\\Ember.exe", aumid: AUMID }) }).written[0]?.[1]).toBe("replace");
    expect(run({ existing: buildLnk({ target: EXE }) }).written[0]?.[1]).toBe("replace");
    expect(run({ existing: Buffer.from("broken") }).written[0]?.[1]).toBe("replace");
  });

  it("logs platform.shortcut_failed instead of throwing", () => {
    expect(run({ writes: false }).warned).toEqual([["platform.shortcut_failed", { reason: "Windows refused to write the shortcut" }]]);
    expect(run({ programs: null }).warned).toEqual([["platform.shortcut_failed", { reason: "no Start Menu folder" }]]);
    expect(run({ writer: false }).warned).toEqual([["platform.shortcut_failed", { reason: "no shortcut writer" }]]);
    expect((run({ throws: true }).warned[0] as unknown[])[0]).toBe("platform.shortcut_failed");
  });
});

describe("the interim Phase 1 helpers the composition uses", () => {
  it("withSystemDialog answers the check and keeps the backend's extras bound to the backend", () => {
    const backend = {
      kind: "win32", count: 0,
      activate(this: { count: number }) { this.count++; return this.count; },
    } as unknown as WindowSystem & { count: number; activate(): number };
    let open = false;
    const ws = withSystemDialog(backend, () => open);
    expect(ws.systemDialogOpen()).toBe(false);
    open = true;
    expect(ws.systemDialogOpen()).toBe(true);
    const activate = ws.activate;
    expect(activate()).toBe(1); // still bound to the backend
    expect(backend.count).toBe(1);
    expect(ws.kind).toBe("win32");
    expect("systemDialogOpen" in ws).toBe(true);
  });

  it("cleanEnv and hostEnv drop tokens and Ember's variables case-insensitively on Windows", () => {
    const env = { Path: "C:\\Windows", gh_token: "t", Copilot_Token: "c", EMBER_LOG_LEVEL: "debug", Ember_User_Data: "x", Node_Options: "--inspect", __PSLockdownPolicy: "4", EMBER_AX_PROVIDER: "fake" };
    expect(cleanEnv(env, { os: "win32" })).toEqual({ Path: "C:\\Windows", EMBER_LOG_LEVEL: "debug", __PSLockdownPolicy: "4" });
    expect(hostEnv(env, { os: "win32", packaged: false, ownerPid: 42 })).toEqual({ Path: "C:\\Windows", EMBER_LOG_LEVEL: "debug", __PSLockdownPolicy: "4", EMBER_AX_PROVIDER: "fake", EMBER_OWNER_PID: "42" });
    expect(hostEnv(env, { os: "win32", packaged: true, ownerPid: 42 })).not.toHaveProperty("EMBER_AX_PROVIDER");
  });

  it("hoverShaper gives Windows tool windows, no input region, no forwarding and no all-workspaces call", () => {
    const s = hoverShaper("win32");
    expect(s.setInputRegion({ getNativeWindowHandle: () => Buffer.alloc(8), getMediaSourceId: () => "" }, [], 1)).toBe(false);
    expect(s.forward).toBe(false);
    for (const kind of ["overlay", "handle", "ask"] as const) expect(s.floating(kind)).toEqual({ options: { type: "toolbar", thickFrame: false, roundedCorners: false }, allWorkspaces: null });
    expect(s.floating("desk-view")).toEqual({ options: {}, allWorkspaces: null });
  });

  it("the Windows clipboard row treats Windows password managers' markers as passwords", () => {
    for (const marker of ["ExcludeClipboardContentFromMonitorProcessing", "Clipboard Viewer Ignore", 'electron application/osclipboard;format="Clipboard Viewer Ignore"']) {
      expect(CLIPBOARD_FORMATS_WIN32.passwordMarker(marker), marker).toBe(true);
    }
    expect(CLIPBOARD_FORMATS_WIN32.passwordMarker("text/plain")).toBe(false);
    expect(CLIPBOARD_FORMATS_WIN32.savable("text/plain")).toBe(true);
  });
});
