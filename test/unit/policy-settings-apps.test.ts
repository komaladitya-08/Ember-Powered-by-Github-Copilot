/**
 * The system's own Settings apps (review #111): GNOME Settings, Windows Settings (and System Properties), and macOS's
 * System Settings hold switches that weaken protection or grant devices to apps (the screen lock, location, camera,
 * microphone, developer mode, remote assistance, login items) whose labels say nothing of security. Every setting there
 * is asked about, every time, whatever the grant; other apps' settings are judged as before.
 */

import { describe, expect, it } from "vitest";
import { KEYS } from "../../app/shared/shortcuts";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";
import { SETTINGS_APP } from "../../app/main/policy/vocabulary";

const engine = (os: "linux" | "win32" | "darwin", grants: Record<string, "act">) =>
  new PolicyEngine({ neverLook: () => [], grants: () => grants, os, keys: KEYS[os], ownPid: 1, rateLimit: 1e6 });
const toggle = (app: string, window: string, name: string, role = "switch", more: Partial<ActionRequest> = {}): ActionRequest => ({
  taskId: "t", kind: "toggle", app, window, windowId: { pid: 9, role: "frame" }, element: { role, name }, value: "on", ...more,
});

describe("settings in the system's Settings apps", () => {
  it("GNOME Settings: every switch is asked about, every time, with an Allow grant", () => {
    const e = engine("linux", { "gnome-control-center": "act" });
    for (const [win, name] of [["Privacy", "Location Services"], ["Privacy", "Camera"], ["Privacy", "Microphone"], ["Screen Lock", "Automatic Screen Lock"],
      ["Screen Lock", "Lock Screen on Suspend"], ["Users", "Automatic Login"], ["Notifications", "Lock Screen Notifications"], ["Appearance", "Dark"]]) {
      expect(e.decide(toggle("gnome-control-center", win, name)), name).toMatchObject({ verdict: "confirm", risky: true });
    }
    // A choice and a value there too, and a key that flips a switch.
    expect(e.decide({ ...toggle("gnome-control-center", "Screen Lock", "Blank Screen Delay", "combo box"), kind: "select", value: "Never" }).verdict).toBe("confirm");
    expect(e.decide({ ...toggle("gnome-control-center", "Power", "Brightness", "slider"), kind: "value", value: "10" }).verdict).toBe("confirm");
    expect(e.decide({ ...toggle("gnome-control-center", "Privacy", "Camera"), kind: "keys", value: "space" }).reason).toMatch(/system setting/);
  });

  it("Windows Settings and System Properties: camera, microphone, location, developer mode and remote assistance are asked about", () => {
    const e = engine("win32", { systemsettings: "act", systempropertiesremote: "act" });
    for (const name of ["Camera access", "Let apps access your camera", "Microphone access", "Location services", "Developer Mode", "Start-up apps: Slack"]) {
      expect(e.decide(toggle("SystemSettings", "Settings", name)), name).toMatchObject({ verdict: "confirm", risky: true });
    }
    expect(e.decide(toggle("SystemPropertiesRemote.exe", "System Properties", "Allow Remote Assistance connections to this computer", "check box"))).toMatchObject({ verdict: "confirm", risky: true });
  });

  it("macOS System Settings: an app's switch in any privacy pane is asked about, in any language", () => {
    const e = engine("darwin", { "system settings": "act", systemeinstellungen: "act" });
    for (const pane of ["Camera", "Microphone", "Location Services", "Photos", "Contacts", "Files & Folders", "Local Network", "Bluetooth", "Login Items & Extensions", "Sharing", "Lock Screen"]) {
      expect(e.decide(toggle("System Settings", pane, "Terminal")), pane).toMatchObject({ verdict: "confirm", risky: true });
    }
    expect(e.decide(toggle("Systemeinstellungen", "Kamera", "Terminal"))).toMatchObject({ verdict: "confirm", risky: true });
    expect(e.decide(toggle("com.apple.systempreferences", "Camera", "Terminal"))).toMatchObject({ verdict: "confirm", risky: true });
  });

  it("leaves other apps' ordinary switches, and buttons in Settings, as they were", () => {
    const e = engine("linux", { "gnome-control-center": "act", firefox: "act" });
    expect(e.decide(toggle("firefox", "Settings", "Use smooth scrolling", "check box")).verdict).toBe("allow");
    expect(e.decide({ ...toggle("gnome-control-center", "Privacy", "Screen Lock", "push button"), kind: "click" }).verdict).toBe("allow");
    expect(e.decide({ ...toggle("gnome-control-center", "Privacy", "Location Services"), kind: "read" }).verdict).toBe("allow");
    expect(SETTINGS_APP.linux?.test("gedit")).toBe(false);
  });
});
