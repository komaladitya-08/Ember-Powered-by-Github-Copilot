/**
 * Ember's own settings, audit log and policy reached through another app (PolicyEngine, safety-privacy-r10-1, -c10-2):
 * their folder typed into an Open dialog or an address bar is refused in every mode, and a step where Ember can't tell
 * whether the file or folder in front of it is its own (an editor's title with no folder, a file manager titled "audit"
 * or "ember", an item named like one of its files) asks every time, never announced, waived or checked, and Autopilot
 * refuses it.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyEngine, mayReachEmberData, namesEmberData, type ActionRequest } from "../../app/main/policy/policy";
import { ALL_SCOPES } from "../../app/main/policy/autonomy";
import { KEYS } from "../../app/shared/shortcuts";
import { PROVIDER_SEAL_FILE } from "../../app/main/provider-record";
import { PROVIDER_KEY_FILE } from "../../app/main/provider";
import { VAULT_FILE } from "../../app/main/vault/store";
import { ERASED_FILE, HISTORY_FILE } from "../../app/main/agent/conversation-store";
import { RUN_FILE } from "../../app/main/run-marker";

type OS = "linux" | "win32" | "darwin";
type Mode = "asking" | "interactive" | "assisted" | "autopilot";
const engine = (mode: Mode, os: OS = "linux", grants: Record<string, "act"> = {}) => new PolicyEngine({
  neverLook: () => [], grants: () => ({ ...grants }), isTerminalApp: () => false, os, keys: KEYS[os], ownPid: 1,
  autonomy: () => (mode !== "asking" ? { ...ALL_SCOPES } : null), assisted: () => mode === "assisted", autopilot: () => mode === "autopilot",
});
// A real request carries the window's process: not Ember's own (pid 1 is).
const req = (app: string, window: string, x: Partial<ActionRequest>): ActionRequest =>
  ({ taskId: "t", goal: "tidy my notes", app, window, windowId: { pid: 4242 }, element: { role: "text", name: "Text Editor" }, kind: "click", ...x }) as ActionRequest;

describe("Ember's own settings, audit log and policy reached through another app", () => {
  it("refuses typing their folder into an Open dialog or an address bar, in every mode (safety-privacy-r10-1)", () => {
    const rows: [OS, string, string, string][] = [
      ["linux", "kate", "Open File — Kate", "~/.config/ember/settings.json"],
      ["linux", "gedit", "Open", "/home/u/.config/ember/settings.json"],
      ["linux", "org.gnome.Nautilus", "Home", "~/.config/ember/audit"],
      ["linux", "org.xfce.mousepad", "Open", "$XDG_CONFIG_HOME/ember/settings.json"],
      ["linux", "gedit", "Open", "/etc/ember/policy.json"],
      ["win32", "notepad", "Open", "%LOCALAPPDATA%\\ember\\settings.json"],
      ["win32", "explorer", "Downloads", "C:\\Users\\u\\AppData\\Local\\ember\\audit"],
      ["darwin", "TextEdit", "Open", "~/Library/Application Support/ember/settings.json"],
    ];
    for (const [os, app, w, value] of rows) {
      for (const mode of ["asking", "interactive", "assisted", "autopilot"] as const) {
        const d = engine(mode, os, { [app]: "act" }).decide(req(app, w, { kind: "text", value, element: { role: "text", name: "Location" } }));
        expect(d.verdict, `${os} ${value} ${mode}`).toBe("deny");
      }
    }
    expect(namesEmberData("my notes about embers in the .config folder")).toBe(false);
    expect(namesEmberData("~/Ember/report.odt")).toBe(false);
  });

  it("refuses their folder typed with a doubled or dotted slash, a percent-escaped letter or an escaped space, in every mode (r10-safety-y10-2)", () => {
    const rows: [OS, string, string][] = [
      ["linux", "gedit", "~/.config//ember/settings.json"],
      ["linux", "gedit", "~/.config/./ember/settings.json"],
      ["linux", "gedit", "file:///home/u/.config/%65mber/settings.json"],
      ["linux", "gedit", "/home/u/%2Econfig/ember/audit"],
      ["darwin", "TextEdit", "~/Library/Application\\ Support/ember/settings.json"],
      ["win32", "notepad", "%userprofile%\\AppData\\\\Local\\ember\\settings.json"],
    ];
    for (const [os, app, value] of rows) {
      expect(namesEmberData(value), value).toBe(true);
      for (const mode of ["asking", "interactive", "assisted", "autopilot"] as const) {
        const d = engine(mode, os, { [app]: "act" }).decide(req(app, "Open", { kind: "text", value, element: { role: "text", name: "Location" } }));
        expect(d.verdict, `${os} ${value} ${mode}`).toBe("deny");
      }
    }
    expect(namesEmberData("100%25 of the .config/./embers")).toBe(false);
  });

  it("asks every time in an editor whose title names settings.json with no folder, and Autopilot refuses (safety-privacy-r10-1)", () => {
    const rows: [OS, string, string][] = [
      ["linux", "kate", "settings.json — Kate"], ["linux", "org.xfce.mousepad", "settings.json - Mousepad"],
      ["win32", "notepad", "*settings.json - Notepad"], ["darwin", "TextEdit", "settings.json"],
    ];
    const steps: Partial<ActionRequest>[] = [{ kind: "click" }, { kind: "text", value: ",\"privacy\":{\"neverLook\":[]}" }, { kind: "keys", value: "ctrl+s" }];
    for (const [os, app, w] of rows) {
      for (const step of steps) {
        for (const mode of ["asking", "interactive", "assisted"] as const) {
          const d = engine(mode, os, { [app]: "act" }).decide(req(app, w, step));
          expect(d.verdict, `${w} ${step.kind} ${mode}`).toBe("confirm");
          expect(d.autonomy, `${w} ${step.kind} ${mode}`).toBeUndefined();
          expect(d.remember).toBe(false);
          expect(d.everyTime).toBe(true);
        }
        expect(engine("autopilot", os, { [app]: "act" }).decide(req(app, w, step)).verdict, `${w} ${step.kind} autopilot`).toBe("deny");
      }
    }
  });

  it("refuses in Autopilot, and asks elsewhere, a Delete or a rename in a file manager showing the audit folder (safety-privacy-c10-2)", () => {
    const rows: [OS, string, string, string][] = [
      ["linux", "org.gnome.Nautilus", "audit", "audit-2026-11.jsonl"], ["linux", "org.gnome.Nautilus", "ember", "settings.json"],
      ["win32", "explorer", "audit - File Explorer", "audit-2026-11"], ["win32", "explorer", "ember", "settings"], ["darwin", "Finder", "audit", "audit-2026-11.jsonl"],
    ];
    for (const [os, app, w, item] of rows) {
      const el = { role: os === "linux" ? "table cell" : "list item", name: item };
      for (const step of [{ kind: "keys", value: "Delete", element: el }, { kind: "keys", value: "F2", element: el }, { kind: "click", element: { role: "menu item", name: "Move to Trash" } }] as Partial<ActionRequest>[]) {
        const auto = engine("autopilot", os).decide(req(app, w, step));
        expect(auto.verdict, `${w} ${step.value ?? step.element?.name} autopilot`).toBe("deny");
        const inter = engine("interactive", os).decide(req(app, w, step));
        expect(inter.verdict, `${w} ${step.value ?? step.element?.name} interactive`).toBe("confirm");
        expect(inter.autonomy).toBeUndefined();
      }
    }
    // The ~/Ember hand-off folder ("Ember") and another folder that shows its path aren't Ember's data.
    expect(mayReachEmberData(req("org.gnome.Nautilus", "Ember", { kind: "click", element: { role: "table cell", name: "report.odt" } }))).toBe(false);
    expect(mayReachEmberData(req("gedit", "settings.json (~/work/.vscode) - gedit", { kind: "click" }))).toBe(false);
    // Reading is never held back.
    expect(engine("autopilot").decide(req("org.gnome.Nautilus", "audit", { kind: "read" })).verdict).toBe("allow");
  });

  it("refuses in Autopilot, and asks elsewhere, a Delete, a cut or a rename in the folder that holds Ember's data or policy folder (r10-safety-x10-2)", () => {
    const view = (os: OS) => ({ role: os === "linux" ? "table" : os === "win32" ? "list" : "AXOutline", name: os === "win32" ? "Items View" : "" });
    const rows: [OS, string, string, Partial<ActionRequest>][] = [
      ["linux", "org.gnome.Nautilus", ".config", { kind: "keys", value: "Delete", afterSelectAll: true }],
      ["linux", "org.gnome.Nautilus", ".config", { kind: "keys", value: "Delete" }],
      ["linux", "org.gnome.Nautilus", ".config", { kind: "keys", value: "shift+Delete" }],
      ["linux", "org.gnome.Nautilus", ".config", { kind: "keys", value: "ctrl+x" }],
      ["linux", "org.gnome.Nautilus", ".config", { kind: "keys", value: "F2" }],
      ["linux", "org.gnome.Nautilus", "/home/u/.config", { kind: "keys", value: "Delete" }],
      ["linux", "org.gnome.Nautilus", "etc", { kind: "keys", value: "Delete" }],
      ["linux", "org.gnome.Nautilus", ".config", { kind: "click", element: { role: "menu item", name: "Move to Trash" } }],
      ["win32", "explorer", "Local - File Explorer", { kind: "keys", value: "Delete" }],
      ["win32", "explorer", "C:\\Users\\u\\AppData\\Local - File Explorer", { kind: "keys", value: "ctrl+d" }],
      ["win32", "explorer", "AppData - File Explorer", { kind: "keys", value: "shift+Delete" }],
      ["win32", "explorer", "Local - File Explorer", { kind: "click", element: { role: "button", name: "Delete" } }],
      ["darwin", "Finder", "Application Support", { kind: "keys", value: "cmd+BackSpace" }],
      ["darwin", "Finder", "Application Support", { kind: "keys", value: "Return" }],
      ["darwin", "Finder", "Library", { kind: "keys", value: "cmd+alt+BackSpace" }],
    ];
    for (const [os, app, w, step] of rows) {
      const r = req(app, w, { element: view(os), ...step });
      expect(engine("autopilot", os).decide(r).verdict, `${w} ${step.value ?? step.element?.name} autopilot`).toBe("deny");
      const inter = engine("interactive", os).decide(r);
      expect(inter.verdict, `${w} ${step.value ?? step.element?.name} interactive`).toBe("confirm");
      expect(inter.autonomy).toBeUndefined();
    }
    // Moving about there, type-ahead and reading stay as they were; so does another app titled like that folder.
    for (const step of [{ kind: "keys", value: "Down" }, { kind: "keys", value: "Tab" }, { kind: "text", value: "auto" }, { kind: "read" }] as Partial<ActionRequest>[]) {
      expect(mayReachEmberData(req("org.gnome.Nautilus", ".config", { element: view("linux"), ...step })), `${step.value}`).toBe(false);
    }
    expect(mayReachEmberData(req("rhythmbox", "Library", { kind: "keys", value: "Delete", element: { role: "table", name: "" } }))).toBe(false);
    expect(mayReachEmberData(req("org.gnome.Nautilus", "Documents", { kind: "keys", value: "Delete", afterSelectAll: true, element: view("linux") }))).toBe(false);
  });

  it("asks every time, and Autopilot refuses, typing and saving a settings.json in VS Code whatever workspace its title names, since the title doesn't say which folder the file is in (r10-safety-y10-1)", () => {
    for (const w of ["settings.json - myapp - Visual Studio Code", "● settings.json - myapp - Visual Studio Code", "settings.json - ember - Visual Studio Code", "settings.json - Visual Studio Code"]) {
      for (const step of [{ kind: "keys", value: "ctrl+a" }, { kind: "text", value: "{\"privacy\":{\"neverLook\":[]}}" }, { kind: "keys", value: "ctrl+s" }] as Partial<ActionRequest>[]) {
        expect(mayReachEmberData(req("code", w, step)), `${w} ${step.value}`).toBe(true);
        expect(engine("autopilot", "linux", { code: "act" }).decide(req("code", w, step)).verdict, `${w} ${step.value} autopilot`).toBe("deny");
        const inter = engine("interactive", "linux", { code: "act" }).decide(req("code", w, step));
        expect(inter.verdict, `${w} ${step.value} interactive`).toBe("confirm");
        expect(inter.autonomy).toBeUndefined();
      }
    }
  });

  it("refuses in Autopilot, and asks elsewhere, a Delete, a cut or a rename of the folder that holds Ember's data or policy folder from the folder above it (r10-safety-y10-3)", () => {
    const rows: [OS, string, string, Partial<ActionRequest>][] = [
      ["linux", "org.gnome.Nautilus", "Home", { kind: "keys", value: "Delete", element: { role: "table cell", name: ".config" } }],
      ["linux", "org.gnome.Nautilus", "Home", { kind: "keys", value: "shift+Delete", element: { role: "table cell", name: ".config" } }],
      ["linux", "org.gnome.Nautilus", "Home", { kind: "keys", value: "F2", element: { role: "table cell", name: ".config" } }],
      ["linux", "org.gnome.Nautilus", "Home", { kind: "keys", value: "ctrl+x", element: { role: "table cell", name: ".config" } }],
      ["linux", "org.gnome.Nautilus", "/", { kind: "keys", value: "Delete", element: { role: "table cell", name: "etc" } }],
      ["win32", "explorer", "u - File Explorer", { kind: "keys", value: "Delete", element: { role: "list item", name: "AppData" } }],
      ["win32", "explorer", "AppData - File Explorer", { kind: "keys", value: "F2", element: { role: "list item", name: "Local" } }],
      ["darwin", "Finder", "u", { kind: "keys", value: "cmd+BackSpace", element: { role: "AXRow", name: "Library" } }],
      ["darwin", "Finder", "Library", { kind: "keys", value: "cmd+BackSpace", element: { role: "AXRow", name: "Application Support" } }],
    ];
    for (const [os, app, w, step] of rows) {
      const r = req(app, w, step);
      expect(engine("autopilot", os).decide(r).verdict, `${w} ${step.value} ${step.element?.name} autopilot`).toBe("deny");
      const inter = engine("interactive", os).decide(r);
      expect(inter.verdict, `${w} ${step.value} ${step.element?.name} interactive`).toBe("confirm");
      expect(inter.autonomy).toBeUndefined();
    }
    // Moving past that row, opening it with a click, and another row stay as they were.
    expect(mayReachEmberData(req("org.gnome.Nautilus", "Home", { kind: "keys", value: "Down", element: { role: "table cell", name: ".config" } }))).toBe(false);
    expect(mayReachEmberData(req("org.gnome.Nautilus", "Home", { kind: "click", element: { role: "table cell", name: ".config" } }))).toBe(false);
    expect(mayReachEmberData(req("org.gnome.Nautilus", "Home", { kind: "keys", value: "Delete", element: { role: "table cell", name: "Documents" } }))).toBe(false);
  });

  it("never sends such a step to Assisted's check, and Autopilot refuses the worker's held question about it (safety-privacy-r10-1)", async () => {
    const e = engine("assisted", "linux", { kate: "act" });
    const r = req("kate", "settings.json — Kate", { kind: "text", value: "x" });
    const d = e.decide(r);
    let asked = 0;
    const out = await e.assist(r, d, { words: "tidy my notes", check: async () => { asked++; return "match"; }, signal: new AbortController().signal } as never);
    expect(asked).toBe(0);
    expect(out.verdict).toBe("confirm");
    const auto = engine("autopilot", "linux", { kate: "act" });
    expect(auto.autopilotStep(r, { ...d, verdict: "confirm" }).verdict).toBe("deny");
  });

  it("knows every file Ember keeps in its data folder by name, so an editor whose title names one with no folder asks, and Autopilot refuses (integ-x-3)", () => {
    // The files the source names as it joins them to a folder (Ember's data folder, or a folder of it), and its constants.
    const files = new Set<string>([PROVIDER_SEAL_FILE, PROVIDER_KEY_FILE, VAULT_FILE, HISTORY_FILE, ERASED_FILE, RUN_FILE]);
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
    for (const f of walk("app/main")) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/path\.join\((?:userData|o\.userData|dir|this\.dir|opts\.dir|dataDir), "([\w-]+\.\w+)"\)/g)) files.add(m[1]);
    }
    for (const f of ["provider-seal.bin", "agent.json", "routines.json", "memory.json", "voiceprint.json", "conversation.json", "words.json", "settings.json", "approvals-seal.bin"]) expect(files, f).toContain(f);
    for (const f of files) {
      const r = req("kate", `${f} — Kate`, { kind: "keys", value: "ctrl+s" });
      expect(mayReachEmberData(r), f).toBe(true);
      expect(engine("interactive", "linux", { kate: "act" }).decide(r).verdict, f).toBe("confirm");
      expect(engine("autopilot", "linux", { kate: "act" }).decide(r).verdict, f).toBe("deny");
    }
  });
});
