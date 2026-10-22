/** Linux's SystemPlatform (platform/linux/system.ts, design §3): every row is today's call with today's arguments. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fakes = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...(await importOriginal<typeof import("node:child_process")>()), execFile: fakes.execFile, spawn: fakes.spawn }));

import { linuxSystem, type LinuxSystemIO } from "../../app/main/platform/linux/system";
import { accessibilityProbe, linuxEnvironment, type ExecSync } from "../../app/main/platform/linux/environment";
import { linuxDoctorProbes } from "../../app/main/platform/linux/doctor-probes";
import type { PlatformDeps } from "../../app/main/platform/types";
import { SETTINGS, findApp, hasBuiltInShell, isTerminalApp, listApps, programsOf, type DesktopApp } from "../../app/main/hands/system";
import { ADMIN_POLICY_FILE, AdminPolicySchema, loadAdminPolicy } from "../../app/main/admin";
import { autostartEntry, launchCommand } from "../../app/main/autostart";
import { journalAvailable, journalSink } from "../../app/main/policy/audit";
import { isSecurityWindow } from "../../app/main/policy/policy";
import { CLIPBOARD_FORMATS } from "../../app/main/agent/clipboard-formats";
import { NEVER_LOOK_DEFAULTS } from "../../app/shared/never-look";
import { KEYS, SHORTCUTS } from "../../app/shared/shortcuts";
import { PLATFORM_WORDS } from "../../app/shared/words";

/** Electron's screen throws on any property access before ready; app.getPath must not be called while composing. */
const throwing = new Proxy({}, { get: (_t, key) => { throw new Error(`screen.${String(key)} touched while composing`); } });
const deps = (over: Partial<PlatformDeps> = {}, a11y = false): PlatformDeps => ({
  electron: {
    app: {
      isPackaged: false, getPath: () => { throw new Error("app.getPath called while composing"); }, getAppPath: () => "/repo", getVersion: () => "0.0.0",
      isAccessibilitySupportEnabled: () => a11y, setLoginItemSettings: () => undefined, getLoginItemSettings: () => ({ openAtLogin: false }), focus: () => undefined,
    },
    screen: throwing as never, desktopCapturer: throwing as never, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
    shell: { openExternal: async () => undefined }, powerMonitor: throwing as never, browserWindow: throwing as never,
  },
  packaged: false, execPath: "/repo/node_modules/electron/dist/electron", appPath: "/repo", resourcesPath: "/repo/resources", env: { PATH: "/usr/bin:/bin" },
  ...over,
});
/** An exec fake answering by the command line. */
const execFake = (answers: Record<string, string | Error>) => {
  const calls: { cmd: string; args: string[]; opts: unknown }[] = [];
  const exec: ExecSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const a = answers[[cmd, ...args].join(" ")];
    if (a === undefined || a instanceof Error) throw a ?? new Error(`${cmd}: not found`);
    return a;
  };
  return { exec, calls };
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-linux-system-"));

afterEach(() => { vi.clearAllMocks(); });

describe("composing Linux's SystemPlatform", () => {
  it("touches nothing of Electron's (screen throws before ready, app.getPath isn't safe yet)", () => {
    expect(() => linuxSystem(deps())).not.toThrow();
  });

  it("is Linux's words, shortcuts and key conventions", () => {
    const s = linuxSystem(deps());
    expect(s.os).toBe("linux");
    expect(s.words).toBe(PLATFORM_WORDS.linux);
    expect(s.shortcuts).toBe(SHORTCUTS.linux);
    expect(s.keys).toBe(KEYS.linux);
    expect(s.chromiumSwitches).toEqual(["enable-speech-dispatcher"]);
    expect(s.spawnDefaults).toEqual({});
    expect(s.ghCliPath()).toBeNull();
  });
});

