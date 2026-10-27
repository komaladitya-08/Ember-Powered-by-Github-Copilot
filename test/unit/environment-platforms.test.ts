/** The setup checks on Windows and macOS (environment.ts, design §4.13, §9.8), and Linux's kept exactly as they were. */

import { describe, expect, it } from "vitest";
import { MAC_REGRANT, inspectEnvironment, type EnvInputs, type MacEnvInputs, type WindowsEnvInputs } from "../../app/main/environment";
import { SHORTCUTS } from "../../app/shared/shortcuts";

const versions = { electron: "44.5.0", chrome: "152", node: "24.21.0" };
const common = { env: {}, osRelease: null, glibc: null, versions };
const win = (w: Partial<WindowsEnvInputs> = {}, more: Partial<EnvInputs> = {}): EnvInputs => ({
  ...common, platform: "win32", arch: "x64",
  windows: { build: 22631, elevated: false, session: "console", powershell: "full", dpiMixed: false, ...w }, shortcutsTaken: [], ...more,
});
const mac = (m: Partial<MacEnvInputs> = {}, more: Partial<EnvInputs> = {}): EnvInputs => ({
  ...common, platform: "darwin", arch: "arm64",
  mac: { version: "14.6.1", accessibility: true, screen: "granted", microphone: "not-determined", inputMonitoring: true, inApplications: true, root: false, ...m },
  shortcutsTaken: [], ...more,
});
const check = (i: EnvInputs, id: string) => inspectEnvironment(i).checks.find(c => c.id === id);
const ids = (i: EnvInputs) => inspectEnvironment(i).checks.map(c => c.id);

