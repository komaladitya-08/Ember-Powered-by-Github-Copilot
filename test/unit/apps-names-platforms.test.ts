/**
 * The names people know apps by on Windows and macOS (app/shared/apps.ts, design §9.11): Windows programs read as
 * their products ("winword" is Word), with or without ".exe" and in any case, Windows' frame host never named; macOS
 * names stay as macOS gives them, and the bundle ids that read badly capitalised get their names. Each OS's table is
 * its own, and a program named like one of Object's keys is never looked up as one.
 */

import { afterEach, describe, expect, it } from "vitest";
import { APP_NAMES, friendlyApp, useAppNames } from "../../app/shared/apps";

afterEach(() => useAppNames("linux"));

describe("friendly app names on Windows", () => {
  it("names the programs design §9.11 lists as people say them", () => {
    useAppNames("win32");
    const names: Record<string, string> = {
      winword: "Word", excel: "Excel", powerpnt: "PowerPoint", outlook: "Outlook", olk: "Outlook", msedge: "Microsoft Edge", chrome: "Google Chrome",
      explorer: "File Explorer", notepad: "Notepad", mspaint: "Paint", systemsettings: "Settings", calculatorapp: "Calculator", windowsterminal: "Terminal",
      code: "Visual Studio Code", "ms-teams": "Teams", teams: "Teams",
    };
    for (const [program, name] of Object.entries(names)) expect(friendlyApp(program), program).toBe(name);
  });

  it("reads a program with its .exe and in any case, and leaves Windows' frame host unnamed", () => {
    useAppNames("win32");
    expect(friendlyApp("WINWORD.EXE")).toBe("Word");
    expect(friendlyApp(" msedge.exe ")).toBe("Microsoft Edge");
    expect(friendlyApp("Microsoft.Photos.exe")).toBe("Photos");
    expect(friendlyApp("soffice.bin")).toBe("LibreOffice");
    expect(friendlyApp("ApplicationFrameHost")).toBe("");
    expect(friendlyApp("applicationframehost.exe")).toBe("");
  });

  it("capitalises a program it doesn't know, and keeps Linux's ids out", () => {
    useAppNames("win32");
    expect(friendlyApp("myeditor.exe")).toBe("Myeditor");
    expect(friendlyApp("gnome-control-center")).toBe("Gnome-control-center");
    expect(friendlyApp("nautilus")).toBe("Nautilus");
  });

  it("never looks a program called like one of Object's keys up as one", () => {
    useAppNames("win32");
    // As any unknown program: an all-lower-case name capitalised, anything else as it is.
    const cases: [string, string][] = [["constructor", "Constructor"], ["toString", "toString"], ["hasOwnProperty", "hasOwnProperty"], ["__proto__", "__proto__"],
      ["valueOf", "valueOf"]];
    for (const [key, name] of cases) expect(friendlyApp(key), key).toBe(name);
    expect(Object.getPrototypeOf(APP_NAMES.win32)).toBeNull();
    expect(Object.isFrozen(APP_NAMES.win32)).toBe(true);
  });
});

describe("friendly app names on macOS", () => {
  it("keeps macOS's localized names as macOS gives them", () => {
    useAppNames("darwin");
    for (const name of ["TextEdit", "System Settings", "Finder", "Microsoft Word", "Ablage", "テキストエディット", "Safari"]) expect(friendlyApp(name), name).toBe(name);
  });

  it("names the bundle ids that would read badly capitalised", () => {
    useAppNames("darwin");
    const names: Record<string, string> = {
      "com.apple.systempreferences": "System Settings", "com.apple.finder": "Finder", "com.apple.TextEdit": "TextEdit", "com.apple.MobileSMS": "Messages",
      "com.apple.iCal": "Calendar", "com.apple.AddressBook": "Contacts", "com.apple.FaceTime": "FaceTime", "com.apple.AppStore": "App Store",
      "com.apple.ActivityMonitor": "Activity Monitor", "com.apple.keychainaccess": "Keychain Access", "com.apple.ScriptEditor2": "Script Editor",
      "com.apple.iWork.Pages": "Pages", "com.microsoft.Word": "Microsoft Word", "com.microsoft.VSCode": "Visual Studio Code", "com.google.Chrome": "Google Chrome",
      "org.mozilla.firefox": "Firefox",
    };
    for (const [id, name] of Object.entries(names)) expect(friendlyApp(id), id).toBe(name);
    // Any other id: its last part, as on Linux.
    expect(friendlyApp("com.apple.Safari")).toBe("Safari");
    expect(friendlyApp("com.example.notes")).toBe("Notes");
  });

  it("doesn't strip .exe there, and has a table of its own", () => {
    useAppNames("darwin");
    expect(friendlyApp("notepad.exe")).toBe("notepad.exe");
    expect(friendlyApp("winword")).toBe("Winword");
    expect(friendlyApp("constructor")).toBe("Constructor");
    expect(Object.getPrototypeOf(APP_NAMES.darwin)).toBeNull();
  });
});

describe("the Linux table", () => {
  it("is today's 22 names (frozen copy)", () => {
    expect({ ...APP_NAMES.linux }).toEqual({
      "gnome-control-center": "Settings", "org.gnome.settings": "Settings", "org.gnome.controlcenter": "Settings", nautilus: "Files", "org.gnome.nautilus": "Files",
      "gnome-terminal-server": "Terminal", "gnome-terminal": "Terminal", "org.gnome.terminal": "Terminal", gedit: "gedit", "org.gnome.gedit": "gedit",
      "gnome-text-editor": "Text Editor", "org.gnome.texteditor": "Text Editor", "gnome-calculator": "Calculator", "org.gnome.calculator": "Calculator",
      evince: "Document Viewer", eog: "Image Viewer", "gnome-system-monitor": "System Monitor", "soffice.bin": "LibreOffice", soffice: "LibreOffice",
      firefox: "Firefox", thunderbird: "Thunderbird", mousepad: "Mousepad",
    });
    expect(friendlyApp("org.gnome.Nautilus")).toBe("Files");
    expect(friendlyApp("winword.exe")).toBe("winword.exe");
  });

  it("never looks a program or desktop id called like one of Object's keys up as one (only those bogus names change)", () => {
    // A plain object answered "constructor" with Object's own function and "__proto__" with Object.prototype.
    const cases: [string, string][] = [["constructor", "Constructor"], ["__proto__", "__proto__"], ["toString", "toString"],
      ["org.example.constructor", "Constructor"], ["org.example.__proto__", "__proto__"]];
    for (const [key, name] of cases) expect(friendlyApp(key), key).toBe(name);
    expect(Object.getPrototypeOf(APP_NAMES.linux)).toBeNull();
    expect(Object.isFrozen(APP_NAMES.linux)).toBe(true);
    expect(friendlyApp("gnome-control-center")).toBe("Settings");
  });
});
