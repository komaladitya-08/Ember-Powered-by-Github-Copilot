/**
 * hands/system.ts's shared parts on every OS: the app environment, the value grammar, programsOf, and the terminal id
 * words each OS reads (design §4.15, §9.6, §9.11).
 */

import { describe, expect, it } from "vitest";
import { appEnv, findApp, isTerminalApp, parseOnOff, parseScale, programsOf, type DesktopApp } from "../../app/main/hands/system";
import { LAUNCHERS, TERMINAL_ID_WORDS } from "../../app/main/hands/terminals";

const app = (more: Partial<DesktopApp>): DesktopApp => ({ id: "x", name: "X", file: "", keywords: [], ...more });

describe("appEnv on Windows", () => {
  const env = {
    Path: "C:\\Windows\\system32;C:\\Windows", SystemRoot: "C:\\Windows", windir: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe",
    USERPROFILE: "C:\\Users\\ada", LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local", APPDATA: "C:\\Users\\ada\\AppData\\Roaming",
    "ProgramFiles(x86)": "C:\\Program Files (x86)", PROCESSOR_ARCHITECTURE: "AMD64", TEMP: "C:\\Users\\ada\\AppData\\Local\\Temp",
    gh_token: "gho_x", Github_Token: "gho_y", Ember_User_Data: "C:\\x", ELECTRON_RUN_AS_NODE: "1", Copilot_Api_Key: "k", my_secret: "s",
    DISPLAY: ":0", XAUTHORITY: "/x", lang: "en_GB.UTF-8",
  };

  it("keeps PATH and Windows' own variables whatever their case, so an app starts with its system folders", () => {
    const out = appEnv(env, { os: "win32" });
    expect(out).toMatchObject({ Path: env.Path, SystemRoot: env.SystemRoot, windir: env.windir, ComSpec: env.ComSpec, USERPROFILE: env.USERPROFILE,
      LOCALAPPDATA: env.LOCALAPPDATA, APPDATA: env.APPDATA, "ProgramFiles(x86)": env["ProgramFiles(x86)"], PROCESSOR_ARCHITECTURE: "AMD64", TEMP: env.TEMP, lang: env.lang });
  });

  it("drops Ember's sign-in, keys and its own variables whatever their case (Windows names are case-insensitive)", () => {
    const out = appEnv(env, { os: "win32" });
    for (const k of ["gh_token", "Github_Token", "Ember_User_Data", "ELECTRON_RUN_AS_NODE", "Copilot_Api_Key", "my_secret"]) expect(out, k).not.toHaveProperty(k);
  });

  it("leaves the X session's variables out on Windows", () => {
    const out = appEnv(env, { os: "win32" });
    expect(out).not.toHaveProperty("DISPLAY");
    expect(out).not.toHaveProperty("XAUTHORITY");
  });

  it("keeps Linux's case-sensitive rules when no OS is given (a Windows-cased Path is not PATH there)", () => {
    const out = appEnv({ PATH: "/usr/bin", Path: "x", DISPLAY: ":0", gh_token: "gho_x", GH_TOKEN: "gho_y", SystemRoot: "C:\\Windows" });
    expect(out).toEqual({ PATH: "/usr/bin", DISPLAY: ":0" });
    expect(appEnv({ PATH: "/usr/bin", DISPLAY: ":0" }, { session: false })).toEqual({ PATH: "/usr/bin" });
  });
});

describe("the change_setting value grammar", () => {
  it("reads on and off as hands/system.ts always has", () => {
    for (const v of ["on", "true", "yes", "1", "ON", "True"]) expect(parseOnOff(v), v).toBe(true);
    for (const v of ["off", "false", "no", "0", "", "maybe", " on"]) expect(parseOnOff(v), v).toBe(false);
  });

  it("reads a text size from 0.5 to 3 and refuses anything else in plain words", () => {
    expect(parseScale("1.25")).toBe(1.25);
    expect(parseScale("3")).toBe(3);
    for (const v of ["0.4", "3.5", "big", ""]) expect(() => parseScale(v), v).toThrow("text size must be between 0.5 and 3");
  });
});

