/**
 * Launching WSLg apps from their Start Menu shortcuts (design §4.8, critique wsl-23): wslg.exe's command line is read
 * strictly, every word after "--" is a plain token (the distro's shell reads the rest as a command line), the distro
 * must be a set-up WSL 2 one not run as root, the Linux command is judged with the Linux terminal vocabulary, and a
 * shortcut that passes is opened with explorer.exe and the .lnk, read again from the file. OS-neutral: fake files,
 * spawn and WSL.
 */

import { describe, expect, it } from "vitest";
import { isTerminalApp, type DesktopApp } from "../../app/main/hands/system";
import type { AppCatalog, AppIdentity } from "../../app/main/platform/types";
import { isWslgShortcut, isWslLauncher, withWslApps, wslgLaunch, wslgRefusal } from "../../app/main/wsl/apps";
import type { WslDistro, WslFacts, WslService } from "../../app/main/wsl/types";
import type { Logger } from "../../app/main/logger";
import { buildLnk } from "./win32-system-fakes";

const WSLG = "C:\\Program Files\\WSL\\wslg.exe";
const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; }, file: "" };

const distro = (name: string, more: Partial<WslDistro> = {}): WslDistro => ({ name, version: 2, isDefault: false, defaultUid: 1000, running: true, needsSetup: false, ...more });
const facts = (distros: WslDistro[], more: Partial<WslFacts> = {}): WslFacts => ({
  installed: true, wslExe: "C:\\Program Files\\WSL\\wsl.exe", distros, wslg: { available: true, disabledByUser: false, version: "1.0.65" }, wslVersion: "2.3.26.0", ...more,
});

describe("wslgLaunch (pure)", () => {
  it.each([
    [[WSLG, "-d", "Ubuntu", "--cd", "~", "--", "gedit"], { distro: "Ubuntu", cwd: "~", argv: ["gedit"] }],
    [[WSLG, "--distribution", "Ubuntu-22.04", "--", "/usr/bin/gedit", "--new-window"], { distro: "Ubuntu-22.04", cwd: null, argv: ["/usr/bin/gedit", "--new-window"] }],
    [["wslg.exe", "--", "xeyes"], { distro: null, cwd: null, argv: ["xeyes"] }],
    [["C:\\Windows\\System32\\WSLG.EXE", "--cd", "/home/ana", "-d", "Debian", "--", "env", "GDK_BACKEND=x11", "gnome-calculator"], { distro: "Debian", cwd: "/home/ana", argv: ["env", "GDK_BACKEND=x11", "gnome-calculator"] }],
    [[WSLG, "--", "libreoffice", "--writer", "%U", "a@b:c,d+e=f.g_h"], { distro: null, cwd: null, argv: ["libreoffice", "--writer", "%U", "a@b:c,d+e=f.g_h"] }],
  ])("accepts %j", (argv, want) => {
    expect(wslgLaunch(argv)).toEqual(want);
  });

  it.each([
    ["no program", []],
    ["not wslg", ["C:\\Windows\\System32\\wsl.exe", "--", "gedit"]],
    ["-u", [WSLG, "-u", "root", "--", "gedit"]],
    ["--user", [WSLG, "--user", "root", "--", "gedit"]],
    ["-e", [WSLG, "-e", "gedit"]],
    ["--exec", [WSLG, "--exec", "gedit"]],
    ["--system", [WSLG, "--system", "--", "gedit"]],
    ["--shell-type", [WSLG, "--shell-type", "login", "--", "gedit"]],
    ["an unknown option", [WSLG, "--verbose", "--", "gedit"]],
    ["-d=", [WSLG, "--distribution=Ubuntu", "--", "gedit"]],
    ["two distros", [WSLG, "-d", "Ubuntu", "-d", "Debian", "--", "gedit"]],
    ["a bad distro name", [WSLG, "-d", "../x", "--", "gedit"]],
    ["-d without a name", [WSLG, "-d"]],
    ["--cd without a folder", [WSLG, "--cd", "--", "gedit"]],
    ["no --", [WSLG, "-d", "Ubuntu", "gedit"]],
    ["nothing after --", [WSLG, "-d", "Ubuntu", "--"]],
    ["the older shape", [WSLG, "~", "-d", "Ubuntu", "gedit"]],
  ])("rejects %s", (_why, argv) => {
    expect(wslgLaunch(argv)).toBeNull();
  });

  it.each(["'gedit'", "\"gedit\"", "$HOME", "`id`", "a;b", "a&b", "a|b", "a<b", "a>b", "(a)", "{a}", "a*", "a?", "[a]", "~", "~/x", "!x", "#x", "a b", "a\tb", "", "é"])(
    "rejects the token %j after -- (the distro's shell would read it as code)", tok => {
      expect(wslgLaunch([WSLG, "-d", "Ubuntu", "--", "gedit", tok])).toBeNull();
    });
});

