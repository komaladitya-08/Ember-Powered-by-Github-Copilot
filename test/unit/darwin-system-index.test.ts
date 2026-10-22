/**
 * The macOS SystemPlatform as a whole (design §9.7, §9.12): the macOS rows of the shared tables, where data lives and
 * how the settings window names it, the Copilot runtime's id, no system-log audit copy, gh found where Homebrew and
 * MacPorts put it (launchd's PATH has neither) and remembered for a minute, the lifecycle facts, and that building it
 * touches nothing of Electron's that only works after ready.
 */

import { describe, expect, it, vi } from "vitest";
import { GH_CACHE_MS, darwinSystem, extraBinDirs } from "../../app/main/platform/darwin/system";
import { PLATFORM_WORDS } from "../../app/shared/words";
import { KEYS, SHORTCUTS } from "../../app/shared/shortcuts";
import { fakeDeps, fakeElectron, fakeRun } from "./darwin-system-fakes";

const quiet = { run: fakeRun().run, every: () => {} };

describe("darwinSystem", () => {
  it("uses the macOS rows of the words, shortcuts and keys tables", () => {
    const s = darwinSystem(fakeDeps(fakeElectron().electron), quiet);
    expect(s.os).toBe("darwin");
    expect(s.words).toBe(PLATFORM_WORDS.darwin);
    expect(s.shortcuts).toBe(SHORTCUTS.darwin);
    expect(s.keys).toBe(KEYS.darwin);
  });

  it("keeps data in Application Support and shows it with the home folder as ~", () => {
    const s = darwinSystem(fakeDeps(fakeElectron().electron), { ...quiet, home: () => "/Users/ada" });
    expect(s.paths.userData("/Users/ada/Library/Application Support", "/Users/ada")).toBe("/Users/ada/Library/Application Support/ember");
    expect(s.paths.dataDirLabel("/Users/ada/Library/Application Support/ember")).toBe("~/Library/Application Support/ember");
    expect(s.paths.dataDirLabel("/Users/ada/Library/Application Support/ember", "settings.json")).toBe("~/Library/Application Support/ember/settings.json");
    expect(s.paths.dataDirLabel("/Volumes/Work/ember")).toBe("/Volumes/Work/ember");
    expect(s.paths.dataDirLabel("/Users/adam/ember")).toBe("/Users/adam/ember");
    expect(s.paths.renameRetries).toBe(0);
  });

  it("names the Copilot runtime for this Mac's architecture", () => {
    const s = darwinSystem(fakeDeps(fakeElectron().electron), quiet);
    expect(s.paths.runtimeId).toBe(`darwin-${process.arch}`);
    expect(s.paths.runtimeExe).toBe("copilot-runtime");
  });

  it("keeps the audit log in its file only, adds no Chromium switches and spawns helpers as they are", () => {
    const s = darwinSystem(fakeDeps(fakeElectron().electron), quiet);
    expect(s.auditSink(() => {})).toBeUndefined();
    expect(s.auditCopy()).toBeNull();
    expect(s.chromiumSwitches).toEqual([]);
    expect(s.spawnDefaults).toEqual({});
  });

  it("finds gh in Homebrew's folder although PATH lacks it, and remembers the answer for a minute", () => {
    let t = 0;
    let installed = new Set(["/opt/homebrew/bin/gh"]);
    const asked: string[] = [];
    const s = darwinSystem(fakeDeps(fakeElectron().electron, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }), {
      ...quiet, home: () => "/Users/ada", now: () => t, isExecutable: p => { asked.push(p); return installed.has(p); },
    });
    expect(s.ghCliPath()).toBe("/opt/homebrew/bin/gh");
    installed = new Set();
    t = GH_CACHE_MS - 1;
    expect(s.ghCliPath()).toBe("/opt/homebrew/bin/gh");
    t = GH_CACHE_MS + 1;
    expect(s.ghCliPath()).toBeNull();
    expect(asked).toContain("/usr/bin/gh");
    expect(asked).toContain("/Users/ada/.local/bin/gh");
  });

  it("prefers gh on PATH, then Homebrew, /usr/local, MacPorts and ~/.local in that order", () => {
    expect(extraBinDirs("/Users/ada")).toEqual(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/Users/ada/.local/bin"]);
    const s = darwinSystem(fakeDeps(fakeElectron().electron, { PATH: "/Users/ada/bin:/usr/bin" }), {
      ...quiet, home: () => "/Users/ada", isExecutable: p => p === "/Users/ada/bin/gh" || p === "/usr/local/bin/gh",
    });
    expect(s.ghCliPath()).toBe("/Users/ada/bin/gh");
    expect(s.which("gh")).toBe("/Users/ada/bin/gh");
  });

  it("has no speaker monitor, and looks for bundled speech models in the app and in /Library", () => {
    const s = darwinSystem(fakeDeps(fakeElectron().electron), quiet);
    expect(s.voice.speakerMonitor).toBe(false);
    expect(s.voice.bundledModelDirs("/Applications/Ember.app/Contents/Resources"))
      .toEqual(["/Applications/Ember.app/Contents/Resources/voice-models", "/Library/Application Support/Ember/voice-models"]);
  });

  it("states the macOS lifecycle facts", async () => {
    const e = fakeElectron();
    const s = darwinSystem(fakeDeps(e.electron), quiet);
    const l = s.lifecycle;
    expect({ id: l.appUserModelId, menu: l.appMenu, reopen: l.reopenShowsSettings, end: l.sessionEnd, own: l.activateOwnWithInput, ask: l.activateForAsk })
      .toEqual({ id: null, menu: true, reopen: true, end: "power-monitor-shutdown", own: false, ask: false });
    l.ensureShortcut();
    l.focusOwnApp();
    expect(e.app.focus).toHaveBeenCalledWith({ steal: true });
    expect(await l.askMicrophone!()).toBe(true);
    expect(e.systemPreferences.askForMediaAccess).toHaveBeenCalledWith("microphone");
    vi.mocked(e.systemPreferences.askForMediaAccess).mockRejectedValueOnce(new Error("no"));
    expect(await l.askMicrophone!()).toBe(false);
  });

  it("offers Dark Mode only, and the macOS policy location", () => {
    const s = darwinSystem(fakeDeps(fakeElectron().electron), quiet);
    expect(Object.keys(s.settings.available)).toEqual(["dark_style"]);
    expect(s.adminPolicy.location).toBe("/Library/Application Support/Ember/policy.json");
  });

  it("compares window app names in lower case", () => {
    const s = darwinSystem(fakeDeps(fakeElectron().electron), quiet);
    expect(s.apps.appKey("System Settings")).toBe("system settings");
  });

  it("is built without app.getPath or isAccessibilitySupportEnabled, and its probes never ask the latter", () => {
    const e = fakeElectron();
    const s = darwinSystem(fakeDeps(e.electron), quiet);
    expect(s.a11y.screenReaderOn()).toBe(false);
    expect(s.a11y.systemReducedMotion()).toBe(false);
    expect(e.app.getPath).not.toHaveBeenCalled();
    expect(e.app.isAccessibilitySupportEnabled).not.toHaveBeenCalled();
  });
});
