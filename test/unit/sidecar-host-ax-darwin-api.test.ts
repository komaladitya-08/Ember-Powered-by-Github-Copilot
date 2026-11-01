import { describe, expect, it } from "vitest";
import { makeCF, type Ref } from "../../app/main/platform/darwin/cf";
import { AX_ERROR, AX_VALUE, makeAX, type AXRaw } from "../../app/main/platform/darwin/ax";
import type { CGRaw } from "../../app/main/platform/darwin/cg";
import {
  AX_TIMEOUT_S, NO_VALUE, axApiError, isAxError, makeAxApi, openAxApi, type AxExtraRaw,
} from "../../app/sidecar-host/providers/ax-darwin-api";
import { fakeAX, fakeCG } from "./platform-darwin-fakes";

const NULL_TYPE = 50;

/**
 * makeAxApi over port/darwin's pretend CoreFoundation and AX (platform-darwin-fakes.ts), with kCFNull added and the
 * extra AX calls pretended here: a batch answers from `slots`, a range from `items`.
 */
function setup(o: { batchError?: number; slots?: Record<string, () => Ref | undefined>; copy?: AXRaw["AXUIElementCopyAttributeValue"] } = {}) {
  const base = fakeAX();
  const { f } = base;
  const nil = f.make({ t: "string", v: "<null>" });
  const raw = { ...f.raw, CFGetTypeID: (ref: Ref) => (ref === nil ? NULL_TYPE : f.raw.CFGetTypeID(ref)) };
  const cf = makeCF(raw);
  const ax = makeAX(o.copy ? { ...base.ax.raw, AXUIElementCopyAttributeValue: o.copy } : base.ax.raw, cf);
  const str = (ref: Ref) => (f.get(ref) as { v: string }).v;
  const made: Record<string, Ref> = {};
  const seen: { attributes?: Ref; batch?: Ref; param?: Ref; result?: Ref } = {};
  const extraCalls: string[] = [];
  const element = (name: string) => f.make({ t: "element", v: name });
  const slots: Record<string, () => Ref | undefined> = {
    AXRole: () => f.make({ t: "string", v: "AXButton" }),
    AXTitle: () => f.make({ t: "string", v: "Save the document now" }),
    AXEnabled: () => f.make({ t: "boolean", v: true }),
    AXMinValue: () => f.make({ t: "number", v: 2.5 }),
    AXPosition: () => f.make({ t: "axvalue", type: AX_VALUE.cgPoint, v: [10, 20] }),
    AXTitleUIElement: () => (made.title = element("label")),
    AXChildren: () => f.make({ t: "array", v: [(made.child = element("child")), f.make({ t: "string", v: "not an element" })] }),
    AXHelp: () => f.make({ t: "axvalue", type: AX_VALUE.axError, v: [AX_ERROR.cannotComplete] }),
    AXFocused: () => nil,
    AXData: () => f.make({ t: "data", v: Buffer.from("x") }),
    ...o.slots,
  };
  const extra: AxExtraRaw = {
    AXUIElementCopyMultipleAttributeValues: (_el, attributes, options, out) => {
      extraCalls.push(`batch ${options}`);
      seen.attributes = attributes;
      if (o.batchError !== undefined) return o.batchError;
      const names = (f.get(attributes) as { v: Ref[] }).v.map(str);
      // A batch that ends early (an app's short answer) leaves out the slots at its end.
      const values = names.filter(n => n !== "Missing").map(n => slots[n]?.() ?? f.make({ t: "axvalue", type: AX_VALUE.axError, v: [AX_ERROR.attributeUnsupported] }));
      out[0] = seen.batch = f.make({ t: "array", v: values });
      return 0;
    },
    AXUIElementGetAttributeValueCount: (_el, attr, out) => { out[0] = str(attr) === "AXChildren" ? 3n : 0; return str(attr) === "AXChildren" ? 0 : AX_ERROR.attributeUnsupported; },
    AXUIElementCopyAttributeValues: (_el, attr, index, max, out) => {
      extraCalls.push(`range ${str(attr)} ${index} ${max}`);
      if (str(attr) !== "AXChildren") return AX_ERROR.attributeUnsupported;
      out[0] = seen.batch = f.make({ t: "array", v: [(made.a = element("a")), f.make({ t: "string", v: "x" }), (made.b = element("b"))] });
      return 0;
    },
    AXUIElementIsAttributeSettable: (_el, attr, out) => { out[0] = str(attr) === "AXValue" ? 1 : 0; return 0; },
    AXUIElementCopyActionNames: (_el, out) => { out[0] = f.make({ t: "array", v: [f.make({ t: "string", v: "AXPress" }), f.make({ t: "string", v: "AXShowMenu" })] }); return 0; },
    AXUIElementCopyParameterizedAttributeValue: (_el, attr, param, out) => {
      extraCalls.push(`param ${str(attr)} ${JSON.stringify((f.get(param) as { type: number; v: number[] }))}`);
      seen.param = param;
      out[0] = seen.result = f.make({ t: "string", v: "abcdefghij".slice(...(f.get(param) as { v: number[] }).v.map((n, i, a) => (i === 0 ? n : a[0]! + n)) as [number, number]) });
      return 0;
    },
    AXValueCreate: (type, buf) => f.make({ t: "axvalue", type, v: [Number(buf.readBigInt64LE(0)), Number(buf.readBigInt64LE(8))] }),
    CFNullGetTypeID: () => NULL_TYPE,
  };
  const cg = fakeCG(f, { windows: [
    { kCGWindowNumber: 42, kCGWindowOwnerPID: 500, kCGWindowOwnerName: "TextEdit", kCGWindowName: "", kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowBounds: { X: 10, Y: 20, Width: 300, Height: 200 } },
    { kCGWindowNumber: 43, kCGWindowOwnerName: "broken" },
  ] }).cg;
  const displays = [{ id: 1, rect: { origin: { x: 0, y: 0 }, size: { width: 1440, height: 900 } } }, { id: 2, rect: { origin: { x: 1440, y: -200 }, size: { width: 1920, height: 1080 } } }];
  Object.assign(cg, {
    CGGetActiveDisplayList: (max: number, buf: Buffer, count: number[]) => { displays.slice(0, max).forEach((d, i) => buf.writeUInt32LE(d.id, i * 4)); count[0] = displays.length; return 0; },
    CGDisplayBounds: (id: number) => displays.find(d => d.id === id)!.rect,
  } as Partial<CGRaw>);
  const api = makeAxApi({ cf, ax, cg, extra });
  const el = element("window");
  return { api, f, base, made, seen, extraCalls, el, nil, count: (ref: Ref) => f.counts.get(ref) ?? 0 };
}

