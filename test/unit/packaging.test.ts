/** M9: `ember doctor`, start at login, and the RPM's promises. */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doctorChecks, formatDoctor, type DoctorProbes } from "../../app/main/doctor";
import { autostartEntry, autostartFile, execArg, launchCommand, syncAutostart } from "../../app/main/autostart";
import { inspectEnvironment } from "../../app/main/environment";
import { AdminPolicySchema } from "../../app/main/admin";

const goodEnv = inspectEnvironment({
  env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "GNOME" },
  osRelease: 'NAME="Red Hat Enterprise Linux"\nVERSION_ID="8.4"\nID="rhel"\nPRETTY_NAME="Red Hat Enterprise Linux 8.4 (Ootpa)"\n',
  glibc: "2.28", versions: { electron: "44.5.0", chrome: "140", node: "24" }, platform: "linux", arch: "x64",
  accessibility: { enabled: true, pyatspi: true },
});
const probes = (over: Partial<DoctorProbes> = {}): DoctorProbes => ({
  env: goodEnv, compositor: true, xtest: true, speechDispatcher: true, microphones: ["alsa_input.pci-0000_00_1f.3.analog-stereo"],
  voiceModels: "bundled", runtime: true, auth: { kind: "github", source: "stored" },
  admin: { policy: AdminPolicySchema.parse({}), source: null }, desk: { ok: true, missing: [] },
  sandbox: { userNamespaces: true, suidHelper: true }, ...over,
});
const byId = (checks: ReturnType<typeof doctorChecks>, id: string) => checks.find(c => c.id === id)!;

describe("ember doctor", () => {
  it("is all green on a well set-up RHEL 8.4 GNOME on Xorg desktop", () => {
    const checks = doctorChecks(probes());
    expect(checks.filter(c => c.status !== "ok")).toEqual([]);
    expect(formatDoctor(checks)).toMatch(/Everything Ember needs is in place\.$/);
  });

  it("explains every problem with what to do", () => {
    const checks = doctorChecks(probes({
      env: inspectEnvironment({ env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }, osRelease: null, glibc: "2.28", versions: { electron: "44", chrome: "140", node: "24" }, platform: "linux", arch: "x64", accessibility: { enabled: false, pyatspi: false } }),
      compositor: false, xtest: false, speechDispatcher: false, microphones: null, voiceModels: "missing", auth: null,
      desk: { ok: false, missing: ["Xvfb"] },
    }));
    for (const c of checks.filter(x => x.status !== "ok" && !["os", "desktop"].includes(x.id))) expect(c.fix, c.id).toBeTruthy();
    expect(byId(checks, "session")).toMatchObject({ status: "fail" });
    expect(byId(checks, "session").fix).toMatch(/GNOME on Xorg/);
    expect(byId(checks, "accessibility").fix).toMatch(/python3-pyatspi/);
    expect(byId(checks, "copilot").fix).toMatch(/Sign in with GitHub|gh auth login/);
    expect(byId(checks, "desk").fix).toMatch(/xorg-x11-server-Xvfb/);
    expect(formatDoctor(checks)).toMatch(/problem.* to fix before Ember can work/);
  });

  it("fails when the installation is broken or the organisation policy is", () => {
    expect(byId(doctorChecks(probes({ runtime: false })), "copilot").status).toBe("fail");
    const locked = doctorChecks(probes({ admin: { policy: AdminPolicySchema.parse({}), source: "/etc/ember/policy.json", error: "features.voice: expected boolean" } }));
    expect(byId(locked, "policy")).toMatchObject({ status: "fail", detail: expect.stringMatching(/locked down/) });
  });

  it("accepts the setuid helper on STIG hosts and fails only with neither sandbox", () => {
    expect(byId(doctorChecks(probes({ sandbox: { userNamespaces: false, suidHelper: true } })), "sandbox")).toMatchObject({ status: "ok", detail: expect.stringMatching(/setuid/) });
    expect(byId(doctorChecks(probes({ sandbox: { userNamespaces: false, suidHelper: false } })), "sandbox")).toMatchObject({ status: "fail", fix: expect.stringMatching(/chmod 4755/) });
  });

  it("names the organisation's endpoint when there is one", () => {
    expect(byId(doctorChecks(probes({ auth: { kind: "provider", host: "ai.example.org" } })), "copilot").detail).toMatch(/ai\.example\.org/);
  });
});

describe("start at login", () => {
  it("starts the right Ember", () => {
    expect(launchCommand({ packaged: true, execPath: "/opt/ember/ember", appPath: "/opt/ember/resources/app", env: {}, exists: p => p === "/usr/bin/ember" })).toEqual(["/usr/bin/ember"]);
    expect(launchCommand({ packaged: true, execPath: "/tmp/.mount_EmberX/ember/ember", appPath: "", env: { APPIMAGE: "/home/ada/Apps/Ember.AppImage" } })).toEqual(["/home/ada/Apps/Ember.AppImage"]);
    expect(launchCommand({ packaged: false, execPath: "/repo/node_modules/electron/dist/electron", appPath: "/repo", env: {} })).toEqual(["/repo/node_modules/electron/dist/electron", "/repo"]);
  });

  it("quotes Exec arguments per the Desktop Entry spec", () => {
    expect(execArg("/usr/bin/ember")).toBe("/usr/bin/ember");
    expect(execArg("/home/ada/My Apps/Ember.AppImage")).toBe('"/home/ada/My Apps/Ember.AppImage"');
    expect(execArg('a"b$c')).toBe('"a\\\\"b\\\\$c"');
    expect(autostartEntry(["/usr/bin/ember"])).toContain("Exec=/usr/bin/ember --autostart\n");
  });

  it("writes, keeps and removes the autostart entry to match the setting", () => {
    const file = autostartFile({ XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "ember-xdg-")) });
    expect(syncAutostart(true, ["/usr/bin/ember"], file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toMatch(/X-GNOME-Autostart-enabled=true/);
    expect(syncAutostart(true, ["/usr/bin/ember"], file)).toBe(false);
    expect(syncAutostart(false, ["/usr/bin/ember"], file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(syncAutostart(false, ["/usr/bin/ember"], file)).toBe(false);
  });
});

describe("the RPM", () => {
  const spec = fs.readFileSync(path.resolve("packaging/rpm/ember.spec"), "utf8");
  it("installs the sandbox helper setuid root, for hosts without user namespaces", () => {
    expect(spec).toMatch(/^%attr\(4755, root, root\) \/opt\/ember\/chrome-sandbox$/m);
  });
  it("lists its libraries explicitly and keeps optional parts optional", () => {
    expect(spec).toMatch(/^AutoReqProv:\s+no$/m);
    for (const dep of ["gtk3", "nss", "libXtst", "python3-pyatspi", "platform-python"]) expect(spec).toMatch(new RegExp(`^Requires:.*\\b${dep}\\b`, "m"));
    for (const dep of ["xorg-x11-server-Xvfb", "speech-dispatcher", "gnome-shell-extension-top-icons", "ember-voice-models"]) expect(spec).toMatch(new RegExp(`^Recommends:.*\\b${dep}\\b`, "m"));
  });
  it("puts speech models where Ember looks for them", () => {
    expect(spec).toContain("%{_datadir}/ember/voice-models");
    expect(fs.readFileSync(path.resolve("app/main/main.ts"), "utf8")).toContain('"/usr/share/ember/voice-models"');
  });
});
