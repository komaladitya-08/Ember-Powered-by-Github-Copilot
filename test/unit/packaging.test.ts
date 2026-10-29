/** M9: `ember doctor`, start at login, the RPM's promises, and the Windows and macOS packages (M11). */

import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TARGETS, layoutFor, selectPackages } from "../../scripts/package/layout.mjs";
import { ICONSET, ICO_SIZES, icoFromPngs } from "../../scripts/package/icon.mjs";
import { BUNDLE_ID, ENTITLEMENTS, EXECUTABLE, FORBIDDEN_ENTITLEMENTS, entitlementsPlist, finishMacBundle, infoPlistValues, type RunResult } from "../../scripts/package/mac-bundle.mjs";
import { certificateTable, exeResourceMismatches, exeVersionStrings, numericVersion, readExeResources, rewriteExeResources } from "../../scripts/package/exe-resources.mjs";
import { SENTINEL, emberFuses, flipFuses, fuseMismatches, readFuses } from "../../scripts/package/fuses.mjs";
import * as ResEdit from "resedit";
import { doctorChecks, formatDoctor, type DoctorCheck, type DoctorProbes } from "../../app/main/doctor";
import { checkDoctorRows, parseDoctorReport, parseExpectation } from "../../scripts/package/doctor-rows.mjs";
import {
  APPLE_EVENTS, SYSTEM_DB, SYSTEM_EVENTS, SYSTEM_EVENTS_REQUIREMENT, SYSTEM_SERVICES, ancestors, appleAnchorRequirement, approveCapture, bundleGrants,
  captureApprovals, designatedRequirement,
  grantBundle, grantPaths, parsePs, pathGrants, restartTccd, showSql, transaction, userDb, type Run,
} from "../../scripts/package/tcc.mjs";
import { createRequire } from "node:module";
import { autostartEntry, autostartFile, execArg, launchCommand, syncAutostart } from "../../app/main/autostart";
import { inspectEnvironment } from "../../app/main/environment";
import { AdminPolicySchema, commandMode, parseAdminPolicy } from "../../app/main/admin";

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
  it("warns when the file watchers Copilot needs are nearly used up", () => {
    expect(byId(doctorChecks({ ...probes(), fileWatchers: { used: 40, max: 128 } }), "file-watchers")).toMatchObject({ status: "ok", detail: "40 of 128 in use." });
    const low = byId(doctorChecks({ ...probes(), fileWatchers: { used: 124, max: 128 } }), "file-watchers");
    expect(low.status).toBe("warn");
    expect(low.fix).toMatch(/max_user_instances=512/);
    expect(byId(doctorChecks({ ...probes(), fileWatchers: { used: 128, max: 128 } }), "file-watchers").status).toBe("fail");
    expect(doctorChecks({ ...probes(), fileWatchers: null }).some(c => c.id === "file-watchers")).toBe(false);
  });

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

  it("only warns about the sandbox in an AppImage on a host with user namespaces off, with no chown for files it lacks", () => {
    // AppRun starts Ember there with --no-sandbox on purpose: an AppImage can't carry a setuid helper.
    const checks = doctorChecks(probes({ sandbox: { userNamespaces: false, suidHelper: false, appImage: true } }));
    const row = byId(checks, "sandbox");
    expect(row).toMatchObject({ status: "warn", label: "Window sandbox", detail: expect.stringMatching(/without Chromium's sandbox/), fix: expect.stringMatching(/RPM/) });
    expect(`${row.detail} ${row.fix}`).not.toMatch(/chown|chmod|\/opt\/ember/);
    expect(formatDoctor(checks)).toMatch(/Ember can work\. 1 thing worth a look\.$/);
    // With user namespaces the AppImage sandboxes as usual.
    expect(byId(doctorChecks(probes({ sandbox: { userNamespaces: true, suidHelper: false, appImage: true } })), "sandbox").status).toBe("ok");
  });

  it("gives each desktop-session problem its own fix", () => {
    const withSession = (detail: string) => {
      const p = probes();
      return byId(doctorChecks({ ...p, env: { ...p.env, checks: [...p.env.checks.filter(c => c.id !== "session"), { id: "session", label: "Desktop session", status: "fail", detail }] } }), "session").fix;
    };
    expect(withSession("Wayland session. Ember needs “GNOME on Xorg”")).toMatch(/GNOME on Xorg/);
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

  it("doubles a % in an Exec argument, which the Desktop Entry spec reserves for field codes", () => {
    expect(execArg("/home/ada/100%/Ember.AppImage")).toBe('"/home/ada/100%%/Ember.AppImage"');
    expect(execArg("/home/ada/50%AB/Ember.AppImage")).toBe('"/home/ada/50%%AB/Ember.AppImage"');
    expect(autostartEntry(["/home/ada/Tools 100% Free/Ember.AppImage"])).toContain('Exec="/home/ada/Tools 100%% Free/Ember.AppImage" --autostart\n');
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
  it("ships an example policy that takes the current keys, so copying it as-is turns nothing off (review #208, #37)", () => {
    const example = fs.readFileSync(path.resolve("packaging/policy.example.json"), "utf8");
    const loaded = parseAdminPolicy(example, "/etc/ember/policy.json");
    expect(loaded.error).toBeUndefined();
    // A policy without `commands` turns commands off on every kind of target (R5): the example says "on" for each.
    for (const kind of ["local", "wsl", "ssh"] as const) expect(commandMode(loaded, kind), kind).toBe("on");
    expect(loaded.policy.features).toMatchObject({ wsl: true, ssh: true });
    // SSH reaches every computer, so the Computers tab mustn't say "only some computers": main marks SSH as limited
    // whenever ssh.allowedHosts is set, even to ["*"] (review #208). The README shows the allowedHosts form instead.
    expect(loaded.policy.ssh).toEqual({ desktop: true });
    expect(loaded.policy.ssh?.allowedHosts).toBeUndefined();
    // The README beside it names every key the policy takes, and the rule about `commands`.
    const readme = fs.readFileSync(path.resolve("packaging/policy.README"), "utf8");
    for (const key of Object.keys(AdminPolicySchema.shape)) expect(readme, key).toContain(`"${key}"`);
    expect(readme).toMatch(/without "commands" turns commands off/);
    expect(readme).toMatch(/"ssh": \{ "allowedHosts": \[/);
    for (const f of ["policy.example.json", "policy.README"]) {
      expect(spec).toContain(`install -Dm644 ${f} %{buildroot}%{_docdir}/ember/${f}`);
      expect(spec).toContain(`%doc %{_docdir}/ember/${f}`);
      expect(fs.readFileSync(path.resolve("scripts/package/rpm.sh"), "utf8")).toMatch(new RegExp(`"\\$root/packaging/${f.replace(".", "\\.")}"`));
    }
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
  it("names the licence of every package the Windows and macOS builds bundle too (one tag for every target)", () => {
    const lock = JSON.parse(fs.readFileSync(path.resolve("package-lock.json"), "utf8")) as { packages: Record<string, { dev?: boolean; license?: string }> };
    for (const target of TARGETS) {
      const { bundle, missing } = selectPackages(Object.keys(lock.packages).filter(k => k && !lock.packages[k].dev), layoutFor(target.split("-")[0], target.split("-")[1]));
      expect(missing, target).toEqual([]);
      for (const k of bundle) for (const id of (lock.packages[k].license ?? "(none)").split(/\s+(?:AND|OR)\s+|[()]/).filter(Boolean)) expect(tag, `${target}: ${k}`).toContain(id);
    }
  });
  it("marks licence and notice files %license and sets plain modes before the sandbox helper's", () => {
    expect(spec).toMatch(/%%license \\1@I/);
    const install = spec.slice(spec.indexOf("%install"), spec.indexOf("%post"));
    expect(install).toMatch(/^chmod -R u=rwX,go=rX %\{buildroot\}\/opt\/ember$/m);
    expect(install.indexOf("chmod -R")).toBeLessThan(install.indexOf("files.list"));
  });
});

// The RPM's scriptlet run with /bin/sh (which Windows doesn't have) against a stand-in /proc.
describe.skipIf(process.platform === "win32")("the RPM's upgrade (review #203)", () => {
  const spec = fs.readFileSync(path.resolve("packaging/rpm/ember.spec"), "utf8");
  const posttrans = /^%posttrans\n([\s\S]*?)\n(?=%files)/m.exec(spec)![1];
  /** %posttrans with these processes running: each pid's /proc/<pid>/exe link says where its program is. */
  const after = (exes: Record<string, string>) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-posttrans-"));
    for (const [pid, exe] of Object.entries(exes)) {
      fs.mkdirSync(path.join(d, "proc", pid), { recursive: true });
      fs.symlinkSync(exe, path.join(d, "proc", pid, "exe"));
    }
    const script = posttrans.replace(/^\/usr\/bin\/gtk-update-icon-cache .*$/m, ":").split("/proc/").join(`${d}/proc/`);
    return spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
  };
  it("tells whoever upgrades that a running Ember must be started again to finish the update", () => {
    // rpm replaced the file under the running Ember, so its link ends in " (deleted)".
    for (const exe of ["/opt/ember/ember (deleted)", "/opt/ember/ember"]) {
      const r = after({ 1: "/usr/lib/systemd/systemd", 4242: exe, 4243: exe });
      expect(r.status, exe).toBe(0);
      expect(r.stdout).toBe("Ember is still running the version before this update: quit Ember and start it again (each person using it on this computer) to finish the update.\n");
    }
  });
  it("says nothing when no Ember from /opt/ember runs (an AppImage is another Ember)", () => {
    const r = after({ 1: "/usr/lib/systemd/systemd", 77: "/tmp/.mount_EmberX/ember/ember", 78: "/opt/ember-old/ember" });
    expect(r).toMatchObject({ status: 0, stdout: "" });
    expect(after({})).toMatchObject({ status: 0, stdout: "" });
  });
});

// The RPM's and the AppImage's sh launchers, run with /bin/sh (which Windows doesn't have).
describe.skipIf(process.platform === "win32")("the launchers", () => {
  // Each runs with a stand-in Ember that prints its arguments, as root (uid 0) or a normal user.
  const stage = (script: string, uid: number) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-launcher-"));
    fs.mkdirSync(path.join(d, "bin"));
    fs.writeFileSync(path.join(d, "bin/id"), `#!/bin/sh\necho ${uid}\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(d, "ember"));
    fs.writeFileSync(path.join(d, "ember/ember"), '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(d, "launcher"), script.replace("APP=/opt/ember/ember", `APP=${d}/ember/ember`), { mode: 0o755 });
    return d;
  };
  const env = (d: string, display?: string) => ({ PATH: `${d}/bin:/usr/bin:/bin`, ...(display ? { DISPLAY: display } : {}) });
  const run = (script: string, args: string[], uid: number, display?: string) => {
    const d = stage(script, uid);
    return execFileSync("/bin/sh", [path.join(d, "launcher"), ...args], { encoding: "utf8", env: env(d, display) }).trim();
  };
  /** As run, but keeps the exit status and stderr. */
  const attempt = (script: string, args: string[], uid: number, display?: string) => {
    const d = stage(script, uid);
    return spawnSync("/bin/sh", [path.join(d, "launcher"), ...args], { encoding: "utf8", env: env(d, display) });
  };
  const launcher = fs.readFileSync(path.resolve("packaging/ember"), "utf8");
  const appRun = /<<'RUN'\n([\s\S]*?)\nRUN\n/.exec(fs.readFileSync(path.resolve("scripts/package/appimage.sh"), "utf8"))![1];
  it("run `ember doctor` without Chromium's sandbox only as root (it shows no web content)", () => {
    expect(run(launcher, ["doctor"], 0)).toBe("--doctor --ozone-platform=headless --disable-gpu --no-sandbox");
    expect(run(launcher, ["doctor"], 0, ":0")).toBe("--doctor --ozone-platform=x11 --disable-gpu --no-sandbox");
    expect(run(launcher, ["doctor"], 1000)).toBe("--doctor --ozone-platform=headless --disable-gpu");
    expect(run(launcher, [], 0, ":0")).toBe("--ozone-platform=x11");
    expect(run(appRun, ["doctor"], 0)).toBe("--doctor --ozone-platform=headless --disable-gpu --no-sandbox");
    const noUserNs = (() => { try { return fs.readFileSync("/proc/sys/user/max_user_namespaces", "utf8").trim() === "0"; } catch { return true; } })();
    expect(run(appRun, ["doctor"], 1000).includes("--no-sandbox")).toBe(noUserNs);
  });
  it("start the AppImage without Chromium's sandbox where either switch the doctor reads turns user namespaces off (review #202)", () => {
    // A stand-in /proc/sys: the AppRun reads the same two files as the Linux doctor probe (doctor-probes.ts).
    const withProc = (files: Record<string, string>) => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-proc-"));
      for (const [f, v] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), `${v}\n`); }
      return appRun.replaceAll("/proc/sys/", `${d}/`);
    };
    const sandboxOff = (files: Record<string, string>) => run(withProc(files), [], 1000, ":0").includes("--no-sandbox");
    expect(sandboxOff({ "user/max_user_namespaces": "0" })).toBe(true);
    // Debian and some hardened Ubuntu hosts: namespaces counted, but unprivileged ones refused.
    expect(sandboxOff({ "user/max_user_namespaces": "15000", "kernel/unprivileged_userns_clone": "0" })).toBe(true);
    expect(sandboxOff({ "user/max_user_namespaces": "15000", "kernel/unprivileged_userns_clone": "1" })).toBe(false);
    expect(sandboxOff({ "user/max_user_namespaces": "15000" })).toBe(false);
    expect(sandboxOff({})).toBe(true);
    expect(appRun.match(/\/proc\/sys\/[\w/]+/g)?.sort()).toEqual(["/proc/sys/kernel/unprivileged_userns_clone", "/proc/sys/user/max_user_namespaces"]);
  });
  it("say Ember needs the desktop session when there is no display, instead of starting into Chromium's error", () => {
    for (const [script, doctor] of [[launcher, "ember doctor"], [appRun, "Ember.AppImage doctor"]]) {
      for (const args of [[], ["--show-settings"]]) {
        const r = attempt(script, args, 1000);
        expect(r.status, `${doctor} ${args.join(" ")}`).toBe(1);
        // The stand-in Ember never ran.
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe(`Ember needs your desktop session (no display here). Run it from a terminal inside GNOME, or run '${doctor}'.\n`);
      }
      expect(attempt(script, [], 1000, ":0")).toMatchObject({ status: 0, stdout: expect.stringMatching(/--ozone-platform=x11/) });
    }
  });
});

// glibc symbol versions of x86-64 ELF binaries: Linux only (macOS's binaries are Mach-O, Windows's are PE).
describe.skipIf(process.platform !== "linux")("the glibc check (check-symvers.sh)", () => {
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

describe("the Windows icon", () => {
  const png = (n: number) => Buffer.from(`\x89PNG fake ${n}`, "latin1");
  it("is an .ico of PNG images, 16 to 256 pixels, with 256 written as 0", () => {
    const ico = icoFromPngs(ICO_SIZES.map(size => ({ size, png: png(size) })));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(ICO_SIZES.length);
    let expected = 6 + 16 * ICO_SIZES.length;
    ICO_SIZES.forEach((size, i) => {
      const e = 6 + 16 * i;
      expect(ico[e]).toBe(size === 256 ? 0 : size);
      expect(ico[e + 1]).toBe(size === 256 ? 0 : size);
      expect(ico.readUInt16LE(e + 6)).toBe(32);
      const [length, offset] = [ico.readUInt32LE(e + 8), ico.readUInt32LE(e + 12)];
      expect(offset).toBe(expected);
      expect(ico.subarray(offset, offset + length).equals(png(size))).toBe(true);
      expected += length;
    });
    expect(ico.length).toBe(expected);
    expect(ICO_SIZES).toContain(256);
  });
  it("refuses sizes the format can't hold", () => {
    expect(() => icoFromPngs([])).toThrow(/at least one/);
    expect(() => icoFromPngs([{ size: 512, png: png(1) }])).toThrow(/1 to 256/);
  });
});

describe("Ember.exe's identity (exe-resources.mjs)", () => {
  const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer;
  const section = (name: string, size: number, characteristics: number) => ({
    name, virtualSize: size, virtualAddress: 0, sizeOfRawData: 0, pointerToRawData: 0, pointerToRelocations: 0,
    pointerToLineNumbers: 0, numberOfRelocations: 0, numberOfLineNumbers: 0, characteristics,
  });
  // As big as real ones (Ember's add up to about 18 KB, more than Electron's three), so the resources grow.
  const fakePng = (size: number, fill: number) => Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(size * 32, fill)]);
  const RDATA = Buffer.concat([Buffer.alloc(256, 0x11), Buffer.from(SENTINEL, "latin1"), Buffer.from([1, 9]), Buffer.from("101100011", "latin1"), Buffer.alloc(256, 0x22)]);
  const RELOC = Buffer.alloc(64, 0x5a);
  const CERT = Buffer.concat([Buffer.from([24, 0, 0, 0, 0x00, 0x02, 0x02, 0x00]), Buffer.from("EMBER-TEST-CERT!", "latin1")]);
  const ELECTRON = {
    CompanyName: "GitHub, Inc.", FileDescription: "Electron", FileVersion: "44.5.0", InternalName: "electron.exe",
    LegalCopyright: "Copyright (C) 2015 GitHub, Inc. All rights reserved.", OriginalFilename: "electron.exe",
    ProductName: "Electron", ProductVersion: "44.5.0",
  };
  /**
   * A stand-in for electron.exe, laid out like it: .rdata holding the fuse wire, then Electron's version resource and
   * icons, then .reloc, which moves when the resources grow; signed (a certificate table at the end) unless told not.
   */
  const fakeElectronExe = (o: { signed?: boolean; resources?: boolean } = {}) => {
    const exe = ResEdit.NtExecutable.createEmpty(false, false);
    exe.setSectionByEntry(ResEdit.Format.ImageDirectoryEntry.GlobalPointer, { info: section(".rdata", RDATA.length, 0x40000040), data: ab(RDATA) });
    if (o.resources !== false) {
      const res = ResEdit.NtExecutableResource.from(exe);
      ResEdit.Resource.VersionInfo.create(1033, { fileVersionMS: (44 << 16) | 5, fileVersionLS: 0, productVersionMS: (44 << 16) | 5, productVersionLS: 0 },
        [{ lang: 1033, codepage: 1200, values: ELECTRON }]).outputToResourceEntries(res.entries);
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, [16, 32, 48].map(n => ResEdit.Data.RawIconItem.from(fakePng(n, 0xee), n, n, 32)));
      res.outputResource(exe);
    }
    exe.setSectionByEntry(ResEdit.Format.ImageDirectoryEntry.BaseRelocation, { info: section(".reloc", RELOC.length, 0x42000040), data: ab(RELOC) });
    const unsigned = Buffer.from(exe.generate());
    if (o.signed === false) return unsigned;
    // A WIN_CERTIFICATE after the image, which the data directory's security entry points at by file offset.
    const signed = Buffer.concat([unsigned, CERT]);
    const raw = ab(signed);
    const dos = ResEdit.Format.ImageDosHeader.from(raw);
    const nt = ResEdit.Format.ImageNtHeaders.from(raw, dos.newHeaderAddress);
    ResEdit.Format.ImageDataDirectoryArray.from(raw, dos.newHeaderAddress + nt.getDataDirectoryOffset())
      .set(ResEdit.Format.ImageDirectoryEntry.Certificate, { virtualAddress: unsigned.length, size: CERT.length });
    return Buffer.from(raw);
  };
  const ico = icoFromPngs(ICO_SIZES.map(size => ({ size, png: fakePng(size, size & 0xff) })));
  const identity = { version: "1.2.3", company: "komaladitya-08", ico };

  it("says Ember, at Ember's version, from its owner, with Ember's icon in every size, and drops the voided signature (W12)", () => {
    const electron = fakeElectronExe();
    expect(certificateTable(electron)).toEqual({ offset: electron.length - CERT.length, size: CERT.length });
    expect(() => ResEdit.NtExecutable.from(electron)).toThrow(/signed/); // the fixture is signed as resedit sees it
    const ember = rewriteExeResources(electron, identity);
    const read = readExeResources(ember);
    expect(read.signed).toBe(false);
    expect(certificateTable(ember)).toEqual({ offset: 0, size: 0 });
    expect(ember.includes(Buffer.from("EMBER-TEST-CERT!", "latin1"))).toBe(false);
    expect(read.versions).toHaveLength(1);
    expect(read.versions[0]).toMatchObject({ fileVersion: [1, 2, 3, 0], productVersion: [1, 2, 3, 0] });
    expect(read.versions[0].strings).toEqual([{
      lang: 1033, codepage: 1200, values: {
        ...ELECTRON, // Electron's copyright stays: the code is Electron's
        CompanyName: "komaladitya-08", FileDescription: "Ember", ProductName: "Ember", InternalName: "Ember.exe", OriginalFilename: "Ember.exe",
        FileVersion: "1.2.3", ProductVersion: "1.2.3",
      },
    }]);
    expect(read.iconGroups).toEqual([{
      id: 1, lang: 1033, icons: ICO_SIZES.map(size => ({ width: size, height: size, bitCount: 32, dataSize: fakePng(size, 0).length })),
    }]);
    expect(exeResourceMismatches(read, identity)).toEqual([]);
    expect(electron.includes(Buffer.from("EMBER-TEST-CERT!", "latin1"))).toBe(true); // the input is left as it was
  });

  it("keeps the fuse wire where stage.mjs flips it, and the sections that move after the resources intact", () => {
    const electron = fakeElectronExe();
    const ember = rewriteExeResources(electron, identity);
    expect(readFuses(ember)).toEqual(readFuses(electron));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-exe-")), "Ember.exe");
    fs.writeFileSync(file, ember);
    expect(fuseMismatches(flipFuses(file, emberFuses("win32")), emberFuses("win32"))).toEqual([]);
    const sections = (bin: Buffer) => ResEdit.NtExecutable.from(bin, { ignoreCert: true });
    const before = sections(electron), after = sections(ember);
    const reloc = (exe: ReturnType<typeof sections>) => exe.getSectionByEntry(ResEdit.Format.ImageDirectoryEntry.BaseRelocation)!;
    // The icons made the resources bigger, so .reloc moved; its directory entry moved with it.
    expect(reloc(after).info.virtualAddress).toBeGreaterThan(reloc(before).info.virtualAddress);
    expect(Buffer.from(reloc(after).data!).subarray(0, RELOC.length).equals(RELOC)).toBe(true);
    expect(Buffer.from(after.getSectionByEntry(ResEdit.Format.ImageDirectoryEntry.GlobalPointer)!.data!).subarray(0, RDATA.length).equals(RDATA)).toBe(true);
  });

  it("gives an unsigned executable, or one without a version resource or icon, the same identity", () => {
    for (const exe of [fakeElectronExe({ signed: false }), fakeElectronExe({ resources: false })]) {
      const read = readExeResources(rewriteExeResources(exe, identity));
      expect(exeResourceMismatches(read, identity)).toEqual([]);
      expect(read.versions[0].strings[0].values).toMatchObject(exeVersionStrings(identity));
      expect(read.iconGroups.map(g => g.id)).toEqual([1]);
    }
  });

  it("says what is still Electron's in an executable it didn't rewrite", () => {
    const problems = exeResourceMismatches(readExeResources(fakeElectronExe()), identity);
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/certificate table/),
      "file version 44.5.0.0, should be 1.2.3.0",
      'FileDescription (language 1033) is "Electron", should be "Ember"',
      expect.stringMatching(/^icon group 1 holds 16x16\/32\/\d+ 32x32/),
    ]));
  });

  it("carries a version Windows can hold, and refuses one it can't or a file that isn't an executable", () => {
    expect(numericVersion("0.1.0")).toEqual([0, 1, 0, 0]);
    expect(numericVersion("1.2.3.4")).toEqual([1, 2, 3, 4]);
    expect(numericVersion("1.2.3-beta.4+build.5")).toEqual([1, 2, 3, 0]);
    for (const bad of ["1.2", "v1.2.3", "1.2.3 ", "70000.0.0"]) expect(() => numericVersion(bad), bad).toThrow();
    expect(() => certificateTable(Buffer.from("#!/bin/sh\necho not a PE\n".padEnd(128, " ")))).toThrow(/not a Windows executable/);
    expect(() => rewriteExeResources(fakeElectronExe(), { ...identity, ico: Buffer.from([0, 0, 1, 0, 0, 0]) })).toThrow(/no images/);
  });

  it("is written before the fuses are flipped, so they are checked in the bytes that ship", () => {
    const stage = fs.readFileSync(path.resolve("scripts/package/stage.mjs"), "utf8");
    const at = (s: string) => { const i = stage.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    expect(at("rewriteExeResources(fs.readFileSync(exe), identity)")).toBeLessThan(at("flipFuses(path.join(app, layout.fuseFile)"));
    expect(at("exeResourceMismatches(read, identity)")).toBeLessThan(at("flipFuses(path.join(app, layout.fuseFile)"));
    expect(at("await writeIco(")).toBeLessThan(at("rewriteExeResources("));
    expect(stage).not.toMatch(/TODO\(port\): set Ember\.exe/);
  });
});

describe("the macOS app bundle", () => {
  it("has every image iconutil needs for an .icns", () => {
    expect(ICONSET.map(i => `${i.name}:${i.size}`)).toEqual([
      "icon_16x16.png:16", "icon_16x16@2x.png:32", "icon_32x32.png:32", "icon_32x32@2x.png:64", "icon_128x128.png:128",
      "icon_128x128@2x.png:256", "icon_256x256.png:256", "icon_256x256@2x.png:512", "icon_512x512.png:512", "icon_512x512@2x.png:1024",
    ]);
  });

  it("says “Ember” in Info.plist, with a bundle id macOS accepts and the texts its prompts show", () => {
    const values = Object.fromEntries(infoPlistValues("1.2.3").map(([k, , v]) => [k, v]));
    expect(BUNDLE_ID).toBe("io.github.komaladitya08.ember");
    expect(BUNDLE_ID).toMatch(/^[A-Za-z0-9.-]+$/); // no "_": TCC and LaunchServices refuse it
    expect(values).toMatchObject({
      CFBundleName: "Ember", CFBundleDisplayName: "Ember", CFBundleIdentifier: BUNDLE_ID, CFBundleShortVersionString: "1.2.3", CFBundleVersion: "1.2.3",
      CFBundleIconFile: "ember.icns", LSApplicationCategoryType: "public.app-category.productivity", LSMinimumSystemVersion: "13.0", NSHighResolutionCapable: true,
      NSMicrophoneUsageDescription: "Ember listens for “Hey Ember” on this Mac only when you turn it on. Audio never leaves your Mac.",
    });
    expect(values.NSAppleEventsUsageDescription).toMatch(/appearance settings.*when you ask/);
    // macOS 15's Local Network prompt names SSH too: Ember's ssh reaches computers on the local network (§5.1.8).
    expect(values.NSLocalNetworkUsageDescription).toBe("Ember connects to your organisation's model service or proxy, and to computers you connect to over SSH, when they are on your local network.");
    // The executable stage.mjs renamed (layout.mjs), so that Electron's app.isPackaged is true.
    expect(values.CFBundleExecutable).toBe(EXECUTABLE);
    expect(layoutFor("darwin", "arm64").exe).toBe(`Contents/MacOS/${EXECUTABLE}`);
  });

  /**
   * A stand-in for plutil, iconutil, xattr and codesign that keeps Info.plist as a map. codesign --display reports the
   * flags and entitlements the signing call asked for, unless `runtime` is false or `extra` adds an entitlement.
   */
  const fakeMac = (o: { ignore?: string; verifyFails?: boolean; noExecutable?: boolean; runtime?: boolean; extra?: string } = {}) => {
    const plist: Record<string, string> = { CFBundleName: "Electron", CFBundleIdentifier: "com.github.Electron", CFBundleExecutable: "Electron", ElectronAsarIntegrity: "<dict/>" };
    const calls: string[][] = [];
    const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
    let signed = { runtime: false, entitlements: "" };
    const run = (file: string, args: string[]): RunResult => {
      calls.push([file, ...args]);
      if (file === "plutil" && args[0] === "-replace") {
        if (args[1] !== o.ignore) plist[args[1]] = args[2] === "-bool" ? String(args[3] === "YES") : args[3];
        return ok();
      }
      if (file === "plutil" && args[0] === "-extract") {
        expect(args.slice(3, 5)).toEqual(["-o", "-"]); // without -o, plutil would overwrite the file
        // Like plutil: raw prints strings, numbers and booleans only (ElectronAsarIntegrity is a dictionary).
        if (args[2] === "raw" && plist[args[1]]?.startsWith("<dict")) return { status: 1, stdout: "", stderr: "not a raw value" };
        return args[1] in plist ? ok(`${plist[args[1]]}\n`) : { status: 1, stdout: "", stderr: "No value at that key path." };
      }
      if (file === "plutil" && args[0] === "-remove") { delete plist[args[1]]; return ok(); }
      if (file === "iconutil") { fs.writeFileSync(args[args.indexOf("-o") + 1], "icns"); return ok(); }
      if (file === "codesign" && args[0] === "--verify" && o.verifyFails) return { status: 1, stdout: "", stderr: "a sealed resource is missing or invalid" };
      if (file === "codesign" && args[0] === "--force") {
        const at = args.indexOf("--entitlements");
        signed = { runtime: args[args.indexOf("--options") + 1] === "runtime" && o.runtime !== false, entitlements: at > 0 ? fs.readFileSync(args[at + 1], "utf8") : "" };
        return ok();
      }
      if (file === "codesign" && args.join(" ") === `--display --verbose=2 ${args.at(-1)}`) {
        return { status: 0, stdout: "", stderr: `Executable=${args.at(-1)}/Contents/MacOS/Ember\nCodeDirectory v=20500 size=1234 flags=${signed.runtime ? "0x10002(adhoc,runtime)" : "0x2(adhoc)"} hashes=30+7 location=embedded\n` };
      }
      if (file === "codesign" && args.join(" ") === `--display --entitlements - --xml ${args.at(-1)}`) {
        return ok(signed.entitlements.replace("</dict>", o.extra ? `<key>${o.extra}</key><true/></dict>` : "</dict>").replace(/\n\s*/g, ""));
      }
      return ok();
    };
    const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-bundle-")), "Ember.app");
    fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
    fs.mkdirSync(path.join(app, "Contents", "MacOS"));
    if (!o.noExecutable) fs.writeFileSync(path.join(app, "Contents", "MacOS", EXECUTABLE), "");
    fs.writeFileSync(path.join(app, "Contents", "Info.plist"), "<plist/>");
    fs.writeFileSync(path.join(app, "Contents", "Resources", "electron.icns"), "electron");
    const iconsets: string[] = [];
    const writeIconset = async (_svg: string, dir: string) => { iconsets.push(dir); };
    const finish = () => finishMacBundle({ app, version: "0.1.0", svg: "ember.svg", tmp: path.dirname(app), run, writeIconset });
    return { plist, calls, app, iconsets, finish };
  };

  it("edits Info.plist, reads every value back, adds the icon, and signs ad hoc last", async () => {
    const mac = fakeMac();
    await mac.finish();
    const plistFile = path.join(mac.app, "Contents", "Info.plist");
    const line = (c: string[]) => c.join(" ");
    expect(line(mac.calls[0])).toBe(`plutil -convert xml1 ${plistFile}`);
    expect(mac.plist).toMatchObject({ CFBundleName: "Ember", CFBundleIdentifier: BUNDLE_ID, CFBundleExecutable: EXECUTABLE, NSHighResolutionCapable: "true", LSMinimumSystemVersion: "13.0" });
    expect(mac.plist).not.toHaveProperty("ElectronAsarIntegrity");
    expect(mac.calls.filter(c => c[1] === "-remove").map(c => c[2])).toEqual(["ElectronAsarIntegrity"]);
    expect(mac.calls.filter(c => c[1] === "-extract").length).toBeGreaterThanOrEqual(infoPlistValues("0.1.0").length);
    expect(mac.iconsets).toEqual([path.join(path.dirname(mac.app), "ember.iconset")]);
    expect(fs.existsSync(path.join(mac.app, "Contents", "Resources", "ember.icns"))).toBe(true);
    expect(fs.existsSync(path.join(mac.app, "Contents", "Resources", "electron.icns"))).toBe(false);
    // The signature covers every change: nothing touches the bundle after it (it is only read back).
    const entitlements = path.join(path.dirname(mac.app), "ember.entitlements");
    expect(mac.calls.slice(-5).map(line)).toEqual([
      `xattr -cr ${mac.app}`,
      `codesign --force --deep --options runtime --entitlements ${entitlements} --sign - --timestamp=none ${mac.app}`,
      `codesign --verify --deep --strict --verbose=2 ${mac.app}`,
      `codesign --display --verbose=2 ${mac.app}`,
      `codesign --display --entitlements - --xml ${mac.app}`,
    ]);
  });

  it("signs under the hardened runtime with only the entitlements Ember needs (review #177)", async () => {
    const mac = fakeMac();
    await mac.finish();
    expect(fs.readFileSync(path.join(path.dirname(mac.app), "ember.entitlements"), "utf8")).toBe(entitlementsPlist());
    // V8's JIT, an ad hoc signature's frameworks and native modules, the microphone, dark mode through System Events.
    expect(ENTITLEMENTS).toEqual([
      "com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.disable-library-validation",
      "com.apple.security.device.audio-input", "com.apple.security.automation.apple-events",
    ]);
    // Either would let another process's code into Ember again (DYLD_INSERT_LIBRARIES, a debugger).
    expect(FORBIDDEN_ENTITLEMENTS).toEqual(["com.apple.security.cs.allow-dyld-environment-variables", "com.apple.security.get-task-allow"]);
    const xml = entitlementsPlist();
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist [^\n]+>\n<plist version="1\.0">\n<dict>\n/);
    expect([...xml.matchAll(/<key>([^<]+)<\/key>\n {2}<true\/>/g)].map(m => m[1])).toEqual(ENTITLEMENTS);
    for (const k of FORBIDDEN_ENTITLEMENTS) expect(xml).not.toContain(k);
  });

  it("refuses a signature without the hardened runtime, or with an entitlement that lets code in", async () => {
    await expect(fakeMac({ runtime: false }).finish()).rejects.toThrow(/isn't signed with the hardened runtime.*flags=0x2\(adhoc\)/s);
    await expect(fakeMac({ extra: "com.apple.security.cs.allow-dyld-environment-variables" }).finish())
      .rejects.toThrow(/Ember\.app's entitlements are wrong: com\.apple\.security\.cs\.allow-dyld-environment-variables must not be there/);
  });

  it("stops before signing when a value doesn't read back, or when the signature doesn't verify", async () => {
    const wrong = fakeMac({ ignore: "CFBundleIdentifier" });
    await expect(wrong.finish()).rejects.toThrow(/CFBundleIdentifier is "com\.github\.Electron", should be "io\.github\.komaladitya08\.ember"/);
    expect(wrong.calls.some(c => c[0] === "codesign")).toBe(false);
    await expect(fakeMac({ verifyFails: true }).finish()).rejects.toThrow(/verifying Ember\.app's signature failed.*sealed resource/);
  });

  it("refuses a bundle whose executable wasn't renamed, before touching it", async () => {
    const mac = fakeMac({ noExecutable: true });
    await expect(mac.finish()).rejects.toThrow(/has no Contents\/MacOS\/Ember/);
    expect(mac.calls).toEqual([]);
  });

  it("is staged in order: fuses flipped, app files in, then Info.plist, icon and signature", () => {
    const stage = fs.readFileSync(path.resolve("scripts/package/stage.mjs"), "utf8");
    const at = (s: string) => { const i = stage.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    expect(at("flipFuses(path.join(app, layout.fuseFile)")).toBeLessThan(at("for (const src of prod)"));
    expect(at("THIRD_PARTY_NOTICES\"), [")).toBeLessThan(at("await finishMacBundle("));
    expect(at("for (const p of layout.prune)")).toBeLessThan(at("await finishMacBundle("));
  });
});

describe("staging in CI", () => {
  const ci = fs.readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8");
  const lines = ci.split("\n");
  const commands = lines.filter(l => !/^\s*#/.test(l));
  it("stages every target with every file required, now that the accessibility host and the bridge exist", () => {
    const job = ci.slice(ci.indexOf("\n  package:"), ci.indexOf("\n  eval:"));
    expect(job).toMatch(/^\s+node scripts\/package\/stage\.mjs$/m);
    expect(job).not.toContain("--allow-missing");
    expect(commands.filter(l => /stage\.mjs/.test(l))).toHaveLength(4); // package, windows, macos, macos-x64
    expect(commands.join("\n")).not.toMatch(/--allow-missing-sidecar|run-integration\.mjs --allow-missing/);
  });
  it("runs every named integration file, so a renamed one fails instead of skipping", () => {
    for (const l of commands.filter(c => /run-integration\.mjs /.test(c))) {
      for (const file of l.match(/test\/integration\/[\w.-]+\.test\.ts/g) ?? []) expect(fs.existsSync(path.resolve(file)), file).toBe(true);
    }
  });
  it("marks every temporary allowance (--allow-missing…) for removal", () => {
    const uses = lines.flatMap((l, i) => (/--allow-missing/.test(l) && !/^\s*#/.test(l) ? [i] : []));
    for (const i of uses) expect(lines.slice(Math.max(0, i - 12), i).join("\n"), lines[i]).toMatch(/TODO\(port\): drop --allow-missing/);
  });
  it("builds the speech models package, then upgrades, verifies and removes both RPMs, keeping the admin's policy (review #207)", () => {
    const job = ci.slice(ci.indexOf("\n  package:"), ci.indexOf("\n  eval:"));
    const at = (s: string) => { const i = job.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    // The real models, verified, before staging: rpm.sh then builds ember-voice-models too.
    expect(at("node scripts/voice/prepare.mjs")).toBeLessThan(at("node scripts/package/stage.mjs"));
    expect(at("dist/package/ember-voice-models-")).toBeGreaterThan(at("scripts/package/rpm.sh"));
    const life = job.slice(at("RPM lifecycle"));
    const order = ["dnf -y install ./dist/package/ember-voice-models-", "rpm -V ember ember-voice-models", "/etc/ember/policy.json",
      "EMBER_RPM_RELEASE=2 scripts/package/rpm.sh", "dnf -y upgrade", "rpm -V ember ember-voice-models", "rpm -e ember ember-voice-models"];
    let from = 0;
    for (const s of order) { const i = life.indexOf(s, from); expect(i, s).toBeGreaterThanOrEqual(from); from = i + s.length; }
    for (const gone of ["/opt/ember", "/usr/share/ember", "/usr/bin/ember", "/usr/share/applications/ember.desktop"]) expect(life.slice(life.indexOf("rpm -e"))).toContain(gone);
    expect(life.slice(life.indexOf("rpm -e"))).toMatch(/cmp packaging\/policy\.example\.json \/etc\/ember\/policy\.json/);
    // The packages kept for download are Release 1's.
    expect(life).toContain("rm -f ./dist/package/ember-$v-2.*.rpm ./dist/package/ember-voice-models-$v-2.*.rpm");
    expect(at("RPM lifecycle")).toBeLessThan(at("actions/upload-artifact"));
  });
  it("checks the installed desktop entry and its Ask Ember action (D-45b)", () => {
    const job = ci.slice(ci.indexOf("\n  package:"), ci.indexOf("\n  eval:"));
    const install = job.slice(job.indexOf("dnf -y install ./dist/package/ember-*.x86_64.rpm"));
    expect(install).toMatch(/^\s+desktop-file-validate \/usr\/share\/applications\/ember\.desktop$/m);
    expect(install).toMatch(/^\s+grep -qx 'Exec=ember --ask' \/usr\/share\/applications\/ember\.desktop$/m);
    expect(install.indexOf("desktop-file-validate")).toBeLessThan(install.indexOf("RPM lifecycle"));
  });
  it("lets rpm.sh build another release of the same version (an upgrade to test)", () => {
    const spec = fs.readFileSync(path.resolve("packaging/rpm/ember.spec"), "utf8");
    expect(spec).toMatch(/^Release:\s+%\{\?ember_release\}%\{!\?ember_release:1\}%\{\?dist\}$/m);
    const rpmSh = fs.readFileSync(path.resolve("scripts/package/rpm.sh"), "utf8");
    expect(rpmSh).toContain('--define "ember_release $release"');
    expect(rpmSh).toMatch(/release=\$\{EMBER_RPM_RELEASE:-1\}/);
  });
});

describe("the SSH, WSL and commands workflow, remote.yml (review #38)", () => {
  const wf = fs.readFileSync(path.resolve(".github/workflows/remote.yml"), "utf8");
  const on = wf.slice(wf.indexOf("\non:\n"), wf.indexOf("\npermissions:"));
  /** A job's text, from its key to the next job's. */
  const job = (name: string) => {
    const start = wf.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(0);
    const next = wf.slice(start + 1).search(/\n {2}[\w-]+:\n/);
    return next < 0 ? wf.slice(start) : wf.slice(start, start + 1 + next);
  };
  const jobs = [...wf.slice(wf.indexOf("\njobs:\n")).matchAll(/^ {2}([\w-]+):$/gm)].map(m => m[1]);

  it("runs on pull requests and pushes to main that touch SSH, WSL or commands code, and on every release tag", () => {
    expect(on).toMatch(/^ {2}pull_request:\n {4}paths:\n/m);
    expect(on).toMatch(/^ {4}branches: \[main, /m);
    expect(on).toMatch(/^ {4}tags: \["v\*"\]$/m);
    // The same paths for pushes and pull requests.
    for (const p of ["app/main/commands/**", "app/main/remote/**", "app/main/wsl/**", "app/main/targets/**", "app/remote/**", "scripts/package/**", ".github/workflows/remote.yml"]) {
      expect(on.split(`- "${p}"`).length - 1, p).toBe(2);
    }
    expect(jobs.length).toBeGreaterThan(10);
    // Every job that runs on a push runs on a pull request too, but macOS (on every push, release tags included) and
    // arm64 (on release tags instead).
    for (const name of jobs.filter(n => !["ssh-macos", "ssh-linux-arm64"].includes(n))) expect(job(name), name).toContain("github.event_name == 'pull_request'");
    expect(job("ssh-macos")).toContain("github.event_name == 'push' ||");
    expect(job("ssh-macos")).not.toContain("github.event_name == 'pull_request'");
    expect(job("ssh-linux-arm64")).toContain("startsWith(github.ref, 'refs/tags/')");
  });

  it("runs the transport suite with RHEL 8's own OpenSSH client (8.0), as a normal user in rockylinux:8", () => {
    const el8 = job("ssh-el8-client");
    expect(el8).toMatch(/container:\n\s+image: rockylinux:8\n/);
    expect(el8).toContain("openssh-clients openssh-server");
    expect(el8).toMatch(/sudo -u ci env [\s\S]*EMBER_SSH_TEST=1[\s\S]*node scripts\/run-integration\.mjs test\/integration\/ssh-transport\.test\.ts/);
    expect(el8).not.toContain("--allow-missing");
  });

  it("signs in with a password, and keyboard-interactive, through Ember's prompt with both clients", () => {
    for (const name of ["ssh-linux", "ssh-el8-client"]) {
      const j = job(name);
      expect(j, name).toContain('"PasswordAuthentication yes"');
      expect(j, name).toContain('"EMBER_SSH_TEST_PASSWORD_PORT=2224"');
      expect(j, name).toContain('echo "::add-mask::$pw"');
    }
    const transport = fs.readFileSync(path.resolve("test/integration/ssh-transport.test.ts"), "utf8");
    expect(transport).toContain("process.env.EMBER_SSH_TEST_PASSWORD_PORT");
    expect(transport).toMatch(/for \(const method of \["password", "keyboard-interactive"\]\)/);
  });

  it("installs and runs the agent on a Linux arm64 computer, where the repository has such a runner", () => {
    const arm = job("ssh-linux-arm64");
    expect(arm).toContain("runs-on: ${{ vars.EMBER_ARM64_RUNNER || 'ubuntu-24.04-arm' }}");
    expect(arm).toContain("vars.EMBER_ARM64_RUNNER != 'none'");
    expect(arm).toContain('test "$(uname -m)" = aarch64');
    for (const f of ["remote-ssh.test.ts", "remote-e2e.test.ts", "remote-desktop.test.ts"]) expect(arm).toContain(`test/integration/${f}`);
  });
});

describe("the Windows and macOS CI jobs", () => {
  const ci = fs.readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8");
  /** A job's text, from its key to the next job's. */
  const job = (name: string) => {
    const start = ci.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(0);
    const next = ci.slice(start + 1).search(/\n {2}[\w-]+:\n/);
    return next < 0 ? ci.slice(start) : ci.slice(start, start + 1 + next);
  };
  const steps = (text: string) => text.split(/\n {6}- /).slice(1);
  const step = (text: string, has: string) => {
    const found = steps(text).filter(s => s.includes(has));
    expect(found, has).toHaveLength(1);
    return found[0];
  };

  it("start the Windows job with the runner's facts, exported for the integration suites (W7)", () => {
    const first = steps(job("windows"))[0];
    expect(first).toMatch(/^name: Runner facts/);
    for (const v of ["EMBER_CI_ELEVATED", "EMBER_CI_LUA", "EMBER_CI_SERVER"]) expect(first).toContain(`${v}=`);
    for (const fact of ["whoami /groups", "EnableLUA", "ProductType", "AllScreens", "OSVersion"]) expect(first).toContain(fact);
    // Windows PowerShell 5.1's Out-File -Encoding utf8 would put a byte-order mark before the first name.
    expect(first).toContain("[IO.File]::AppendAllText($env:GITHUB_ENV, $facts)");
    expect(steps(job("macos"))[0]).toMatch(/^name: Runner facts[\s\S]*sw_vers[\s\S]*uname -m[\s\S]*TCC\.db/);
  });

  it("compile the bridge by running it as Ember runs it, stdin closed, on every run (W21)", () => {
    const windows = job("windows");
    expect(windows).not.toMatch(/Add-Type -Path sidecar|-ReferencedAssemblies UIAutomationClient/);
    const bridge = step(windows, '-File "$script"');
    expect(bridge).toMatch(/"\$powershell" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "\$script" < \/dev\/null/);
    expect(bridge).toContain('powershell="$(cygpath -W)/System32/WindowsPowerShell/v1.0/powershell.exe"');
    expect(bridge).toMatch(/export EMBER_UIA_CACHE/);
    expect(bridge).toMatch(/for pass in compiled cached/);
    // With the bridge's environment: PSModulePath only the system modules folder (design departure 3).
    expect(bridge).toContain('env -u PSMODULEPATH PSModulePath="$modules" "$powershell"');
    expect(bridge).toContain('modules="$(cygpath -w -W)\\System32\\WindowsPowerShell\\v1.0\\Modules"');
    // Compiled into a fresh cache under the source's hash, then loaded from it without compiling again.
    expect(bridge).toMatch(/rm -rf "\$cache"\n[\s\S]*dll="\$cache\/ember_uia-\$\(sha256sum sidecar\/uia\/ember_uia\.cs/);
    expect(bridge).toContain('find "$cache" -name \'ember_uia-*\' -newer "$compiled"');
    expect(bridge).not.toMatch(/^\s+(if|continue-on-error):/m);
    // The arguments Ember's accessibility host starts the bridge with.
    expect(fs.readFileSync(path.resolve("app/sidecar-host/providers/uia.ts"), "utf8")).toContain('["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.o.script]');
    expect(windows.indexOf("ember_uia.ps1")).toBeLessThan(windows.indexOf("uia-bridge.test.ts"));
  });

  it("check Ember.exe's name, version and publisher as Windows reads them, and that it is unsigned, not tampered with (W12)", () => {
    const windows = job("windows");
    const identity = step(windows, "Get-AuthenticodeSignature");
    expect(identity).toContain('FileDescription = "Ember"');
    expect(identity).toContain("CompanyName = $pkg.author");
    expect(identity).toMatch(/\[string\]\$signature\.Status -ne "NotSigned"/);
    expect(windows.indexOf("node scripts/package/stage.mjs")).toBeLessThan(windows.indexOf("Get-AuthenticodeSignature"));
  });

  it("fail the packaged Windows smoke run when a shortcut couldn't be registered (W8)", () => {
    expect(job("windows")).toContain("node test/smoke/launch.mjs --exe dist/package/Ember/Ember.exe --forbid shortcut.unavailable");
  });

  it("grant TCC per binary before the tests, and per bundle with its real requirement between the attribution runs (M4, M3)", () => {
    const macos = job("macos");
    // Every row is tcc.mjs's: no NULL-csreq bundle rows.
    expect(macos).not.toMatch(/INSERT OR REPLACE INTO access/);
    const at = (s: string) => { const i = macos.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    expect(at("tcc.mjs grant-paths --ancestors")).toBeLessThan(at("node scripts/run-integration.mjs"));
    expect(at("tcc.mjs approve-capture")).toBeLessThan(at("node scripts/run-integration.mjs"));
    // The doctor's Accessibility row is called what the setup check calls it (review #229).
    expect(at("node scripts/package/stage.mjs")).toBeLessThan(at('"Reading and using apps=fail" "Accessibility helper=fail"'));
    expect(at('"Reading and using apps=fail" "Accessibility helper=fail"')).toBeLessThan(at("tcc.mjs grant-bundle dist/package/Ember.app"));
    expect(at("tcc.mjs grant-bundle dist/package/Ember.app")).toBeLessThan(at('"Reading and using apps=ok" "Accessibility helper=ok"'));
    // Through LaunchServices, so Ember.app is its own responsible process.
    expect(macos.match(/open -n -W --stdout "\$report" --stderr "\$RUNNER_TEMP\/doctor-(before|after)\.err" -a "\$PWD\/dist\/package\/Ember\.app" --args --doctor/g)).toHaveLength(2);
    // Ember.app's executable is no path client, which would muddy the first attribution run; it is only approved to capture.
    const paths = step(macos, "grant-paths").split("\n").find(l => l.includes("tcc.mjs grant-paths"))!;
    expect(paths).not.toContain("Ember.app");
    expect(step(macos, "approve-capture")).toContain("dist/package/Ember.app/Contents/MacOS/Ember");
  });

  it("build and check an x64 Ember.app on an Intel Mac, on the default branch, on tags and when asked (M6)", () => {
    const x64 = job("macos-x64");
    expect(x64).toMatch(/runs-on: macos-15-intel/);
    expect(x64).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
    expect(x64).toContain("startsWith(github.ref, 'refs/tags/')");
    expect(x64).toContain("github.event_name == 'workflow_dispatch' && inputs.intel");
    expect(ci).toMatch(/^ {4}tags: \["v\*"\]$/m);
    expect(ci).toMatch(/^ {6}intel:\n {8}description: .+\n {8}type: boolean\n {8}default: false$/m);
    for (const s of ["test \"$(uname -m)\" = x86_64", "node scripts/package/stage.mjs", "node scripts/package/archive.mjs", "lipo -archs", "test \"$machos\" -gt 0", "fuses.mjs --check",
      "codesign --verify --deep --strict", "test/integration/darwin-desktop.test.ts", "node test/smoke/launch.mjs --exe dist/package/Ember.app/Contents/MacOS/Ember"]) {
      expect(x64, s).toContain(s);
    }
  });

  it("read the hardened runtime's flag on both Macs, and try DYLD_* only where SIP is on, as on users' Macs (review #177)", () => {
    for (const name of ["macos", "macos-x64"]) {
      const s = step(job(name), "fuses.mjs --check");
      const at = (line: string) => { const i = s.indexOf(line); expect(i, `${name}: ${line}`).toBeGreaterThan(0); return i; };
      // The flag, whatever SIP says.
      const flag = at(`\n          codesign --display --verbose=2 "$app" 2>&1 | grep -E 'flags=0x[0-9a-f]+\\([^)]*runtime'\n`);
      // The runners report SIP off, and with it off dyld may honour DYLD_* for any binary: there the line would fail
      // for a reason that has nothing to do with Ember, or prove nothing.
      // Ember started as the app (node mode is refused there now) gets as far as refusing --inspect: exit 2.
      const sip = at(`\n          if [[ "$(csrutil status 2>&1)" == *"status: enabled"* ]]; then\n`
        + `            status=0\n`
        + `            DYLD_INSERT_LIBRARIES=/nonexistent/ember-dyld-check.dylib "$exe" --inspect=127.0.0.1:9229 || status=$?\n`
        + `            test "$status" -eq 2\n`
        + `          else\n`
        + `            echo "::notice::SIP is off on this runner: the DYLD_* check can't prove anything here"\n`
        + `          fi\n`);
      expect(flag).toBeLessThan(sip);
      expect(s.match(/DYLD_INSERT_LIBRARIES/g), name).toHaveLength(1);
    }
  });

  it("prove node mode is refused on both Macs: Ember's binary given ELECTRON_RUN_AS_NODE starts as Ember, never runs the script (review #177)", () => {
    for (const name of ["macos", "macos-x64"]) {
      const s = step(job(name), "fuses.mjs --check");
      expect(s, name).toMatch(/^name: ".*node mode refused, NODE_OPTIONS fuse off, --inspect refused/);
      // Nothing in the step runs the binary as plain Node any more.
      expect(s, name).not.toContain("-e 'process.exit(0)'");
      expect(s, name).not.toMatch(/ELECTRON_RUN_AS_NODE=1 [^\n]*"\$exe"/);
      const at = (line: string) => { const i = s.indexOf(line); expect(i, `${name}: ${line}`).toBeGreaterThan(0); return i; };
      at(`\n          mark="$RUNNER_TEMP/ember-node-mode-mark"\n`);
      at(`\n          echo 'require("fs").writeFileSync(process.env.EMBER_MARK, "node mode")' > "$RUNNER_TEMP/ember-node-mode.js"\n`);
      const run = at(`\n          node -e 'const r = require("child_process").spawnSync(process.argv[1], ["--inspect=127.0.0.1:9229", process.argv[2]], { encoding: "utf8", timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", EMBER_MARK: process.argv[3] } }); console.log(r.stdout + r.stderr + "\\nexit " + r.status)' "$exe" "$RUNNER_TEMP/ember-node-mode.js" "$mark" > node-mode.log\n`);
      const verdict = at(`\n          if [ -e "$mark" ] || ! grep -q "doesn't start with debugging switches" node-mode.log || ! grep -qx 'exit 2' node-mode.log; then cat node-mode.log; exit 1; fi\n`);
      expect(run).toBeLessThan(verdict);
      // NODE_OPTIONS: a packaged Electron drops all but two NODE_OPTIONS in app mode (and in its utility processes)
      // whatever the fuse says, and node mode is refused, so no run can show the fuse here. `fuses.mjs --check` above
      // (EnableNodeOptionsEnvironmentVariable off) is the proof. This run only shows that --inspect is still refused
      // with it set; the step says exactly that, and claims nothing more of it.
      const check = at(`\n          node scripts/package/fuses.mjs --check "$app/Contents/Frameworks/Electron Framework.framework/Electron Framework"\n`);
      const options = at(`\n          # NODE_OPTIONS: a packaged Electron drops all but two NODE_OPTIONS in app mode (and in its utility processes)\n`
        + `          # whatever the fuse says, and node mode is refused, so no run can show the fuse here. \`fuses.mjs --check\` above\n`
        + `          # (EnableNodeOptionsEnvironmentVariable off) is the proof. This run only shows that --inspect is still refused\n`
        + `          # with it set.\n`
        + `          node -e 'const r = require("child_process").spawnSync(process.argv[1], ["--inspect=127.0.0.1:9229"], { encoding: "utf8", timeout: 60000, env: { ...process.env, NODE_OPTIONS: "--require=/nonexistent/ember-fuse-check.js" } }); console.log(r.stdout + r.stderr + "\\nexit " + r.status)' "$exe" > inspect.log\n`);
      expect(check).toBeLessThan(options);
      expect(verdict).toBeLessThan(options);
      expect(s, name).not.toContain("it is ignored");
      expect(s.match(/NODE_OPTIONS:/g), name).toHaveLength(2);
      expect(s.match(/doesn't start with debugging switches/g), name).toHaveLength(2);
    }
    // Linux and Windows keep node mode, and their checks say so.
    expect(job("windows")).toContain('ELECTRON_RUN_AS_NODE=1 "$app/Ember.exe" -e "process.exit(0)"');
    expect(ci).toContain("ELECTRON_RUN_AS_NODE=1 /opt/ember/ember -e 'process.exit(0)'");
  });

  it("check SSH's askpass as Ember itself on Apple silicon, the development Electron and the staged Ember.app (review #177)", () => {
    const macos = job("macos");
    const s = step(macos, "test/integration/askpass-darwin.test.ts");
    expect(s).toContain("node scripts/run-integration.mjs test/integration/askpass-darwin.test.ts");
    expect(s).toMatch(/EMBER_DARWIN_TEST: "1"/);
    expect(s).toMatch(/EMBER_PACKAGED_APP: dist\/package\/Ember\.app/);
    expect(s).toContain("steps.stage.outcome == 'success'");
    expect(macos.indexOf("node scripts/package/stage.mjs")).toBeLessThan(macos.indexOf("askpass-darwin.test.ts"));
    // Before Ember.app's own grant and the attribution runs: askpass needs no permission.
    expect(macos.indexOf("askpass-darwin.test.ts")).toBeLessThan(macos.indexOf("tcc.mjs grant-bundle"));
  });

  it("offer dev:mac, which starts the development Electron through LaunchServices so TCC grants go to Electron (M14)", () => {
    const scripts = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")).scripts as Record<string, string>;
    expect(scripts["dev:mac"]).toBe('node scripts/build-app.mjs && open -n -W node_modules/electron/dist/Electron.app --args "$PWD"');
  });
});

describe("the macOS privacy grants CI writes (tcc.mjs)", () => {
  const now = 1_790_000_000;
  // macOS 14 and 15's access table (13 lacks the last four columns; the INSERT names its columns, so it fits both).
  const ACCESS = `CREATE TABLE access (service TEXT NOT NULL, client TEXT NOT NULL, client_type INTEGER NOT NULL,
    auth_value INTEGER NOT NULL, auth_reason INTEGER NOT NULL, auth_version INTEGER NOT NULL, csreq BLOB, policy_id INTEGER,
    indirect_object_identifier_type INTEGER, indirect_object_identifier TEXT NOT NULL DEFAULT 'UNUSED',
    indirect_object_code_identity BLOB, flags INTEGER, last_modified INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    pid INTEGER, pid_version INTEGER, boot_uuid TEXT NOT NULL DEFAULT 'UNUSED',
    last_reminded INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    PRIMARY KEY (service, client, client_type, indirect_object_identifier))`;
  const sqlite = (() => {
    try { return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite"); } catch { return null; }
  })();
  const database = () => { const db = new sqlite!.DatabaseSync(":memory:"); db.exec(ACCESS); return db; };
  type Row = Record<string, unknown>;
  const rows = (db: ReturnType<typeof database>) => db.prepare("SELECT * FROM access ORDER BY client, service").all() as Row[];
  const CSREQ = `fade0c00000000${"30"}00000001000000080000001400${"ab".repeat(18)}`;

  it.skipIf(!sqlite)("writes grants macOS's access table takes, for every candidate binary, as often as it runs", () => {
    const clients = ["/Users/runner/work/ember/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", "/opt/hca/hosted-compute-agent", "/tmp/it's here/node", "/bin/bash", "/bin/bash"];
    const { system, user } = pathGrants(clients, now);
    const sys = database();
    sys.exec(transaction(system));
    sys.exec(transaction(system)); // replaced, not added twice
    const granted = rows(sys);
    expect(granted).toHaveLength(4 * SYSTEM_SERVICES.length);
    expect(SYSTEM_SERVICES).toEqual(["kTCCServiceAccessibility", "kTCCServiceScreenCapture", "kTCCServicePostEvent", "kTCCServiceListenEvent"]);
    expect([...new Set(granted.map(r => r.client))]).toEqual([...new Set(clients)].sort());
    for (const r of granted) expect(r).toMatchObject({ client_type: 1, auth_value: 2, auth_reason: 4, auth_version: 1, csreq: null, indirect_object_identifier: "UNUSED", last_modified: now });
    const usr = database();
    usr.exec(transaction(user));
    expect(rows(usr).map(r => [r.service, r.client, r.indirect_object_identifier])).toEqual([...new Set(clients)].sort().map(c => [APPLE_EVENTS, c, SYSTEM_EVENTS]));
    // The target named by its code requirement, as tccd records an approval; the system rows have no target.
    for (const r of rows(usr)) expect(Buffer.from(r.indirect_object_code_identity as Uint8Array).toString("hex")).toBe(SYSTEM_EVENTS_REQUIREMENT);
    for (const r of granted) expect(r.indirect_object_code_identity).toBeNull();
  });

  it("names System Events by its requirement, compiled as csreq compiles it and as the runner image's own rows carry it", () => {
    // identifier "com.apple.systemevents" and anchor apple
    expect(SYSTEM_EVENTS_REQUIREMENT).toBe("fade0c000000003400000001000000060000000200000016636f6d2e6170706c652e73797374656d6576656e7473000000000003");
    const blob = Buffer.from(appleAnchorRequirement("com.apple.abc"), "hex");
    expect([blob.readUInt32BE(0), blob.readUInt32BE(4), blob.length]).toEqual([0xfade0c00, 44, 44]);
    expect([8, 12, 16, 20].map(o => blob.readUInt32BE(o))).toEqual([1, 6, 2, 13]); // an expression: and, identifier of 13 bytes
    expect(blob.subarray(24, 37).toString("ascii")).toBe("com.apple.abc");
    expect([...blob.subarray(37, 40)]).toEqual([0, 0, 0]); // padded to four bytes
    expect(blob.readUInt32BE(40)).toBe(3); // anchor apple
    expect(() => appleAnchorRequirement('x" or anchor apple generic')).toThrow(/code identifier/);
  });

  it.skipIf(!sqlite)("grants the bundle id with its compiled code requirement, not a NULL one", () => {
    const { system, user } = bundleGrants("io.github.komaladitya08.ember", CSREQ, now);
    const sys = database(), usr = database();
    sys.exec(transaction(system));
    usr.exec(transaction(user));
    expect(rows(sys).map(r => r.service)).toEqual([...SYSTEM_SERVICES].sort());
    for (const r of [...rows(sys), ...rows(usr)]) {
      expect(r).toMatchObject({ client: "io.github.komaladitya08.ember", client_type: 0, auth_value: 2 });
      expect(Buffer.from(r.csreq as Uint8Array).toString("hex")).toBe(CSREQ);
    }
    expect(rows(usr)).toMatchObject([{ service: APPLE_EVENTS, indirect_object_identifier: SYSTEM_EVENTS }]);
    expect(showSql(SYSTEM_SERVICES)).toMatch(/^SELECT .* FROM access WHERE service IN \('kTCCServiceAccessibility',/);
    expect(sys.prepare(showSql(SYSTEM_SERVICES)).all()).toHaveLength(4);
  });

  it("refuses a relative path, a control character, an odd bundle id and a missing or malformed requirement", () => {
    expect(() => pathGrants(["node"], now)).toThrow(/absolute path/);
    expect(() => pathGrants([], now)).toThrow(/at least one/);
    expect(() => pathGrants(["/tmp/a\nb"], now)).toThrow(/control character/);
    expect(() => bundleGrants("io.github.komaladitya08.ember'; DROP TABLE access; --", CSREQ, now)).toThrow(/isn't a bundle id/);
    expect(() => bundleGrants("io.github.komaladitya08.ember", "", now)).toThrow(/code requirement/);
    expect(() => bundleGrants("io.github.komaladitya08.ember", "fade0c0z", now)).toThrow(/hex/);
    expect(SYSTEM_DB).toBe("/Library/Application Support/com.apple.TCC/TCC.db");
    expect(userDb("/Users/runner")).toBe("/Users/runner/Library/Application Support/com.apple.TCC/TCC.db");
    expect(captureApprovals("/Users/runner")).toBe("/Users/runner/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals");
  });

  it("reads the designated requirement codesign prints, implicit (an ad hoc signature) or explicit", () => {
    expect(designatedRequirement('# designated => cdhash H"5f2c9e01" or cdhash H"77aa0b"\n')).toBe('cdhash H"5f2c9e01" or cdhash H"77aa0b"');
    expect(designatedRequirement('Executable=/System/Library/CoreServices/System Events.app/Contents/MacOS/System Events\ndesignated => identifier "com.apple.systemevents" and anchor apple\n'))
      .toBe('identifier "com.apple.systemevents" and anchor apple');
    expect(() => designatedRequirement("Executable=/w/Ember.app/Contents/MacOS/Ember\n")).toThrow(/no designated requirement/);
  });

  it("finds the runner's own processes above the step's shell, and stops at launchd", () => {
    const ps: Record<number, string> = {
      900: "  800 /bin/bash", 800: "  700 /Users/runner/actions-runner/cached/bin/Runner.Worker", 700: "  650 Runner.Listener", 650: "    1 /opt/hca/hosted-compute-agent",
    };
    expect(ancestors(900, pid => parsePs(ps[pid] ?? ""))).toEqual(["/bin/bash", "/Users/runner/actions-runner/cached/bin/Runner.Worker", "/opt/hca/hosted-compute-agent"]);
    expect(parsePs("   12 /Applications/Some App.app/Contents/MacOS/Some App ")).toEqual({ ppid: 12, comm: "/Applications/Some App.app/Contents/MacOS/Some App" });
    expect(parsePs("")).toBeNull();
    expect(ancestors(5, () => ({ ppid: 5, comm: "/bin/sh" }))).toHaveLength(64); // a loop ends
  });

  /** A stand-in for sudo, sqlite3, launchctl, plutil, codesign, csreq and defaults that records each call. */
  const fakeRunner = (o: { refuse?: RegExp; blob?: Buffer } = {}) => {
    const calls: string[] = [];
    const inputs: (string | undefined)[] = [];
    const run: Run = (file, args, input) => {
      const line = [file, ...args].join(" ");
      calls.push(line);
      inputs.push(input);
      if (o.refuse?.test(line)) return { status: 1, stdout: "", stderr: "Operation not permitted" };
      if (file === "plutil") return { status: 0, stdout: "io.github.komaladitya08.ember\n", stderr: "" };
      if (file === "codesign") return { status: 0, stdout: '# designated => cdhash H"5f2c9e01"\n', stderr: "Executable=/w/Ember.app/Contents/MacOS/Ember\n" };
      if (file === "csreq") fs.writeFileSync(args[2], o.blob ?? Buffer.from(CSREQ, "hex"));
      return { status: 0, stdout: file === "defaults" ? "{\n}\n" : "", stderr: "" };
    };
    const log: string[] = [], slept: number[] = [];
    return { calls, inputs, log, slept, common: { run, home: "/Users/runner", uid: 501, now, log: (l: string) => log.push(l), sleep: (ms: number) => slept.push(ms) } };
  };

  it("writes the path grants into both databases, then restarts both tccds", () => {
    const f = fakeRunner();
    grantPaths({ ...f.common, clients: ["/bin/bash", "/usr/local/bin/node"] });
    expect(f.calls.map(c => c.split(" BEGIN;")[0])).toEqual([
      `sudo sqlite3 ${SYSTEM_DB}`,
      `sqlite3 ${userDb("/Users/runner")}`,
      "launchctl kickstart -k gui/501/com.apple.tccd",
      "sudo launchctl kickstart -k system/com.apple.tccd.system",
    ]);
    expect(f.calls[0]).toContain("'kTCCServiceListenEvent','/usr/local/bin/node',1,2,4,1,NULL");
    expect(f.calls[1]).toContain(`'${APPLE_EVENTS}','/bin/bash',1,2,4,1,NULL,NULL,0,'${SYSTEM_EVENTS}'`);
    expect(f.slept).toEqual([2000]);
  });

  it("restarts tccd with pkill when launchctl is refused, and stops when nothing can restart it", () => {
    const f = fakeRunner({ refuse: /kickstart/ });
    restartTccd(f.common);
    expect(f.calls.slice(-1)).toEqual(["sudo pkill -x tccd"]);
    expect(f.log.join("\n")).toMatch(/pkill/);
    expect(() => restartTccd(fakeRunner({ refuse: /kickstart|pkill/ }).common)).toThrow(/restarting tccd/);
    expect(() => grantPaths({ ...fakeRunner({ refuse: /^sqlite3/ }).common, clients: ["/bin/bash"] })).toThrow(/writing the user's TCC database failed: Operation not permitted/);
  });

  it("grants Ember.app by its bundle id with the requirement codesign reads and csreq compiles", () => {
    const f = fakeRunner();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-tcc-"));
    expect(grantBundle({ ...f.common, app: "/w/dist/package/Ember.app", tmp })).toEqual({ bundleId: "io.github.komaladitya08.ember", requirement: 'cdhash H"5f2c9e01"' });
    expect(f.calls.slice(0, 3)).toEqual([
      "plutil -extract CFBundleIdentifier raw -o - /w/dist/package/Ember.app/Contents/Info.plist",
      "codesign -d -r- /w/dist/package/Ember.app",
      `csreq -r- -b ${path.join(tmp, "ember-csreq.bin")}`,
    ]);
    expect(f.inputs[2]).toBe('cdhash H"5f2c9e01"');
    expect(f.calls[3]).toMatch(new RegExp(`^sudo sqlite3 ${SYSTEM_DB} BEGIN;.*'io\\.github\\.komaladitya08\\.ember',0,2,4,1,X'${CSREQ}'`));
    expect(f.calls[4]).toContain(`'${APPLE_EVENTS}','io.github.komaladitya08.ember',0,2,4,1,X'${CSREQ}',NULL,0,'${SYSTEM_EVENTS}'`);
    // Something that isn't a compiled requirement is never written.
    const bad = fakeRunner({ blob: Buffer.from("designated => cdhash") });
    expect(() => grantBundle({ ...bad.common, app: "/w/dist/package/Ember.app", tmp })).toThrow(/no code requirement/);
    expect(bad.calls.some(c => c.includes("sqlite3"))).toBe(false);
  });

  it("approves screen capture for each binary until 3024 and prints the approvals", () => {
    const f = fakeRunner();
    approveCapture({ ...f.common, binaries: ["/usr/local/bin/node", "/w/Electron", "/usr/local/bin/node"] });
    const plist = captureApprovals("/Users/runner");
    expect(f.calls).toEqual([
      `mkdir -p ${path.posix.dirname(plist)}`,
      `defaults write ${plist} /usr/local/bin/node -date 3024-01-01 00:00:00 +0000`,
      `defaults write ${plist} /w/Electron -date 3024-01-01 00:00:00 +0000`,
      `defaults read ${plist}`,
    ]);
    expect(() => approveCapture({ ...f.common, binaries: ["node"] })).toThrow(/absolute path/);
  });

  it.skipIf(process.platform === "darwin")("refuses to run anywhere but macOS", () => {
    const r = spawnSync(process.execPath, [path.resolve("scripts/package/tcc.mjs"), "show"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/run it on macOS/);
  });
});

describe("the doctor report check (doctor-rows.mjs)", () => {
  const row = (label: string, status: DoctorCheck["status"], detail: string): DoctorCheck =>
    ({ id: label.toLowerCase().replaceAll(" ", "-"), label, status, detail, ...(status === "ok" ? {} : { fix: "System Settings › Privacy & Security" }) });
  const report = (rows: DoctorCheck[]) => `Ember 0.1.0 check-up\n\n${formatDoctor(rows)}\n`;
  const before = report([
    row("Operating system", "ok", "macOS 15.5 (arm64)."), row("Accessibility", "fail", "Ember isn't allowed to control your Mac."),
    row("Accessibility helper", "fail", "toolkitAccessibility false."), row("Screen Recording", "warn", "Not allowed yet."),
  ]);
  const after = before.replace(/^FAIL( {2}Accessibility)/gm, "ok  $1");
  const expect2 = (...args: string[]) => args.map(parseExpectation);

  it("reads formatDoctor's rows back, multi-word labels included", () => {
    const r = parseDoctorReport(before.replaceAll("\n", "\r\n"));
    expect(r.header).toBe("Ember 0.1.0 check-up");
    expect(r.rows.map(x => [x.status, x.label, x.detail])).toEqual([
      ["ok", "Operating system", "macOS 15.5 (arm64)."], ["fail", "Accessibility", "Ember isn't allowed to control your Mac."],
      ["fail", "Accessibility helper", "toolkitAccessibility false."], ["warn", "Screen Recording", "Not allowed yet."],
    ]);
    const linux = doctorChecks(probes());
    expect(parseDoctorReport(formatDoctor(linux)).rows.map(x => x.label)).toEqual(linux.map(c => c.label));
  });

  it("passes rows with the expected status and fails the others, saying what they said", () => {
    const want = expect2("Accessibility=fail", "Accessibility helper=fail");
    expect(checkDoctorRows(parseDoctorReport(before), want)).toEqual({ problems: [], notChecked: [] });
    expect(checkDoctorRows(parseDoctorReport(after), expect2("Accessibility=ok", "Accessibility helper=ok"))).toEqual({ problems: [], notChecked: [] });
    expect(checkDoctorRows(parseDoctorReport(after), want).problems).toEqual([
      '"Accessibility" is ok, should be fail: Ember isn\'t allowed to control your Mac.',
      '"Accessibility helper" is ok, should be fail: toolkitAccessibility false.',
    ]);
  });

  it("fails a report with no rows whatever it is allowed, and a missing row unless allowed", () => {
    const want = expect2("Accessibility=fail");
    for (const text of ["", "Ember 0.1.0 check-up\n", "[1234:ERROR:gpu_init.cc] crashed\n"]) {
      expect(checkDoctorRows(parseDoctorReport(text), want, { allowMissing: true }).problems).toEqual(["the report has no rows (Ember printed no check-up)"]);
    }
    const old = parseDoctorReport(report([row("Operating system", "ok", "macOS 15.5.")]));
    expect(checkDoctorRows(old, want).problems).toEqual(['no "Accessibility" row (rows: Operating system)']);
    expect(checkDoctorRows(old, want, { allowMissing: true })).toEqual({ problems: [], notChecked: ["Accessibility"] });
    // A row that is there with the wrong status fails even when missing rows are allowed.
    expect(checkDoctorRows(parseDoctorReport(after), want, { allowMissing: true }).problems).toHaveLength(1);
    expect(() => parseExpectation("Accessibility=passes")).toThrow(/<label>=<ok\|warn\|fail>/);
  });

  it("exits 0 when the rows match, 1 when they don't or there are none, 2 when misused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-doctor-"));
    const file = (name: string, text: string) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
    const run = (...args: string[]) => spawnSync(process.execPath, [path.resolve("scripts/package/doctor-rows.mjs"), ...args], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" } });
    expect(run(file("before.txt", before), "Accessibility=fail", "Accessibility helper=fail")).toMatchObject({ status: 0, stdout: expect.stringMatching(/4 rows/) });
    expect(run(file("after.txt", after), "Accessibility=fail")).toMatchObject({ status: 1, stderr: expect.stringMatching(/"Accessibility" is ok, should be fail/) });
    const old = file("old.txt", report([row("Operating system", "ok", "macOS 15.5.")]));
    expect(run(old, "Accessibility=fail")).toMatchObject({ status: 1 });
    expect(run(old, "Accessibility=fail", "--allow-missing-rows")).toMatchObject({ status: 0, stderr: expect.stringMatching(/no "Accessibility" row yet, so it isn't checked/) });
    expect(run(path.join(dir, "missing.txt"), "Accessibility=fail", "--allow-missing-rows")).toMatchObject({ status: 1, stderr: expect.stringMatching(/no rows/) });
    expect(run(old)).toMatchObject({ status: 2, stderr: expect.stringMatching(/usage:/) });
  });
});

describe("the integration runner (scripts/run-integration.mjs)", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [path.resolve("scripts/run-integration.mjs"), ...args], { encoding: "utf8" });
  it("refuses a test file that doesn't exist, rather than skipping it silently", () => {
    expect(run("test/integration/no-such-suite.test.ts")).toMatchObject({ status: 2, stderr: expect.stringMatching(/no such test file: test\/integration\/no-such-suite\.test\.ts/) });
  });
  it("drops files that don't exist yet with --allow-missing, and runs nothing when none are left", () => {
    const r = run("--allow-missing", "test/integration/no-such-suite.test.ts");
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/no-such-suite\.test\.ts doesn't exist yet: not run/);
    expect(r.stdout).toMatch(/nothing to run/);
  });
});

// The smoke test against a stand-in Ember (a Node script it runs as the packaged binary). Windows can't run a script
// as an executable, so this runs on Linux and macOS; the Windows CI job runs the real packaged Ember.exe.
describe.skipIf(process.platform === "win32")("the smoke test (test/smoke/launch.mjs --exe)", () => {
  const fake = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-fake-exe-"));
    const file = path.join(dir, "ember.mjs");
    fs.writeFileSync(file, `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const dir = process.env.EMBER_USER_DATA;
const log = (msg, fields = {}) => console.log(JSON.stringify({ ...fields, level: "info", msg }));
const mode = process.env.FAKE_EMBER_MODE;
if (mode === "start-failed") { log("app.start_failed"); setInterval(() => {}, 1000); }
else if (mode === "crash") { console.error("libsomething.so: cannot open shared object file"); process.exit(3); }
else if (fs.existsSync(path.join(dir, "first"))) { fs.writeFileSync(path.join(dir, "second"), process.argv.slice(2).join(" ")); log("instance.handover"); }
else {
  fs.writeFileSync(path.join(dir, "first"), "");
  if (process.env.FAKE_EMBER_LOG) log(process.env.FAKE_EMBER_LOG);
  // As Ember does once it has started: the jump list on Windows (whether setUserTasks took it), the Dock menu on a Mac.
  if (mode !== "no-launcher") { log("launcher.tasks", { ok: mode !== "tasks-refused" }); log("launcher.dock"); }
  log("window.home.shown");
  // Ember opens the ask box for --ask only once it is set up (else settings, without the box).
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")); } catch {}
  setInterval(() => {
    if (!fs.existsSync(path.join(dir, "second"))) return;
    const args = fs.readFileSync(path.join(dir, "second"), "utf8");
    fs.rmSync(path.join(dir, "second"));
    log("instance.second");
    if (args.includes("--ask") && settings.onboarded === true && mode !== "no-ask") log("ask.open", { source: "launcher" });
  }, 50);
}
`, { mode: 0o755 });
    return file;
  })();
  const smoke = (mode: string, o: { args?: string[]; log?: string; os?: NodeJS.Platform } = {}) => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.resolve("test/smoke/launch.mjs"), "--exe", fake, ...(o.args ?? [])], {
      encoding: "utf8", timeout: 60_000,
      env: { ...process.env, FAKE_EMBER_MODE: mode, FAKE_EMBER_LOG: o.log ?? "", EMBER_SMOKE_TIMEOUT_MS: "20000", EMBER_SMOKE_VERBOSE: "", EMBER_SMOKE_PLATFORM: o.os ?? "linux" },
    });
    return { ...r, ms: Date.now() - t0 };
  };

  it("passes when the window shows and a second launch hands over", () => {
    const r = smoke("ok");
    expect(r.stdout).toMatch(/ok {3}first instance showed its window\nok {3}second launch handed over/);
    expect(r.stdout).toMatch(/ok {3}a start with --ask handed over and the first instance opened its ask box/);
    // Linux's Ask Ember is its desktop entry's action, which the package job checks.
    expect(r.stdout).not.toMatch(/jump list|Dock menu/);
    expect(r.status).toBe(0);
  });

  it("requires Ask Ember in the jump list on Windows and in the Dock menu on a Mac (D-45b)", () => {
    expect(smoke("ok", { os: "win32" })).toMatchObject({ status: 0, stdout: expect.stringMatching(/ok {3}the first instance put Ask Ember in its jump list\n/) });
    expect(smoke("ok", { os: "darwin" })).toMatchObject({ status: 0, stdout: expect.stringMatching(/ok {3}the first instance put Ask Ember in its Dock menu\n/) });
    const refused = smoke("tasks-refused", { os: "win32" });
    expect(refused.stderr).toMatch(/FAIL Windows refused the jump list \(launcher\.tasks ok: false\)/);
    expect(refused.status).toBe(1);
    for (const os of ["win32", "darwin"] as const) {
      const none = smoke("no-launcher", { os });
      expect(none.stderr, os).toMatch(/FAIL timed out after 5 s waiting for the first instance to put Ask Ember in its (jump list|Dock menu)/);
      expect(none.status, os).toBe(1);
    }
  }, 60_000);

  it("fails when a start with --ask doesn't open the ask box in the running Ember (D-45b)", () => {
    const r = smoke("no-ask");
    expect(r.stdout).toMatch(/ok {3}second launch handed over/);
    expect(r.stderr).toMatch(/FAIL timed out after 10 s waiting for the first instance to open the ask box for a start with --ask/);
    expect(r.status).toBe(1);
  }, 30_000);

  it("fails at once on app.start_failed, quoting it, and stops the app", () => {
    const r = smoke("start-failed");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL .*"msg":"app\.start_failed".*\(waiting for home window\)/);
    expect(r.ms).toBeLessThan(15_000);
  });

  it("fails when the app logged a forbidden event, quoting it, and passes when it didn't (W8)", () => {
    const taken = smoke("ok", { args: ["--forbid", "shortcut.unavailable"], log: "shortcut.unavailable" });
    expect(taken.status).toBe(1);
    expect(taken.stdout).toMatch(/ok {3}second launch handed over/);
    expect(taken.stderr).toMatch(/FAIL the first instance logged .*"msg":"shortcut\.unavailable"/);
    const clear = smoke("ok", { args: ["--forbid", "shortcut.unavailable", "--forbid", "app.other"], log: "shortcut.question_key_taken" });
    expect(clear.stdout).toMatch(/ok {3}the first instance logged none of shortcut\.unavailable, app\.other/);
    expect(clear.status).toBe(0);
    // Without --forbid the event is only a log line.
    expect(smoke("ok", { log: "shortcut.unavailable" }).status).toBe(0);
    expect(spawnSync(process.execPath, [path.resolve("test/smoke/launch.mjs"), "--forbid"], { encoding: "utf8" })).toMatchObject({ status: 2, stderr: expect.stringMatching(/usage:.*--forbid <event>/) });
  });

  it("fails at once when the app exits before its window, showing what it said", () => {
    const r = smoke("crash");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL the first instance exited with 3/);
    expect(r.stderr).toMatch(/cannot open shared object file/);
    expect(r.ms).toBeLessThan(15_000);
  });
});
