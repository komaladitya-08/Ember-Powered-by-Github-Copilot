/**
 * The "system keys" never-rule on Linux with a multi-layout keyboard (review #115): Ember's keyboard finds a keysym of
 * another layout group on its physical key (hands/keymap.ts searches layout.others), so Ctrl+Alt+Cyrillic_ie lands on
 * the T key and opens a terminal. A key named in another script, with Ctrl or Alt held, is refused as a system key;
 * Latin names and the other OSes are judged as before.
 */

import { describe, expect, it } from "vitest";
import { canonicalKeys, isSystemKey, PolicyEngine } from "../../app/main/policy/policy";
import { KEYS } from "../../app/shared/shortcuts";

const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ firefox: "act" }), os: "linux" });
const press = (value: string) => e.decide({ taskId: "t", kind: "keys", app: "firefox", window: "Page", value, element: { role: "document web", name: "page" } });
const system = (keys: string, kc = KEYS.linux) => { const c = canonicalKeys(keys, kc); return c !== null && isSystemKey(c, kc); };

describe("keys named in another script on Linux", () => {
  it("refuses them with Ctrl and Alt (they can land on Ctrl+Alt+T, or on Ember's own Allow)", () => {
    for (const k of ["ctrl+alt+Cyrillic_ie", "ctrl+alt+Cyrillic_en", "ctrl+alt+Greek_tau", "ctrl+alt+Hebrew_alef", "ctrl+alt+hebrew_aleph", "ctrl+alt+Arabic_alef",
      "ctrl+alt+Ukrainian_i", "ctrl+alt+Thai_kokai", "ctrl+alt+Armenian_ben", "ctrl+alt+Georgian_an", "ctrl+alt+kana_A", "ctrl+alt+Hangul_A", "ctrl+alt+Serbian_dje",
      "ctrl+alt+Macedonia_gje", "ctrl+alt+Byelorussian_shortu", "ctrl+alt+е", "ctrl+alt+τ"]) {
      expect(system(k), k).toBe(true);
      expect(press(k).verdict, k).toBe("deny");
    }
  });

  it("refuses them with Ctrl or Alt alone too", () => {
    for (const k of ["ctrl+Cyrillic_es", "alt+Cyrillic_ie", "ctrl+shift+Greek_tau", "alt+н"]) expect(system(k), k).toBe(true);
  });

  it("leaves Latin keys, plain keys in another script and the other OSes as they were", () => {
    for (const k of ["ctrl+alt+t", "ctrl+alt+y"]) expect(system(k), k).toBe(true);
    for (const k of ["ctrl+alt+eacute", "ctrl+c", "ctrl+odiaeresis", "alt+Left", "ctrl+alt+b", "Cyrillic_ie", "shift+Greek_tau", "е"]) expect(system(k), k).toBe(false);
    expect(system("ctrl+alt+Cyrillic_ie", KEYS.win32)).toBe(false);
    expect(system("ctrl+Cyrillic_ie", KEYS.darwin)).toBe(false);
  });
});