describe("programsOf", () => {
  it("names an app's windows by its desktop id and launcher, never by an interpreter (worker.ts's rule, moved)", () => {
    expect(programsOf(app({ id: "org.gnome.gedit.desktop", exec: "gedit %U" }))).toEqual(new Set(["org.gnome.gedit", "gedit"]));
    expect(programsOf(app({ id: "thonny", exec: "python3 -m thonny --flag %F" }))).toEqual(new Set(["thonny"]));
    expect(programsOf(app({ id: "foo", exec: "/usr/bin/env FOO=1 /opt/foo/bin/foo" }))).toEqual(new Set(["foo", "foo=1"]));
  });

  it("prefers the catalogue's own program list (Windows, macOS), still without launchers", () => {
    expect(programsOf(app({ id: "Accessories/Notepad", programs: ["Notepad"], argv: ["C:\\Windows\\notepad.exe"] }))).toEqual(new Set(["notepad"]));
    expect(programsOf(app({ id: "Java app", programs: ["java"] }))).toEqual(new Set());
    // An advertised (MSI) shortcut has no program: its window is matched by title.
    expect(programsOf(app({ id: "Office/Word", programs: [] }))).toEqual(new Set());
  });

  it("takes the OS's launcher list", () => {
    expect(programsOf(app({ id: "x", programs: ["javaw", "x"] }), /^javaw$/)).toEqual(new Set(["x"]));
    expect(programsOf(app({ id: "x", programs: ["sh"] }), LAUNCHERS.win32)).toEqual(new Set(["sh"]));
  });
});

describe("findApp", () => {
  it("ranks the same on every OS when no terminal is involved", () => {
    const apps = [app({ id: "Accessories/Notepad", name: "Notepad", generic: "text editor", keywords: ["text editor"] }), app({ id: "Paint", name: "Paint" })];
    for (const os of ["linux", "win32", "darwin"] as const) expect(findApp(apps, "text editor", os)?.name, os).toBe("Notepad");
    expect(findApp(apps, "text editor")?.name).toBe("Notepad");
  });
});

describe("a terminal by its id's words", () => {
  it("takes \"console\" in an id for a terminal on Linux, as it always has, whatever the app is called", () => {
    for (const id of ["org.gnome.Console", "org.example.console", "org.example.my-console", "org.example.console_app.desktop"]) {
      expect(isTerminalApp({ id, name: "Logs" }), id).toBe(true);
    }
    expect(isTerminalApp({ id: "org.example.consoles", name: "Logs" })).toBe(false);
    expect(TERMINAL_ID_WORDS.linux).toEqual(["console"]);
  });

  it("takes it on Windows too (a packaged app's id split at \".\", \"!\" and \"_\")", () => {
    for (const id of ["Example.Console_8wekyb3d8bbwe!App", "Contoso.Admin-Console"]) expect(isTerminalApp({ id, name: "Logs" }, "win32"), id).toBe(true);
    expect(isTerminalApp({ id: "Example.Notes_8wekyb3d8bbwe!App", name: "Logs" }, "win32")).toBe(false);
  });

  it("leaves the Mac's Console, its log viewer, alone: macOS has no such id word (Console.app is com.apple.Console)", () => {
    expect(TERMINAL_ID_WORDS.darwin).toEqual([]);
    for (const id of ["com.apple.Console", "com.example.my-console"]) expect(isTerminalApp({ id, name: "Console" }, "darwin"), id).toBe(false);
    expect(isTerminalApp({ id: "com.apple.Console", name: "com.apple.Console" }, "darwin")).toBe(false);
    // Terminal itself is still known by its id's words there.
    expect(isTerminalApp({ id: "com.apple.Terminal", name: "Utility" }, "darwin")).toBe(true);
  });
});
