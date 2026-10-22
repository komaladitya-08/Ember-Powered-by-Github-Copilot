/** M9: `ember doctor`, start at login, the RPM's promises, and the Windows and macOS packages (M11). */

import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TARGETS, layoutFor, selectPackages } from "../../scripts/package/layout.mjs";
import { ICONSET, ICO_SIZES, icoFromPngs } from "../../scripts/package/icon.mjs";
import { BUNDLE_ID, EXECUTABLE, finishMacBundle, infoPlistValues, type RunResult } from "../../scripts/package/mac-bundle.mjs";
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

// The RPM's and the AppImage's sh launchers, run with /bin/sh (which Windows doesn't have).
describe.skipIf(process.platform === "win32")("the launchers", () => {
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
    expect(run(launcher, ["doctor"], 0)).toBe("--doctor --ozone-platform=headless --disable-gpu --no-sandbox");
    expect(run(launcher, ["doctor"], 0, ":0")).toBe("--doctor --ozone-platform=x11 --disable-gpu --no-sandbox");
    expect(run(launcher, ["doctor"], 1000)).toBe("--doctor --ozone-platform=headless --disable-gpu");
    expect(run(launcher, [], 0, ":0")).toBe("--ozone-platform=x11");
    expect(run(appRun, ["doctor"], 0)).toBe("--doctor --ozone-platform=headless --disable-gpu --no-sandbox");
    const noUserNs = (() => { try { return fs.readFileSync("/proc/sys/user/max_user_namespaces", "utf8").trim() === "0"; } catch { return true; } })();
    expect(run(appRun, ["doctor"], 1000).includes("--no-sandbox")).toBe(noUserNs);
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
    // The executable stage.mjs renamed (layout.mjs), so that Electron's app.isPackaged is true.
    expect(values.CFBundleExecutable).toBe(EXECUTABLE);
    expect(layoutFor("darwin", "arm64").exe).toBe(`Contents/MacOS/${EXECUTABLE}`);
  });

  /** A stand-in for plutil, iconutil, xattr and codesign that keeps Info.plist as a map. */
  const fakeMac = (o: { ignore?: string; verifyFails?: boolean; noExecutable?: boolean } = {}) => {
    const plist: Record<string, string> = { CFBundleName: "Electron", CFBundleIdentifier: "com.github.Electron", CFBundleExecutable: "Electron", ElectronAsarIntegrity: "<dict/>" };
    const calls: string[][] = [];
    const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
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
    // The signature covers every change: nothing touches the bundle after it.
    expect(mac.calls.slice(-3).map(line)).toEqual([
      `xattr -cr ${mac.app}`,
      `codesign --force --deep --sign - --timestamp=none ${mac.app}`,
      `codesign --verify --deep --strict --verbose=2 ${mac.app}`,
    ]);
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
  it("stages the Linux packages with every file required (no --allow-missing-sidecar)", () => {
    const job = ci.slice(ci.indexOf("\n  package:"), ci.indexOf("\n  eval:"));
    expect(job).toMatch(/^\s+node scripts\/package\/stage\.mjs$/m);
    expect(job).not.toContain("--allow-missing");
  });
  it("marks every use of --allow-missing-sidecar and --allow-missing for removal", () => {
    const lines = ci.split("\n");
    const uses = lines.flatMap((l, i) => (/--allow-missing/.test(l) && !/^\s*#/.test(l) ? [i] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const i of uses) expect(lines.slice(Math.max(0, i - 4), i).join("\n"), lines[i]).toMatch(/TODO\(port\): drop --allow-missing/);
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
const log = msg => console.log(JSON.stringify({ level: "info", msg }));
const mode = process.env.FAKE_EMBER_MODE;
if (mode === "start-failed") { log("app.start_failed"); setInterval(() => {}, 1000); }
else if (mode === "crash") { console.error("libsomething.so: cannot open shared object file"); process.exit(3); }
else if (fs.existsSync(path.join(dir, "first"))) { fs.writeFileSync(path.join(dir, "second"), ""); log("instance.handover"); }
else {
  fs.writeFileSync(path.join(dir, "first"), "");
  log("window.home.shown");
  setInterval(() => { if (fs.existsSync(path.join(dir, "second"))) { fs.rmSync(path.join(dir, "second")); log("instance.second"); } }, 50);
}
`, { mode: 0o755 });
    return file;
  })();
  const smoke = (mode: string) => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.resolve("test/smoke/launch.mjs"), "--exe", fake], {
      encoding: "utf8", timeout: 60_000, env: { ...process.env, FAKE_EMBER_MODE: mode, EMBER_SMOKE_TIMEOUT_MS: "20000", EMBER_SMOKE_VERBOSE: "" },
    });
    return { ...r, ms: Date.now() - t0 };
  };

  it("passes when the window shows and a second launch hands over", () => {
    const r = smoke("ok");
    expect(r.stdout).toMatch(/ok {3}first instance showed its window\nok {3}second launch handed over/);
    expect(r.status).toBe(0);
  });

  it("fails at once on app.start_failed, quoting it, and stops the app", () => {
    const r = smoke("start-failed");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL .*"msg":"app\.start_failed".*\(waiting for home window\)/);
    expect(r.ms).toBeLessThan(15_000);
  });

  it("fails at once when the app exits before its window, showing what it said", () => {
    const r = smoke("crash");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL the first instance exited with 3/);
    expect(r.stderr).toMatch(/cannot open shared object file/);
    expect(r.ms).toBeLessThan(15_000);
  });
});
