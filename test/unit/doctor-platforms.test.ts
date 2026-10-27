/** `ember doctor` on Windows and macOS (doctor.ts, design §4.14, §9.9): the `os` field decides the advice, never a check's text. */

import { describe, expect, it } from "vitest";
import { doctorChecks, formatDoctor, type DoctorProbes } from "../../app/main/doctor";
import { inspectEnvironment, type EnvInputs } from "../../app/main/environment";
import { AdminPolicySchema } from "../../app/main/admin";
import { SHORTCUTS } from "../../app/shared/shortcuts";
import { PLATFORM_WORDS } from "../../app/shared/words";

const versions = { electron: "44.5.0", chrome: "152", node: "24" };
const RHEL84 = 'NAME="Red Hat Enterprise Linux"\nVERSION_ID="8.4"\nID="rhel"\nPRETTY_NAME="Red Hat Enterprise Linux 8.4 (Ootpa)"\n';
const linuxEnv = (more: Partial<EnvInputs> = {}) => inspectEnvironment({
  env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "GNOME" }, osRelease: RHEL84, glibc: "2.28", versions, platform: "linux", arch: "x64",
  accessibility: { enabled: true, pyatspi: true }, ...more,
});
const winEnv = (powershell: "full" | "constrained" = "full") => inspectEnvironment({ env: {}, osRelease: null, glibc: null, versions, platform: "win32", arch: "x64",
  windows: { build: 22631, elevated: false, session: "console", powershell, dpiMixed: false } });
const macEnv = () => inspectEnvironment({ env: {}, osRelease: null, glibc: null, versions, platform: "darwin", arch: "arm64",
  mac: { version: "14.6", accessibility: true, screen: "granted", microphone: "granted", inputMonitoring: true, inApplications: true, root: false } });

const base = (over: Partial<DoctorProbes> = {}): DoctorProbes => ({
  env: linuxEnv(), compositor: true, xtest: true, speechDispatcher: true, microphones: ["alsa_input.pci-0000_00_1f.3.analog-stereo"],
  voiceModels: "bundled", runtime: true, auth: { kind: "github", source: "stored" }, admin: { policy: AdminPolicySchema.parse({}), source: null },
  desk: { ok: true, missing: [] }, sandbox: { userNamespaces: true, suidHelper: true }, ...over,
});
const windows = (over: Partial<DoctorProbes> = {}): DoctorProbes => base({
  os: "win32", env: winEnv(), microphones: null, desk: null, sandbox: null, fileWatchers: null, helper: { toolkitAccessibility: true, languageMode: "FullLanguage", dpi: "PerMonitorV2", processDpi: "PerMonitorV2" },
  shortcuts: SHORTCUTS.win32, words: PLATFORM_WORDS.win32, policyLocation: "HKLM\\SOFTWARE\\Policies\\Ember (PolicyJson)", extra: [], ...over,
});
const macos = (over: Partial<DoctorProbes> = {}): DoctorProbes => base({
  os: "darwin", env: macEnv(), microphones: null, desk: null, sandbox: null, fileWatchers: null, helper: { toolkitAccessibility: true },
  shortcuts: SHORTCUTS.darwin, words: PLATFORM_WORDS.darwin, policyLocation: "/Library/Application Support/Ember/policy.json", extra: [], ...over,
});
const byId = (checks: ReturnType<typeof doctorChecks>, id: string) => checks.find(c => c.id === id);
const LINUX_WORDS = /\bdnf\b|gsettings|GNOME|Xorg|pactl|speech-dispatcher|sysctl|chrome-sandbox|XTest|X display/;

