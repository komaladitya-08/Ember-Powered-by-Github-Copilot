import { describe, it, expect } from "vitest";
import { WAYLAND_REASON, inspectEnvironment, isWaylandSession, parseOsRelease, sessionGreeting, type EnvInputs } from "../../app/main/environment";

const RHEL84 = 'NAME="Red Hat Enterprise Linux"\nVERSION="8.4 (Ootpa)"\nID="rhel"\nVERSION_ID="8.4"\nPRETTY_NAME="Red Hat Enterprise Linux 8.4 (Ootpa)"\n';
const base: EnvInputs = {
  env: { XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "GNOME", DISPLAY: ":0" },
  osRelease: RHEL84,
  glibc: "2.28",
  versions: { electron: "44.5.0", chrome: "152", node: "24.21.0" },
  platform: "linux",
  arch: "x64",
};
const status = (r: ReturnType<typeof inspectEnvironment>, id: string) => r.checks.find(c => c.id === id)?.status;

describe("environment", () => {
  it("parses os-release", () => {
    expect(parseOsRelease(RHEL84)).toMatchObject({ ID: "rhel", VERSION_ID: "8.4" });
  });

  it("accepts RHEL 8.4 on GNOME Xorg", () => {
    const r = inspectEnvironment(base);
    expect(r.checks.every(c => c.status === "ok")).toBe(true);
    expect(r.os).toBe("Red Hat Enterprise Linux 8.4 (Ootpa)");
  });

  it("explains how to leave a Wayland session", () => {
    const r = inspectEnvironment({ ...base, env: { ...base.env, XDG_SESSION_TYPE: "wayland" } });
    expect(status(r, "session")).toBe("fail");
    expect(r.checks.find(c => c.id === "session")?.detail).toMatch(/GNOME on Xorg/);
  });

  it("fails on old glibc and warns on other distributions", () => {
    const r = inspectEnvironment({ ...base, glibc: "2.17", osRelease: 'ID="ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04"' });
    expect(status(r, "glibc")).toBe("fail");
    expect(status(r, "os")).toBe("warn");
  });

  it("fails without a display", () => {
    const r = inspectEnvironment({ ...base, env: {} });
    expect(status(r, "session")).toBe("fail");
  });
});

describe("session detection without XDG_SESSION_TYPE (Xvfb, xrdp, ssh -X)", () => {
  const env = (e: Record<string, string>) => inspectEnvironment({ env: e, osRelease: null, glibc: "2.28", versions: { node: "22" }, platform: "linux", arch: "x64", x11: true });
  it("an X display Ember can open is fine, whatever the session type says", () => {
    const r = env({ DISPLAY: ":55" });
    expect(r.checks.find(c => c.id === "session")).toMatchObject({ status: "ok", detail: "X11 on :55" });
  });
  it("WAYLAND_DISPLAY means Wayland even when the session type is unset", () => {
    expect(env({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }).checks.find(c => c.id === "session")?.status).toBe("fail");
  });
  it("a display Ember can't open is reported as such (not as a Wayland problem)", () => {
    const r = inspectEnvironment({ env: { DISPLAY: ":9" }, osRelease: null, glibc: "2.28", versions: { node: "22" }, platform: "linux", arch: "x64", x11: false });
    const c = r.checks.find(x => x.id === "session")!;
    expect(c.status).toBe("fail");
    expect(c.detail).not.toMatch(/GNOME on Xorg/);
  });
  it("shortcuts another app holds are named, with the way around them", () => {
    const r = inspectEnvironment({ env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" }, osRelease: null, glibc: "2.28", versions: { node: "22" }, platform: "linux", arch: "x64", shortcutsTaken: ["Control+Alt+X"] });
    expect(r.checks.find(c => c.id === "shortcuts")).toMatchObject({ status: "warn" });
    expect(r.checks.find(c => c.id === "shortcuts")?.detail).toMatch(/Ctrl\+Alt\+X.*handle/);
  });
});

describe("a desktop session Ember can't use, at start-up (review #240)", () => {
  it("is Wayland by the same rule the setup check uses", () => {
    expect(isWaylandSession({ XDG_SESSION_TYPE: "wayland" })).toBe(true);
    expect(isWaylandSession({ WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
    expect(isWaylandSession({ WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "x11" })).toBe(false);
    expect(isWaylandSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })).toBe(false);
    expect(isWaylandSession({ DISPLAY: ":99" })).toBe(false);
    expect(WAYLAND_REASON).toMatch(/^this is a Wayland session, so Ember can't take screenshots or use the mouse and keyboard here: .*GNOME on Xorg/);
  });

  it("is what Ember's greeting says instead of “I'll stay by your cursor”", () => {
    const wayland = inspectEnvironment({ ...base, env: { ...base.env, XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" } });
    expect(sessionGreeting(wayland)).toBe("This is a Wayland session, so I can't see your screen or use your mouse here. Log out, click the gear on the login screen, choose “GNOME on Xorg”, and log in again.");
    // In Ember's own voice throughout, never with the setup check's third-person detail appended.
    const display = "I can't reach your desktop's display: start me from inside your desktop session.";
    expect(sessionGreeting(inspectEnvironment({ ...base, env: {} }))).toBe(display);
    expect(sessionGreeting(inspectEnvironment({ ...base, env: { DISPLAY: ":7" }, x11: false }))).toBe(display);
    expect(sessionGreeting(inspectEnvironment(base))).toBeNull();
    // Another check failing (old glibc) isn't the session's: the greeting stays as it was.
    expect(sessionGreeting(inspectEnvironment({ ...base, glibc: "2.17" }))).toBeNull();
  });

  it("speaks of a Windows service session too", () => {
    const r = inspectEnvironment({ env: {}, osRelease: null, glibc: null, versions: { node: "22" }, platform: "win32", arch: "x64",
      windows: { build: 22631, elevated: false, session: "service", powershell: "full", dpiMixed: false } });
    expect(sessionGreeting(r)).toBe("I can't work in this session: start me from your desktop, not as a service.");
  });
});
