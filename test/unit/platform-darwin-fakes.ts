/**
 * Stand-ins for CoreFoundation, AX and CoreGraphics, shared by the macOS binding tests: CF objects in a table with
 * reference counts and a log of releases (so a leak or a double release fails the test), an AX API over them with
 * one app (pid 500), and CoreGraphics' window list, session dictionary, key state and permission calls.
 */

import { expect } from "vitest";
import { makeCF, type CFRaw, type Ref } from "../../app/main/platform/darwin/cf";
import { AX_ERROR, AX_VALUE, makeAX, type AXRaw } from "../../app/main/platform/darwin/ax";
import type { CGRaw, CGRect } from "../../app/main/platform/darwin/cg";

export type Obj =
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
export function fakeCF() {
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

/**
 * A pretend AX API over the pretend CoreFoundation: one app (pid 500) with a focused window, and the system-wide
 * element's frontmost app (`state.frontmost`, null when AX can't name one). With `dockList`, every app element also
 * holds an AXList with that frame (the Dock's strip of icons).
 */
export function fakeAX(o: { windowIds?: boolean; failCopy?: boolean; dockList?: { x: number; y: number; width: number; height: number } } = {}) {
  const state = { frontmost: 500 as number | null };
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
      ...(o.dockList ? { AXChildren: () => f.make({ t: "array", v: [element("dockList")] }) } : {}),
    },
    dockList: {
      AXRole: () => f.make({ t: "string", v: "AXList" }),
      AXPosition: () => axValue(AX_VALUE.cgPoint, o.dockList?.x ?? 0, o.dockList?.y ?? 0),
      AXSize: () => axValue(AX_VALUE.cgSize, o.dockList?.width ?? 0, o.dockList?.height ?? 0),
    },
    system: {
      AXFocusedApplication: () => (f.raw.CFRetain(element("frontApp")), element("frontApp")),
    },
  };
  const raw: AXRaw = {
    AXUIElementCreateSystemWide: () => element("system"),
    AXUIElementCreateApplication: pid => (calls.push(`app ${pid}`), f.make({ t: "element", v: "app" })),
    AXUIElementCopyAttributeValue: (el, attr, out) => {
      const name = (f.get(attr) as { v: string }).v;
      const make = attrs[(f.get(el) as { v: string }).v]?.[name];
      if (name === "AXFocusedApplication" && state.frontmost === null) return AX_ERROR.cannotComplete;
      if (o.failCopy || !make) return AX_ERROR.attributeUnsupported;
      out[0] = make();
      return AX_ERROR.success;
    },
    AXUIElementCopyAttributeNames: (_el, out) => { out[0] = f.make({ t: "array", v: [f.make({ t: "string", v: "AXTitle" })] }); return 0; },
    AXUIElementSetAttributeValue: (_el, attr, value) => (calls.push(`set ${(f.get(attr) as { v: string }).v}=${String(cf.boolean(value))}`), 0),
    AXUIElementPerformAction: (_el, action) => (calls.push(`perform ${(f.get(action) as { v: string }).v}`), 0),
    AXUIElementGetPid: (el, pid) => { pid[0] = (f.get(el) as { v: string }).v === "frontApp" ? state.frontmost ?? 0 : 500; return 0; },
    AXUIElementSetMessagingTimeout: (_el, s) => (calls.push(`timeout ${s}`), 0),
    AXUIElementCopyElementAtPosition: (_app, x, y, out) => { calls.push(`at ${x},${y}`); out[0] = element("window"); f.raw.CFRetain(element("window")); return 0; },
    AXUIElementGetTypeID: () => 100,
    AXValueGetTypeID: () => 101,
    AXValueGetType: v => (f.get(v) as { type: number }).type,
    AXValueGetValue: (v, type, out) => {
      const val = f.get(v) as { type: number; v: number[] };
      if (val.type !== type) return false;
      if (type === AX_VALUE.axError) out.writeInt32LE(val.v[0]!, 0); // an AXError is one int32
      else val.v.forEach((n, i) => out.writeDoubleLE(n, i * 8));
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
  return { f, cf, ax: makeAX(raw, cf), calls, element, axValue, state };
}

/** What fakeCG() pretends: the window list, the session dictionary, keys down and the Input Monitoring answers. */
export interface FakeCGOptions {
  windows: Record<string, unknown>[];
  session?: Record<string, unknown> | null;
  keys?: Set<number>;
  /** CGPreflightListenEventAccess's answer; undefined leaves the call unbound, as before macOS 10.15. */
  listen?: boolean;
  /** CGPreflightPostEventAccess's answer; undefined leaves it unbound. */
  post?: boolean;
}

/** CoreGraphics as far as the desktop's reads go, over the pretend CoreFoundation. */
export function fakeCG(f: ReturnType<typeof fakeCF>, o: FakeCGOptions) {
  const value = (v: unknown): Ref => (typeof v === "string" ? f.make({ t: "string", v })
    : typeof v === "boolean" ? f.make({ t: "boolean", v })
    : typeof v === "number" ? f.make({ t: "number", v })
    : f.make({ t: "dictionary", v: Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => [value(k), value(x)]) }));
  const field = (dict: Ref, key: string) => {
    const pair = (f.get(dict) as { v: [Ref, Ref][] }).v.find(([k]) => (f.get(k) as { v: string }).v === key);
    return pair ? (f.get(pair[1]) as { v: number }).v : undefined;
  };
  const lists: Ref[] = [];
  const keyCalls: number[] = [];
  const requests: string[] = [];
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
    CGEventSourceKeyState: (state: number, key: number) => {
      expect(state).toBe(0); // the combined session state: the hardware's keys and every posted one
      keyCalls.push(key);
      return o.keys?.has(key) ?? false;
    },
    ...(o.listen === undefined ? {} : {
      CGPreflightListenEventAccess: () => o.listen,
      CGRequestListenEventAccess: () => (requests.push("listen"), o.listen),
    }),
    ...(o.post === undefined ? {} : { CGPreflightPostEventAccess: () => o.post }),
  } as unknown as CGRaw;
  return { cg, lists, keyCalls, requests };
}