describe("ember doctor on Linux", () => {
  it("is exactly today's report when the platform's Linux values are passed", () => {
    const today = doctorChecks(base());
    expect(doctorChecks(base({ os: "linux", shortcuts: SHORTCUTS.linux, words: PLATFORM_WORDS.linux, policyLocation: "/etc/ember/policy.json", extra: [] }))).toEqual(today);
    expect(byId(today, "policy")?.detail).toBe("None (optional: /etc/ember/policy.json).");
    expect(byId(doctorChecks(base({ runtime: false })), "copilot")?.fix).toBe("Reinstall Ember (sudo dnf reinstall ember).");
    expect(byId(doctorChecks(base({ auth: null })), "copilot")?.fix).toBe("Open Ember's settings (Ctrl+Alt+E) and choose “Sign in with GitHub”, or run “gh auth login”.");
    expect(byId(doctorChecks(base({ microphones: [] })), "microphone")?.detail).toBe("No microphone found. Only needed for “Hey Ember”; typing (Ctrl+Alt+Space) always works.");
  });

  it("keeps Linux's wording on Linux arm64, whose platform check reads 'isn’t supported' (the os field decides, not that text)", () => {
    const checks = doctorChecks(base({ os: "linux", env: linuxEnv({ arch: "arm64" }), compositor: false, xtest: false, speechDispatcher: false, microphones: null }));
    expect(byId(checks, "platform")).toMatchObject({ status: "fail", detail: "linux/arm64 isn't supported" });
    expect(byId(checks, "xtest")?.fix).toBe("sudo dnf install libXtst");
    expect(byId(checks, "compositor")?.fix).toBe("Use GNOME on Xorg (its compositor is built in).");
    expect(byId(checks, "microphone")?.fix).toBe("sudo dnf install pulseaudio-utils");
    expect(byId(checks, "speech")?.fix).toMatch(/speech-dispatcher/);
    expect(byId(checks, "accessibility-helper")).toBeUndefined();
  });

  it("leaves out the desk and sandbox rows when the platform has none", () => {
    const checks = doctorChecks(base({ desk: null, sandbox: null }));
    expect(byId(checks, "desk")).toBeUndefined();
    expect(byId(checks, "sandbox")).toBeUndefined();
  });

  it("never shows the helper row on Linux (the Python sidecar starts on demand there)", () => {
    expect(byId(doctorChecks(base({ helper: null })), "accessibility-helper")).toBeUndefined();
  });

  it("adds the platform's extra rows before the Copilot row", () => {
    const ids = doctorChecks(base({ extra: [{ id: "x1", status: "ok", label: "X1", detail: "one" }, { id: "x2", status: "warn", label: "X2", detail: "two", fix: "do it" }] })).map(c => c.id);
    expect(ids.slice(ids.indexOf("x1"), ids.indexOf("copilot") + 1)).toEqual(["x1", "x2", "copilot"]);
  });
});

