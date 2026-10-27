/**
 * Ember's shortcut table and each OS's key conventions (app/shared/shortcuts.ts) against the policy that reads them
 * (design §2.2, §2.4): every chord is the policy's own spelling of its accelerator and a key only the user presses,
 * the keys Ember presses itself are canonical, macOS refuses the whole Control+Shift+Command family, and Linux reads
 * keys exactly as before the port.
 */

import { describe, expect, it } from "vitest";
import { KEYS, SHORTCUTS, type OS, type ShortcutId } from "../../app/shared/shortcuts";
import { canonicalKeys, isSystemKey, keyTables } from "../../app/main/policy/policy";

const OSES: OS[] = ["linux", "win32", "darwin"];
const IDS: ShortcutId[] = ["ask", "stop", "settings", "mute", "allow", "deny"];
/** An Electron accelerator as a combination the policy reads ("Control+Shift+Command+Y" → "ctrl+shift+cmd+y"). */
const asCombo = (accel: string) => accel.split("+").map(p => ({ Control: "ctrl", Command: "cmd", Super: "super", Alt: "alt", Shift: "shift" } as Record<string, string>)[p] ?? p.toLowerCase()).join("+");

describe("the shortcut table", () => {
  it("names each chord as the policy spells its accelerator, and every chord is a key only the user presses (§2.4)", () => {
    for (const os of OSES) {
      for (const id of IDS) {
        const def = SHORTCUTS[os][id];
        expect(canonicalKeys(asCombo(def.accel), KEYS[os]), `${os} ${id}`).toBe(def.chord);
        expect(isSystemKey(def.chord, KEYS[os]), `${os} ${id}`).toBe(true);
      }
    }
  });

  it("keeps the Linux words Ember shows and says today (labels, the menu, question hints, the setup check)", () => {
    const sc = SHORTCUTS.linux;
    expect(sc.ask.label).toBe("Ctrl+Alt+Space");
    for (const id of IDS) expect(sc[id].accel.replace("Control", "Ctrl")).toBe(sc[id].label);
    expect(`${sc.allow.label} allow`).toBe("Ctrl+Alt+Y allow");
    expect(`${sc.deny.label} not now`).toBe("Ctrl+Alt+N not now");
    expect(`${sc.allow.say} to allow`).toBe("Control Alt Y to allow");
    expect(`${sc.deny.say} for not now`).toBe("Control Alt N for not now");
    expect(`${sc.ask.label} ask · ${sc.stop.label} stop · ${sc.settings.label} settings · ${sc.mute.label} microphone`)
      .toBe("Ctrl+Alt+Space ask · Ctrl+Alt+X stop · Ctrl+Alt+E settings · Ctrl+Alt+M microphone");
    expect(sc.settings.keys).toEqual(["Ctrl", "Alt", "E"]);
  });
});

describe("the keys Ember presses itself", () => {
  it("are today's exact strings on Linux and Windows (the worker's tests pin them)", () => {
    const today = { selectAll: "ctrl+a", paste: "ctrl+v", textEnd: "ctrl+End", sheetHome: "ctrl+Home", nameBox: "ctrl+shift+F5" };
    expect(KEYS.linux.edit).toEqual(today);
    expect(KEYS.win32.edit).toEqual(today);
  });

  it("are canonical on macOS, so the worker compares them as they are", () => {
    for (const k of Object.values(KEYS.darwin.edit)) expect(canonicalKeys(k, KEYS.darwin), k).toBe(k);
    expect(KEYS.darwin.edit.selectAll).toBe("cmd+a");
    expect(KEYS.darwin.edit.paste).toBe("cmd+v");
  });

  it("lists each OS's own system keys canonically, and each is refused there", () => {
    for (const os of OSES) {
      for (const k of KEYS[os].systemKeys) {
        expect(canonicalKeys(k, KEYS[os]), `${os} ${k}`).toBe(k);
        expect(isSystemKey(k, KEYS[os]), `${os} ${k}`).toBe(true);
      }
    }
  });
});

