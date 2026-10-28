/**
 * The "system keys" never-rule on Linux with a multi-layout keyboard (review #115): Ember's keyboard finds a keysym of
 * another layout group on its physical key (hands/keymap.ts searches layout.others), so Ctrl+Alt+Cyrillic_ie lands on
 * the T key and opens a terminal, and Ctrl+Alt+gbreve lands on E (Ember's own settings chord) on a us,tr(f) keyboard.
 * With Ctrl and Alt held, a key the rules can't judge by its Latin name is refused as a system key. Ctrl or Alt alone
 * reach no system key but F1 and F2, so those are judged as before (an Alt access key in a Russian app is asked about).
 */

import { describe, expect, it } from "vitest";
import { canonicalKeys, isSystemKey, PolicyEngine } from "../../app/main/policy/policy";
import { KEYS } from "../../app/shared/shortcuts";

const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ firefox: "act" }), os: "linux" });
const press = (value: string) => e.decide({ taskId: "t", kind: "keys", app: "firefox", window: "Page", value, element: { role: "document web", name: "page" } });
const system = (keys: string, kc = KEYS.linux) => { const c = canonicalKeys(keys, kc); return c !== null && isSystemKey(c, kc); };

describe("Ctrl+Alt with a key not named in Latin on Linux", () => {
  it("refuses keys named in another script (they can land on Ctrl+Alt+T, or on Ember's own Allow)", () => {
    for (const k of ["ctrl+alt+Cyrillic_ie", "ctrl+alt+Cyrillic_en", "ctrl+alt+Greek_tau", "ctrl+alt+Hebrew_alef", "ctrl+alt+hebrew_aleph", "ctrl+alt+Arabic_alef",
      "ctrl+alt+Ukrainian_i", "ctrl+alt+Thai_kokai", "ctrl+alt+Armenian_ben", "ctrl+alt+Georgian_an", "ctrl+alt+kana_A", "ctrl+alt+Hangul_A", "ctrl+alt+Serbian_dje",
      "ctrl+alt+Macedonia_gje", "ctrl+alt+Byelorussian_shortu", "ctrl+alt+е", "ctrl+alt+τ", "ctrl+alt+shift+Cyrillic_ie"]) {
      expect(system(k), k).toBe(true);
      expect(press(k).verdict, k).toBe("deny");
    }
  });

  it("refuses Latin letters with an accent too (ğ is on E on a us,tr(f) keyboard, ö on X)", () => {
    for (const k of ["ctrl+alt+gbreve", "ctrl+alt+odiaeresis", "ctrl+alt+eacute", "ctrl+alt+é", "ctrl+alt+ccedilla", "ctrl+alt+ssharp", "ctrl+alt+dead_acute",
      "ctrl+alt+ISO_Level3_Shift", "ctrl+alt+Multi_key"]) {
      expect(system(k), k).toBe(true);
      expect(press(k).verdict, k).toBe("deny");
    }
  });

  it("still asks about ASCII letters and digits, and keys named for moving, editing, functions and punctuation", () => {
    for (const k of ["ctrl+alt+b", "ctrl+alt+shift+b", "ctrl+alt+1", "ctrl+alt+KP_5", "ctrl+alt+minus", "ctrl+alt+KP_Add", "ctrl+alt+bracketleft", "ctrl+alt+question",
      "ctrl+alt+Home", "ctrl+alt+Page_Up", "ctrl+alt+Prior", "ctrl+alt+Insert", "ctrl+alt+Return", "ctrl+alt+Escape", "ctrl+alt+Menu", "ctrl+alt+Shift_L", "ctrl+alt+Caps_Lock"]) {
      expect(system(k), k).toBe(false);
      expect(press(k).verdict, k).toBe("confirm");
    }
    for (const k of ["ctrl+alt+t", "ctrl+alt+y", "ctrl+alt+e", "ctrl+alt+x", "ctrl+alt+F13"]) expect(system(k), k).toBe(true);
  });

  it("judges Ctrl or Alt alone as before (no system key is reached that way but F1 and F2)", () => {
    for (const k of ["ctrl+Cyrillic_es", "alt+Cyrillic_ie", "alt+Cyrillic_ef", "ctrl+shift+Greek_tau", "alt+Greek_tau", "alt+н", "ctrl+é", "ctrl+odiaeresis"]) {
      expect(system(k), k).toBe(false);
      expect(press(k).verdict, k).toBe("confirm");
    }
    expect(system("alt+F2")).toBe(true);
  });

  it("leaves plain keys in another script and the other OSes as they were", () => {
    for (const k of ["ctrl+c", "alt+Left", "Cyrillic_ie", "shift+Greek_tau", "е"]) expect(system(k), k).toBe(false);
    expect(system("ctrl+alt+Cyrillic_ie", KEYS.win32)).toBe(false);
    expect(system("ctrl+alt+gbreve", KEYS.win32)).toBe(false);
    expect(system("ctrl+Cyrillic_ie", KEYS.darwin)).toBe(false);
  });
});
