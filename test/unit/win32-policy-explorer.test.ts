/**
 * File Explorer running programs in the policy (vocabulary.ts OPENS_PROGRAMS): Explorer and the desktop (explorer.exe)
 * run a program or script they open with no dialog, so on Windows Ember never opens an item whose name shows such an
 * extension (by its own action, a double click, the borrowed mouse or Enter), nor uses Explorer's Open, Open with and
 * Run as commands, whose target the request doesn't name. Selecting an item by accessibility and reading stay allowed;
 * documents, other apps, Linux and macOS are judged as before.
 */

import { describe, expect, it } from "vitest";
import { KEYS } from "../../app/shared/shortcuts";
import { PolicyEngine, opensProgram, type ActionRequest } from "../../app/main/policy/policy";
import { OPENS_PROGRAMS } from "../../app/main/policy/vocabulary";

type OS = "linux" | "win32" | "darwin";
const engine = (os: OS = "win32") => new PolicyEngine({ neverLook: () => [], grants: () => ({ explorer: "act", notepad: "act" }), keys: KEYS[os], os });
const ITEM = "Ember doesn't run programs, so it never opens programs or scripts from File Explorer";
const COMMAND = "Ember doesn't run programs, and File Explorer's Open and Run as commands may start one, so it never uses them";
/** An item of File Explorer's view (or the desktop's), clicked by its own action unless `selects`. */
const open = (name: string, more: Partial<ActionRequest> = {}): ActionRequest => ({
  taskId: "t", kind: "click", app: "explorer", window: "Downloads", element: { role: "list item", name }, ...more,
});
const enter = (name: string, keys = "Return", role = "list item"): ActionRequest => ({ ...open(name), kind: "keys", value: keys, element: { role, name } });
const command = (name: string, role = "menu item", more: Partial<ActionRequest> = {}): ActionRequest => open("", { element: { role, name }, ...more });

const PROGRAMS = ["setup.exe", "tool.com", "build.bat", "go.cmd", "fix.ps1", "a.vbs", "a.vbe", "a.js", "a.jse", "a.wsf", "a.wsh", "a.hta", "a.msi",
  "a.msp", "a.scr", "a.pif", "a.cpl", "Chrome.lnk", "site.url", "app.appref-ms", "app.jar"];

describe("File Explorer opening programs on Windows", () => {
  it("never opens a program or script by its own action, a double click or the borrowed mouse", () => {
    for (const name of PROGRAMS) {
      expect(engine().decide(open(name)), name).toMatchObject({ tier: "never", verdict: "deny", reason: ITEM });
      expect(engine().decide(open(name, { kind: "cursor_click" })).reason, name).toBe(ITEM);
    }
    // Whatever the case, an invisible character or a look-alike letter in its name (fail closed).
    for (const name of ["SETUP.EXE", " Setup.Exe ", "photo‮gpj.exe", "invoice​.exe", "setup.ехе"]) expect(engine().decide(open(name)).reason, name).toBe(ITEM);
  });

  it("never opens one with Enter (with Ctrl or Shift too, or the keypad's)", () => {
    for (const keys of ["Return", "KP_Enter", "ctrl+Return", "shift+Return", "ctrl+shift+Return"]) expect(engine().decide(enter("setup.exe", keys)).reason, keys).toBe(ITEM);
    for (const role of ["icon", "table cell", "tree item"]) expect(engine().decide(enter("setup.exe", "Return", role)).reason, role).toBe(ITEM);
  });

  it("still selects and reads one: a click that only selects it, Alt+Enter (Properties), Space, reading", () => {
    expect(engine().decide(open("setup.exe", { clickSelects: true })).tier).not.toBe("never");
    for (const keys of ["alt+Return", "space", "Down", "F2"]) expect(engine().decide(enter("setup.exe", keys)).reason, keys).not.toBe(ITEM);
    expect(engine().decide({ ...open("setup.exe"), kind: "read" }).verdict).toBe("allow");
  });

  it("opens documents and folders as before", () => {
    for (const name of ["report.docx", "notes.txt", "setup.exe.txt", "photo.jpg", "Programs", "exe", "readme.js.md", "archive.zip"]) {
      expect(engine().decide(open(name)).tier, name).not.toBe("never");
      expect(engine().decide(enter(name)).tier, name).not.toBe("never");
    }
  });

  it("never uses Explorer's Open, Open with or Run as commands, in Windows' main languages, whatever is selected", () => {
    for (const label of ["Open", "Open with", "Open with…", "Open with...", "Run as administrator", "Run as different user", "Run with PowerShell",
      "Öffnen", "Öffnen mit", "Als Administrator ausführen", "Exécuter en tant qu’administrateur", "Ejecutar como administrador", "Esegui come amministratore",
      "Executar como administrador", "Als administrator uitvoeren", "開く(O)", "管理者として実行", "以管理员身份运行", "以系統管理員身分執行", "관리자 권한으로 실행"]) {
      expect(engine().decide(command(label)), label).toMatchObject({ tier: "never", verdict: "deny", reason: COMMAND });
    }
    // The ribbon's or command bar's button, Open with's submenu, the borrowed mouse, Enter or Space on the focused item.
    expect(engine().decide(command("Open", "push button")).reason).toBe(COMMAND);
    expect(engine().decide(command("Open with", "menu")).reason).toBe(COMMAND);
    expect(engine().decide(command("Open", "menu item", { kind: "cursor_click" })).reason).toBe(COMMAND);
    for (const keys of ["Return", "space"]) expect(engine().decide(enter("Run as administrator", keys, "menu item")).reason, keys).toBe(COMMAND);
  });

  it("uses Explorer's other commands as before", () => {
    for (const label of ["Open file location", "Open in new window", "Open in new tab", "Opened", "Properties", "Rename", "Copy as path"]) {
      expect(engine().decide(command(label)).reason, label).not.toBe(COMMAND);
    }
    expect(engine().decide(enter("Open", "Down", "menu item")).reason).not.toBe(COMMAND);
    expect(engine().decide({ ...command("Open"), kind: "read" }).verdict).toBe("allow");
  });

  it("judges other apps as before, the desktop (explorer.exe too) as Explorer", () => {
    for (const app of ["notepad", "msedge", "7zFM", "explorerpatcher"]) {
      expect(engine().decide({ ...open("setup.exe"), app }).reason, app).not.toBe(ITEM);
      expect(engine().decide({ ...command("Open"), app }).reason, app).not.toBe(COMMAND);
    }
    expect(engine().decide({ ...open("setup.exe"), app: "explorer.exe", window: "Program Manager" }).reason).toBe(ITEM);
    // A folder named "Run" (a frame, not the Run dialog) is a folder like any other.
    expect(engine().decide({ ...enter("setup.exe"), window: "Run", windowId: { pid: 4321, path: "65812", role: "frame" } }).reason).toBe(ITEM);
  });

  it("has no such app on Linux or macOS", () => {
    expect([OPENS_PROGRAMS.linux, OPENS_PROGRAMS.darwin]).toEqual([[], []]);
    for (const os of ["linux", "darwin"] as const) {
      expect(engine(os).decide(open("setup.exe")).reason, os).not.toBe(ITEM);
      expect(engine(os).decide(command("Open")).reason, os).not.toBe(COMMAND);
      expect(opensProgram(OPENS_PROGRAMS[os], open("setup.exe"), KEYS[os])).toBeNull();
    }
    expect(opensProgram(OPENS_PROGRAMS.win32, open("setup.exe"), KEYS.win32)).toBe("item");
    expect(opensProgram(OPENS_PROGRAMS.win32, command("Open"), KEYS.win32)).toBe("command");
  });
});