describe("wslgRefusal (with what WSL says)", () => {
  const argv = (d?: string) => [WSLG, ...(d ? ["-d", d] : []), "--", "gedit"];

  it("accepts a set-up WSL 2 distro not run as root, and the default one when none is named", () => {
    expect(wslgRefusal(argv("Ubuntu"), facts([distro("Ubuntu")]))).toBeNull();
    expect(wslgRefusal(argv("ubuntu"), facts([distro("Ubuntu")]))).toBeNull();
    expect(wslgRefusal(argv(), facts([distro("Debian"), distro("Ubuntu", { isDefault: true })]))).toBeNull();
    // Its uid not known yet (stopped since Ember started): opening the app starts it, as the user asked.
    expect(wslgRefusal(argv("Ubuntu"), facts([distro("Ubuntu", { defaultUid: null, running: false })]))).toBeNull();
  });

  it("refuses a distro that isn't installed, is WSL 1, runs as root, isn't set up, is a tool's, or has no WSLg", () => {
    expect(wslgRefusal(argv("Arch"), facts([distro("Ubuntu")]))).toMatch(/isn't installed/);
    expect(wslgRefusal(argv(), facts([distro("Ubuntu")]))).toMatch(/no default/);
    expect(wslgRefusal(argv("Ubuntu"), facts([distro("Ubuntu", { version: 1 })]))).toMatch(/WSL 1/);
    expect(wslgRefusal(argv("Ubuntu"), facts([distro("Ubuntu", { defaultUid: 0 })]))).toBe("Ember doesn't use Linux apps of a distro that runs as root.");
    expect(wslgRefusal(argv("Ubuntu"), facts([distro("Ubuntu", { needsSetup: true })]))).toBe("Set up Ubuntu first: open it from the Start menu once.");
    expect(wslgRefusal(argv("podman-machine-default"), facts([distro("podman-machine-default", { tool: "podman" })]))).toMatch(/tool/);
    expect(wslgRefusal(argv("Ubuntu"), facts([distro("Ubuntu")], { wslg: { available: false, disabledByUser: false, version: null } }))).toMatch(/wsl --update/);
    expect(wslgRefusal(argv("Ubuntu"), facts([distro("Ubuntu")], { installed: false }))).toMatch(/isn't installed/);
    expect(wslgRefusal([WSLG, "-u", "root", "--", "gedit"], facts([distro("Ubuntu")]))).toBe("Ember can't tell exactly what this shortcut runs");
  });
});

describe("whose wslg.exe", () => {
  it("is WSL's own, in its install folder or the Store package's", () => {
    expect(isWslLauncher(WSLG)).toBe(true);
    expect(isWslLauncher("c:\\PROGRAM FILES\\WSL\\WSLG.EXE")).toBe(true);
    expect(isWslLauncher("C:\\Program Files\\WindowsApps\\MicrosoftCorporationII.WindowsSubsystemForLinux_1.2.5.0_x64__8wekyb3d8bbwe\\wslg.exe")).toBe(true);
    expect(isWslLauncher("C:\\Users\\ana\\Downloads\\wslg.exe")).toBe(false);
    expect(isWslLauncher("C:\\Program Files\\WSL\\..\\Evil\\wslg.exe")).toBe(false);
    expect(isWslLauncher("\\\\server\\share\\Program Files\\WSL\\wslg.exe")).toBe(false);
  });
});

/** A catalogue like Windows': wslg is a refused program there, so a WSLg shortcut is a terminal to it. */
function windowsCatalogue(launched: DesktopApp[]): AppCatalog {
  return {
    list: () => [],
    find: () => null,
    launch: app => { if (isTerminalApp(app, "win32")) throw new Error("Ember doesn't run terminals, on its desk or anywhere else"); launched.push(app); },
    isTerminalApp: (a: AppIdentity) => isTerminalApp(a, "win32"),
    hasBuiltInShell: () => false,
    programsOf: app => new Set(app.programs ?? []),
    appKey: s => s.toLowerCase().replace(/\.exe$/, ""),
  };
}

const shortcut = (name: string, args: string, file = `C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Ubuntu\\${name}.lnk`): DesktopApp => ({
  id: `Ubuntu/${name}`, name, file, keywords: [], argv: [WSLG, ...args.split(" ")], programs: ["wslg"],
});

function setup(o: { on?: boolean; facts?: WslFacts; files?: Record<string, Buffer> } = {}) {
  const launched: DesktopApp[] = [];
  const spawned: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const f = o.facts ?? facts([distro("Ubuntu", { isDefault: true })]);
  const wsl = { facts: async () => f, onChange: () => () => undefined } as unknown as WslService;
  const files = o.files ?? {};
  const apps = withWslApps(windowsCatalogue(launched), {
    wsl: () => wsl, log, on: () => o.on ?? true, env: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows", GH_TOKEN: "secret" },
    readFile: p => files[p] ?? null, homedir: () => "C:\\Users\\ana",
    spawn: (command, args, options) => { spawned.push({ command, args, options: options as Record<string, unknown> }); return { on: () => undefined, unref: () => undefined }; },
  });
  return { apps, launched, spawned };
}

describe("withWslApps", () => {
  const gedit = shortcut("gedit (Ubuntu)", "-d Ubuntu --cd ~ -- gedit");
  const lnk = (args: string, target = WSLG) => buildLnk({ target, args });

  it("judges a WSLg shortcut by its Linux command: gedit isn't a terminal, gnome-terminal, xterm and shells are", () => {
    const { apps } = setup();
    expect(isWslgShortcut(gedit)).toBe(true);
    expect(apps.isTerminalApp(gedit)).toBe(false);
    for (const args of ["-d Ubuntu -- gnome-terminal", "-d Ubuntu -- env TERM=xterm xterm", "-d Ubuntu -- bash", "-d Ubuntu -- python3 -m idlelib",
      "-d Ubuntu -- timeout 5 konsole", "-d Ubuntu -- code .", "-d Ubuntu -- python3 /usr/bin/terminator"]) {
      expect(apps.isTerminalApp(shortcut("x", args)), args).toBe(true);
    }
  });

  it("refuses a shortcut it can't read exactly, or whose distro it knows can't be used", async () => {
    const { apps } = setup({ facts: facts([distro("Ubuntu", { isDefault: true, defaultUid: 0 })]) });
    expect(apps.isTerminalApp(shortcut("x", "-u root -- gedit"))).toBe(true);
    expect(apps.isTerminalApp(shortcut("x", "-d Ubuntu -- gedit;id"))).toBe(true);
    await new Promise(r => setTimeout(r, 0)); // the facts have come
    expect(apps.isTerminalApp(gedit)).toBe(true);
  });

  it("with WSL off is the Windows catalogue itself: wslg stays refused", () => {
    const { apps, spawned } = setup({ on: false });
    expect(apps.isTerminalApp(gedit)).toBe(true);
    expect(() => apps.launch(gedit)).toThrow("Ember doesn't run terminals");
    expect(spawned).toEqual([]);
  });

  it("opens a WSLg shortcut with explorer.exe and the .lnk (fixed argv, hidden, the app environment), after reading the file again", async () => {
    const { apps, spawned } = setup({ files: { [gedit.file]: lnk("-d Ubuntu --cd \"~\" -- gedit") } });
    await apps.launch(gedit);
    expect(spawned).toEqual([{ command: "C:\\Windows\\explorer.exe", args: [gedit.file], options: expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true, cwd: "C:\\Users\\ana" }) }]);
    expect(JSON.stringify(spawned[0].options.env)).not.toContain("secret");
  });

  it("judges the shortcut as the file says now, not as it was listed", async () => {
    const changed = setup({ files: { [gedit.file]: lnk("-d Ubuntu -- gnome-terminal") } });
    await expect(changed.apps.launch(gedit)).rejects.toThrow("Ember doesn't run terminals");
    const gone = setup();
    await expect(gone.apps.launch(gedit)).rejects.toThrow("isn't there any more");
    const other = setup({ files: { [gedit.file]: lnk("-d Ubuntu -- gedit", "C:\\Users\\ana\\wslg.exe") } });
    await expect(other.apps.launch(gedit)).rejects.toThrow("doesn't start WSL's own launcher");
    const elevated = setup({ files: { [gedit.file]: buildLnk({ target: WSLG, args: "-d Ubuntu -- gedit", runAsUser: true }) } });
    await expect(elevated.apps.launch(gedit)).rejects.toThrow("can't open that shortcut");
    const junk = setup({ files: { [gedit.file]: Buffer.from("not a shortcut") } });
    await expect(junk.apps.launch(gedit)).rejects.toThrow("can't open that shortcut");
    // An MSI-advertised shortcut: Windows Installer decides what it starts, not the target read here.
    const advertised = setup({ files: { [gedit.file]: buildLnk({ target: WSLG, args: "-d Ubuntu -- gedit", advertised: true }) } });
    await expect(advertised.apps.launch(gedit)).rejects.toThrow("can't open that shortcut");
    for (const s of [changed, gone, other, elevated, junk, advertised]) expect(s.spawned).toEqual([]);
  });

  it("refuses with fresh facts: a root distro, WSL 1, or no WSLg", async () => {
    for (const f of [facts([distro("Ubuntu", { defaultUid: 0 })]), facts([distro("Ubuntu", { version: 1 })]), facts([distro("Ubuntu")], { wslg: { available: false, disabledByUser: true, version: null } })]) {
      const s = setup({ facts: f, files: { [gedit.file]: lnk("-d Ubuntu -- gedit") } });
      await expect(s.apps.launch(gedit)).rejects.toThrow(/root|WSL 1|WSLg/);
      expect(s.spawned).toEqual([]);
    }
  });

  it("leaves every other app to the Windows catalogue", () => {
    const { apps, launched } = setup();
    const notepad: DesktopApp = { id: "Notepad", name: "Notepad", file: "C:\\x\\Notepad.lnk", keywords: [], argv: ["C:\\Windows\\notepad.exe"], programs: ["notepad"] };
    expect(apps.isTerminalApp(notepad)).toBe(false);
    void apps.launch(notepad);
    expect(launched).toEqual([notepad]);
    expect(apps.programsOf(notepad)).toEqual(new Set(["notepad"]));
  });

  it("knows a WSLg app's windows by their WSL name", () => {
    const { apps } = setup();
    expect(apps.programsOf(gedit)).toEqual(new Set(["wsl:ubuntu:gedit"]));
    expect(apps.programsOf(shortcut("t", "-d Ubuntu -- python3 /usr/bin/meld"))).toEqual(new Set(["wsl:ubuntu:meld"]));
  });
});
