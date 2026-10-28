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

  it("never presses Enter where the selection may hold an item other than the one focused, nor splits the keyboard from it", () => {
    const SELECTION = "Ember doesn't run programs, and Enter in File Explorer opens every item selected, so it never opens a selection it can't name or moves the keyboard off one";
    // After Ctrl+A or Shift and an arrow here, Enter on a document opens every item selected (a program among them).
    for (const more of [{ afterSelectAll: true }, { afterSelecting: true }]) {
      expect(engine().decide({ ...enter("notes.txt"), ...more }), JSON.stringify(more)).toMatchObject({ tier: "never", reason: SELECTION });
    }
    // Enter on the view itself (File Explorer's items, the desktop's) opens what is selected there.
    for (const role of ["list", "table"]) expect(engine().decide(enter("Items View", "Return", role)).reason, role).toBe(SELECTION);
    // Ctrl and an arrow move the keyboard off the selection, Ctrl+Space adds the focused item to it.
    for (const keys of ["ctrl+Down", "ctrl+Up", "ctrl+Home", "ctrl+End", "ctrl+Next", "ctrl+space", "ctrl+KP_Down"]) {
      expect(engine().decide(enter("notes.txt", keys)).reason, keys).toBe(SELECTION);
      expect(engine().decide(enter("Items View", keys, "list")).reason, keys).toBe(SELECTION);
    }
    // Moving with the arrows, Space, and Enter on a document alone stay as they were.
    for (const keys of ["Down", "shift+Down", "space", "Return"]) expect(engine().decide(enter("notes.txt", keys)).reason, keys).not.toBe(SELECTION);
    expect(engine().decide(enter("Items View", "Down", "list")).reason).not.toBe(SELECTION);
  });

  it("never picks a command in Explorer's menus by its letter (Open's \"O\", Run as administrator's \"A\")", () => {
    for (const role of ["menu", "menu item"]) {
      for (const keys of ["o", "a", "shift+o", "1"]) expect(engine().decide(enter("Cut", keys, role)), `${role} ${keys}`).toMatchObject({ tier: "never", reason: COMMAND });
    }
    // Elsewhere in Explorer a letter types or selects by name; in other apps' menus it is asked about, as before.
    expect(engine().decide(enter("notes.txt", "o")).reason).not.toBe(COMMAND);
    expect(engine().decide({ ...enter("Cut", "o", "menu item"), app: "notepad" }).reason).not.toBe(COMMAND);
  });

  it("still selects and reads one: a click that only selects it, Alt+Enter (Properties), Space, reading", () => {
    expect(engine().decide(open("setup.exe", { clickSelects: true })).tier).not.toBe("never");
    for (const keys of ["alt+Return", "space", "Down", "F2"]) expect(engine().decide(enter("setup.exe", keys)).reason, keys).not.toBe(ITEM);
    expect(engine().decide({ ...open("setup.exe"), kind: "read" }).verdict).toBe("allow");
  });

  it("opens documents, asking first (Explorer may hide a program's type behind theirs: review #110)", () => {
    for (const name of ["report.docx", "notes.txt", "setup.exe.txt", "photo.jpg", "readme.js.md", "archive.zip"]) {
      expect(engine().decide(open(name)).tier, name).not.toBe("never");
      expect(engine().decide(enter(name)).tier, name).not.toBe("never");
    }
    // A name that shows no type ("Programs", "exe") may be a program whose type Explorer hides: refused (review #110).
    for (const name of ["Programs", "exe"]) expect(engine().decide(open(name)).tier, name).toBe("never");
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
    // A script's Open with Command Prompt runs it in a console; Open with's submenu, opened with an arrow, lists the
    // apps that would run it (a script's interpreter).
    expect(engine().decide(command("Open with Command Prompt")).reason).toBe(COMMAND);
    for (const keys of ["Right", "Left"]) expect(engine().decide(enter("Open with", keys, "menu")).reason, keys).toBe(COMMAND);
    for (const keys of ["Down", "Up", "Escape"]) expect(engine().decide(enter("Open with", keys, "menu")).reason, keys).not.toBe(COMMAND);
  });

  it("matches a command as written, whatever characters its name holds", () => {
    const rules = [{ app: /^contoso$/, item: /\.exe$/, commands: ["java(tm) platform se binary", "a.b"] }];
    const at = (name: string) => opensProgram(rules, { kind: "click", app: "contoso", element: { role: "menu item", name } }, KEYS.win32);
    expect(at("Java(TM) Platform SE binary")).toBe("command");
    for (const name of ["javatm platform se binary", "axb", "a.b.c"]) expect(at(name), name).toBeNull();
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

  it("has no such app on Linux, and on macOS only Finder (review #110)", () => {
    expect(OPENS_PROGRAMS.linux).toEqual([]);
    expect(OPENS_PROGRAMS.darwin.map(r => r.app.test("Finder"))).toEqual([true]);
    for (const os of ["linux", "darwin"] as const) {
      expect(engine(os).decide(open("setup.exe")).reason, os).not.toBe(ITEM);
      expect(engine(os).decide(command("Open")).reason, os).not.toBe(COMMAND);
      expect(opensProgram(OPENS_PROGRAMS[os], open("setup.exe"), KEYS[os])).toBeNull();
    }
    expect(opensProgram(OPENS_PROGRAMS.win32, open("setup.exe"), KEYS.win32)).toBe("item");
    expect(opensProgram(OPENS_PROGRAMS.win32, command("Open"), KEYS.win32)).toBe("command");
  });
});
