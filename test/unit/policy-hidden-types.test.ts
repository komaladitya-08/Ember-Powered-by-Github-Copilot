/**
 * File managers that hide file types (review #110): File Explorer hides known extensions by default (and always hides a
 * shortcut's), and Finder hides them too (an app's .app always), so a program can show as "setup" or "Calculator", or as
 * "invoice.pdf" when its real name is invoice.pdf.exe. Opening an item whose name shows no type is refused; opening one
 * whose name shows a document's type is asked about every time, saying it could be a program; a name that shows a
 * program's type is refused as before. Finder gets the rules File Explorer has (its own open keys: Return renames there).
 */

import { describe, expect, it } from "vitest";
import { KEYS } from "../../app/shared/shortcuts";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";

const win = new PolicyEngine({ neverLook: () => [], grants: () => ({ explorer: "act" }), os: "win32", keys: KEYS.win32, ownPid: 1, rateLimit: 1e6 });
const mac = new PolicyEngine({ neverLook: () => [], grants: () => ({ finder: "act" }), os: "darwin", keys: KEYS.darwin, ownPid: 1, rateLimit: 1e6 });
const item = (app: string, name: string, more: Partial<ActionRequest> = {}): ActionRequest => ({
  taskId: "t", kind: "click", app, window: "Downloads", windowId: { pid: 9, role: "frame" }, element: { role: "list item", name }, ...more,
});
const HIDDEN = /hides file types/;

describe("File Explorer's items whose type is hidden", () => {
  it("never opens an item whose name shows no type: Enter, an activating click or the borrowed mouse", () => {
    for (const name of ["setup", "install", "run", "payload", "Google Chrome", "Command Prompt"]) {
      for (const more of [{}, { kind: "cursor_click" as const }, { kind: "keys" as const, value: "Return" }, { kind: "keys" as const, value: "ctrl+Return" }]) {
        const d = win.decide(item("explorer", name, more));
        expect(d, `${name} ${JSON.stringify(more)}`).toMatchObject({ tier: "never", verdict: "deny" });
        expect(d.reason).toMatch(HIDDEN);
      }
    }
  });

  it("asks every time before opening one whose name shows a document's type, saying it could be a program", () => {
    for (const name of ["invoice.pdf", "notes.txt", "photo.jpg", "Budget v1.2"]) {
      const d = win.decide(item("explorer", name));
      expect(d, name).toMatchObject({ verdict: "confirm", risky: true });
      expect(d.prompt).toMatch(/could be a program/);
      expect(d.remember).toBe(false);
    }
  });

  it("refuses a name that shows a program's type, as before; selecting, reading and the navigation pane stay as they were", () => {
    expect(win.decide(item("explorer", "setup.exe")).reason).toMatch(/never opens programs or scripts from File Explorer/);
    expect(win.decide(item("explorer", "setup", { clickSelects: true })).verdict).toBe("allow");
    expect(win.decide(item("explorer", "setup", { kind: "keys", value: "Down" })).tier).not.toBe("never");
    expect(win.decide(item("explorer", "setup", { kind: "read" })).verdict).toBe("allow");
    for (const more of [{}, { kind: "keys" as const, value: "Return" }]) {
      expect(win.decide(item("explorer", "Documents", { element: { role: "tree item", name: "Documents" }, ...more })).tier).not.toBe("never");
    }
    expect(win.decide(item("notepad", "setup")).tier).not.toBe("never");
  });
});

describe("Finder", () => {
  it("never opens a program or a script it would run, by its name, or an item whose name shows no type", () => {
    for (const name of ["Calculator.app", "build.command", "deploy.tool", "evil.terminal", "app.jar", "Calculator", "setup"]) {
      for (const more of [{}, { kind: "cursor_click" as const }, { kind: "keys" as const, value: "cmd+o" }, { kind: "keys" as const, value: "cmd+Down" }]) {
        expect(mac.decide(item("Finder", name, more)), `${name} ${JSON.stringify(more)}`).toMatchObject({ tier: "never", verdict: "deny" });
      }
    }
  });

  it("asks before opening a document, and never uses Open or Open With, whose target isn't named", () => {
    expect(mac.decide(item("Finder", "report.pdf"))).toMatchObject({ verdict: "confirm", risky: true });
    for (const name of ["Open", "Open With", "Öffnen", "Ouvrir avec", "開く"]) {
      expect(mac.decide(item("Finder", "", { element: { role: "menu item", name } })).verdict, name).toBe("deny");
    }
    // Cmd+O where several items may be selected opens all of them.
    expect(mac.decide(item("Finder", "report.pdf", { kind: "keys", value: "cmd+o", afterSelectAll: true })).verdict).toBe("deny");
  });

  it("renames with Return as before (Finder's Return doesn't open), and leaves other apps alone", () => {
    expect(mac.decide(item("Finder", "setup", { kind: "keys", value: "Return" })).tier).not.toBe("never");
    expect(mac.decide(item("Finder", "", { element: { role: "menu item", name: "Get Info" } })).tier).not.toBe("never");
    expect(mac.decide(item("Preview", "Calculator.app")).tier).not.toBe("never");
  });
});
