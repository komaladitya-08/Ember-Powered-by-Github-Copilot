/** M9: `ember doctor`, start at login, and the RPM's promises. */

import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
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

  it("gives each desktop-session problem its own fix", () => {
    const withSession = (detail: string) => {
      const p = probes();
      return byId(doctorChecks({ ...p, env: { ...p.env, checks: [...p.env.checks.filter(c => c.id !== "session"), { id: "session", label: "Desktop session", status: "fail", detail }] } }), "session").fix;
    };
    expect(withSession("Wayland session. Ember v1 needs “GNOME on Xorg”")).toMatch(/GNOME on Xorg/);
    expect(withSession("Ember can't connect to the X display :0.")).toMatch(/terminal inside your desktop/);
    expect(withSession("No X display. Start Ember from inside your desktop session")).not.toMatch(/Xorg/);
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

describe("the RPM's licences", () => {
  const spec = fs.readFileSync(path.resolve("packaging/rpm/ember.spec"), "utf8");
  const tag = /^License:\s*(.+)$/m.exec(spec)![1].split(/\s+AND\s+/);
  it("names the licence of every package it bundles (production, Linux x64 glibc)", () => {
    const lock = JSON.parse(fs.readFileSync(path.resolve("package-lock.json"), "utf8")) as { packages: Record<string, { dev?: boolean; license?: string; os?: string[]; cpu?: string[]; libc?: string[] }> };
    const skip = [/linuxmusl/, /@img[\\/]sharp-wasm32/, /@emnapi/, /node_modules[\\/]tslib$/]; // as stage.mjs
    const bundled = Object.entries(lock.packages).filter(([k, v]) => k && !v.dev && !skip.some(r => r.test(k))
      && (!v.os || v.os.includes("linux")) && (!v.cpu || v.cpu.includes("x64")) && (!v.libc || v.libc.includes("glibc")));
    expect(bundled.length).toBeGreaterThan(5);
    for (const [k, v] of bundled) for (const id of (v.license ?? "(none)").split(/\s+(?:AND|OR)\s+|[()]/).filter(Boolean)) expect(tag, k).toContain(id);
    for (const id of ["MIT", "BSD-3-Clause", "LGPL-2.1-or-later"]) expect(tag).toContain(id); // Electron, Chromium, FFmpeg
  });
  it("marks licence and notice files %license and sets plain modes before the sandbox helper's", () => {
    expect(spec).toMatch(/%%license \\1@I/);
    const install = spec.slice(spec.indexOf("%install"), spec.indexOf("%post"));
    expect(install).toMatch(/^chmod -R u=rwX,go=rX %\{buildroot\}\/opt\/ember$/m);
    expect(install.indexOf("chmod -R")).toBeLessThan(install.indexOf("files.list"));
  });
});

describe("the launchers", () => {
  // Each runs with a stand-in Ember that prints its arguments, as root (uid 0) or a normal user.
  const run = (script: string, args: string[], uid: number, display?: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-launcher-"));
    fs.mkdirSync(path.join(d, "bin"));
    fs.writeFileSync(path.join(d, "bin/id"), `#!/bin/sh\necho ${uid}\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(d, "ember"));
    fs.writeFileSync(path.join(d, "ember/ember"), '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(d, "launcher"), script.replace("APP=/opt/ember/ember", `APP=${d}/ember/ember`), { mode: 0o755 });
    return execFileSync("/bin/sh", [path.join(d, "launcher"), ...args], { encoding: "utf8", env: { PATH: `${d}/bin:/usr/bin:/bin`, ...(display ? { DISPLAY: display } : {}) } }).trim();
  };
  const launcher = fs.readFileSync(path.resolve("packaging/ember"), "utf8");
  const appRun = /<<'RUN'\n([\s\S]*?)\nRUN\n/.exec(fs.readFileSync(path.resolve("scripts/package/appimage.sh"), "utf8"))![1];
  it("run `ember doctor` without Chromium's sandbox only as root (it shows no web content)", () => {
    expect(run(launcher, ["doctor"], 0)).toBe("--doctor --ozone-platform=headless --no-sandbox");
    expect(run(launcher, ["doctor"], 0, ":0")).toBe("--doctor --ozone-platform=x11 --no-sandbox");
    expect(run(launcher, ["doctor"], 1000)).toBe("--doctor --ozone-platform=headless");
    expect(run(launcher, [], 0, ":0")).toBe("--ozone-platform=x11");
    expect(run(appRun, ["doctor"], 0)).toBe("--doctor --ozone-platform=headless --no-sandbox");
    const noUserNs = (() => { try { return fs.readFileSync("/proc/sys/user/max_user_namespaces", "utf8").trim() === "0"; } catch { return true; } })();
    expect(run(appRun, ["doctor"], 1000).includes("--no-sandbox")).toBe(noUserNs);
  });
});

describe("the glibc check (check-symvers.sh)", () => {
  const script = path.resolve("scripts/check-symvers.sh");
  const has = (t: string) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0;
  const bash = has("bash") ? execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim() : "bash";
  const run = (args: string[], PATH = process.env.PATH ?? "") => spawnSync(bash, [script, ...args], { encoding: "utf8", env: { ...process.env, PATH } });
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-symvers-"));
  it.skipIf(!has("file") || !has("objdump") || process.arch !== "x64")("fails closed", () => {
    expect(run([]).status).toBe(2);
    expect(run([path.join(dir(), "missing")]).status).toBe(2);
    // Without objdump it can't check anything.
    const tools = dir();
    fs.symlinkSync(execFileSync("sh", ["-c", "command -v file"], { encoding: "utf8" }).trim(), path.join(tools, "file"));
    expect(run([dir()], tools)).toMatchObject({ status: 2, stderr: expect.stringMatching(/objdump/) });
    // No binaries at all is a failure, not a pass.
    const empty = dir();
    fs.writeFileSync(path.join(empty, "lib.so"), "not an ELF");
    expect(run([empty])).toMatchObject({ status: 1, stdout: expect.stringMatching(/^FAIL no x86-64/m) });
    // A binary objdump can't read fails.
    const one = dir();
    fs.copyFileSync(fs.realpathSync(execFileSync("sh", ["-c", "command -v env"], { encoding: "utf8" }).trim()), path.join(one, "true"));
    fs.chmodSync(path.join(one, "true"), 0o755);
    expect(run([one]).stdout).toMatch(/^(ok {2}|FAIL) .*\/true/m);
    const broken = dir();
    fs.writeFileSync(path.join(broken, "objdump"), "#!/bin/sh\necho 'objdump: bad' >&2\nexit 1\n", { mode: 0o755 });
    expect(run([one], `${broken}:${process.env.PATH}`)).toMatchObject({ status: 1, stdout: expect.stringMatching(/^FAIL .*true: objdump couldn't read/m) });
  });
});
