/**
 * A fallback chord when another app holds one of Ember's shortcuts (owner decision D-45b, review #45b): each shortcut
 * has a documented fallback per OS (app/shared/shortcuts.ts), registered when the default is refused (hotkey.ts
 * holdShortcuts, with a fake registry here); what Ember holds (default, fallback or none) is what the setup check, the
 * keyboard route to settings and the greeting name.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ALWAYS_HELD, FALLBACK_SHORTCUTS, KEYS, SHORTCUTS, heldShortcuts, type OS, type ShortcutId } from "../../app/shared/shortcuts";
import { canonicalKeys, isSystemKey } from "../../app/main/policy/policy";
import { holdShortcuts, type ShortcutRegistry } from "../../app/main/hotkey";
import { inspectEnvironment, keyboardRoute, type EnvInputs } from "../../app/main/environment";
import { keysLine } from "../../app/main/hello";

const OSES: OS[] = ["linux", "win32", "darwin"];
const IDS: ShortcutId[] = ["ask", "stop", "settings", "mute", "allow", "deny"];
/** An Electron accelerator as a combination the policy reads ("Control+Alt+Shift+Command+Y" → "ctrl+alt+shift+cmd+y"). */
const asCombo = (accel: string) => accel.split("+").map(p => ({ Control: "ctrl", Command: "cmd", Super: "super", Alt: "alt", Shift: "shift" } as Record<string, string>)[p] ?? p.toLowerCase()).join("+");

describe("the fallback chords (D-45b)", () => {
  it("are the defaults with Shift on Linux and Windows, and with Option on macOS", () => {
    expect(FALLBACK_SHORTCUTS.linux.ask).toEqual({ accel: "Control+Alt+Shift+Space", label: "Ctrl+Alt+Shift+Space", keys: ["Ctrl", "Alt", "Shift", "Space"], say: "Control Alt Shift Space", chord: "ctrl+alt+shift+space" });
    expect(FALLBACK_SHORTCUTS.win32.stop).toEqual({ accel: "Super+Alt+Shift+X", label: "Win+Alt+Shift+X", keys: ["Win", "Alt", "Shift", "X"], say: "Windows key, Alt, Shift, X", chord: "alt+shift+super+x" });
    expect(FALLBACK_SHORTCUTS.darwin.settings).toEqual({
      accel: "Control+Alt+Shift+Command+E", label: "Control+Option+Shift+Command+E", keys: ["Control", "Option", "Shift", "Command", "E"],
      say: "Control Option Shift Command E", chord: "ctrl+alt+shift+cmd+e",
    });
  });

  it("are each the policy's spelling of the accelerator, a key only the user presses, and never a default", () => {
    for (const os of OSES) {
      const defaults = new Set(Object.values(SHORTCUTS[os]).map(d => d.accel));
      const accels = new Set<string>();
      for (const id of IDS) {
        const f = FALLBACK_SHORTCUTS[os][id];
        expect(canonicalKeys(asCombo(f.accel), KEYS[os]), `${os} ${id}`).toBe(f.chord);
        // A task can't press it (it would ask, stop or answer for the user), as it can't press a default.
        expect(isSystemKey(f.chord, KEYS[os]), `${os} ${id}`).toBe(true);
        expect(defaults.has(f.accel), `${os} ${id}`).toBe(false);
        accels.add(f.accel);
        // The same key as the default, one modifier more.
        expect(f.keys.at(-1)).toBe(SHORTCUTS[os][id].keys.at(-1));
        expect(f.keys).toHaveLength(SHORTCUTS[os][id].keys.length + 1);
        expect(f.label).toBe(f.keys.join("+"));
      }
      expect(accels.size).toBe(IDS.length);
    }
  });
});

describe("heldShortcuts", () => {
  const sc = SHORTCUTS.linux, fb = FALLBACK_SHORTCUTS.linux;
  it("is the default while Ember holds it, the fallback once another app holds the default, and null once both", () => {
    expect(heldShortcuts(sc, fb, []).ask).toBe(sc.ask);
    const held = heldShortcuts(sc, fb, ["Control+Alt+Space", "Control+Alt+X", "Control+Alt+Shift+X"]);
    expect(held.ask).toBe(fb.ask);
    expect(held.stop).toBeNull();
    expect(held.settings).toBe(sc.settings);
  });
});

/** A fake of Electron's globalShortcut: `others` are held by other apps; what Ember registers is kept. */
function registry(others: string[]) {
  const mine = new Map<string, ShortcutId>();
  const tried: string[] = [];
  const reg: ShortcutRegistry = {
    isRegistered: accel => mine.has(accel),
    register: (id, accel) => {
      tried.push(accel);
      if (others.includes(accel) || mine.has(accel)) return false;
      mine.set(accel, id);
      return true;
    },
  };
  return { reg, mine, tried, others };
}

