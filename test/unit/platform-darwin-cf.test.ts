/**
 * CoreFoundation and AX the JS way round, over stand-in raw functions: strings (with surrogate pairs and a cap that
 * never splits one), numbers, booleans, arrays and dictionaries by CFString key, the ownership rule (what is copied
 * is released once, even when the caller throws; what is borrowed is not), interned keys made once, exact 64-bit
 * hashes, and the AX helpers (failed copies, AXValue frames and errors, window ids without the private call, the
 * trust prompt's options).
 */

import { describe, expect, it } from "vitest";
import { hashHex, makeCF, pointerArray, utf16ToString } from "../../app/main/platform/darwin/cf";
import { AX_ERROR, AX_VALUE, axErrorName, decodeAXValue } from "../../app/main/platform/darwin/ax";
import { fakeAX, fakeCF } from "./platform-darwin-fakes";

describe("CoreFoundation values in JS", () => {
  it("reads strings, numbers, booleans and data, and says what each object is", () => {
    const f = fakeCF();
    const cf = makeCF(f.raw);
    const s = f.make({ t: "string", v: "TextEdit — notes 😀" }), n = f.make({ t: "number", v: 4242 }), b = f.make({ t: "boolean", v: false });
    const d = f.make({ t: "data", v: Buffer.from([1, 2, 3]) });
    expect(cf.string(s)).toBe("TextEdit — notes 😀");
    expect(cf.number(n)).toBe(4242);
    expect(cf.boolean(b)).toBe(false);
    expect(cf.data(d)).toEqual(Buffer.from([1, 2, 3]));
    expect([cf.kind(s), cf.kind(n), cf.kind(b), cf.kind(d), cf.kind(null)]).toEqual(["string", "number", "boolean", "data", null]);
  });

  it("answers null instead of misreading an object of another type", () => {
    const f = fakeCF();
    const cf = makeCF(f.raw);
    const n = f.make({ t: "number", v: 1 }), s = f.make({ t: "string", v: "1" });
    expect(cf.string(n)).toBeNull();
    expect(cf.number(s)).toBeNull();
    expect(cf.boolean(n)).toBeNull();
    expect(cf.array(s)).toEqual([]);
    expect(cf.get(s, "key")).toBeNull();
    expect(cf.string(null)).toBeNull();
  });

  it("caps a long string without splitting a surrogate pair", () => {
    const f = fakeCF();
    const cf = makeCF(f.raw);
    const s = f.make({ t: "string", v: "ab😀cd" });
    expect(cf.string(s, 3)).toBe("ab");
    expect(cf.string(s, 4)).toBe("ab😀");
    expect(cf.string(s, 0)).toBe("");
    expect(utf16ToString(Buffer.from("x\ud83d", "utf16le"))).toBe("x");
  });

  it("looks dictionary values up by CFString key, creating each key once for the process", () => {
    const f = fakeCF();
    const cf = makeCF(f.raw);
    const key = f.make({ t: "string", v: "kCGWindowLayer" }), val = f.make({ t: "number", v: 0 });
    const dict = f.make({ t: "dictionary", v: [[key, val]] });
    expect(cf.number(cf.get(dict, "kCGWindowLayer"))).toBe(0);
    expect(cf.get(dict, "kCGWindowAlpha")).toBeNull();
    cf.get(dict, "kCGWindowLayer");
    expect(f.created.map(r => (f.objects.get(r) as { v: string }).v)).toEqual(["kCGWindowLayer", "kCGWindowAlpha"]);
    expect(f.released).toEqual([]); // borrowed values and interned keys are never released
  });

  it("borrows an array's values without releasing them", () => {
    const f = fakeCF();
    const cf = makeCF(f.raw);
    const a = f.make({ t: "string", v: "a" }), b = f.make({ t: "string", v: "b" });
    const arr = f.make({ t: "array", v: [a, b] });
    expect(cf.array(arr).map(r => cf.string(r))).toEqual(["a", "b"]);
    expect(f.released).toEqual([]);
  });

  it("releases an owned object exactly once, also when the callback throws", () => {
    const f = fakeCF();
    const cf = makeCF(f.raw);
    const s = f.make({ t: "string", v: "x" });
    expect(cf.own(s, r => cf.string(r))).toBe("x");
    expect(f.released).toEqual([s]);
    const t = f.make({ t: "string", v: "y" });
    expect(() => cf.own(t, () => { throw new Error("boom"); })).toThrow("boom");
    expect(f.released).toEqual([s, t]);
    expect(cf.own(null, () => 1)).toBeNull();
    cf.release(null);
    expect(f.released).toHaveLength(2);
  });

  it("creates numbers, strings, arrays and dictionaries with the right types and callbacks", () => {
    const f = fakeCF();
    const cf = makeCF(f.raw);
    expect(f.get(cf.createNumber(7)!)).toEqual({ t: "number", v: 7 });
    expect(f.get(cf.createNumber(0.25)!)).toEqual({ t: "number", v: 0.25 });
    expect(cf.string(cf.createString("Ünïcode 😀"))).toBe("Ünïcode 😀");
    const a = cf.createString("a")!, b = cf.createString("b")!;
    expect(cf.array(cf.createArray([a, b])).map(r => cf.string(r))).toEqual(["a", "b"]);
    const dict = cf.createDictionary([[a, cf.kTrue!]])!;
    expect(cf.boolean(cf.raw.CFDictionaryGetValue(dict, a))).toBe(true);
    expect(pointerArray([1n, 2n]).readBigUInt64LE(8)).toBe(2n);
    expect(pointerArray([]).length).toBe(8);
  });

  it("gives CFHash as the exact unsigned 64-bit value, so elements above 2^53 never share a key (M8)", () => {
    const f = fakeCF();
    const a = 0xfedc_ba98_7654_3211n, b = 0xfedc_ba98_7654_3210n;
    // Number() would round these two together.
    expect(Number(a)).toBe(Number(b));
    f.raw.CFHash = ref => (ref % 0x20n === 0n ? a : b); // the fake's objects sit 0x10 apart
    const cf = makeCF(f.raw);
    const x = f.make({ t: "string", v: "x" }), y = f.make({ t: "string", v: "y" });
    expect([cf.hash(x), cf.hash(y)].sort()).toEqual(["fedcba9876543210", "fedcba9876543211"]);
    expect(cf.hash(null)).toBe("0");
    expect(hashHex(4242)).toBe("1092");
    expect(hashHex(Number.MAX_SAFE_INTEGER)).toBe("1fffffffffffff");
    expect(hashHex(-1n)).toBe("ffffffffffffffff"); // a signed reading still names the same 64 bits
  });
});

