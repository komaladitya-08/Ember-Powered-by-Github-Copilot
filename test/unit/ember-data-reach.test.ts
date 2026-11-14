/**
 * Ember's own settings, audit log and policy reached through another app (PolicyEngine, safety-privacy-r10-1, -c10-2):
 * their folder typed into an Open dialog or an address bar is refused in every mode, and a step where Ember can't tell
 * whether the file or folder in front of it is its own (an editor's title with no folder, a file manager titled "audit"
 * or "ember", an item named like one of its files) asks every time, never announced, waived or checked, and Autopilot
 * refuses it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EMBER_DATA_QUESTION, EMBER_DATA_UNREAD_QUESTION, PolicyEngine, mayReachEmberData, namesEmberData, type ActionRequest } from "../../app/main/policy/policy";
import { ALL_SCOPES } from "../../app/main/policy/autonomy";
import { KEYS } from "../../app/shared/shortcuts";
import { PROVIDER_SEAL_FILE } from "../../app/main/provider-record";
import { PROVIDER_KEY_FILE } from "../../app/main/provider";
import { VAULT_FILE } from "../../app/main/vault/store";
import { ERASED_FILE, HISTORY_FILE } from "../../app/main/agent/conversation-store";
import { RUN_FILE } from "../../app/main/run-marker";
import { emberDataOf } from "../../app/main/extensions/gate";
import { chosenIn, dialogAround } from "../../app/main/agent/worker";
import type { AxNode } from "../../app/main/perception/sidecar";

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

  it("refuses typing a pattern that reaches their folder, and asks about “EMBER” typed where case doesn't count, as the commands classifier does (integ-y-1)", () => {
    for (const [os, value] of [
      ["linux", "~/.config/emb?r/settings.json"], ["linux", "/home/u/.config/e*/audit"], ["darwin", "~/Library/Application Support/emb*/settings.json"],
      ["win32", "%LOCALAPPDATA%\\emb*\\settings.json"], ["win32", "C:\\Users\\u\\AppData\\Local\\e?ber"],
    ] as [OS, string][]) {
      for (const mode of ["asking", "interactive", "assisted", "autopilot"] as const) {
        expect(engine(mode, os, { gedit: "act" }).decide(req("gedit", "Open", { kind: "text", value, element: { role: "text", name: "Location" } })).verdict, `${value} ${mode}`).toBe("deny");
      }
    }
    for (const os of ["win32", "darwin"] as const) {
      for (const value of ["EMBER", "Ember", "AUDIT"]) {
        const r = req("gedit", "Open", { kind: "text", value, element: { role: "text", name: "Location" } });
        expect(mayReachEmberData(r, os), `${os} ${value}`).toBe(true);
        expect(engine("autopilot", os, { gedit: "act" }).decide(r).verdict, `${os} ${value}`).toBe("deny");
        expect(engine("interactive", os, { gedit: "act" }).decide(r).verdict, `${os} ${value}`).toBe("confirm");
      }
    }
    // On Linux "Ember" is the hand-off folder, and a folder above theirs typed alone only goes there.
    expect(mayReachEmberData(req("gedit", "Open", { kind: "text", value: "Ember" }), "linux")).toBe(false);
    expect(engine("autopilot", "linux", { gedit: "act" }).decide(req("gedit", "Open", { kind: "text", value: "~/.config", element: { role: "text", name: "Location" } })).verdict).not.toBe("deny");
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
    // (As the worker reads it as the step is taken: the rows chosen, all of them read. Not known, it asks: safety-privacy-r11-2.)
    expect(mayReachEmberData(req("org.gnome.Nautilus", "Home", { kind: "keys", value: "Delete", element: { role: "table cell", name: "Documents" }, chosen: { names: ["Documents"], whole: true } }))).toBe(false);
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

  it("refuses typing the path of anything Ember keeps in its data folder, whatever its name, and an extension's call that names it, in every mode (integ-y-3)", () => {
    // What the source joins to Ember's data folder itself: files, folders and names built at runtime alike.
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
    const constants: Record<string, string> = { PROVIDER_SEAL_FILE, PROVIDER_KEY_FILE, VAULT_FILE, RUN_FILE };
    // Names built at runtime, each by a sample (an unknown one fails below until it is listed here).
    const built: Record<string, string> = { '"project-workspaces-" + scopeKey.parse(scope) + ".bin"': "project-workspaces-0a1b.bin" };
    const children = new Set<string>();
    for (const f of walk("app/main")) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/path\.join\((?:userData|o\.userData|deps\.userData|dataDir), ([^,)]+)[,)]/g)) {
        const arg = m[1].trim();
        const name = /^"([^"]+)"$/.exec(arg)?.[1] ?? constants[arg] ?? built[arg];
        expect(name, `${f}: path.join(…, ${arg})`).toBeDefined();
        children.add(name!);
      }
    }
    for (const c of ["settings.json", "audit", "extensions", "copilot", "models", "logs", "desk-profiles", "agent.json", "github-token.bin"]) expect(children, c).toContain(c);
    // Every one of them, and anything further down (the desk's owner.json, an installed plugin's files) or added later.
    const rows: [OS, string][] = [];
    for (const c of [...children, "desk-profiles/1/owner.json", "extensions/plugins/fake/server.mjs", "a-file-added-later.bin", "project-workspaces-ff.bin"]) {
      rows.push(["linux", `~/.config/ember/${c}`], ["win32", `%LOCALAPPDATA%\\ember\\${c.replace(/\//g, "\\")}`], ["darwin", `~/Library/Application Support/ember/${c}`]);
    }
    for (const [os, value] of rows) {
      expect(emberDataOf({ path: value }, { os }), value).toBe("names");
      for (const mode of ["asking", "interactive", "autopilot"] as const) {
        expect(engine(mode, os, { gedit: "act" }).decide(req("gedit", "Open", { kind: "text", value, element: { role: "text", name: "Location" } })).verdict, `${value} ${mode}`).toBe("deny");
      }
    }
  });

  it("knows by name alone the files Ember keeps at its data folder's top level, so an editor whose title names one with no folder asks, and Autopilot refuses (integ-x-3, integ-y-3)", () => {
    // The files the source names as it joins them to a folder (Ember's data folder, or a store's folder in it), its
    // constants, and the one whose name is built at runtime. Its sub-folders' files are Ember's by their path (above).
    const files = new Set<string>([PROVIDER_SEAL_FILE, PROVIDER_KEY_FILE, VAULT_FILE, HISTORY_FILE, ERASED_FILE, RUN_FILE, "project-workspaces-0a1b.bin"]);
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

describe("Ember's own files reached by what a field or a file dialog holds, not by what one step typed", () => {
  const modes = ["asking", "interactive", "assisted", "autopilot"] as const;
  const loc = { role: "text", name: "Location" };
  const denied = (os: OS, app: string, r: ActionRequest, what: string) => {
    for (const mode of modes) expect(engine(mode, os, { [app]: "act" }).decide(r).verdict, `${what} ${mode}`).toBe("deny");
  };
  const asksOrRefused = (os: OS, app: string, r: ActionRequest, what: string) => {
    for (const mode of ["asking", "interactive", "assisted"] as const) {
      const d = engine(mode, os, { [app]: "act" }).decide(r);
      expect(d.verdict, `${what} ${mode}`).toBe("confirm");
      expect(d.everyTime, `${what} ${mode}`).toBe(true);
      expect(d.autonomy, `${what} ${mode}`).toBeFalsy();
    }
    expect(engine("autopilot", os, { [app]: "act" }).decide(r).verdict, `${what} autopilot`).toBe("deny");
  };

  it("refuses the last piece of their folder typed in parts, key by key, or appended to what the field holds, in every mode (safety-privacy-r11-1)", () => {
    const rows: [OS, string, string, Partial<ActionRequest>][] = [
      ["linux", "kate", "Save File — Kate", { kind: "text", mode: "append", value: "ings.json", typed: "~/.config/ember/settings.json" }],
      ["linux", "kate", "Save File — Kate", { kind: "text", mode: "append", value: "er/sett", typed: "~/.config/ember/sett" }],
      ["linux", "gedit", "Save As", { kind: "text", mode: "append", value: "ings.json", currentText: "~/.config/ember/sett" }],
      ["linux", "gedit", "Save As", { kind: "text", mode: "insert", value: "ember/", currentText: "~/.config/settings.json" }],
      ["linux", "gedit", "Save As", { kind: "keys", value: "r", currentText: "~/.config/embe", typed: "~/.config/ember" }],
      ["linux", "kate", "Save File — Kate", { kind: "keys", value: "Return", currentText: "~/.config/ember/settings.json" }],
      ["linux", "kate", "Save File — Kate", { kind: "cursor_text", mode: "append", value: "ber", typed: "/home/u/.config/em" + "ber" }],
      ["win32", "notepad", "Save As", { kind: "text", mode: "append", value: "mber\\settings.json", currentText: "%LOCALAPPDATA%\\e" }],
      ["win32", "notepad", "Save As", { kind: "keys", value: "Return", currentText: "C:\\Users\\a\\AppData\\Local\\ember\\audit\\audit-2026-11.jsonl" }],
      ["darwin", "TextEdit", "Save", { kind: "keys", value: "Return", currentText: "~/Library/Application Support/ember/settings.json" }],
      ["linux", "gedit", "Save As", { kind: "text", mode: "append", value: "*/settings.json", currentText: "~/.config/emb" }],
    ];
    for (const [os, app, w, x] of rows) denied(os, app, req(app, w, { element: loc, ...x }), `${os} ${w} ${JSON.stringify(x)}`);
  });

  it("judges what a document already holds only where it may be a path, so a note about Ember's folder can be added to as before (r11-safety-y11-2)", () => {
    const doc = (_os: OS, app: string, w: string, x: Partial<ActionRequest>) => req(app, w, { element: { role: "text", name: "" }, multiLine: true, ...x });
    const rows: [OS, string, string, Partial<ActionRequest>][] = [
      ["linux", "gedit", "README.md (~/proj) - gedit", { kind: "text", mode: "append", value: "\nMore.", currentText: "Ember keeps data in ~/.config/ember/settings.json" }],
      ["linux", "gedit", "notes.txt (~/Documents) - gedit", { kind: "text", mode: "append", value: "\nnext", currentText: "todo\naudit\n" }],
      ["darwin", "TextEdit", "notes.txt", { kind: "text", mode: "append", value: "next item", currentText: "Q3 plan\nAudit\n- book room" }],
      ["win32", "WINWORD", "Story - Word", { kind: "keys", value: "Return", currentText: "Chapter 1\nEmber\nThe fire" }],
    ];
    for (const [os, app, w, x] of rows) {
      const r = doc(os, app, w, x);
      expect(mayReachEmberData(r, os), `${app} ${JSON.stringify(x)}`).toBe(false);
      for (const mode of ["interactive", "autopilot"] as const) expect(engine(mode, os, { [app]: "act" }).decide(r).verdict, `${app} ${mode}`).toBe("allow");
    }
    // A one-line field (or one whose lines aren't known) and any field in a dialog are still judged by what they hold.
    denied("linux", "gedit", req("gedit", "Save As", { element: loc, kind: "text", mode: "append", value: "ings.json", currentText: "~/.config/ember/sett" }), "one line");
    denied("linux", "gedit", req("gedit", "Save As", { element: loc, multiLine: true, kind: "keys", value: "Return", currentText: "~/.config/ember/settings.json", dialog: { name: "Save As", text: "", fields: ["~/.config/ember/settings.json"] } }), "in a dialog");
    // What the step itself types is judged in a document too.
    denied("linux", "gedit", doc("linux", "gedit", "notes.txt - gedit", { kind: "text", mode: "append", value: "~/.config/ember/settings.json", currentText: "todo" }), "typed");
  });

  it("takes Windows' trailing dot or space and a \"::$DATA\" stream for the file they save as, so \"settings.json.\" asks too (r11-safety-y11-5)", () => {
    for (const name of ["settings.json.", "settings.json::$DATA", "settings.json. .", "EMBER.\\x.txt"]) {
      asksOrRefused("win32", "notepad", req("notepad", "Save As", { kind: "text", value: name, element: loc }), name);
    }
  });

  it("takes only a path's part shaped like one for a Windows short name, so \"~5 minutes\" types as before and EMBER~1 still asks (r11-safety-y11-3)", () => {
    const rows: [string, string, Partial<ActionRequest>][] = [
      ["notepad", "notes.txt - Notepad", { kind: "text", mode: "append", value: "It takes ~5 minutes", element: { role: "edit", name: "Text Editor" } }],
      ["notepad", "notes.txt - Notepad", { kind: "text", mode: "append", value: " ok", currentText: "Walk ~2 km", element: { role: "edit", name: "Text Editor" } }],
      ["msedge", "New tab - Microsoft Edge", { kind: "text", mode: "replace", value: "lego set ~3 years old", element: { role: "edit", name: "Search" } }],
    ];
    for (const [app, w, x] of rows) {
      const r = req(app, w, x);
      expect(mayReachEmberData(r, "win32"), JSON.stringify(x)).toBe(false);
      expect(engine("autopilot", "win32", { [app]: "act" }).decide(r).verdict, JSON.stringify(x)).toBe("allow");
    }
    asksOrRefused("win32", "notepad", req("notepad", "Save As", { kind: "text", value: "EMBER~1", element: loc }), "EMBER~1");
    asksOrRefused("win32", "notepad", req("notepad", "Save As", { kind: "text", value: "notepad C:\\APPDAT~1.X\\a.txt", element: loc }), "APPDAT~1.X");
  });

  it("refuses Save, Open or Enter in a dialog whose field holds their folder, in every mode (safety-privacy-r11-1)", () => {
    const dialog = (name: string, fields: string[]) => ({ name, text: "", fields, controls: [{ role: "text", name: "Location", editable: true }, { role: "push button", name: "Save" }] });
    const rows: [OS, string, string, Partial<ActionRequest>][] = [
      ["linux", "kate", "Save File — Kate", { kind: "click", element: { role: "push button", name: "Save" }, dialog: dialog("Save File", ["~/.config/ember/settings.json"]) }],
      ["linux", "gedit", "Open", { kind: "click", element: { role: "push button", name: "Open" }, dialog: dialog("Open", ["/home/u/.config/ember/audit"]) }],
      ["linux", "gedit", "Open", { kind: "keys", value: "Return", element: { role: "table cell", name: "notes.txt" }, dialog: dialog("Open", ["~/.config/emb?r/settings.json"]) }],
      ["win32", "notepad", "Save As", { kind: "click", element: { role: "button", name: "Save" }, dialog: dialog("Save As", ["%LOCALAPPDATA%\\ember\\settings.json"]) }],
    ];
    for (const [os, app, w, x] of rows) denied(os, app, req(app, w, x), `${os} ${w} ${JSON.stringify(x)}`);
  });

  it("asks every time before Overwrite, Replace or Yes on a dialog that names one of their files, and Autopilot refuses it (safety-privacy-r11-1)", () => {
    const rows: [OS, string, string, string, string, string][] = [
      ["linux", "kate", "File Already Exists — Kate", "Overwrite", "File Already Exists", "A file named \"settings.json\" already exists. Are you sure you want to overwrite it?"],
      ["linux", "gedit", "", "Replace", "", "A file named “audit-2026-11.jsonl” already exists. Do you want to replace it?"],
      ["win32", "notepad", "Confirm Save As", "Yes", "Confirm Save As", "settings.json already exists.\nDo you want to replace it?"],
      ["darwin", "TextEdit", "Save", "Replace", "", "“extensions.json” already exists. Do you want to replace it?"],
      ["linux", "org.gnome.Nautilus", "Home", "Delete", "", "Are you sure you want to permanently delete “vault.json”?"],
    ];
    for (const [os, app, w, button, name, text] of rows) {
      asksOrRefused(os, app, req(app, w, { kind: "click", element: { role: "push button", name: button }, dialog: { name, text, alert: true } }), `${os} ${button} ${text}`);
    }
    // A dialog about another file stays as it was (asked as a risky step, announced in Autopilot).
    const other = req("kate", "File Already Exists — Kate", { kind: "click", element: { role: "push button", name: "Overwrite" }, dialog: { name: "File Already Exists", text: "A file named \"notes.txt\" already exists.", alert: true } });
    expect(mayReachEmberData(other)).toBe(false);
  });

  it("asks every time before a file dialog's Save or Open when its name field or its folder names one of their files or folders, and Autopilot refuses it (safety-privacy-r11-1)", () => {
    const rows: Partial<ActionRequest>[] = [
      { kind: "click", element: { role: "push button", name: "Save" }, dialog: { name: "Save File", text: "Name:", fields: ["settings.json"], items: ["Home", ".config"], controls: [{ role: "text", name: "Name", editable: true }, { role: "push button", name: "Save" }] } },
      { kind: "click", element: { role: "push button", name: "Save" }, dialog: { name: "Save File", text: "Name:", fields: ["notes.json"], items: ["u", ".config", "ember"], controls: [{ role: "text", name: "Name", editable: true }, { role: "toggle button", name: "ember" }, { role: "push button", name: "Save" }] } },
      { kind: "keys", value: "Return", element: { role: "text", name: "Name" }, dialog: { name: "Save As", text: "", fields: ["ember"], items: [], controls: [{ role: "text", name: "Name", editable: true }] } },
    ];
    for (const x of rows) asksOrRefused("linux", "gedit", req("gedit", "Save As", x), JSON.stringify(x));
    // Windows' 8.3 short names may be any folder, Ember's included.
    asksOrRefused("win32", "notepad", req("notepad", "Save As", { kind: "text", value: "C:\\Users\\a\\AppData\\Local\\EMBER~1\\settings.json", element: loc }), "8.3");
    asksOrRefused("win32", "notepad", req("notepad", "Save As", { kind: "text", value: "C:\\Users\\a\\APPDAT~1\\Local\\EMBER~1", element: loc }), "8.3 folder");
  });

  it("asks every time before Save, Open or Enter in a file dialog whose name or folder can't be read whole, and Autopilot refuses it; one read whole goes as before (safety-privacy-r11-1)", () => {
    const save = { role: "push button", name: "Save" };
    const unread: Partial<ActionRequest>[] = [
      { kind: "click", element: save, dialog: { name: "Save File", text: "Name:" } },
      { kind: "click", element: save, dialog: { name: "Save As", text: "Name:", fields: [], items: [] } },
      { kind: "click", element: save, dialog: { name: "Save As", text: "Name:", fields: ["notes.txt"], items: [], truncated: true, controls: [] } },
      { kind: "keys", value: "Return", element: { role: "text", name: "Name" }, dialog: { name: "Open File", text: "" } },
      { kind: "click", element: save },
    ];
    for (const x of unread) asksOrRefused("linux", "kate", req("kate", "Save File — Kate", x), JSON.stringify(x));
    // Read whole: its fields, its folder and its controls, none of them Ember's.
    const whole = req("kate", "Save File — Kate", { kind: "click", element: save, dialog: { name: "Save File", text: "Name:", fields: ["notes.txt"], items: ["u", "Documents", "notes.txt"], controls: [{ role: "text", name: "Name", editable: true }, save] } });
    expect(mayReachEmberData(whole)).toBe(false);
    expect(engine("autopilot", "linux", { kate: "act" }).decide(whole).verdict).toBe("allow");
    // Cancel backs out, wherever the dialog is.
    expect(mayReachEmberData(req("kate", "Save File — Kate", { kind: "click", element: { role: "push button", name: "Cancel" }, dialog: { name: "Save File", text: "" } }))).toBe(false);
  });

  it("lets an ordinary step on a web page titled like a file dialog go as before, announced in Interactive, since a page saves and opens nothing but through the browser's own chooser (docs/APPROVALS.md)", () => {
    const go = { role: "push button", name: "Continue" };
    const rows: Partial<ActionRequest>[] = [
      { kind: "click", element: go, onPage: true },
      { kind: "keys", value: "F5", element: { role: "document web", name: "Page" }, inPage: true },
      { kind: "click", element: go, onPage: true, dialog: { name: "Save As", text: "Name:", page: true } },
    ];
    for (const [title, x] of [["Save As — Mozilla Firefox", rows[0]], ["Open - Google Chrome", rows[1]]] as const) {
      const r = req("firefox", title, x);
      expect(mayReachEmberData(r), title).toBe(false);
      const i = engine("interactive", "linux").decide(r);
      expect(i.verdict, `${title} interactive`).toBe("allow");
      expect(i.announce, title).toBeTruthy();
      expect(engine("autopilot", "linux").decide(r).verdict, `${title} autopilot`).toBe("allow");
    }
    // A page's own dialog titled so is judged as any page's dialog is, not as one Ember can't read where it saves.
    const own = req("firefox", "Browse — Mozilla Firefox", rows[2]);
    expect(mayReachEmberData(own)).toBe(false);
    expect(engine("interactive", "linux").decide(own).prompt).not.toContain(EMBER_DATA_UNREAD_QUESTION);
    // The browser's own file chooser, a native window, is still judged as a file dialog it can't read whole.
    asksOrRefused("linux", "firefox", req("firefox", "Save As", { kind: "click", element: { role: "push button", name: "Save" } }), "native chooser");
  });

  it("reads a file dialog's fields, its path bar and its chosen rows as it is when the step is taken, and leaves its fields unknown when one can't be read (safety-privacy-r11-1)", () => {
    const n = (id: number, parent: number | null, role: string, name: string, x: Partial<AxNode> = {}): AxNode => ({ id, parent, depth: parent === null ? 0 : 1, role, name, states: [], bounds: null, ...x });
    const nodes = (field: Partial<AxNode> = {}): AxNode[] => [
      n(1, null, "file chooser", "Save File"),
      n(2, 1, "text", "Location", { editable: true, text: "~/.config/ember/settings.json", ...field }),
      n(3, 1, "toggle button", "ember"),
      n(4, 1, "table cell", "settings.json", { states: ["selected"] }),
      n(5, 1, "push button", "Save"),
    ];
    const read = (all: AxNode[]) => dialogAround(all.find(x => x.id === 5), id => all.find(x => x.id === id), all, true)!;
    const d = read(nodes());
    expect(d.fileChooser).toBe(true);
    expect(d.fields).toEqual(["~/.config/ember/settings.json"]);
    expect(d.items).toEqual(["Location", "ember", "Save"]);
    expect(d.selected).toEqual(["settings.json"]);
    for (const mode of modes) expect(engine(mode, "linux", { kate: "act" }).decide(req("kate", "Save File — Kate", { kind: "click", element: { role: "push button", name: "Save" }, dialog: d })).verdict, mode).toBe("deny");
    // A field whose contents are withheld: what it holds can't be told, so its Save asks (and Autopilot refuses it).
    const hidden = read(nodes({ secret: true, text: undefined }));
    expect(hidden.fields).toBeUndefined();
    expect(mayReachEmberData(req("kate", "Save File — Kate", { kind: "click", element: { role: "push button", name: "Save" }, dialog: { ...hidden, items: ["Location", "Documents", "Save"], selected: [] } }))).toBe(true);
  });

  it("refuses in Autopilot, and asks elsewhere, a context menu's Move to Trash, a header button or a Delete in a file manager while the rows chosen hold the folder above Ember's data, or can't all be read in the home folder (safety-privacy-r11-2)", () => {
    const trash = { kind: "click" as const, element: { role: "menu item", name: "Move to Trash" } };
    const user = path.basename(os.homedir());
    const rows: [OS, string, string, Partial<ActionRequest>][] = [
      ["linux", "org.gnome.Nautilus", "Home", { ...trash, chosen: { names: [".config"], whole: true } }],
      ["linux", "org.gnome.Nautilus", "Home", { kind: "click", element: { role: "push button", name: "Move to Trash" }, chosen: { names: ["Documents", ".config", "Music"], whole: true } }],
      ["linux", "org.gnome.Nautilus", "Home", { kind: "keys", value: "Delete", element: { role: "table", name: "" }, chosen: { names: ["Documents", ".config"], whole: true } }],
      ["linux", "org.gnome.Nautilus", "Home", { kind: "keys", value: "Delete", element: { role: "table", name: "" }, chosen: { names: ["Documents"], whole: false } }],
      ["linux", "org.gnome.Nautilus", "Home", { ...trash }],
      ["linux", "org.kde.dolphin", "Home — Dolphin", { kind: "click", element: { role: "menu item", name: "Cut" }, chosen: { names: [".config"], whole: true } }],
      ["linux", "org.gnome.Nautilus", "/", { kind: "click", element: { role: "menu item", name: "Delete Permanently" }, chosen: { names: ["etc"], whole: true } }],
      ["win32", "explorer", `${user} - File Explorer`, { kind: "click", element: { role: "menu item", name: "Delete" }, chosen: { names: ["AppData"], whole: true } }],
      ["win32", "explorer", `${user} - File Explorer`, { kind: "click", element: { role: "menu item", name: "Delete" } }],
      ["win32", "explorer", "Users - File Explorer", { kind: "keys", value: "Delete", element: { role: "list", name: "Items View" }, chosen: { names: [user], whole: true } }],
      ["darwin", "Finder", user, { kind: "click", element: { role: "AXMenuItem", name: "Move to Trash" }, chosen: { names: ["Library"], whole: true } }],
      ["darwin", "Finder", "Library", { kind: "keys", value: "cmd+BackSpace", element: { role: "AXList", name: "" }, chosen: { names: ["Application Support"], whole: true } }],
    ];
    for (const [o, app, w, step] of rows) {
      const r = req(app, w, step);
      const what = `${o} ${w} ${step.element?.name} ${JSON.stringify(step.chosen)}`;
      expect(mayReachEmberData(r, o), what).toBe(true);
      expect(engine("autopilot", o).decide(r).verdict, `${what} autopilot`).toBe("deny");
      const inter = engine("interactive", o).decide(r);
      expect(inter.verdict, `${what} interactive`).toBe("confirm");
      expect(inter.autonomy, what).toBeFalsy();
    }
    // Other rows chosen, all read: as before (a risky step asks, and Autopilot announces it).
    expect(mayReachEmberData(req("org.gnome.Nautilus", "Home", { ...trash, chosen: { names: ["Documents", "notes.txt"], whole: true } }))).toBe(false);
    expect(mayReachEmberData(req("org.gnome.Nautilus", "Projects", { ...trash, chosen: { names: ["old"], whole: false } }))).toBe(false);
    expect(mayReachEmberData(req("org.gnome.Nautilus", "Home", { kind: "click", element: { role: "menu item", name: "Open With Text Editor" }, chosen: { names: ["notes.txt"], whole: true } }))).toBe(false);
  });

  it("takes any menu item, and any button but one that backs off, for one that may move the rows chosen when they hold the folder above Ember's data, in any language (r11-safety-y11-4)", () => {
    const rows: [OS, string, string, string, string, string][] = [
      ["linux", "org.gnome.Nautilus", "Persönlicher Ordner", "menu item", "In den Papierkorb verschieben", ".config"],
      ["linux", "org.gnome.Nautilus", "Persönlicher Ordner", "menu item", "Löschen", ".config"],
      ["linux", "org.gnome.Nautilus", "Persönlicher Ordner", "push button", "Löschen", ".config"],
      ["linux", "org.gnome.Nautilus", "Dossier personnel", "menu item", "Mettre à la corbeille", ".config"],
      ["linux", "org.gnome.Nautilus", "Dossier personnel", "menu item", "Couper", ".config"],
      ["linux", "org.gnome.Nautilus", "Persönlicher Ordner", "menu item", "Umbenennen…", ".config"],
      ["win32", "explorer", "Ordner", "menu item", "Löschen", "AppData"],
      ["win32", "explorer", "Ordner", "menu item", "Ausschneiden", "AppData"],
      ["darwin", "Finder", "Privat", "AXMenuItem", "In den Papierkorb legen", "Library"],
    ];
    for (const [o, app, w, role, name, holder] of rows) {
      const r = req(app, w, { kind: "click", element: { role, name }, chosen: { names: [holder], whole: true } });
      expect(mayReachEmberData(r, o), `${w} ${name}`).toBe(true);
      expect(engine("autopilot", o).decide(r).verdict, `${w} ${name} autopilot`).toBe("deny");
      const inter = engine("interactive", o).decide(r);
      expect(inter.verdict, `${w} ${name} interactive`).toBe("confirm");
      expect(inter.autonomy, `${w} ${name}`).toBeFalsy();
    }
    // Backing off stays as it was, and other rows chosen, all read, go as before.
    expect(mayReachEmberData(req("org.gnome.Nautilus", "Home", { kind: "click", element: { role: "push button", name: "Cancel" }, chosen: { names: [".config"], whole: true } }))).toBe(false);
    expect(mayReachEmberData(req("org.gnome.Nautilus", "Persönlicher Ordner", { kind: "click", element: { role: "menu item", name: "Löschen" }, chosen: { names: ["Dokumente"], whole: true } }))).toBe(false);
  });

  it("reads the rows chosen in a file manager as the step is taken, and can't tell them whole when one is unnamed or a row was left out (safety-privacy-r11-2)", () => {
    const row = (id: number, name: string, selected: boolean, x: Partial<AxNode> = {}): AxNode => ({ id, parent: 1, depth: 1, role: "table cell", name, states: selected ? ["selected"] : [], bounds: null, ...x });
    const view = (extra: AxNode[] = []): AxNode[] => [{ id: 1, parent: null, depth: 0, role: "table", name: "", states: [], bounds: null }, row(2, "Documents", true), row(3, ".config", true), row(4, "Music", false), ...extra];
    expect(chosenIn(view(), true)).toEqual({ names: ["Documents", ".config"], whole: true, shown: ["Documents", ".config", "Music"] });
    expect(chosenIn(view(), false).whole).toBe(false);
    expect(chosenIn(view([row(5, "", true, { withheld: true })]), true).whole).toBe(false);
    expect(chosenIn(view([row(5, "Pictures", false, { omitted: true })]), true).whole).toBe(false);
    expect(chosenIn([{ id: 1, parent: null, depth: 0, role: "menu", name: "", states: [], bounds: null }], true).whole).toBe(false);
    const d = engine("autopilot").decide(req("org.gnome.Nautilus", "Home", { kind: "click", element: { role: "menu item", name: "Move to Trash" }, chosen: chosenIn(view(), true) }));
    expect(d.verdict).toBe("deny");
  });

  it("says in the question that the step may reach Ember's own settings or record, in Ember's words (safety-privacy-r11-3)", () => {
    expect(EMBER_DATA_QUESTION).toBe("This may be my own settings or my record of what I did, so say no unless you asked for that.");
    expect(EMBER_DATA_UNREAD_QUESTION).toBe("I can't read where this saves or what it opens, so it may be my own settings or my record of what I did: say no unless you asked for that.");
    const rows: [OS, string, string, Partial<ActionRequest>, string][] = [
      ["linux", "kate", "settings.json — Kate", { kind: "click" }, EMBER_DATA_QUESTION],
      ["linux", "kate", "settings.json — Kate", { kind: "keys", value: "ctrl+s" }, EMBER_DATA_QUESTION],
      ["win32", "notepad", "settings.json - Notepad", { kind: "keys", value: "ctrl+s" }, EMBER_DATA_QUESTION],
      ["win32", "explorer", "ember - File Explorer", { kind: "keys", value: "Delete", element: { role: "list item", name: "audit" } }, EMBER_DATA_QUESTION],
      ["linux", "kate", "File Already Exists — Kate", { kind: "click", element: { role: "push button", name: "Overwrite" }, dialog: { name: "File Already Exists", text: "A file named \"settings.json\" already exists.", alert: true } }, EMBER_DATA_QUESTION],
      ["linux", "kate", "Save File — Kate", { kind: "click", element: { role: "push button", name: "Save" }, dialog: { name: "Save File", text: "" } }, EMBER_DATA_UNREAD_QUESTION],
    ];
    for (const [o, app, w, x, line] of rows) {
      for (const mode of ["asking", "interactive"] as const) {
        const d = engine(mode, o, { [app]: "act" }).decide(req(app, w, x));
        expect(d.verdict, `${w} ${mode}`).toBe("confirm");
        expect(d.prompt, `${w} ${mode}`).toContain(line);
        expect(d.prompt.split(line)).toHaveLength(2);
      }
    }
  });
});

describe("Ember's own files behind a file dialog the screen reader can't read whole, or doesn't call a file dialog", () => {
  const n = (id: number, parent: number | null, role: string, name: string, x: Partial<AxNode> = {}): AxNode => ({ id, parent, depth: parent === null ? 0 : 1, role, name, states: [], bounds: null, ...x });
  const read = (all: AxNode[], at: number, whole = true) => dialogAround(all.find(x => x.id === at), id => all.find(x => x.id === id), all, whole, "root")!;
  const asksOrRefused = (o: OS, app: string, r: ActionRequest, what: string) => {
    expect(mayReachEmberData(r, o), what).toBe(true);
    for (const mode of ["asking", "interactive", "assisted"] as const) {
      const d = engine(mode, o, { [app]: "act" }).decide(r);
      expect(d.verdict, `${what} ${mode}`).toBe("confirm");
      expect(d.everyTime, `${what} ${mode}`).toBe(true);
      expect(d.autonomy, `${what} ${mode}`).toBeFalsy();
    }
    expect(engine("autopilot", o, { [app]: "act" }).decide(r).verdict, `${what} autopilot`).toBe("deny");
  };
  const winSave = (field: Partial<AxNode>, title = "Save As"): AxNode[] => [
    n(1, null, "dialog", title, { dialogBox: true }),
    n(2, 1, "tool bar", "Address: Documents"),
    n(3, 1, "list", "Items View"),
    n(4, 3, "list item", "notes.txt"),
    n(5, 1, "edit", "File name:", { editable: true, ...field }),
    n(6, 1, "combo box", "Save as type:", { selected: "Text Documents (*.txt)" }),
    n(7, 1, "button", "Save"),
    n(8, 1, "button", "Cancel"),
  ];
  const save = { kind: "click" as const, element: { role: "button", name: "Save" } };

  it("takes a field the reader cut short for one whose path can't be read whole, so Save or Enter asks, and Autopilot refuses it (r11-safety-x11-1)", () => {
    // A path pasted from a page the task read, whose part in Ember's folder lies past the 200 characters a read gives.
    const path = "C:\\Users\\a\\Documents\\" + "..\\Documents\\".repeat(16) + "..\\..\\AppData\\Local\\ember\\settings.json";
    const cut = winSave({ text: path.slice(0, 200), textCut: true });
    const d = read(cut, 7);
    asksOrRefused("win32", "notepad", req("notepad", "Save As", { ...save, dialog: d }), "Save, the name cut");
    asksOrRefused("win32", "notepad", req("notepad", "Save As", { kind: "keys", value: "Return", element: { role: "edit", name: "File name:" }, currentText: path.slice(0, 200), dialog: read(cut, 5) }), "Enter, the name cut");
    // The same on Linux's file chooser, cut at its reader's 200 characters.
    const lin = "/home/u/Documents/" + "./".repeat(1000) + "../.config/ember/extensions.json";
    const gtk = [n(1, null, "file chooser", "Save File"), n(2, 1, "text", "Name", { editable: true, text: lin.slice(0, 200), textCut: true }), n(3, 1, "toggle button", "Documents"), n(4, 1, "push button", "Save")];
    asksOrRefused("linux", "gedit", req("gedit", "Save File", { kind: "click", element: { role: "push button", name: "Save" }, dialog: read(gtk, 4) }), "GTK Save, the name cut");
    // One the reader gave whole (200 characters exactly, an ordinary name) goes as before.
    const full = read(winSave({ text: "n".repeat(196) + ".txt" }), 7);
    expect(mayReachEmberData(req("notepad", "Save As", { ...save, dialog: full }), "win32")).toBe(false);
    expect(engine("autopilot", "win32", { notepad: "act" }).decide(req("notepad", "Save As", { ...save, dialog: full })).verdict).toBe("allow");
  });

  it("reads a file dialog whole only when the read was whole, nothing under it was left out and each field's text is known, empty included (r11-safety-x11-2)", () => {
    const gtk = (x: AxNode[] = []): AxNode[] => [n(1, null, "file chooser", "Save File"), n(2, 1, "text", "Name", { editable: true, text: "settings.jsonx" }), n(5, 1, "push button", "Save"), ...x];
    const step = (d: ReturnType<typeof read>) => req("gedit", "Save File", { kind: "click", element: { role: "push button", name: "Save" }, dialog: d });
    // Read cut short, or with the panel that holds its path bar left out: where it saves can't be told.
    asksOrRefused("linux", "gedit", step(read(gtk(), 5, false)), "read cut short");
    asksOrRefused("linux", "gedit", step(read(gtk([n(3, 1, "panel", "", { omitted: true })]), 5)), "path bar left out");
    // Windows' File name edit whose text the reader couldn't get, with a row chosen: what it saves as can't be told.
    const unknown = winSave({});
    unknown[3] = n(4, 3, "list item", "notes.txt", { states: ["selected"] });
    asksOrRefused("win32", "notepad", req("notepad", "Save As", { ...save, dialog: read(unknown, 7) }), "File name unknown");
    // Read and found empty, a row chosen: Save saves as that row, read whole.
    const empty = winSave({ empty: true });
    empty[3] = n(4, 3, "list item", "notes.txt", { states: ["selected"] });
    expect(mayReachEmberData(req("notepad", "Save As", { ...save, dialog: read(empty, 7) }), "win32")).toBe(false);
    // Rows of its list scrolled away hold files, not where it saves: still read whole.
    const scrolled = winSave({ text: "notes.txt" });
    scrolled[2] = n(3, 1, "list", "Items View", { omitted: true });
    expect(read(scrolled, 7).unread).toBeUndefined();
    expect(engine("autopilot", "win32", { notepad: "act" }).decide(req("notepad", "Save As", { ...save, dialog: read(scrolled, 7) })).verdict).toBe("allow");
    // A real GTK chooser (read under Xvfb with AT-SPI): its own widget, its places and its path bar's scrolled crumbs are
    // always left out of the read, but its name and its current folder (the checked crumb) are read: as before.
    const real = (folder: string, crumbs: string[], name: string): AxNode[] => [
      n(1, null, "file chooser", "Speichern unter", { omitted: true }), n(2, 1, "file chooser", "File Chooser Widget", { omitted: true }),
      n(3, 2, "text", "", { editable: true, text: name, states: ["editable", "focused"] }), n(4, 2, "label", "Name:"),
      n(5, 2, "scroll pane", "Places", { omitted: true }), n(6, 5, "list box", "", { omitted: true }), n(7, 6, "list item", "", { omitted: true, states: ["selected"] }),
      n(8, 2, "filler", "PathBar Layer", { omitted: true }), n(9, 8, "toggle button", folder, { states: ["checked"] }),
      ...crumbs.map((c, i) => n(20 + i, 8, "toggle button", c)), n(10, 8, "push button", "Up Path"),
      n(11, 2, "table", "Files"), n(12, 11, "table cell", "x"), n(13, 1, "push button", "Cancel"), n(14, 1, "push button", "Save"),
    ];
    const home = read(real("root", [], "notes.txt"), 14);
    expect(home.unread).toBeUndefined();
    for (const mode of ["interactive", "autopilot"] as const) expect(engine(mode, "linux", { gedit: "act" }).decide(step(home)).verdict, mode).toBe("allow");
    asksOrRefused("linux", "gedit", step(read(real("ember", [".config", "d", "home"], "settings.json"), 14)), "real GTK in ember");
    // Its path bar left out entirely: where it saves can't be told.
    asksOrRefused("linux", "gedit", step(read(real("root", [], "notes.txt").filter(a => a.id !== 9), 14)), "real GTK, no crumb");
    // Positive evidence from a read cut short still counts: a path bar naming Ember's folder is refused.
    const named = read([...gtk([n(3, 1, "panel", "", { omitted: true })]), n(6, 1, "toggle button", "ember")], 5);
    expect(engine("autopilot", "linux", { gedit: "act" }).decide(step(named)).verdict).toBe("deny");
  });

  it("reads a GTK chooser's folder only from crumbs that reach the home folder or the root, so a Save deep in Ember's folder asks and Autopilot refuses it (r11-safety-y11-1)", () => {
    // The reviewer's real read three folders below Ember's models: the path bar scrolled, no ember, .config or home crumb.
    const deep: AxNode[] = [
      n(1, null, "file chooser", "Speichern unter", { omitted: true }), n(2, 1, "file chooser", "File Chooser Widget", { omitted: true }),
      n(3, 2, "text", "", { editable: true, text: "notes.txt", states: ["editable", "focused"] }), n(4, 2, "label", "Name:"),
      n(5, 2, "scroll pane", "Places", { omitted: true }), n(8, 2, "filler", "PathBar Layer", { omitted: true }),
      n(9, 8, "toggle button", "third-level-folder", { states: ["checked"] }), n(20, 8, "toggle button", "another-long-sub-folder-name"),
      n(21, 8, "toggle button", "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"), n(22, 8, "toggle button", "models"),
      n(10, 8, "push button", "Up Path"), n(11, 2, "table", "Files"), n(12, 11, "table cell", "x"), n(14, 1, "push button", "Save"),
    ];
    const step = (d: ReturnType<typeof read>) => req("gedit", "Save File", { kind: "click", element: { role: "push button", name: "Save" }, dialog: d });
    const at = (all: AxNode[]) => dialogAround(all.find(x => x.id === 14), id => all.find(x => x.id === id), all, true, "u")!;
    expect(at(deep).unread).toBe(true);
    asksOrRefused("linux", "gedit", step(at(deep)), "real GTK deep in Ember's folder");
    // Crumbs that reach the user's home folder, or the root, show where it saves: Documents and /tmp go as before.
    const shows = (crumbs: string[]) => deep.filter(a => a.id < 20 || a.id > 22).map(a => (a.id === 9 ? { ...a, name: crumbs[0]! } : a))
      .concat(crumbs.slice(1).map((c, i) => n(30 + i, 8, "toggle button", c)));
    for (const crumbs of [["Documents", "u"], ["u"], ["x", "tmp", "/"]]) {
      const d = at(shows(crumbs));
      expect(d.unread, crumbs.join("/")).toBeUndefined();
      for (const mode of ["interactive", "autopilot"] as const) expect(engine(mode, "linux", { gedit: "act" }).decide(step(d)).verdict, `${crumbs.join("/")} ${mode}`).toBe("allow");
    }
  });

  it("knows a file dialog by its shape, whatever its title says, so a localised or an app's own Save dialog is judged as one (r11-safety-x11-3)", () => {
    for (const title of ["Speichern unter", "Enregistrer sous", "Enter name of file to save to…", "Save Image As", "Export Image", "Save Page As", "名前を付けて保存"]) {
      // Its name field names one of Ember's files: asks, and Autopilot refuses.
      const named = winSave({ text: "settings.json" }, title);
      asksOrRefused("win32", "app", req("app", title, { ...save, dialog: read(named, 7) }), `${title} settings.json`);
      // Its folder shown as breadcrumb buttons, Ember's among them.
      const crumbs = [...winSave({ text: "notes.txt" }, title), n(9, 2, "button", "AppData"), n(10, 2, "button", "Local"), n(11, 2, "button", "ember")];
      asksOrRefused("win32", "app", req("app", title, { ...save, dialog: read(crumbs, 7) }), `${title} breadcrumb`);
      // Its name the reader couldn't get: can't be read whole.
      asksOrRefused("win32", "app", req("app", title, { ...save, dialog: read(winSave({}, title), 7) }), `${title} unread`);
      // macOS's save sheet: a text field and an outline of rows, a "dialog" to the reader.
      const sheet = [n(1, null, "dialog", title), n(2, 1, "text", "Save As:", { editable: true, text: "words.json" }), n(3, 1, "tree table", ""), n(4, 3, "table row", "Documents"), n(5, 1, "push button", "Save")];
      asksOrRefused("darwin", "app", req("app", title, { kind: "click", element: { role: "push button", name: "Save" }, dialog: read(sheet, 5) }), `${title} sheet`);
    }
    // Windows' File name as the editable combo box it is, with no edit listed inside it, its text cut.
    const combo = [n(1, null, "dialog", "Guardar como"), n(2, 1, "list", "Items View"), n(3, 2, "list item", "a.txt"), n(4, 1, "combo box", "Nombre:", { editable: true, text: "x".repeat(200), textCut: true }), n(5, 1, "button", "Guardar")];
    asksOrRefused("win32", "app", req("app", "Guardar como", { kind: "click", element: { role: "button", name: "Guardar" }, dialog: read(combo, 5) }), "editable combo name");
    // A dialog with a field and no rows (a Find box, a rename) isn't taken for one.
    const find = [n(1, null, "dialog", "Suchen"), n(2, 1, "edit", "Suchen nach:", { editable: true, text: "notes" }), n(3, 1, "button", "Weitersuchen")];
    expect(read(find, 3).fileChooser).toBeUndefined();
  });

  it("takes a file manager showing the folders above Ember's data for the home folder, whatever its title, so a Delete whose choice can't all be read asks, and Autopilot refuses it (r11-safety-x11-4)", () => {
    const row = (id: number, name: string, selected = false): AxNode => n(id, 1, "table cell", name, { states: selected ? ["selected"] : [] });
    const view = (...more: AxNode[]): AxNode[] => [n(1, null, "table", ""), row(2, "Documents", true), row(3, "Music"), ...more];
    for (const [o, title, holder] of [["linux", "Persönlicher Ordner", ".config"], ["linux", "Dossier personnel", ".config"], ["linux", "Carpeta personal", ".config"], ["linux", "u - File Manager", ".config"], ["win32", "Ordner", "AppData"], ["darwin", "Privat", "Library"]] as [OS, string, string][]) {
      const chosen = chosenIn(view(row(4, holder), n(5, 1, "table cell", "", { omitted: true })), true);
      expect(chosen.whole).toBe(false);
      const app = o === "linux" ? "org.gnome.Nautilus" : o === "win32" ? "explorer" : "Finder";
      const r = req(app, title, { kind: "keys", value: "Delete", element: { role: "table cell", name: "Documents" }, chosen });
      expect(mayReachEmberData(r, o), title).toBe(true);
      expect(engine("autopilot", o).decide(r).verdict, `${title} autopilot`).toBe("deny");
      expect(engine("interactive", o).decide(r).autonomy, title).toBeFalsy();
    }
    // A folder that shows none of them, its choice not all read: as before.
    const other = chosenIn(view(n(5, 1, "table cell", "", { omitted: true })), true);
    expect(mayReachEmberData(req("org.gnome.Nautilus", "Projekte", { kind: "keys", value: "Delete", element: { role: "table cell", name: "Documents" }, chosen: other }))).toBe(false);
  });
});