describe("Windows setup checks", () => {
  it("are all fine on a well set-up Windows 11, with no Linux-only checks", () => {
    const r = inspectEnvironment(win());
    expect(r.checks.filter(c => c.status !== "ok")).toEqual([]);
    expect(ids(win())).toEqual(["platform", "os", "session", "accessibility", "shortcuts"]);
    expect(r.os).toBe("Windows 11 (build 22631)");
    expect(check(win(), "platform")?.detail).toBe("Windows x64");
    expect(check(win(), "accessibility")).toEqual({ id: "accessibility", label: "Screen reading", status: "ok", detail: "Windows UI Automation" });
  });

  it("explain each state of the PowerShell helper on Windows 11, from its facts", () => {
    expect(check(win({ powershell: "constrained" }), "accessibility")).toMatchObject({ status: "warn", detail: expect.stringMatching(/Constrained Language Mode.*administrator/) });
    expect(check(win({ powershell: "constrained" }), "accessibility")?.fix).toBeUndefined();
    expect(check(win({ powershell: "policy" }), "accessibility")).toMatchObject({ status: "warn", detail: expect.stringMatching(/only signed PowerShell scripts/) });
    expect(check(win({ powershell: "blocked-download" }), "accessibility")).toMatchObject({ status: "warn", detail: expect.stringMatching(/came from the internet/), fix: "unblock-helper" });
    expect(check(win({ powershell: "missing", helperDetail: "Add-Type failed: CS0246" }), "accessibility"))
      .toMatchObject({ status: "warn", detail: "Ember's accessibility helper didn't start: Add-Type failed: CS0246" });
    expect(check(win({ powershell: "missing" }), "accessibility")?.detail).toBe("Ember's accessibility helper didn't start.");
    // Not asked yet (the helper's status comes in the background): no row rather than a guess.
    expect(check(win({ powershell: "unknown" }), "accessibility")).toBeUndefined();
  });

  it("warn on Windows 10 1809 (works, untested) and fail before it", () => {
    expect(check(win({ build: 17763 }), "os")).toEqual({ id: "os", label: "Operating system", status: "warn", detail: "Windows 10 (build 17763). Ember is tested on Windows 10 22H2 and Windows 11." });
    expect(check(win({ build: 19045 }), "os")).toMatchObject({ status: "ok", detail: "Windows 10 (build 19045)" });
    expect(check(win({ build: 17134 }), "os")).toMatchObject({ status: "fail", detail: "Windows 10 (build 17134). Ember needs Windows 10 version 1809 or newer." });
    expect(check(win({ build: 0 }), "os")).toMatchObject({ status: "warn" });
  });

  it("name Windows on Arm best effort and refuse other processors", () => {
    expect(check(win({}, { arch: "arm64" }), "platform")).toMatchObject({ status: "ok", detail: "Windows on Arm (best effort)" });
    expect(check(win({}, { arch: "ia32" }), "platform")?.status).toBe("fail");
  });

  it("refuse a service session and accept Remote Desktop", () => {
    expect(check(win({ session: "service" }), "session")).toMatchObject({ status: "fail", detail: "Start Ember from your desktop, not as a service." });
    expect(check(win({ session: "rdp" }), "session")?.status).toBe("ok");
  });

  it("warn about running as administrator and about mixed display scaling", () => {
    expect(check(win({ elevated: true }), "elevated")).toMatchObject({ status: "warn", detail: expect.stringMatching(/running as administrator: start it normally/) });
    expect(check(win(), "elevated")).toBeUndefined();
    // A token that couldn't be read isn't called elevated here (the targets runtime counts it as elevated: commands ask).
    expect(check(win({ elevated: null }), "elevated")).toBeUndefined();
    expect(check(win({ dpiMixed: true }), "display-scaling")).toMatchObject({ status: "warn", detail: expect.stringMatching(/mixed display scaling/) });
    expect(check(win(), "display-scaling")).toBeUndefined();
  });

  it("name Windows' own shortcuts, and the ones another app took by their Windows labels", () => {
    expect(check(win({}, { shortcuts: SHORTCUTS.win32 }), "shortcuts")?.detail).toBe("Win+Alt+Space ask · Win+Alt+X stop · Win+Alt+E settings · Win+Alt+M microphone");
    expect(check(win({}, { shortcutsTaken: ["Super+Alt+Space", "Super+Alt+M"] }), "shortcuts"))
      .toMatchObject({ status: "warn", detail: expect.stringMatching(/^Another app already uses Win\+Alt\+Space, Win\+Alt\+M\. /) });
  });

  it("give keyboard users a way to ask when the shortcuts are taken, not only the mouse-only handle (review #45)", () => {
    expect(check(win({}, { shortcutsTaken: ["Super+Alt+Space"] }), "shortcuts")?.detail).toBe(
      "Another app already uses Win+Alt+Space. Ember keeps trying to get it; meanwhile, click Ember's handle in the corner "
      + "(it has Ask, Stop everything and Settings), or, from the keyboard, open Ember again from the Start menu and choose Ask Ember… in its settings.",
    );
    expect(check(mac({}, { shortcutsTaken: ["Control+Shift+Command+Space", "Control+Shift+Command+X"] }), "shortcuts")?.detail)
      .toMatch(/^Another app already uses Control\+Shift\+Command\+Space, Control\+Shift\+Command\+X\. Ember keeps trying to get them; .* open Ember again from Applications and choose Ask Ember… in its settings\.$/);
  });

  it("say only what they know without the Windows facts", () => {
    expect(ids(win({}, { windows: undefined }))).toEqual(["platform", "shortcuts"]);
  });
});

