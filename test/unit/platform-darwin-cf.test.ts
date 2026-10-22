/**
 * CoreFoundation and AX the JS way round, over stand-in raw functions: strings (with surrogate pairs and a cap that
 * never splits one), numbers, booleans, arrays and dictionaries by CFString key, the ownership rule (what is copied
 * is released once, even when the caller throws; what is borrowed is not), interned keys made once, and the AX helpers
 * (failed copies, AXValue frames, window ids without the private call, the trust prompt's options).
 */

import { describe, expect, it } from "vitest";
import { makeCF, pointerArray, utf16ToString, type CFRaw, type Ref } from "../../app/main/platform/darwin/cf";
import { AX_ERROR, AX_VALUE, axErrorName, decodeAXValue, makeAX, type AXRaw } from "../../app/main/platform/darwin/ax";
import type { CGRaw, CGRect } from "../../app/main/platform/darwin/cg";
import { makeDesktop } from "../../app/main/platform/darwin/desktop";

type Obj =
  | { t: "string"; v: string }
  | { t: "number"; v: number }
  | { t: "boolean"; v: boolean }
  | { t: "array"; v: Ref[] }
  | { t: "dictionary"; v: [Ref, Ref][] }
  | { t: "data"; v: Buffer }
  | { t: "element"; v: string }
  | { t: "axvalue"; type: number; v: number[] };

const TYPE_IDS: Record<Obj["t"], number> = { string: 7, number: 22, boolean: 21, array: 19, dictionary: 18, data: 20, element: 100, axvalue: 101 };

/** A pretend CoreFoundation: objects in a table, reference counts, and a log of releases. */
function fakeCF() {
  const objects = new Map<Ref, Obj>();
  const counts = new Map<Ref, number>();
  const released: Ref[] = [];
  let next = 0x1000n;
  const make = (o: Obj): Ref => {
    const ref = (next += 0x10n);
    objects.set(ref, o);
    counts.set(ref, 1);
    return ref;
  };
  const get = (ref: Ref) => {
    const o = objects.get(ref);
    if (!o || (counts.get(ref) ?? 0) <= 0) throw new Error(`use of a released or unknown object ${ref}`);
    return o;
  };
  const readPointers = (buf: Buffer, n: number) => Array.from({ length: n }, (_, i) => buf.readBigUInt64LE(i * 8));
  const created: Ref[] = [];
  const kTrue = make({ t: "boolean", v: true }), kFalse = make({ t: "boolean", v: false });
  const raw: CFRaw = {
    CFRelease: ref => {
      get(ref);
      released.push(ref);
      counts.set(ref, counts.get(ref)! - 1);
    },
    CFRetain: ref => (get(ref), counts.set(ref, counts.get(ref)! + 1), ref),
    CFGetTypeID: ref => TYPE_IDS[get(ref).t],
    CFEqual: (a, b) => JSON.stringify(get(a)) === JSON.stringify(get(b)),
    CFHash: ref => Number(ref % 997n),
    CFStringGetTypeID: () => 7, CFNumberGetTypeID: () => 22, CFBooleanGetTypeID: () => 21,
    CFArrayGetTypeID: () => 19, CFDictionaryGetTypeID: () => 18, CFDataGetTypeID: () => 20,
    CFStringGetLength: ref => (get(ref) as { v: string }).v.length,
    CFStringGetCharacters: (ref, range, buf) => { buf.write((get(ref) as { v: string }).v.slice(range.location, range.location + range.length), "utf16le"); },
    CFStringCreateWithCharacters: (_a, chars, n) => { const r = make({ t: "string", v: chars.toString("utf16le", 0, n * 2) }); created.push(r); return r; },
    CFNumberGetValue: (ref, type, out) => { expect(type).toBe(6); out[0] = (get(ref) as { v: number }).v; return true; },
    CFNumberCreate: (_a, type, value) => make({ t: "number", v: type === 4 ? Number(value.readBigInt64LE()) : value.readDoubleLE() }),
    CFBooleanGetValue: ref => (get(ref) as { v: boolean }).v,
    CFArrayGetCount: ref => (get(ref) as { v: Ref[] }).v.length,
    CFArrayGetValueAtIndex: (ref, i) => (get(ref) as { v: Ref[] }).v[i] ?? null,
    CFArrayCreate: (_a, values, n, callbacks) => { expect(callbacks).toBe(0xa1n); return make({ t: "array", v: readPointers(values, n) }); },
    CFDictionaryGetValue: (ref, key) => {
      const want = get(key);
      return (get(ref) as { v: [Ref, Ref][] }).v.find(([k]) => JSON.stringify(get(k)) === JSON.stringify(want))?.[1] ?? null;
    },
    CFDictionaryCreate: (_a, keys, values, n, kcb, vcb) => {
      expect([kcb, vcb]).toEqual([0xa2n, 0xa3n]);
      const ks = readPointers(keys, n), vs = readPointers(values, n);
      return make({ t: "dictionary", v: ks.map((k, i) => [k, vs[i]!]) });
    },
    CFDataGetLength: ref => (get(ref) as { v: Buffer }).v.length,
    CFDataGetBytePtr: ref => ref + 1n,
    kCFBooleanTrue: kTrue, kCFBooleanFalse: kFalse,
    arrayCallBacks: 0xa1n, dictionaryKeyCallBacks: 0xa2n, dictionaryValueCallBacks: 0xa3n,
    copyBytes: (ptr, n) => Buffer.from((get(ptr - 1n) as { v: Buffer }).v.subarray(0, n)),
  };
  return { raw, make, objects, counts, released, created, get };
}

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
});