describe("paths", () => {
  it("are today's: ~/.config/ember, the linux-x64 runtime, the fixed folder text and no rename retries", () => {
    const p = linuxSystem(deps()).paths;
    expect(p.userData("/home/u/.config", "/home/u")).toBe("/home/u/.config/ember");
    expect([p.runtimeId, p.runtimeExe]).toEqual(["linux-x64", "copilot-runtime"]);
    expect(p.dataDirLabel("/tmp/anything")).toBe("~/.config/ember");
    expect(p.dataDirLabel("/tmp/anything", "settings.json")).toBe("~/.config/ember/settings.json");
    expect(p.renameRetries).toBe(0);
  });
});

describe("apps", () => {
  it("list the XDG desktop files listApps finds, from the platform's environment", () => {
    const data = tmp();
    fs.mkdirSync(path.join(data, "applications"));
    fs.writeFileSync(path.join(data, "applications", "org.example.Notes.desktop"), "[Desktop Entry]\nType=Application\nName=Notes\nExec=notes %U\n");
    const env = { XDG_DATA_HOME: data, XDG_DATA_DIRS: path.join(data, "none") };
    expect(linuxSystem(deps({ env })).apps.list()).toEqual(listApps(env));
    expect(linuxSystem(deps({ env })).apps.list().map(a => a.id)).toEqual(["org.example.Notes"]);
  });

  it("find, check and name apps with hands/system.ts's functions", () => {
    const apps = linuxSystem(deps()).apps;
    const sample: DesktopApp[] = [
      { id: "org.gnome.Terminal", name: "Terminal", file: "", keywords: [], exec: "gnome-terminal" },
      { id: "org.gnome.gedit", name: "Text Editor", file: "", keywords: ["text editor"], exec: "gedit %U", generic: "text editor" },
      { id: "emacs", name: "Emacs", file: "", keywords: [], exec: "emacs %F" },
    ];
    for (const q of ["terminal", "text editor", "emacs", "nothing"]) expect(apps.find(sample, q)).toBe(findApp(sample, q));
    for (const a of sample) {
      expect(apps.isTerminalApp(a), a.id).toBe(isTerminalApp(a));
      expect(apps.hasBuiltInShell(a), a.id).toBe(hasBuiltInShell(a));
      expect(apps.programsOf(a), a.id).toEqual(programsOf(a));
    }
    expect(apps.appKey("Gedit")).toBe("gedit");
    expect(apps.appKey("NOTEPAD.EXE")).toBe("notepad.exe");
  });

  it("launch through launchApp: terminals refused at once, others with gtk-launch from the home folder", () => {
    const apps = linuxSystem(deps()).apps;
    expect(() => apps.launch({ id: "xterm", name: "XTerm", file: "", keywords: [], exec: "xterm" })).toThrow("Ember doesn't run terminals, on its desk or anywhere else");
    fakes.spawn.mockReturnValue(Object.assign(new EventEmitter(), { unref: vi.fn() }));
    apps.launch({ id: "org.gnome.gedit", name: "Text Editor", file: "", keywords: [], exec: "gedit %U" });
    expect(fakes.spawn).toHaveBeenCalledWith("gtk-launch", ["org.gnome.gedit"], expect.objectContaining({ cwd: os.homedir(), detached: true }));
  });
});

describe("settings", () => {
  it("offer all six GNOME settings and change them with gsettings, read back", async () => {
    const s = linuxSystem(deps()).settings;
    expect(s.available).toBe(SETTINGS);
    const values: Record<string, string> = { "night-light-enabled": "false" };
    fakes.execFile.mockImplementation((_cmd: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      if (args[0] === "set") values[args[2]] = args[3];
      cb(null, args[0] === "get" ? values[args[2]] : "", "");
    });
    expect(await s.change("night_light", "on")).toEqual({ before: "false", after: "true" });
    expect(fakes.execFile.mock.calls.map(c => [c[0], ...c[1]].join(" "))).toEqual([
      "gsettings writable org.gnome.settings-daemon.plugins.color night-light-enabled",
      "gsettings get org.gnome.settings-daemon.plugins.color night-light-enabled",
      "gsettings set org.gnome.settings-daemon.plugins.color night-light-enabled true",
      "gsettings get org.gnome.settings-daemon.plugins.color night-light-enabled",
    ]);
  });
});