describe("holdShortcuts (registration with a fallback)", () => {
  const sc = SHORTCUTS.win32, fb = FALLBACK_SHORTCUTS.win32;

  it("registers each default when it is free, and nothing else", () => {
    const r = registry([]);
    expect(holdShortcuts(ALWAYS_HELD, sc, fb, r.reg)).toEqual({ taken: [], missing: [] });
    expect([...r.mine]).toEqual([["Super+Alt+Space", "ask"], ["Super+Alt+X", "stop"], ["Super+Alt+E", "settings"], ["Super+Alt+M", "mute"]]);
  });

  it("registers the fallback when another app holds the default, for the same shortcut", () => {
    const r = registry(["Super+Alt+Space", "Super+Alt+M"]);
    expect(holdShortcuts(ALWAYS_HELD, sc, fb, r.reg)).toEqual({ taken: ["Super+Alt+Space", "Super+Alt+M"], missing: [] });
    expect(r.mine.get("Super+Alt+Shift+Space")).toBe("ask");
    expect(r.mine.get("Super+Alt+Shift+M")).toBe("mute");
    expect(heldShortcuts(sc, fb, ["Super+Alt+Space", "Super+Alt+M"]).ask?.label).toBe("Win+Alt+Shift+Space");
  });

  it("keeps today's route when both are taken: both reported, the shortcut missing, and tried again later", () => {
    const r = registry(["Super+Alt+X", "Super+Alt+Shift+X"]);
    const first = holdShortcuts(ALWAYS_HELD, sc, fb, r.reg);
    expect(first).toEqual({ taken: ["Super+Alt+X", "Super+Alt+Shift+X"], missing: ["stop"] });
    // The other app let go of the default: the next try (main's minute) takes it.
    r.others.splice(0, 1);
    expect(holdShortcuts(ALWAYS_HELD, sc, fb, r.reg)).toEqual({ taken: [], missing: [] });
    expect(r.mine.get("Super+Alt+X")).toBe("stop");
  });

  it("keeps a fallback it holds once the default comes free, so the chord it named doesn't change while Ember runs", () => {
    const r = registry(["Super+Alt+Space"]);
    holdShortcuts(ALWAYS_HELD, sc, fb, r.reg);
    r.others.length = 0;
    r.tried.length = 0;
    expect(holdShortcuts(ALWAYS_HELD, sc, fb, r.reg)).toEqual({ taken: ["Super+Alt+Space"], missing: [] });
    expect(r.tried).toEqual([]);
    expect(r.mine.has("Super+Alt+Space")).toBe(false);
  });

  it("holds the question keys the same way (Allow and Not now)", () => {
    const r = registry(["Super+Alt+Y"]);
    expect(holdShortcuts(["allow", "deny"], sc, fb, r.reg)).toEqual({ taken: ["Super+Alt+Y"], missing: [] });
    expect(r.mine.get("Super+Alt+Shift+Y")).toBe("allow");
    expect(r.mine.get("Super+Alt+N")).toBe("deny");
  });

  it("counts a registry that throws as a refusal", () => {
    const reg: ShortcutRegistry = { isRegistered: () => false, register: () => { throw new Error("invalid accelerator"); } };
    expect(holdShortcuts(["ask"], sc, fb, reg)).toEqual({ taken: ["Super+Alt+Space", "Super+Alt+Shift+Space"], missing: ["ask"] });
  });
});

describe("keyboardRoute with fallbacks (review #45)", () => {
  const sc = SHORTCUTS.linux, fb = FALLBACK_SHORTCUTS.linux;
  it("opens settings at Ask Ember… or Stop everything only while Ember holds neither chord of that shortcut", () => {
    expect(keyboardRoute(["Control+Alt+Space"], sc, fb)).toBeNull();
    expect(keyboardRoute(["Control+Alt+Space", "Control+Alt+Shift+Space"], sc, fb)).toBe("access:ask");
    expect(keyboardRoute(["Control+Alt+X", "Control+Alt+Shift+X", "Control+Alt+Space"], sc, fb)).toBe("access:stop");
    expect(keyboardRoute([], sc, fb)).toBeNull();
  });
});