describe("the AX API's batched read", () => {
  it("converts every slot in one call: text cut, numbers, booleans, AXValues, elements (the caller's), arrays", () => {
    const { api, f, made, seen, extraCalls, el, count } = setup();
    const m = api.attrs(el, ["AXRole", "AXTitle", "AXEnabled", "AXMinValue", "AXPosition", "AXTitleUIElement", "AXChildren"], 8);
    expect(extraCalls).toEqual(["batch 0"]);
    expect(isAxError(m)).toBe(false);
    const values = m as Map<string, unknown>;
    expect(values.get("AXRole")).toBe("AXButton");
    expect(values.get("AXTitle")).toBe("Save the");
    expect(values.get("AXEnabled")).toBe(true);
    expect(values.get("AXMinValue")).toBe(2.5);
    expect(values.get("AXPosition")).toEqual({ type: "point", x: 10, y: 20 });
    expect(values.get("AXTitleUIElement")).toBe(made.title);
    expect(values.get("AXChildren")).toEqual([made.child, "not an e"]);
    // Elements are retained for the caller; the batch's array and the names' array are given back.
    expect(count(made.title!)).toBe(2);
    expect(count(made.child!)).toBe(2);
    expect(count(seen.batch!)).toBe(0);
    expect(count(seen.attributes!)).toBe(0);
    f.raw.CFRelease(made.title!);
    expect(count(made.title!)).toBe(1);
  });

  it("reads a failed slot as its AXError, kCFNull and a short answer as no value, and what it can't convert as no value", () => {
    const { api, el } = setup();
    const m = api.attrs(el, ["AXHelp", "AXFocused", "AXData", "AXUnknown", "Missing"]) as Map<string, unknown>;
    expect(m.get("AXHelp")).toEqual({ axError: AX_ERROR.cannotComplete });
    expect(m.get("AXFocused")).toEqual(NO_VALUE);
    expect(m.get("Missing")).toEqual(NO_VALUE);
    expect(m.get("AXData")).toEqual(NO_VALUE);
    expect(m.get("AXUnknown")).toEqual({ axError: AX_ERROR.attributeUnsupported });
  });

  it("answers a busy, gone or disabled call as its error, and reads one by one where the app can't batch", () => {
    for (const error of [AX_ERROR.cannotComplete, AX_ERROR.invalidUIElement, AX_ERROR.apiDisabled]) {
      expect(setup({ batchError: error }).api.attrs(setup().el, ["AXRole"])).toEqual({ axError: error });
    }
    const { api, base } = setup({ batchError: AX_ERROR.notImplemented });
    // port/darwin's pretend AX serves the window's AXTitle and nothing else.
    const window = base.element("window");
    const m = api.attrs(window, ["AXTitle", "AXRole"]) as Map<string, unknown>;
    expect(m.get("AXTitle")).toBe("notes.txt");
    expect(m.get("AXRole")).toEqual({ axError: AX_ERROR.attributeUnsupported });
  });

  it("stops reading one by one at the first attribute an app doesn't answer, giving back what it read (never 25 timeouts in a row)", () => {
    for (const stop of [AX_ERROR.cannotComplete, AX_ERROR.invalidUIElement, AX_ERROR.apiDisabled]) {
      const asked: string[] = [];
      let label: Ref | undefined;
      const { api, f, el } = setup({
        batchError: AX_ERROR.notImplemented,
        copy: (_el, attr, out) => {
          const name = (f.get(attr) as { v: string }).v;
          asked.push(name);
          if (name === "AXTitleUIElement") { out[0] = label = f.make({ t: "element", v: "label" }); return 0; }
          return stop;
        },
      });
      expect(api.attrs(el, ["AXTitleUIElement", "AXRole", "AXTitle", "AXEnabled"])).toEqual({ axError: stop });
      expect(asked).toEqual(["AXTitleUIElement", "AXRole"]);
      expect(f.counts.get(label!) ?? 0).toBe(0);
    }
  });
});