/** A pretend AX API over the pretend CoreFoundation: one app (pid 500) with a focused window. */
function fakeAX(o: { windowIds?: boolean; failCopy?: boolean } = {}) {
  const f = fakeCF();
  const cf = makeCF(f.raw);
  const calls: string[] = [];
  const elements = new Map<string, Ref>();
  const element = (name: string) => elements.get(name) ?? (elements.set(name, f.make({ t: "element", v: name })), elements.get(name)!);
  const axValue = (type: number, ...v: number[]) => f.make({ t: "axvalue", type, v });
  const prompt = f.make({ t: "string", v: "AXTrustedCheckOptionPrompt" });
  const attrs: Record<string, Record<string, () => Ref>> = {
    window: {
      AXTitle: () => f.make({ t: "string", v: "notes.txt" }),
      AXPosition: () => axValue(AX_VALUE.cgPoint, 100, 120),
      AXSize: () => axValue(AX_VALUE.cgSize, 600, 400),
    },
    app: {
      AXFocusedWindow: () => (f.raw.CFRetain(element("window")), element("window")),
      AXWindows: () => f.make({ t: "array", v: [element("window")] }),
    },
  };
  const raw: AXRaw = {
    AXUIElementCreateSystemWide: () => element("system"),
    AXUIElementCreateApplication: pid => (calls.push(`app ${pid}`), f.make({ t: "element", v: "app" })),
    AXUIElementCopyAttributeValue: (el, attr, out) => {
      const name = (f.get(attr) as { v: string }).v;
      const make = attrs[(f.get(el) as { v: string }).v]?.[name];
      if (o.failCopy || !make) return AX_ERROR.attributeUnsupported;
      out[0] = make();
      return AX_ERROR.success;
    },
    AXUIElementCopyAttributeNames: (_el, out) => { out[0] = f.make({ t: "array", v: [f.make({ t: "string", v: "AXTitle" })] }); return 0; },
    AXUIElementSetAttributeValue: (_el, attr, value) => (calls.push(`set ${(f.get(attr) as { v: string }).v}=${String(cf.boolean(value))}`), 0),
    AXUIElementPerformAction: (_el, action) => (calls.push(`perform ${(f.get(action) as { v: string }).v}`), 0),
    AXUIElementGetPid: (_el, pid) => { pid[0] = 500; return 0; },
    AXUIElementSetMessagingTimeout: (_el, s) => (calls.push(`timeout ${s}`), 0),
    AXUIElementCopyElementAtPosition: (_app, x, y, out) => { calls.push(`at ${x},${y}`); out[0] = element("window"); f.raw.CFRetain(element("window")); return 0; },
    AXUIElementGetTypeID: () => 100,
    AXValueGetTypeID: () => 101,
    AXValueGetType: v => (f.get(v) as { type: number }).type,
    AXValueGetValue: (v, type, out) => {
      const val = f.get(v) as { type: number; v: number[] };
      if (val.type !== type) return false;
      val.v.forEach((n, i) => out.writeDoubleLE(n, i * 8));
      return true;
    },
    AXIsProcessTrusted: () => true,
    AXIsProcessTrustedWithOptions: options => {
      const entries = (f.get(options!) as { v: [Ref, Ref][] }).v;
      calls.push(`trusted? ${entries.map(([k, v]) => `${(f.get(k) as { v: string }).v}=${String(cf.boolean(v))}`).join(",")}`);
      return true;
    },
    _AXUIElementGetWindow: o.windowIds === false ? undefined : (_el, out) => { out[0] = 101; return 0; },
    kAXTrustedCheckOptionPrompt: prompt,
  };
  return { f, cf, ax: makeAX(raw, cf), calls, element };
}

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
    expect(decodeAXValue(AX_VALUE.axError, buf)).toBeNull();
    buf.writeDoubleLE(NaN, 0);
    expect(decodeAXValue(AX_VALUE.cgPoint, buf)).toBeNull();
    expect(decodeAXValue(AX_VALUE.cgPoint, Buffer.alloc(8))).toBeNull();
  });
  it("names AX errors for the log", () => {
    expect(axErrorName(-25204)).toBe("cannotComplete");
    expect(axErrorName(-25211)).toBe("apiDisabled");
    expect(axErrorName(1)).toBe("1");
  });
});