describe("macOS setup checks", () => {
  it("are all fine on a well set-up Mac", () => {
    const r = inspectEnvironment(mac());
    expect(r.checks.filter(c => c.status !== "ok")).toEqual([]);
    expect(ids(mac())).toEqual(["platform", "os", "accessibility", "screen-recording", "input-monitoring", "location", "shortcuts"]);
    expect(r.os).toBe("macOS 14.6.1");
    expect(check(mac(), "platform")?.detail).toBe("macOS on Apple silicon");
    expect(check(mac({}, { arch: "x64" }), "platform")?.detail).toBe("macOS on Intel (best effort)");
  });

  it("on macOS 14 without Screen Recording or Input Monitoring, warn about both with their fixes and the re-grant advice", () => {
    const i = mac({ screen: "denied", inputMonitoring: false });
    expect(check(i, "screen-recording")).toEqual({ id: "screen-recording", label: "Screen Recording", status: "warn",
      detail: `Without Screen Recording, Ember can't take screenshots or see other apps' window titles. After you allow it, quit and reopen Ember. ${MAC_REGRANT}`,
      fix: "open-screen-recording-settings" });
    expect(check(i, "input-monitoring")).toMatchObject({ status: "warn", fix: "open-input-monitoring-settings",
      detail: expect.stringMatching(/^Without Input Monitoring, Ember won't use the keyboard for you, because it couldn't notice you taking over\. If Ember is already listed/) });
    expect(inspectEnvironment(i).checks.filter(c => c.status === "fail")).toEqual([]);
    expect(check(mac({ screen: "not-determined" }), "screen-recording")?.status).toBe("warn");
  });

  it("fail on macOS 12", () => {
    expect(check(mac({ version: "12.7.4" }), "os")).toEqual({ id: "os", label: "Operating system", status: "fail", detail: "macOS 12.7.4. Ember needs macOS 13 or newer." });
    expect(check(mac({ version: "13.0" }), "os")?.status).toBe("ok");
  });

  it("fail without Accessibility, offering System Settings", () => {
    expect(check(mac({ accessibility: false }), "accessibility")).toMatchObject({ label: "Reading and using apps", status: "fail", fix: "open-accessibility-settings",
      detail: `Ember needs the Accessibility permission to read and use apps. ${MAC_REGRANT}` });
  });

  it("leave Input Monitoring out when it can't be asked, and the microphone out until it is refused", () => {
    expect(check(mac({ inputMonitoring: null }), "input-monitoring")).toBeUndefined();
    expect(check(mac({ microphone: "granted" }), "microphone")).toBeUndefined();
    expect(check(mac({ microphone: "denied" }), "microphone")).toMatchObject({ status: "warn", fix: "open-microphone-settings", detail: expect.stringMatching(/^Microphone access is off for Ember, so “Hey Ember” can't hear you\./) });
  });

  it("ask to be moved to Applications, and warn when run as root", () => {
    expect(check(mac({ inApplications: false }), "location")).toMatchObject({ status: "warn", fix: "move-to-applications", detail: "Ember isn't in the Applications folder, so its permissions and login item may not stick." });
    expect(check(mac({ root: true }), "elevated")).toMatchObject({ status: "warn", detail: "Ember is running as root. Start it as yourself." });
  });

  it("name macOS's own shortcuts", () => {
    expect(check(mac(), "shortcuts")?.detail).toBe("Control+Shift+Command+Space ask · Control+Shift+Command+X stop · Control+Shift+Command+E settings · Control+Shift+Command+M microphone");
  });
});

describe("Linux setup checks", () => {
  const RHEL84 = 'NAME="Red Hat Enterprise Linux"\nVERSION="8.4 (Ootpa)"\nID="rhel"\nVERSION_ID="8.4"\nPRETTY_NAME="Red Hat Enterprise Linux 8.4 (Ootpa)"\n';
  const linux: EnvInputs = { env: { XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "GNOME", DISPLAY: ":0" }, osRelease: RHEL84, glibc: "2.28", versions,
    platform: "linux", arch: "x64", accessibility: { enabled: true, pyatspi: true }, x11: true, shortcutsTaken: [] };

  it("give exactly today's report, with or without the Linux shortcut table", () => {
    expect(inspectEnvironment({ ...linux, shortcuts: SHORTCUTS.linux })).toEqual(inspectEnvironment(linux));
    expect(check(linux, "shortcuts")?.detail).toBe("Ctrl+Alt+Space ask · Ctrl+Alt+X stop · Ctrl+Alt+E settings · Ctrl+Alt+M microphone");
    expect(check({ ...linux, shortcutsTaken: ["Control+Alt+X", "Control+Alt+Space"] }, "shortcuts")?.detail).toMatch(/^Another app already uses Ctrl\+Alt\+X, Ctrl\+Alt\+Space\. /);
    // The keyboard's way to ask meanwhile (review #45).
    expect(check({ ...linux, shortcutsTaken: ["Control+Alt+Space"] }, "shortcuts")?.detail).toMatch(/open Ember again from your apps and choose Ask Ember… in its settings\.$/);
    expect(ids(linux)).toEqual(["platform", "os", "session", "desktop", "glibc", "accessibility", "shortcuts"]);
  });

  it("decide by platform alone: Windows or macOS facts given to Linux change nothing", () => {
    expect(inspectEnvironment({ ...linux, windows: win().windows, mac: mac().mac })).toEqual(inspectEnvironment(linux));
  });

  it("keep failing other Linux machines as before (arm64: not supported in v1)", () => {
    expect(check({ ...linux, arch: "arm64" }, "platform")).toEqual({ id: "platform", label: "Platform", status: "fail", detail: "linux/arm64 is not supported in v1" });
    expect(check({ ...linux, platform: "freebsd" }, "platform")?.detail).toBe("freebsd/x64 is not supported in v1");
  });
});
