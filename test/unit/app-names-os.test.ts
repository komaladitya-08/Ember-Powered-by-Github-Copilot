/** friendlyApp per OS (app/shared/apps.ts; design §4.20): Linux unchanged, Windows programs without ".exe". */

import { afterEach, describe, expect, it } from "vitest";
import { APP_NAMES, friendlyApp, useAppNames } from "../../app/shared/apps";

afterEach(() => useAppNames("linux"));

describe("friendlyApp", () => {
  it("uses Linux's names until told otherwise", () => {
    expect(friendlyApp("gnome-control-center")).toBe("Settings");
    expect(friendlyApp("org.gnome.Nautilus")).toBe("Files");
    expect(friendlyApp("firefox.desktop")).toBe("Firefox");
    expect(friendlyApp("notepad.exe")).toBe("notepad.exe");
  });

  it("drops a Windows program's .exe and leaves Linux's names out there", () => {
    useAppNames("win32");
    expect(friendlyApp("notepad.exe")).toBe("Notepad");
    expect(friendlyApp("NOTEPAD.EXE")).toBe("NOTEPAD");
    expect(friendlyApp("msedge")).toBe("Msedge");
    expect(friendlyApp("nautilus")).toBe("Nautilus");
    expect(friendlyApp("Word")).toBe("Word");
  });

  it("keeps macOS's localized names as they are", () => {
    useAppNames("darwin");
    expect(friendlyApp("TextEdit")).toBe("TextEdit");
    expect(friendlyApp("System Settings")).toBe("System Settings");
    expect(friendlyApp("notepad.exe")).toBe("notepad.exe");
  });

  it("keeps today's Linux table, and leaves the Windows and macOS tables to their own package", () => {
    expect(Object.keys(APP_NAMES.linux)).toHaveLength(22);
    expect(APP_NAMES.linux["soffice.bin"]).toBe("LibreOffice");
    expect(APP_NAMES.win32).toEqual({});
    expect(APP_NAMES.darwin).toEqual({});
  });
});