describe("the AX helpers", () => {
  it("reads a window's title and frame, releasing every copied value", () => {
    const { f, ax, element } = fakeAX();
    const win = element("window");
    expect(ax.string(win, "AXTitle")).toBe("notes.txt");
    expect(ax.frame(win)).toEqual({ x: 100, y: 120, width: 600, height: 400 });
    // The title string and both AXValues were released; the window element itself was never touched.
    expect(f.released.map(r => f.objects.get(r)!.t)).toEqual(["string", "axvalue", "axvalue"]);
  });

  it("returns nothing for a failed copy", () => {
    const { ax, element, f } = fakeAX({ failCopy: true });
    expect(ax.copy(element("window"), "AXTitle")).toEqual({ error: AX_ERROR.attributeUnsupported, value: null });
    expect(ax.frame(element("window"))).toBeNull();
    expect(ax.withElements(element("app"), "AXWindows", items => items.length)).toBeNull();
    expect(f.released).toEqual([]);
  });

  it("lends an array attribute's elements for a call, then releases the array", () => {
    const { ax, element, f } = fakeAX();
    expect(ax.withElements(element("app"), "AXWindows", items => items.map(w => ax.windowId(w)))).toEqual([101]);
    expect(f.released.map(r => f.objects.get(r)!.t)).toEqual(["array"]);
  });

  it("gives a window id only through _AXUIElementGetWindow, else 0", () => {
    expect(fakeAX().ax.hasWindowIds).toBe(true);
    const { ax, element } = fakeAX({ windowIds: false });
    expect(ax.hasWindowIds).toBe(false);
    expect(ax.windowId(element("window"))).toBe(0);
  });

  it("creates each application element, reads pids and names, and hit-tests with the coordinates given", () => {
    const { ax, calls, element, cf } = fakeAX();
    expect(ax.application(0)).toBeNull();
    const app = ax.application(500)!;
    expect(ax.pid(app)).toBe(500);
    expect(ax.attributeNames(app)).toEqual(["AXTitle"]);
    cf.release(ax.elementAt(element("system"), 10.5, 20));
    expect(calls).toEqual(["app 500", "at 10.5,20"]);
  });

  it("asks for trust with the prompt option only when told to, and releases the options", () => {
    const { ax, calls, f } = fakeAX();
    expect(ax.trusted()).toBe(true);
    expect(calls).toEqual([]);
    expect(ax.trusted(true)).toBe(true);
    expect(calls).toEqual(["trusted? AXTrustedCheckOptionPrompt=true"]);
    expect(f.released.map(r => f.objects.get(r)!.t)).toEqual(["dictionary"]);
  });

  it("sets attributes and performs actions by name", () => {
    const { ax, cf, element, calls } = fakeAX();
    ax.set(element("app"), "AXFrontmost", cf.kTrue!);
    ax.perform(element("window"), "AXRaise");
    expect(calls).toEqual(["set AXFrontmost=true", "perform AXRaise"]);
  });
});