/** CoreGraphics as far as the desktop's window list and session reads go, over the pretend CoreFoundation. */
function fakeCG(f: ReturnType<typeof fakeCF>, o: { windows: Record<string, unknown>[]; session?: Record<string, unknown> | null }) {
  const value = (v: unknown): Ref => (typeof v === "string" ? f.make({ t: "string", v })
    : typeof v === "boolean" ? f.make({ t: "boolean", v })
    : typeof v === "number" ? f.make({ t: "number", v })
    : f.make({ t: "dictionary", v: Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => [value(k), value(x)]) }));
  const field = (dict: Ref, key: string) => {
    const pair = (f.get(dict) as { v: [Ref, Ref][] }).v.find(([k]) => (f.get(k) as { v: string }).v === key);
    return pair ? (f.get(pair[1]) as { v: number }).v : undefined;
  };
  const lists: Ref[] = [];
  const cg = {
    CGWindowListCopyWindowInfo: (option: number, relativeTo: number) => {
      expect([option, relativeTo]).toEqual([17, 0]); // on screen only, no desktop elements, every window
      const list = f.make({ t: "array", v: o.windows.map(value) });
      lists.push(list);
      return list;
    },
    CGRectMakeWithDictionaryRepresentation: (dict: Ref, out: Partial<CGRect>) => {
      const [x, y, width, height] = ["X", "Y", "Width", "Height"].map(k => field(dict, k));
      if ([x, y, width, height].some(n => n === undefined)) return false;
      out.origin = { x: x!, y: y! };
      out.size = { width: width!, height: height! };
      return true;
    },
    CGSessionCopyCurrentDictionary: () => (o.session ? value(o.session) : null),
  } as unknown as CGRaw;
  return { cg, lists };
}