describe("the AX API's other calls", () => {
  it("reads a range of elements (the caller's), skipping anything else, and gives the array back", () => {
    const { api, made, seen, extraCalls, el, count } = setup();
    expect(api.range(el, "AXChildren", 0, 200)).toEqual([made.a, made.b]);
    expect(extraCalls).toEqual(["range AXChildren 0 200"]);
    expect([count(made.a!), count(made.b!), count(seen.batch!)]).toEqual([2, 2, 0]);
    expect(api.range(el, "AXVisibleRows", 0, 5)).toEqual({ axError: AX_ERROR.attributeUnsupported });
  });

  it("counts values, says what is settable, and names actions", () => {
    const { api, el } = setup();
    expect(api.count(el, "AXChildren")).toBe(3);
    expect(api.count(el, "AXRows")).toEqual({ axError: AX_ERROR.attributeUnsupported });
    expect(api.settable(el, "AXValue")).toBe(true);
    expect(api.settable(el, "AXTitle")).toBe(false);
    expect(api.actions(el)).toEqual(["AXPress", "AXShowMenu"]);
  });

  it("sets text with a CFString it gives back, a CFRange for a selection, booleans with the constants, and nothing it can't make", () => {
    const { api, base, el } = setup();
    expect(api.set(el, "AXSelected", true)).toBeNull();
    expect(base.calls).toContain("set AXSelected=true");
    const before = base.f.created.length;
    expect(api.set(el, "AXValue", "Ember 1")).toBeNull();
    const made = base.f.created.slice(before).find(r => (base.f.objects.get(r) as { v?: unknown }).v === "Ember 1")!;
    expect(base.f.counts.get(made)).toBe(0);
    expect(api.set(el, "AXSelectedTextRange", { type: "range", location: 0, length: 7 })).toBeNull();
    const range = [...base.f.objects.entries()].find(([, o]) => o.t === "axvalue" && o.type === AX_VALUE.cfRange && o.v[0] === 0 && o.v[1] === 7);
    expect(range, "a CFRange was made for the selection").toBeTruthy();
    expect(base.f.counts.get(range![0])).toBe(0);
    expect(api.set(el, "AXPosition", { type: "point", x: 1, y: 2 })).toEqual({ axError: AX_ERROR.illegalArgument });
    expect(api.perform(el, "AXPress")).toBeNull();
    expect(base.calls).toContain("perform AXPress");
  });

  it("hit-tests in an app (made once, with the 0.8 s messaging timeout) or system-wide", () => {
    const { api, base } = setup();
    const hit = api.at(12.5, 30, 500);
    expect(isAxError(hit)).toBe(false);
    expect(api.at(1, 2, 500)).not.toBeNull();
    expect(api.at(3, 4)).not.toBeNull();
    expect(base.calls.filter(c => c.startsWith("app "))).toEqual(["app 500"]);
    expect(base.calls).toContain(`timeout ${AX_TIMEOUT_S}`);
    expect(base.calls.filter(c => c.startsWith("at "))).toEqual(["at 12.5,30", "at 1,2", "at 3,4"]);
    expect(api.app(500)).toBe(api.app(500));
  });

  it("reads part of a text through AXStringForRange, giving its CFRange back", () => {
    const { api, seen, extraCalls, el, count } = setup();
    expect(api.textRange(el, 2, 3)).toBe("cde");
    expect(extraCalls).toEqual([`param AXStringForRange {"t":"axvalue","type":${AX_VALUE.cfRange},"v":[2,3]}`]);
    expect([count(seen.param!), count(seen.result!)]).toEqual([0, 0]);
  });

  it("keys an element by its exact 64-bit CFHash, even above 2^53", () => {
    const { api, f, el } = setup();
    expect(api.hash(el)).toBe((el % 997n).toString(16));
    const big = makeAxApi({ cf: makeCF({ ...f.raw, CFHash: () => 0xfedcba9876543211n }), ax: setup().base.ax, cg: {} as CGRaw, extra: {} as AxExtraRaw });
    expect(big.hash(el)).toBe("fedcba9876543211");
    expect(api.same(el, el)).toBe(true);
    expect(api.retain(el)).toBe(el);
  });

  it("lists the on-screen windows and the displays as port/darwin reads them", () => {
    const { api } = setup();
    expect(api.onScreenWindows()).toEqual([{ id: 42, pid: 500, owner: "TextEdit", title: "", bounds: { x: 10, y: 20, width: 300, height: 200 }, layer: 0, alpha: 1 }]);
    expect(api.displays()).toEqual([{ x: 0, y: 0, width: 1440, height: 900 }, { x: 1440, y: -200, width: 1920, height: 1080 }]);
  });

  it("binds nothing off macOS, and says why", () => {
    if (process.platform === "darwin") return; // on a Mac it binds the real frameworks (the integration test's)
    expect(openAxApi()).toBeNull();
    expect(String(axApiError)).toMatch(/isn't available on/);
  });
});
