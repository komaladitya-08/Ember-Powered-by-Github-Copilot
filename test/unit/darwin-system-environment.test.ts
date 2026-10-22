/**
 * The macOS setup-check inputs, fixes and doctor rows (design §9.8, §9.9) over fake Electron parts and a fake
 * window system: EnvInputs.mac reads each permission (the window system's answers first, Input Monitoring only
 * through FX-PD's extra, fail closed when a read throws), each fix does the one thing that lists Ember in its
 * pane and then opens that pane, and every permission's doctor advice ends with the "remove and add again" sentence.
 */

import { describe, expect, it, vi } from "vitest";
import { BUNDLE_ID, DARWIN_FIXES, GRAB_WAIT_MS, darwinEnvironment, darwinFixes, type DarwinEnvDeps } from "../../app/main/platform/darwin/system/environment";
import { PANES, REGRANT, macVersionFromDarwin, readPermissions } from "../../app/main/platform/darwin/system/permissions";
import { darwinDoctorProbes, darwinDoctorRows } from "../../app/main/platform/darwin/system/doctor";
import { SHORTCUTS } from "../../app/shared/shortcuts";
import type { WindowSystem } from "../../app/main/platform/types";
import { fakeDarwinWindows, fakeElectron, fakeRun, tool } from "./darwin-system-fakes";

function deps(o: { ws?: WindowSystem | null; electron?: Parameters<typeof fakeElectron>[0]; run?: DarwinEnvDeps["run"]; uid?: number; version?: string } = {}) {
  const e = fakeElectron(o.electron);
  const d: DarwinEnvDeps = {
    env: { HOME: "/Users/ada" },
    app: e.app, systemPreferences: e.systemPreferences, desktopCapturer: e.desktopCapturer, shell: e.shell,
    windows: () => o.ws, run: o.run,
    uid: () => o.uid ?? 501, systemVersion: () => o.version ?? "15.1",
  };
  return { d, e };
}