describe("the macOS desktop over stand-in frameworks", () => {
  const textEdit = {
    kCGWindowNumber: 101, kCGWindowOwnerPID: 500, kCGWindowOwnerName: "TextEdit", kCGWindowName: "notes.txt",
    kCGWindowBounds: { X: -100, Y: 25, Width: 600, Height: 400 }, kCGWindowLayer: 0, kCGWindowAlpha: 1,
  };

  it("reads the window list front to back, drops entries it can't place, and releases the list once", () => {
    const { f, cf, ax } = fakeAX();
    const { cg, lists } = fakeCG(f, { windows: [{ ...textEdit }, { kCGWindowNumber: 7, kCGWindowOwnerPID: 1 }, { ...textEdit, kCGWindowNumber: 102, kCGWindowName: undefined, kCGWindowLayer: 101 }] });
    const desktop = makeDesktop(cf, cg, ax, null, 4242);
    expect(desktop.windows()).toEqual([
      { id: 101, pid: 500, owner: "TextEdit", title: "notes.txt", bounds: { x: -100, y: 25, width: 600, height: 400 }, layer: 0, alpha: 1 },
      { id: 102, pid: 500, owner: "TextEdit", title: "", bounds: { x: -100, y: 25, width: 600, height: 400 }, layer: 101, alpha: 1 },
    ]);
    expect(f.released).toEqual(lists);
  });

  it("never asks AX about Ember's own process", () => {
    const { f, cf, ax, calls } = fakeAX();
    const desktop = makeDesktop(cf, fakeCG(f, { windows: [textEdit] }).cg, ax, null, 500);
    expect(desktop.focusedWindow(500)).toBeNull();
    expect(desktop.appWindows(500)).toBeNull();
    expect(desktop.raise(500, 101, { x: -100, y: 25, width: 600, height: 400 })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("reads a window's frame over AX only when AX gives no window id, and releases the app element", () => {
    const withIds = fakeAX();
    const desktop = makeDesktop(withIds.cf, fakeCG(withIds.f, { windows: [] }).cg, withIds.ax, null, 4242);
    expect(desktop.focusedWindow(500)).toEqual({ id: 101, title: "notes.txt", frame: null });
    expect(desktop.appWindows(500)).toEqual([{ id: 101, title: "notes.txt", frame: null }]);
    expect(withIds.f.released.some(r => withIds.f.objects.get(r)!.t === "axvalue")).toBe(false);
    const apps = [...withIds.f.objects.entries()].filter(([, o]) => o.t === "element" && o.v === "app").map(([r]) => r);
    expect(apps.map(r => withIds.f.counts.get(r))).toEqual([0, 0]);

    const noIds = fakeAX({ windowIds: false });
    const plain = makeDesktop(noIds.cf, fakeCG(noIds.f, { windows: [] }).cg, noIds.ax, null, 4242);
    expect(plain.focusedWindow(500)).toEqual({ id: 0, title: "notes.txt", frame: { x: 100, y: 120, width: 600, height: 400 } });
  });

  it("raises the one window AX matches, and brings its app to the front", () => {
    const { f, cf, ax, calls } = fakeAX();
    const desktop = makeDesktop(cf, fakeCG(f, { windows: [] }).cg, ax, null, 4242);
    expect(desktop.raise(500, 101, { x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    expect(calls).toEqual(["app 500", "set AXFrontmost=true", "perform AXRaise", "set AXMain=true"]);
    calls.length = 0;
    desktop.raise(500, 999, { x: 0, y: 0, width: 1, height: 1 }); // AX lists no such window: nothing is raised
    expect(calls).toEqual(["app 500", "set AXFrontmost=true"]);
  });

  it("reads the lock state and the secure-input holder from the session", () => {
    const session = (s: Record<string, unknown> | null) => {
      const { f, cf, ax } = fakeAX();
      return makeDesktop(cf, fakeCG(f, { windows: [], session: s }).cg, ax, null, 4242).session();
    };
    expect(session({ kCGSSessionOnConsoleKey: true })).toEqual({ locked: false, secureInputPid: null });
    expect(session({ kCGSSessionOnConsoleKey: true, CGSSessionScreenIsLocked: true, kCGSSessionSecureInputPID: 88 })).toEqual({ locked: true, secureInputPid: 88 });
    expect(session({ kCGSSessionOnConsoleKey: false })).toEqual({ locked: true, secureInputPid: null });
    expect(session({ CGSSessionScreenIsLocked: 1, kCGSSessionSecureInputPID: 0 })).toEqual({ locked: true, secureInputPid: null });
    expect(session(null)).toEqual({ locked: false, secureInputPid: null });
  });
});