describe("the administrator's policy", () => {
  it("lives in /etc/ember/policy.json and loads as loadAdminPolicy always has", () => {
    const a = linuxSystem(deps()).adminPolicy;
    expect(a.location).toBe(ADMIN_POLICY_FILE);
    expect(a.load()).toEqual(loadAdminPolicy());
    const f = path.join(tmp(), "policy.json");
    fs.writeFileSync(f, JSON.stringify({ confirmEveryAction: true }));
    // EMBER_ADMIN_POLICY (development): today's loader, without the root-owner check.
    expect(a.load(f)).toEqual({ policy: AdminPolicySchema.parse({ confirmEveryAction: true }), source: f });
  });

  it("reads the provider key from its key file, else EMBER_PROVIDER_API_KEY", () => {
    const f = path.join(tmp(), "key");
    fs.writeFileSync(f, " sk-test \n");
    expect(linuxSystem(deps()).adminPolicy.providerApiKey({ type: "openai", baseUrl: "https://ai.example.org", apiKeyFile: f })).toBe("sk-test");
  });
});

describe("autostart", () => {
  it("writes and removes the XDG autostart entry for this Ember, and knows an --autostart start", () => {
    const config = tmp();
    const d = deps({ env: { XDG_CONFIG_HOME: config } });
    const a = linuxSystem(d).autostart;
    const file = path.join(config, "autostart", "ember.desktop");
    expect(a.sync(true)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(autostartEntry(launchCommand({ packaged: false, execPath: d.execPath, appPath: d.appPath, env: d.env })));
    expect(a.sync(true)).toBe(false);
    expect(a.sync(false)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(a.launchedAtLogin(["/usr/bin/ember", "--autostart"])).toBe(true);
    expect(a.launchedAtLogin(["/usr/bin/ember"])).toBe(false);
    expect(a.note()).toBeNull();
  });
});

describe("the audit copy", () => {
  it("goes to the journal through journalSink, and the settings window names it only when there is one", () => {
    const both = (p: string) => p === "/usr/bin/systemd-cat" || p === "/run/systemd/journal/stdout";
    expect(linuxSystem(deps(), { exists: both }).auditCopy()).toBe("the system journal (journalctl -t ember-audit)");
    expect(linuxSystem(deps(), { exists: p => p === "/bin/systemd-cat" }).auditCopy()).toBeNull();
    expect(linuxSystem(deps(), { exists: () => false }).auditCopy()).toBeNull();
    expect(linuxSystem(deps()).auditSink(() => undefined) === undefined).toBe(journalSink() === undefined);
  });

  it("journalAvailable needs both systemd-cat and the journal's socket", () => {
    expect(journalAvailable(p => p === "/bin/systemd-cat" || p === "/run/systemd/journal/stdout")).toBe(true);
    expect(journalAvailable(p => p === "/run/systemd/journal/stdout")).toBe(false);
    expect(journalAvailable(p => p === "/usr/bin/systemd-cat")).toBe(false);
  });
});

describe("which", () => {
  it("searches PATH (default /usr/bin:/bin) for an executable", () => {
    const sh = linuxSystem(deps({ env: {} })).which("sh");
    if (process.platform !== "win32") expect(sh === "/usr/bin/sh" || sh === "/bin/sh").toBe(true);
    expect(linuxSystem(deps({ env: { PATH: tmp() } })).which("sh")).toBeNull();
  });
});

describe("the setup-check inputs", () => {
  const RELEASE = 'ID="rhel"\nVERSION_ID="8.4"\n';
  // EMBER_PYTHON pins the interpreter (pickPython prefers /usr/libexec/platform-python where it exists, as on RHEL 8).
  const env = { DISPLAY: ":0", XDG_SESSION_TYPE: "x11", PATH: "/usr/bin", EMBER_PYTHON: "python3" };
  const versions = { electron: "44.5.0", chrome: "152", node: "24.21.0" };

  it("are main.ts's readEnvironment construction, field by field", () => {
    const { exec } = execFake({ "gsettings get org.gnome.desktop.interface toolkit-accessibility": "true\n", "python3 -c import pyatspi": "" });
    const read = linuxEnvironment({ env, platform: "linux", arch: "x64", versions, exec, readFile: () => RELEASE, report: () => ({ header: { glibcVersionRuntime: "2.28" } }), now: () => 0 });
    const windows = {} as never;
    // Today's construction (main.ts:141-156), with the same inputs.
    const today = {
      env, osRelease: RELEASE, glibc: "2.28", versions, platform: "linux", arch: "x64",
      accessibility: { enabled: true, pyatspi: true }, x11: true, shortcutsTaken: ["Control+Alt+X"],
    };
    expect(read({ windows, shortcutsTaken: ["Control+Alt+X"] })).toEqual(today);
  });

  it("know the X display's state only once Ember has tried it (as x11Reachable did)", () => {
    const { exec } = execFake({});
    const read = (e: NodeJS.ProcessEnv) => linuxEnvironment({ env: e, platform: "linux", exec, readFile: () => "", report: () => undefined });
    expect(read(env)({ windows: undefined }).x11).toBeUndefined();
    expect(read(env)({ windows: null }).x11).toBe(false);
    expect(read(env)({ windows: {} as never }).x11).toBe(true);
    expect(read({})({ windows: null }).x11).toBeUndefined();
    expect(read(env)({ windows: null }).osRelease).toBe("");
    expect(read(env)({ windows: null }).glibc).toBeNull();
  });

  it("probe accessibility with today's commands, and look for pyatspi again only while it is missing, every 30 s", () => {
    let t = 0;
    const fake = execFake({ "gsettings get org.gnome.desktop.interface toolkit-accessibility": "false\n" });
    const probe = accessibilityProbe({ env: { EMBER_PYTHON: "/opt/py" }, exec: fake.exec, now: () => t });
    expect(probe()).toEqual({ enabled: false, pyatspi: false });
    expect(fake.calls).toEqual([
      { cmd: "gsettings", args: ["get", "org.gnome.desktop.interface", "toolkit-accessibility"], opts: { encoding: "utf8", timeout: 2000 } },
      { cmd: "/opt/py", args: ["-c", "import pyatspi"], opts: { stdio: "ignore", timeout: 5000 } },
    ]);
    t = 20_000;
    probe();
    expect(fake.calls.filter(c => c.cmd === "/opt/py")).toHaveLength(1);
    t = 30_001;
    probe();
    expect(fake.calls.filter(c => c.cmd === "/opt/py")).toHaveLength(2);
    const found = execFake({ "python3 -c import pyatspi": "" });
    const once = accessibilityProbe({ env: { EMBER_PYTHON: "python3" }, exec: found.exec, now: () => t });
    expect(once()).toEqual({ enabled: null, pyatspi: true });
    t += 100_000;
    once();
    expect(found.calls.filter(c => c.cmd === "python3")).toHaveLength(1);
  });

  it("leave accessibility out on an OS that isn't Linux (an unknown OS gets the Linux object)", () => {
    const { exec } = execFake({});
    expect(linuxEnvironment({ env, platform: "freebsd", exec, readFile: () => "", report: () => undefined })({ windows: undefined }).accessibility).toBeUndefined();
  });
});

describe("fixes", () => {
  it("offer only turning accessibility on, with today's gsettings command", async () => {
    const fake = execFake({ "gsettings set org.gnome.desktop.interface toolkit-accessibility true": "" });
    const f = linuxSystem(deps(), { exec: fake.exec }).fixes;
    expect(f.ids).toEqual(["enable-accessibility"]);
    expect(f.label("enable-accessibility")).toBe("Turn on");
    await f.apply("enable-accessibility");
    expect(fake.calls).toEqual([{ cmd: "gsettings", args: ["set", "org.gnome.desktop.interface", "toolkit-accessibility", "true"], opts: { timeout: 5000 } }]);
    await expect(f.apply("open-accessibility-settings")).rejects.toThrow("unknown fix: open-accessibility-settings");
  });

  it("let a failed gsettings reach the caller", async () => {
    const fake = execFake({ "gsettings set org.gnome.desktop.interface toolkit-accessibility true": new Error("gsettings: not found") });
    await expect(linuxSystem(deps(), { exec: fake.exec }).fixes.apply("enable-accessibility")).rejects.toThrow("gsettings: not found");
  });
});

describe("the doctor's probes", () => {
  const io = (over: Partial<Parameters<typeof linuxDoctorProbes>[0]> = {}) => linuxDoctorProbes({
    execPath: "/opt/ember/ember", which: () => null, exec: execFake({}).exec, readFile: () => { throw new Error("ENOENT"); }, stat: () => { throw new Error("ENOENT"); },
    exists: () => false, fileWatchers: () => null, desk: () => ({ ok: false, missing: ["Xvfb"] }), ...over,
  });

  it("list PulseAudio's microphones without their monitors", async () => {
    const { exec, calls } = execFake({ "pactl list short sources": "0\talsa_output.monitor\tmodule\n1\talsa_input.analog-stereo\tmodule\n\n" });
    expect((await io({ exec })).microphones).toEqual(["alsa_input.analog-stereo"]);
    expect(calls[0].opts).toEqual({ encoding: "utf8", timeout: 3000 });
  });

  it("say null without pactl, and none found when pactl is there but failed", async () => {
    expect((await io()).microphones).toBeNull();
    expect((await io({ which: c => (c === "pactl" ? "/usr/bin/pactl" : null) })).microphones).toEqual([]);
  });

  it("find speech-dispatcher by its program or its library", async () => {
    expect((await io()).speechDispatcher).toBe(false);
    expect((await io({ which: c => (c === "speech-dispatcher" ? "/usr/bin/speech-dispatcher" : null) })).speechDispatcher).toBe(true);
    expect((await io({ exists: f => f === "/usr/lib64/libspeechd.so.2" })).speechDispatcher).toBe(true);
  });

  it("read the sandbox as before: user namespaces (off when Debian's switch says 0), or a setuid-root chrome-sandbox beside Ember", async () => {
    const files = (m: Record<string, string>) => (f: string) => { if (f in m) return m[f]; throw new Error("ENOENT"); };
    expect((await io({ readFile: files({ "/proc/sys/user/max_user_namespaces": "15000\n" }) })).sandbox).toEqual({ userNamespaces: true, suidHelper: false });
    expect((await io({ readFile: files({ "/proc/sys/user/max_user_namespaces": "15000\n", "/proc/sys/kernel/unprivileged_userns_clone": "0\n" }) })).sandbox?.userNamespaces).toBe(false);
    expect((await io({ readFile: files({ "/proc/sys/user/max_user_namespaces": "0\n" }) })).sandbox?.userNamespaces).toBe(false);
    // Built as doctor-probes builds it (path.join), so the case holds on a Windows or macOS CI runner too.
    const stat = (f: string) => { if (f === path.join("/opt/ember", "chrome-sandbox")) return { uid: 0, mode: 0o104755 }; throw new Error("ENOENT"); };
    expect((await io({ stat })).sandbox?.suidHelper).toBe(true);
    expect((await io({ stat: () => ({ uid: 1000, mode: 0o104755 }) })).sandbox?.suidHelper).toBe(false);
  });

  it("pass on the desk's and the file watchers' answers, and add no rows of their own", async () => {
    const p = await io({ fileWatchers: () => ({ used: 3, max: 128 }) });
    expect(p.desk).toEqual({ ok: false, missing: ["Xvfb"] });
    expect(p.fileWatchers).toEqual({ used: 3, max: 128 });
    expect(p.extra).toEqual([]);
  });

  it("are what linuxSystem's doctorProbes gathers", async () => {
    const p = await linuxSystem(deps(), { exec: execFake({}).exec, exists: () => false }).doctorProbes();
    expect(Object.keys(p).sort()).toEqual(["desk", "extra", "fileWatchers", "microphones", "sandbox", "speechDispatcher"]);
    expect(p.desk).not.toBeNull();
    expect(p.sandbox).not.toBeNull();
  });
});

describe("accessibility probes", () => {
  it("know a screen reader from GNOME's switch, asked once a minute, or from Chromium's accessibility being on", () => {
    let fire: () => void = () => undefined;
    const fake = execFake({ "gsettings get org.gnome.desktop.a11y.applications screen-reader-enabled": "true\n" });
    const io: LinuxSystemIO = { exec: fake.exec, setTimeout: (fn, ms) => { expect(ms).toBe(60_000); fire = fn; return {}; } };
    const a = linuxSystem(deps(), io).a11y;
    expect(a.screenReaderOn()).toBe(true);
    expect(a.screenReaderOn()).toBe(true);
    expect(fake.calls).toHaveLength(1);
    fire();
    a.screenReaderOn();
    expect(fake.calls).toHaveLength(2);
    expect(linuxSystem(deps({}, true), { exec: execFake({}).exec, setTimeout: () => ({}) }).a11y.screenReaderOn()).toBe(true);
    expect(linuxSystem(deps({}, false), { exec: execFake({}).exec, setTimeout: () => ({}) }).a11y.screenReaderOn()).toBe(false);
  });

  it("count GNOME's Animations switch off as reduced motion", () => {
    const off = execFake({ "gsettings get org.gnome.desktop.interface enable-animations": "false\n" });
    expect(linuxSystem(deps(), { exec: off.exec }).a11y.systemReducedMotion()).toBe(true);
    expect(off.calls[0].opts).toEqual({ encoding: "utf8", timeout: 2000 });
    expect(linuxSystem(deps(), { exec: execFake({ "gsettings get org.gnome.desktop.interface enable-animations": "true\n" }).exec }).a11y.systemReducedMotion()).toBe(false);
    expect(linuxSystem(deps(), { exec: execFake({}).exec }).a11y.systemReducedMotion()).toBe(false);
  });
});

describe("voice, privacy, clipboard and lifecycle", () => {
  it("are today's Linux values", () => {
    const s = linuxSystem(deps());
    expect(s.voice.speakerMonitor).toBe(true);
    expect(s.voice.bundledModelDirs("/opt/ember/resources")).toEqual(["/usr/share/ember/voice-models", path.join("/opt/ember/resources", "voice-models")]);
    expect(s.voice.bundledModelDirs("")).toEqual(["/usr/share/ember/voice-models", "voice-models"]);
    expect(s.privacy.neverLookDefaults).toBe(NEVER_LOOK_DEFAULTS.linux);
    for (const w of [{ app: "polkit-gnome-authentication-agent-1" }, { title: "Authentication Required" }, { app: "gedit", title: "notes" }]) {
      expect(s.privacy.isSecurityWindow(w), JSON.stringify(w)).toBe(isSecurityWindow(w));
    }
    expect(s.clipboardFormats).toBe(CLIPBOARD_FORMATS.linux);
    const l = s.lifecycle;
    expect({ ...l, ensureShortcut: undefined, focusOwnApp: undefined }).toEqual({ appUserModelId: null, appMenu: false, reopenShowsSettings: false, sessionEnd: null,
      activateOwnWithInput: true, activateForAsk: true, ensureShortcut: undefined, focusOwnApp: undefined });
    expect(l.askMicrophone).toBeUndefined();
    expect(() => { l.ensureShortcut(); l.focusOwnApp(); }).not.toThrow();
  });
});
