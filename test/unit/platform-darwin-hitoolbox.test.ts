/**
 * The Carbon-era bindings over stand-in raw functions: secure input bound on its own, so a macOS that moves one
 * layout symbol can't switch the secure-input check off (null, "can't tell", where its own symbol is missing); the
 * input source told apart from an input method, only on the main thread; GetKeys' KeyMap; and the layout, which
 * needs its four functions together.
 */

import { describe, expect, it } from "vitest";
import { makeCF, type Ref } from "../../app/main/platform/darwin/cf";
import { KEY_MAP_BYTES, TIS_TYPE_KEYBOARD_LAYOUT, makeHIToolbox, type HIRaw } from "../../app/main/platform/darwin/hitoolbox";
import { fakeCF } from "./platform-darwin-fakes";

/** A pretend HIToolbox: an input source of a given type, a layout whose A key types "q", and a key map. */
function fakeHI(o: { type?: string; omit?: (keyof HIRaw)[]; secure?: boolean; keys?: number[] } = {}) {
  const f = fakeCF();
  const cf = makeCF(f.raw);
  const constant = (v: string) => f.make({ t: "string", v });
  const typeKey = constant("TISPropertyInputSourceType"), layoutKey = constant("TISPropertyUnicodeKeyLayoutData");
  const layoutType = constant(TIS_TYPE_KEYBOARD_LAYOUT);
  const sources: Ref[] = [];
  const typeValues: Ref[] = [];
  const source = () => {
    const ref = f.make({ t: "element", v: "source" });
    sources.push(ref);
    return ref;
  };
  const raw: HIRaw = {
    TISCopyCurrentKeyboardLayoutInputSource: source,
    TISCopyCurrentKeyboardInputSource: source,
    TISGetInputSourceProperty: (_source, key) => {
      if (key === typeKey) {
        const v = constant(o.type ?? TIS_TYPE_KEYBOARD_LAYOUT);
        typeValues.push(v);
        return v;
      }
      return key === layoutKey ? f.make({ t: "data", v: Buffer.from("uchr") }) : null;
    },
    LMGetKbdType: () => 40,
    IsSecureEventInputEnabled: () => o.secure ?? false,
    GetKeys: map => { for (const k of o.keys ?? []) map[k >> 3]! |= 1 << (k & 7); },
    UCKeyTranslate: (_layout, code, _action, _mods, _type, _options, _dead, _max, length, chars) => {
      length[0] = code === 0 ? 1 : 0;
      if (code === 0) chars.write("q", "utf16le");
      return 0;
    },
    kTISPropertyUnicodeKeyLayoutData: layoutKey,
    kTISPropertyInputSourceType: typeKey,
    kTISTypeKeyboardLayout: layoutType,
  };
  for (const name of o.omit ?? []) delete (raw as unknown as Record<string, unknown>)[name];
  return { f, cf, raw, sources, typeValues };
}

describe("secure keyboard entry on macOS (M18)", () => {
  it("answers whatever IsSecureEventInputEnabled says", () => {
    const on = fakeHI({ secure: true });
    expect(makeHIToolbox(on.raw, on.cf).secureInput()).toBe(true);
    const off = fakeHI({ secure: false });
    expect(makeHIToolbox(off.raw, off.cf).secureInput()).toBe(false);
  });

  it("still answers when a layout function is missing: the check is bound on its own", () => {
    const { raw, cf } = fakeHI({ secure: true, omit: ["UCKeyTranslate", "LMGetKbdType"] });
    const hi = makeHIToolbox(raw, cf);
    expect(hi.secureInput()).toBe(true);
    expect(hi.keyboardLayout(null)).toBeNull();
  });

  it("can't tell (null) when IsSecureEventInputEnabled itself is missing, so callers fail closed", () => {
    const { raw, cf } = fakeHI({ omit: ["IsSecureEventInputEnabled"] });
    expect(makeHIToolbox(raw, cf).secureInput()).toBeNull();
  });
});

describe("the input source on macOS (M16)", () => {
  it("tells a keyboard layout from an input method, releasing the source it copied but not the type it borrowed", () => {
    const layout = fakeHI();
    expect(makeHIToolbox(layout.raw, layout.cf, true).inputSourceIsLayout()).toBe(true);
    expect(layout.f.released).toEqual(layout.sources);
    expect(layout.typeValues.every(v => layout.f.counts.get(v) === 1)).toBe(true);
    const ime = fakeHI({ type: "TISTypeKeyboardInputMode" });
    expect(makeHIToolbox(ime.raw, ime.cf, true).inputSourceIsLayout()).toBe(false);
    const palette = fakeHI({ type: "TISTypeCharacterPalette" });
    expect(makeHIToolbox(palette.raw, palette.cf, true).inputSourceIsLayout()).toBe(false);
  });

  it("compares with the constant's documented value when kTISTypeKeyboardLayout can't be read", () => {
    const layout = fakeHI();
    expect(makeHIToolbox({ ...layout.raw, kTISTypeKeyboardLayout: null }, layout.cf, true).inputSourceIsLayout()).toBe(true);
    const ime = fakeHI({ type: "TISTypeKeyboardInputMode" });
    expect(makeHIToolbox({ ...ime.raw, kTISTypeKeyboardLayout: null }, ime.cf, true).inputSourceIsLayout()).toBe(false);
  });

  it("can't tell off the main thread (TIS aborts the process there) or without its symbols", () => {
    const off = fakeHI();
    expect(makeHIToolbox(off.raw, off.cf, false).inputSourceIsLayout()).toBeNull();
    expect(off.sources).toEqual([]);
    const missing = fakeHI({ omit: ["TISCopyCurrentKeyboardInputSource"] });
    expect(makeHIToolbox(missing.raw, missing.cf, true).inputSourceIsLayout()).toBeNull();
    const noKey = fakeHI();
    expect(makeHIToolbox({ ...noKey.raw, kTISPropertyInputSourceType: null }, noKey.cf, true).inputSourceIsLayout()).toBeNull();
  });
});

describe("every key's state in one call on macOS (M11)", () => {
  it("fills GetKeys' 16-byte KeyMap", () => {
    const { raw, cf } = fakeHI({ keys: [0, 0x38, 0x69] });
    const map = makeHIToolbox(raw, cf).keyMap()!;
    expect(map.length).toBe(KEY_MAP_BYTES);
    expect([map[0], map[7], map[13]]).toEqual([1, 1, 2]);
  });

  it("has no KeyMap where GetKeys isn't exported", () => {
    const { raw, cf } = fakeHI({ omit: ["GetKeys"] });
    expect(makeHIToolbox(raw, cf).keyMap()).toBeNull();
  });
});

describe("the keyboard layout on macOS", () => {
  it("translates keys with all four functions, and reuses the layout while the source is the same", () => {
    const { raw, cf, f } = fakeHI();
    f.raw.CFEqual = () => true; // the same input source again
    const hi = makeHIToolbox(raw, cf, true);
    const layout = hi.keyboardLayout(null)!;
    expect(layout.translate(0, 0)).toBe("q");
    expect(layout.translate(1, 0)).toBe("");
    expect(hi.keyboardLayout(layout)).toBe(layout);
  });

  it("gives no layout off the main thread", () => {
    const { raw, cf } = fakeHI();
    expect(makeHIToolbox(raw, cf, false).keyboardLayout(null)).toBeNull();
  });
});