describe("macOS keys", () => {
  const mac = KEYS.darwin;
  it("reads ⌘ as the primary modifier, not the logo key", () => {
    expect(canonicalKeys("cmd+s", mac)).toBe("cmd+s");
    expect(canonicalKeys("Command+Shift+Z", mac)).toBe("shift+cmd+z");
    expect(canonicalKeys("option+left", mac)).toBe("alt+left");
    expect(canonicalKeys("win+s", mac)).toBe("cmd+s");
    expect(isSystemKey("cmd+s", mac)).toBe(false);
    expect(isSystemKey("cmd+space", mac)).toBe(true);
    expect(keyTables(mac).destructive.has("cmd+q")).toBe(true);
  });

  it("refuses the whole Control+Shift+Command family, whichever letter a layout puts there (L1)", () => {
    for (const k of ["ctrl+shift+cmd+z", "ctrl+alt+shift+cmd+y", "ctrl+shift+super+y", "ctrl+shift+meta+comma"]) {
      const c = canonicalKeys(k, mac);
      expect(c, k).not.toBeNull();
      expect(isSystemKey(c!, mac), k).toBe(true);
    }
    for (const letter of "abcdefghijklmnopqrstuvwxyz0123456789") expect(isSystemKey(`ctrl+shift+cmd+${letter}`, mac)).toBe(true);
    // Fewer modifiers than Ember's chords are ordinary shortcuts.
    expect(isSystemKey("shift+cmd+z", mac)).toBe(false);
    expect(isSystemKey("ctrl+cmd+z", mac)).toBe(false);
  });
});

describe("Windows keys", () => {
  const win = KEYS.win32;
  it("refuses the logo key, Task Manager and window switching, and Ember's Win+Alt family", () => {
    expect(isSystemKey("super+r", win)).toBe(true);
    expect(isSystemKey(canonicalKeys("win+r", win)!, win)).toBe(true);
    expect(isSystemKey("ctrl+shift+escape", win)).toBe(true);
    expect(isSystemKey("alt+tab", win)).toBe(true);
    expect(isSystemKey("alt+super+q", win)).toBe(true);
    expect(isSystemKey("ctrl+s", win)).toBe(false);
    expect(isSystemKey("alt+f4", win)).toBe(false);
  });

  it("learns no new spellings: \"option\" and \"mod\" still fail to parse", () => {
    expect(canonicalKeys("option+left", win)).toBeNull();
    expect(canonicalKeys("mod+s", win)).toBeNull();
    expect(canonicalKeys("cmd+s", win)).toBe("super+s");
  });
});

describe("Linux keys stay as they were", () => {
  it("parses no new spellings (mod, primary, cmdorctrl) and still reads cmd and win as the logo key", () => {
    expect(["mod+s", "primary+a", "cmdorctrl+v", "cmd+s", "win+r"].map(k => canonicalKeys(k))).toEqual([null, null, null, "super+s", "super+r"]);
    expect(["mod+s", "cmd+s"].map(k => canonicalKeys(k, KEYS.linux))).toEqual([null, "super+s"]);
  });

  it("gives today's isSystemKey answer for a frozen list of 40 combinations", () => {
    // From the code before the port: [combination, isSystemKey(canonicalKeys(combination))].
    const frozen: [string, boolean][] = [
      ["ctrl+s", false], ["Ctrl+Shift+T", false], ["alt+F4", false], ["ctrl+alt+t", true], ["ctrl+alt+delete", true], ["ctrl+alt+f2", true],
      ["alt+f2", true], ["alt+f1", true], ["Super_L", true], ["win+r", true], ["cmd+space", true], ["cmd+s", true], ["ctrl+alt+y", true],
      ["ctrl+alt+shift+y", true], ["ctrl+alt+space", true], ["ctrl+alt+x", true], ["ctrl+alt+e", true], ["ctrl+alt+m", true],
      ["ctrl+alt+n", true], ["ctrl+alt+end", true], ["ctrl+alt+a", true], ["ctrl+alt+l", true], ["ctrl+alt+left", true],
      ["ctrl+alt+backspace", true], ["Print", true], ["XF86AudioMute", true], ["meta+e", true], ["shift+super+s", true],
      ["ctrl+escape", false], ["ctrl+shift+escape", false], ["alt+tab", false], ["alt+space", false], ["ctrl+q", false],
      ["Return", false], ["ctrl+a", false], ["ctrl+v", false], ["ctrl+shift+F5", false], ["ctrl+shift+cmd+z", true],
      ["shift+cmd+3", true], ["ctrl+super+d", true],
    ];
    expect(frozen).toHaveLength(40);
    for (const [k, want] of frozen) {
      const c = canonicalKeys(k);
      expect(c, k).not.toBeNull();
      expect(isSystemKey(c!), k).toBe(want);
      expect(isSystemKey(c!, KEYS.linux), k).toBe(want);
    }
  });
});