describe("ember doctor on Windows", () => {
  it("is all green on a well set-up Windows 11, in Windows' words only", () => {
    const checks = doctorChecks(windows());
    expect(checks.filter(c => c.status !== "ok")).toEqual([]);
    expect(checks.map(c => c.id)).toEqual(["platform", "os", "session", "compositor", "accessibility-helper", "xtest", "copilot", "policy", "microphone", "voice-models", "speech"]);
    expect(byId(checks, "compositor")?.detail).toBe("Windows always composites: Ember appears beside your cursor.");
    expect(byId(checks, "xtest")?.detail).toMatch(/SendInput/);
    expect(byId(checks, "microphone")).toMatchObject({ status: "ok", detail: expect.stringMatching(/^Not checked here; the settings window tests it/) });
    expect(byId(checks, "speech")?.detail).toBe("Uses Windows' voices.");
    expect(byId(checks, "accessibility-helper")?.detail).toBe("Running: Ember can read apps (PowerShell FullLanguage, DPI awareness PerMonitorV2).");
    expect(byId(checks, "policy")?.detail).toBe("None (optional: HKLM\\SOFTWARE\\Policies\\Ember (PolicyJson)).");
    expect(formatDoctor(checks)).toMatch(/Everything Ember needs is in place\.$/);
  });

  it("explains every problem with Windows' fixes, never a Linux command", () => {
    const checks = doctorChecks(windows({ compositor: null, xtest: false, runtime: false, voiceModels: "missing", speechDispatcher: false, helper: null, microphones: [] }));
    for (const c of checks) {
      expect(`${c.detail} ${c.fix ?? ""}`, c.id).not.toMatch(LINUX_WORDS);
      if (c.status === "fail") expect(c.fix, c.id).toBeTruthy();
    }
    expect(byId(checks, "copilot")?.fix).toBe("Reinstall Ember.");
    expect(byId(checks, "compositor")).toMatchObject({ status: "fail", fix: "Reinstall Ember." });
    expect(byId(checks, "voice-models")?.fix).not.toMatch(/ember-voice-models/);
    expect(byId(checks, "microphone")?.detail).toMatch(/typing \(Win\+Alt\+Space\) always works/);
    expect(byId(doctorChecks(windows({ auth: null })), "copilot")?.fix).toMatch(/\(Win\+Alt\+E\)/);
  });

  it("doesn't repeat the setup check's helper row: the helper and the platform's rows say it", () => {
    const checks = doctorChecks(windows({ env: winEnv("constrained") }));
    expect(byId(checks, "accessibility")).toBeUndefined();
  });

  it("reports the helper: no answer, can't read apps (with its own words and facts), unsure, and mixed scaling", () => {
    expect(byId(doctorChecks(windows({ helper: null })), "accessibility-helper")).toMatchObject({ status: "fail", label: "Accessibility helper", detail: expect.stringMatching(/didn't answer/) });
    expect(byId(doctorChecks(windows({ helper: { toolkitAccessibility: false, detail: "refused by an execution policy", languageMode: "FullLanguage" } })), "accessibility-helper"))
      .toMatchObject({ status: "fail", detail: "Ember's accessibility helper can't read apps: refused by an execution policy (PowerShell FullLanguage).", fix: expect.stringMatching(/PowerShell row/) });
    expect(byId(doctorChecks(windows({ helper: { toolkitAccessibility: false } })), "accessibility-helper")?.detail).toBe("Ember's accessibility helper can't read apps.");
    expect(byId(doctorChecks(windows({ helper: { toolkitAccessibility: null } })), "accessibility-helper")?.status).toBe("warn");
    expect(byId(doctorChecks(windows({ helper: { toolkitAccessibility: true, dpi: "PerMonitorV2", processDpi: "SystemAware" } })), "accessibility-helper"))
      .toMatchObject({ status: "warn", detail: "Running, but its display scaling differs from Ember's, so it may click in the wrong place on some monitors (DPI awareness PerMonitorV2, Ember's DPI awareness SystemAware)." });
    expect(byId(doctorChecks(windows({ helper: undefined })), "accessibility-helper")).toBeUndefined();
  });

  it("asks to sign in to Windows when started as a service", () => {
    const env = inspectEnvironment({ env: {}, osRelease: null, glibc: null, versions, platform: "win32", arch: "x64",
      windows: { build: 22631, elevated: false, session: "service", powershell: "full", dpiMixed: false } });
    expect(byId(doctorChecks(windows({ env })), "session")).toMatchObject({ status: "fail", fix: "Sign in to Windows and start Ember from the Start menu." });
  });
});

describe("ember doctor on macOS", () => {
  it("is all green on a well set-up Mac, in macOS's words only", () => {
    const checks = doctorChecks(macos());
    expect(checks.filter(c => c.status !== "ok")).toEqual([]);
    expect(byId(checks, "compositor")?.detail).toBe("macOS always composites: Ember appears beside your cursor.");
    expect(byId(checks, "speech")?.detail).toBe("Uses macOS voices.");
    expect(byId(checks, "policy")?.detail).toBe("None (optional: /Library/Application Support/Ember/policy.json).");
    for (const c of checks) expect(`${c.detail} ${c.fix ?? ""}`, c.id).not.toMatch(LINUX_WORDS);
  });

  it("sends the user to Accessibility in System Settings when the helper or input can't work", () => {
    const checks = doctorChecks(macos({ xtest: false, helper: { toolkitAccessibility: false } }));
    expect(byId(checks, "xtest")).toMatchObject({ status: "warn", fix: "Allow Ember in System Settings › Privacy & Security › Accessibility." });
    expect(byId(checks, "accessibility-helper")).toMatchObject({ status: "fail", fix: expect.stringMatching(/Privacy & Security › Accessibility/) });
    expect(byId(doctorChecks(macos({ runtime: false })), "copilot")?.fix).toBe(PLATFORM_WORDS.darwin.reinstall);
    expect(byId(doctorChecks(macos({ auth: null })), "copilot")?.fix).toMatch(/\(Control\+Shift\+Command\+E\)/);
  });

  it("keeps the platform's permission rows, in the order given, before the Copilot row", () => {
    const extra = [
      { id: "screen-recording", status: "warn" as const, label: "Screen Recording", detail: "Not allowed.", fix: "System Settings › Privacy & Security › Screen Recording" },
      { id: "secure-input", status: "warn" as const, label: "Secure input", detail: "Terminal holds secure input." },
    ];
    const checks = doctorChecks(macos({ extra }));
    const ids = checks.map(c => c.id);
    expect(ids.slice(ids.indexOf("screen-recording"), ids.indexOf("copilot") + 1)).toEqual(["screen-recording", "secure-input", "copilot"]);
    expect(byId(checks, "screen-recording")).toEqual({ id: "screen-recording", status: "warn", label: "Screen Recording", detail: "Not allowed.", fix: "System Settings › Privacy & Security › Screen Recording" });
    expect(byId(checks, "secure-input")).not.toHaveProperty("fix");
  });
});