describe("AXValue decoding and error names", () => {
  it("decodes points, sizes, rects and ranges", () => {
    const buf = Buffer.alloc(32);
    [1, 2, 3, 4].forEach((n, i) => buf.writeDoubleLE(n, i * 8));
    expect(decodeAXValue(AX_VALUE.cgPoint, buf)).toEqual({ type: "point", x: 1, y: 2 });
    expect(decodeAXValue(AX_VALUE.cgSize, buf)).toEqual({ type: "size", width: 1, height: 2 });
    expect(decodeAXValue(AX_VALUE.cgRect, buf)).toEqual({ type: "rect", x: 1, y: 2, width: 3, height: 4 });
    const range = Buffer.alloc(32);
    range.writeBigInt64LE(5n, 0);
    range.writeBigInt64LE(7n, 8);
    expect(decodeAXValue(AX_VALUE.cfRange, range)).toEqual({ type: "range", location: 5, length: 7 });
    expect(decodeAXValue(99, buf)).toBeNull();
    buf.writeDoubleLE(NaN, 0);
    expect(decodeAXValue(AX_VALUE.cgPoint, buf)).toBeNull();
    expect(decodeAXValue(AX_VALUE.cgPoint, Buffer.alloc(8))).toBeNull();
  });
  it("decodes an AXError slot as that error, not as an absent value (M9)", () => {
    const err = Buffer.alloc(32);
    err.writeInt32LE(AX_ERROR.cannotComplete, 0);
    expect(decodeAXValue(AX_VALUE.axError, err)).toEqual({ type: "error", code: -25204 });
    expect(decodeAXValue(AX_VALUE.axError, Buffer.from([0x24, 0x9d, 0xff, 0xff]))).toEqual({ type: "error", code: -25308 });
    expect(decodeAXValue(AX_VALUE.axError, Buffer.alloc(3))).toBeNull();
  });

  it("decodes a value already in hand (a batched read's slot) without releasing it", () => {
    const { f, ax, axValue } = fakeAX();
    const busy = axValue(AX_VALUE.axError, AX_ERROR.cannotComplete), none = axValue(AX_VALUE.axError, AX_ERROR.noValue);
    const point = axValue(AX_VALUE.cgPoint, 3, 4), text = f.make({ t: "string", v: "Save" });
    expect(ax.decode(busy)).toEqual({ type: "error", code: AX_ERROR.cannotComplete });
    expect(ax.decode(none)).toEqual({ type: "error", code: AX_ERROR.noValue });
    expect(ax.decode(point)).toEqual({ type: "point", x: 3, y: 4 });
    expect([ax.decode(text), ax.decode(null)]).toEqual([null, null]);
    expect(f.released).toEqual([]);
  });

  it("names AX errors for the log", () => {
    expect(axErrorName(-25204)).toBe("cannotComplete");
    expect(axErrorName(-25211)).toBe("apiDisabled");
    expect(axErrorName(1)).toBe("1");
  });
});