describe("the setup check's shortcuts row names what Ember holds (D-45b)", () => {
  const linux: EnvInputs = { env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" }, osRelease: null, glibc: "2.28", versions: { node: "22" }, platform: "linux", arch: "x64", shortcutsTaken: [] };
  const row = (i: EnvInputs) => inspectEnvironment(i).checks.find(c => c.id === "shortcuts");

  it("says when a fallback is in use, and which chord does what now", () => {
    expect(row({ ...linux, shortcutsTaken: ["Control+Alt+Space"] })).toMatchObject({
      status: "warn",
      detail: "Ctrl+Alt+Space is taken by another app, so Ask Ember is Ctrl+Alt+Shift+Space. Ctrl+Alt+Shift+Space ask · Ctrl+Alt+X stop · Ctrl+Alt+E settings · Ctrl+Alt+M microphone",
    });
    expect(row({ ...linux, shortcutsTaken: ["Control+Alt+Space", "Control+Alt+X"] })?.detail).toMatch(
      /^Ctrl\+Alt\+Space and Ctrl\+Alt\+X are taken by other apps, so Ask Ember is Ctrl\+Alt\+Shift\+Space and Stop everything is Ctrl\+Alt\+Shift\+X\. /);
  });

  it("keeps today's route when another app holds the fallback too, naming both chords", () => {
    const d = row({ ...linux, shortcutsTaken: ["Control+Alt+Space", "Control+Alt+Shift+Space"] })?.detail;
    expect(d).toBe("Another app already uses Ctrl+Alt+Space, Ctrl+Alt+Shift+Space. Ember keeps trying to get them; meanwhile, click Ember's handle in the corner (it has Ask, Stop everything and Settings), or, from the keyboard, open Ember again from your apps: its settings open at Ask Ember… and Stop everything, under Comfort & access.");
    // One on its fallback, one with neither: both said.
    expect(row({ ...linux, shortcutsTaken: ["Control+Alt+M", "Control+Alt+E", "Control+Alt+Shift+E"] })?.detail).toBe(
      "Ctrl+Alt+M is taken by another app, so Mute microphone is Ctrl+Alt+Shift+M. Another app already uses Ctrl+Alt+E, Ctrl+Alt+Shift+E. Ember keeps trying to get them; meanwhile, click Ember's handle in the corner (it has Ask, Stop everything and Settings), or, from the keyboard, open Ember again from your apps for its settings.");
  });

  it("names each OS's own fallbacks", () => {
    const win = { ...linux, platform: "win32", windows: { build: 22631, elevated: false, session: "console" as const, powershell: "full" as const, dpiMixed: false }, shortcuts: SHORTCUTS.win32, shortcutsTaken: ["Super+Alt+Space"] };
    expect(row(win)?.detail).toMatch(/^Win\+Alt\+Space is taken by another app, so Ask Ember is Win\+Alt\+Shift\+Space\. Win\+Alt\+Shift\+Space ask · Win\+Alt\+X stop/);
  });

  it("is unchanged while Ember holds every default", () => {
    expect(row(linux)).toMatchObject({ status: "ok", detail: "Ctrl+Alt+Space ask · Ctrl+Alt+X stop · Ctrl+Alt+E settings · Ctrl+Alt+M microphone" });
  });
});

describe("the greeting names the chords Ember holds (D-45b)", () => {
  const sc = SHORTCUTS.linux, fb = FALLBACK_SHORTCUTS.linux;
  const line = (taken: string[]) => keysLine(heldShortcuts(sc, fb, taken), sc);

  it("names the defaults as before", () => {
    expect(line([])).toBe("Press Ctrl+Alt+Space to ask me anything; Ctrl+Alt+X stops me.");
  });

  it("names a fallback, and says which default another app has", () => {
    expect(line(["Control+Alt+Space"])).toBe("Press Ctrl+Alt+Shift+Space to ask me anything; Ctrl+Alt+X stops me. Another app has Ctrl+Alt+Space.");
    expect(line(["Control+Alt+Space", "Control+Alt+X"])).toBe("Press Ctrl+Alt+Shift+Space to ask me anything; Ctrl+Alt+Shift+X stops me. Another app has Ctrl+Alt+Space and Ctrl+Alt+X.");
  });

  it("keeps today's route when Ember holds neither chord, naming the settings chord it holds", () => {
    expect(line(["Control+Alt+Space", "Control+Alt+Shift+Space", "Control+Alt+E"])).toBe(
      "Click my handle in the corner to ask me something or to stop me, or press Ctrl+Alt+Shift+E: settings opens at Ask Ember… and Stop everything.");
    expect(line(["Control+Alt+X", "Control+Alt+Shift+X", "Control+Alt+E", "Control+Alt+Shift+E"])).toBe(
      "Click my handle in the corner to ask me something or to stop me, or open Ember again: its settings open at Ask Ember… and Stop everything.");
  });
});

/** main.ts without its comments, every run of white space made one space (it can't be loaded in a unit test). */
const MAIN = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\s+/g, " ");

describe("main.ts holds each shortcut by its default or its fallback, and names the one it holds (D-45b)", () => {
  it("registers Ember's shortcuts and the question keys through holdShortcuts with this OS's fallbacks", () => {
    expect(MAIN).toContain("const fb = FALLBACK_SHORTCUTS[platform.os];");
    expect(MAIN).toContain("holdShortcuts(ALWAYS_HELD, sc, fb, {");
    expect(MAIN).toContain("holdShortcuts(QUESTION_KEYS.map(k => k.id), sc, fb, {");
    // No accelerator is registered past it, but the menu's (never registered) and nothing else.
    expect(MAIN.match(/globalShortcut\.register\(/g)).toHaveLength(2);
  });

  it("names what it holds: the greeting, the handle menu, settings' keyboard route and the agent's and targets' words", () => {
    expect(MAIN).toContain("const holding = (id: ShortcutId): ShortcutDef | null => heldShortcuts(sc, fb, shortcutsTaken ?? [])[id];");
    expect(MAIN).toContain("const keys = keysLine(heldShortcuts(sc, fb, shortcutsTaken ?? []), sc);");
    expect(MAIN).toContain("settingsKey: keyName(\"settings\"),");
    expect(MAIN).toContain("keyboardRoute(shortcutsTaken ?? [], sc, fb)");
    expect(MAIN).not.toMatch(/hasKey\(/);
  });
});