describe("darwinEnvironment", () => {
  it("gives the common inputs and the mac block, with the macOS shortcuts", () => {
    const { d } = deps({ ws: fakeDarwinWindows({ inputMonitoring: true }) });
    const i = darwinEnvironment(d, { windows: undefined, shortcutsTaken: ["Control+Shift+Command+Space"] });
    expect(i.osRelease).toBeNull();
    expect(i.glibc).toBeNull();
    expect(i.platform).toBe(process.platform);
    expect(i.versions.node).toBe(process.versions.node);
    expect(i.shortcuts).toBe(SHORTCUTS.darwin);
    expect(i.shortcutsTaken).toEqual(["Control+Shift+Command+Space"]);
    expect(i.mac).toEqual({ version: "15.1", accessibility: true, screen: "granted", microphone: "not-determined", inputMonitoring: true, inApplications: true, root: false });
  });

  it("reads the opened window system's answers first, and Electron's before it opened", () => {
    const { d, e } = deps({ ws: fakeDarwinWindows({ trusted: false }) });
    expect(darwinEnvironment(d, { windows: undefined }).mac?.accessibility).toBe(false);
    expect(e.systemPreferences.isTrustedAccessibilityClient).not.toHaveBeenCalled();
    // ctx.windows wins over the platform's own record (main passes what openWindows returned).
    expect(darwinEnvironment(d, { windows: null }).mac?.accessibility).toBe(true);
    expect(e.systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
  });

  it("has no Input Monitoring answer without the window system's FX-PD extra", () => {
    expect(darwinEnvironment(deps({ ws: fakeDarwinWindows() }).d, { windows: undefined }).mac?.inputMonitoring).toBeNull();
    expect(darwinEnvironment(deps({ ws: null }).d, { windows: undefined }).mac?.inputMonitoring).toBeNull();
    expect(darwinEnvironment(deps({ ws: fakeDarwinWindows({ inputMonitoring: false }) }).d, { windows: undefined }).mac?.inputMonitoring).toBe(false);
  });

  it("answers not allowed (fail closed) when a permission read throws", () => {
    const { d } = deps({
      ws: null,
      electron: { systemPreferences: {
        isTrustedAccessibilityClient: () => { throw new Error("no"); },
        getMediaAccessStatus: () => { throw new Error("no"); },
      } },
    });
    const mac = darwinEnvironment(d, { windows: undefined }).mac!;
    expect(mac.accessibility).toBe(false);
    expect(mac.screen).toBe("unknown");
    expect(mac.microphone).toBe("unknown");
  });

  it("reports the Applications folder, root and the denied microphone", () => {
    const { d } = deps({
      uid: 0,
      electron: { app: { isInApplicationsFolder: () => false }, systemPreferences: { getMediaAccessStatus: () => "denied" } },
    });
    const mac = darwinEnvironment(d, { windows: undefined }).mac!;
    expect(mac).toMatchObject({ inApplications: false, root: true, microphone: "denied", screen: "denied" });
  });

  it("maps the Darwin kernel's version to macOS's when Electron can't say", () => {
    expect(macVersionFromDarwin("22.6.0")).toBe("13.0");
    expect(macVersionFromDarwin("23.1.0")).toBe("14.0");
    expect(macVersionFromDarwin("24.0.0")).toBe("15.0");
    expect(macVersionFromDarwin("25.0.0")).toBe("26.0");
    expect(macVersionFromDarwin("19.6.0")).toBe("0");
    expect(macVersionFromDarwin("garbage")).toBe("0");
    const { d } = deps();
    expect(readPermissions({ ...d, systemVersion: () => undefined }).version).toMatch(/^\d+(\.\d+)*$/);
  });
});

describe("darwinFixes", () => {
  it("offers the seven macOS fixes with their button labels", () => {
    const f = darwinFixes(deps().d);
    expect(f.ids).toEqual(["open-accessibility-settings", "open-screen-recording-settings", "open-input-monitoring-settings", "open-microphone-settings",
      "open-automation-settings", "reset-permissions", "move-to-applications"]);
    expect(DARWIN_FIXES).toBe(f.ids);
    expect(f.ids.filter(id => id.startsWith("open-")).map(id => f.label(id))).toEqual(Array(5).fill("Open System Settings"));
    expect(f.label("reset-permissions")).toBe("Reset Ember's permissions");
    expect(f.label("move-to-applications")).toBe("Move to Applications");
  });

  it("asks for Accessibility once (macOS's prompt), then opens its pane each time", async () => {
    const { d, e } = deps();
    const f = darwinFixes(d);
    await f.apply("open-accessibility-settings");
    await f.apply("open-accessibility-settings");
    expect(e.systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledTimes(1);
    expect(e.systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledWith(true);
    expect(e.shell.openExternal.mock.calls).toEqual([[PANES.accessibility], [PANES.accessibility]]);
    expect(PANES.accessibility).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  });

  it("grabs one 1×1 screen thumbnail once (it lists Ember under Screen Recording), then opens the pane", async () => {
    const { d, e } = deps();
    const f = darwinFixes(d);
    await f.apply("open-screen-recording-settings");
    await f.apply("open-screen-recording-settings");
    expect(e.desktopCapturer.getSources).toHaveBeenCalledTimes(1);
    expect(e.desktopCapturer.getSources).toHaveBeenCalledWith({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
    expect(e.shell.openExternal).toHaveBeenLastCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  });

  it("opens the Screen Recording pane after at most 3 s when the grab doesn't answer", async () => {
    vi.useFakeTimers();
    try {
      const { d, e } = deps();
      e.desktopCapturer.getSources.mockReturnValueOnce(new Promise(() => { /* never settles */ }));
      const done = darwinFixes(d).apply("open-screen-recording-settings");
      await vi.advanceTimersByTimeAsync(GRAB_WAIT_MS);
      await done;
      expect(e.shell.openExternal).toHaveBeenCalledWith(PANES.screenRecording);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still opens the Screen Recording pane when the grab fails", async () => {
    const { d, e } = deps();
    e.desktopCapturer.getSources.mockRejectedValueOnce(new Error("denied"));
    await darwinFixes(d).apply("open-screen-recording-settings");
    expect(e.shell.openExternal).toHaveBeenCalledWith(PANES.screenRecording);
  });

  it("requests Input Monitoring through port/darwin once, then opens its pane", async () => {
    const request = vi.fn();
    const { d, e } = deps({ ws: fakeDarwinWindows({ inputMonitoring: false, requestInputMonitoring: request }) });
    const f = darwinFixes(d);
    await f.apply("open-input-monitoring-settings");
    await f.apply("open-input-monitoring-settings");
    expect(request).toHaveBeenCalledTimes(1);
    expect(e.shell.openExternal).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent");
    // Without the window system (or before FX-PD) the pane still opens.
    const bare = deps({ ws: null });
    await darwinFixes(bare.d).apply("open-input-monitoring-settings");
    expect(bare.e.shell.openExternal).toHaveBeenCalledWith(PANES.inputMonitoring);
  });

  it("asks for the microphone while macOS hasn't asked yet, and opens its pane after a refusal", async () => {
    const first = deps();
    await darwinFixes(first.d).apply("open-microphone-settings");
    expect(first.e.systemPreferences.askForMediaAccess).toHaveBeenCalledWith("microphone");
    expect(first.e.shell.openExternal).not.toHaveBeenCalled();
    const denied = deps({ electron: { systemPreferences: { getMediaAccessStatus: () => "denied" } } });
    await darwinFixes(denied.d).apply("open-microphone-settings");
    expect(denied.e.systemPreferences.askForMediaAccess).not.toHaveBeenCalled();
    expect(denied.e.shell.openExternal).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
  });

  it("opens the Automation pane", async () => {
    const { d, e } = deps();
    await darwinFixes(d).apply("open-automation-settings");
    expect(e.shell.openExternal).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation");
  });

  it("resets Ember's three permissions by bundle id with tccutil, then asks for Accessibility again", async () => {
    const { run, calls } = fakeRun([{ match: tool("/usr/bin/tccutil", "reset"), result: { code: 0 } }]);
    const { d, e } = deps({ run });
    await darwinFixes(d).apply("reset-permissions");
    expect(calls.map(c => [c.file, ...c.args])).toEqual([
      ["/usr/bin/tccutil", "reset", "Accessibility", BUNDLE_ID],
      ["/usr/bin/tccutil", "reset", "ScreenCapture", BUNDLE_ID],
      ["/usr/bin/tccutil", "reset", "ListenEvent", BUNDLE_ID],
    ]);
    expect(BUNDLE_ID).toBe("io.github.komaladitya08.ember");
    expect(e.systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledWith(true);
  });

  it("says what to do by hand when tccutil fails", async () => {
    const { run } = fakeRun([{ match: tool("/usr/bin/tccutil"), result: { code: 1, stderr: "tccutil: Failed to reset" } }]);
    await expect(darwinFixes(deps({ run }).d).apply("reset-permissions")).rejects.toThrow(/Remove Ember from each list/);
  });

  it("moves Ember to Applications, and says to drag it there when it can't", async () => {
    const ok = deps();
    await darwinFixes(ok.d).apply("move-to-applications");
    expect(ok.e.app.moveToApplicationsFolder).toHaveBeenCalled();
    for (const move of [() => false, () => { throw new Error("EPERM"); }]) {
      const bad = deps({ electron: { app: { moveToApplicationsFolder: move } } });
      await expect(darwinFixes(bad.d).apply("move-to-applications")).rejects.toThrow("Ember couldn't move itself: drag Ember into Applications.");
    }
  });

  it("refuses a fix that isn't macOS's", async () => {
    await expect(darwinFixes(deps().d).apply("enable-accessibility")).rejects.toThrow("unknown fix: enable-accessibility");
    await expect(darwinFixes(deps().d).apply("unblock-helper")).rejects.toThrow(/unknown fix/);
  });
});

describe("the macOS doctor rows", () => {
  const row = <T extends { id: string }>(rows: T[], id: string) => rows.find(r => r.id === id);

  it("are all ok on a Mac with every permission", async () => {
    const { d } = deps({ ws: fakeDarwinWindows({ inputMonitoring: true, secureInput: () => ({ on: false, pid: null, app: "" }) }), electron: { systemPreferences: { getMediaAccessStatus: () => "granted" } } });
    const probes = await darwinDoctorProbes(d);
    expect(probes).toMatchObject({ microphones: null, speechDispatcher: true, sandbox: null, fileWatchers: null, desk: null });
    expect(probes.extra.map(r => [r.id, r.status])).toEqual([
      ["accessibility-permission", "ok"], ["screen-recording", "ok"], ["input-monitoring", "ok"], ["microphone-permission", "ok"],
      ["secure-input", "ok"], ["location", "ok"],
    ]);
    expect(row(probes.extra, "screen-recording")?.detail).toBe("Allowed. macOS asks again about once a month; choose Allow.");
  });

  it("give each missing permission its System Settings path and the re-grant sentence", () => {
    const { d } = deps({
      ws: fakeDarwinWindows({ trusted: false, inputMonitoring: false }),
      electron: { systemPreferences: { getMediaAccessStatus: () => "denied" } },
    });
    const rows = darwinDoctorRows(d);
    expect(row(rows, "accessibility-permission")).toMatchObject({ status: "fail", fix: `System Settings › Privacy & Security › Accessibility: switch Ember on. ${REGRANT}` });
    expect(row(rows, "screen-recording")).toMatchObject({ status: "warn" });
    expect(row(rows, "screen-recording")?.fix).toMatch(/Screen Recording: switch Ember on, then quit and reopen Ember\. If Ember is already listed/);
    expect(row(rows, "input-monitoring")?.fix).toContain(REGRANT);
    expect(row(rows, "microphone-permission")).toMatchObject({ status: "warn", detail: "Off for Ember, so “Hey Ember” can't hear you.",
      fix: `System Settings › Privacy & Security › Microphone: switch Ember on. ${REGRANT}` });
    expect(REGRANT).toBe("If Ember is already listed and switched on, remove it with − and add it again: macOS ties the permission to this exact copy of Ember.");
  });

  it("leave Input Monitoring out when it can't be asked", () => {
    expect(row(darwinDoctorRows(deps({ ws: fakeDarwinWindows() }).d), "input-monitoring")).toBeUndefined();
  });

  it("name the app holding secure keyboard entry", () => {
    const rows = darwinDoctorRows(deps({ ws: fakeDarwinWindows({ secureInput: () => ({ on: true, pid: 812, app: "Terminal" }) }) }).d);
    expect(row(rows, "secure-input")).toMatchObject({
      status: "warn", detail: "Secure keyboard entry is on in Terminal, so Ember won't use the keyboard until it's off.",
    });
    expect(row(rows, "secure-input")?.fix).toMatch(/Terminal menu › Secure Keyboard Entry/);
  });

  it("warn when secure input can't be told, and leave the row out without a window system", () => {
    expect(row(darwinDoctorRows(deps({ ws: fakeDarwinWindows({ secureInput: () => ({ on: true, pid: 9, app: "" }) }) }).d), "secure-input")?.detail)
      .toBe("Secure keyboard entry is on, so Ember won't use the keyboard until it's off.");
    expect(row(darwinDoctorRows(deps({ ws: fakeDarwinWindows({ secureInput: () => ({ on: null, pid: null, app: "" }) }) }).d), "secure-input"))
      .toMatchObject({ status: "warn", detail: "Ember can't tell whether a password is being typed, so it won't use the keyboard." });
    expect(row(darwinDoctorRows(deps({ ws: null }).d), "secure-input")).toBeUndefined();
  });

  it("warn about the location and root", () => {
    const rows = darwinDoctorRows(deps({ uid: 0, electron: { app: { isInApplicationsFolder: () => false } } }).d);
    expect(row(rows, "location")).toMatchObject({ status: "warn", detail: "Not in the Applications folder, so its permissions and login item may not stick." });
    expect(row(rows, "root")).toMatchObject({ status: "warn", detail: "Ember is running as root.", fix: "Start it as yourself." });
  });
});
