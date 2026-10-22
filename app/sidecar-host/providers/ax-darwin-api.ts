/**
 * The narrow macOS accessibility API the sidecar host's AX provider calls (AxApi), and its koffi implementation over
 * port/darwin's bindings (app/main/platform/darwin/{cf,ax,cg}.ts) plus the few AX calls those don't bind: the batched
 * read (AXUIElementCopyMultipleAttributeValues), the ranged read of a long list, the value count, whether an attribute
 * is settable, the action names and the parameterised text read. Everything the provider decides is above this
 * interface, so every unit test runs on Linux against a fake AxApi; this module only converts between CoreFoundation
 * and JavaScript, with the ownership rule made explicit: every element reference it hands out (in a value, a range, a
 * hit test) is the caller's (+1) to give back with release(); the app elements it caches and the system-wide element
 * are its own.
 *
 * Every AX call is a synchronous IPC to the target app, answered within the process-wide messaging timeout this
 * module sets first (0.8 s: design C13; Electron's main process uses 0.25 s on its own). An AX error never throws
 * here: it comes back as an AxError value ({ axError: code }), also per slot of a batched read, where a failed
 * attribute is an AXValue of kAXValueAXErrorType (or kCFNull) rather than an error of the call. Nothing is loaded
 * until openAxApi() runs on macOS, so the module imports on every OS.
 */

import type { Rect } from "../provider";
import { CF_PATH, cfError, openCoreFoundation, type CF } from "../../main/platform/darwin/cf";
import { AX_ERROR, AX_PATHS, AX_VALUE, axError as axBindError, openAX, type AX } from "../../main/platform/darwin/ax";
import { NULL_WINDOW_ID, WINDOW_KEY, WINDOW_LIST, cgError, openCoreGraphics, rectOf, type CGRaw, type CGRect } from "../../main/platform/darwin/cg";
import { windowEntry, type CGWindowEntry } from "../../main/platform/darwin/model";
import { bindFunctions, koffiModule, loadFirst, onMacOS, type Ref } from "../../main/platform/darwin/native";

/** An AXUIElementRef as koffi passes it (an address). */
export type AxRef = Ref;

/** An AX error code as a value: a failed call, or a failed attribute in a batched read. */
export interface AxError { readonly axError: number }

/** A decoded AXValue (CGPoint, CGSize, CGRect, CFRange). */
export type AxStruct =
  | { type: "point"; x: number; y: number }
  | { type: "size"; width: number; height: number }
  | { type: "rect"; x: number; y: number; width: number; height: number }
  | { type: "range"; location: number; length: number };

/**
 * An attribute's value, the JavaScript way round: a CFString, CFNumber or CFBoolean as such, an AXUIElementRef as its
 * reference (owned by the caller: release it), an AXValue decoded, a CFArray as an array of these.
 */
export type AxValue = string | number | boolean | AxRef | AxStruct | AxValue[];

/** An on-screen window as CGWindowListCopyWindowInfo describes it (port/darwin's entry: points, front to back). */
export type AxWindowEntry = CGWindowEntry;

/** The macOS accessibility calls the provider makes (see the module comment for ownership and errors). */
export interface AxApi {
  /** AXIsProcessTrusted(): has this process the Accessibility permission? */
  trusted(): boolean;
  /** The system-wide element (the API's own: never release it); null when it can't be made. */
  systemWide(): AxRef | null;
  /** The app element of `pid` (cached per pid with the messaging timeout set: never release it); null when it can't be made. */
  app(pid: number): AxRef | null;
  /** AXUIElementCopyMultipleAttributeValues: every attribute of `names` in ONE round trip (strings cut to `maxChars`). */
  attrs(el: AxRef, names: readonly string[], maxChars?: number): Map<string, AxValue | AxError> | AxError;
  /** AXUIElementCopyAttributeValue (strings cut to `maxChars`). */
  attr(el: AxRef, name: string, maxChars?: number): AxValue | AxError;
  /** AXUIElementGetAttributeValueCount. */
  count(el: AxRef, name: string): number | AxError;
  /** AXUIElementCopyAttributeValues: up to `max` elements of an array attribute from `index` (each the caller's). */
  range(el: AxRef, name: string, index: number, max: number): AxRef[] | AxError;
  /** AXUIElementIsAttributeSettable. */
  settable(el: AxRef, name: string): boolean | AxError;
  /** AXUIElementCopyActionNames. */
  actions(el: AxRef): string[] | AxError;
  /** AXUIElementSetAttributeValue with a CFString, CFNumber or CFBoolean (an element: as it is); null when it worked. */
  set(el: AxRef, name: string, v: AxValue): AxError | null;
  /** AXUIElementPerformAction; null when it worked. */
  perform(el: AxRef, action: string): AxError | null;
  /**
   * AXUIElementCopyElementAtPosition in app `pid` (app-scoped: only that app is asked), or with no pid the
   * system-wide element (whichever app owns the point is asked). The element is the caller's.
   */
  at(x: number, y: number, pid?: number): AxRef | AxError;
  /** AXStringForRange: `length` characters of an element's text from `location`, without copying the rest over. */
  textRange(el: AxRef, location: number, length: number): string | AxError;
  /** AXUIElementGetPid (no IPC: the pid is part of the reference); 0 when it can't be told. */
  pid(el: AxRef): number;
  /** _AXUIElementGetWindow: an AX window's CGWindowID, 0 when it fails or the call doesn't exist. */
  windowId(win: AxRef): number;
  /** CFHash as an exact unsigned 64-bit hex string (no IPC: computed from the pid and the app's element token). */
  hash(el: AxRef): string;
  /** CFEqual: the same element of the same app. */
  same(a: AxRef, b: AxRef): boolean;
  /** CFRetain (+1): the reference is the caller's to release too. */
  retain(el: AxRef): AxRef;
  /** CFRelease. */
  release(el: AxRef): void;
  /** CGWindowListCopyWindowInfo (on-screen windows, no desktop elements), front to back. */
  onScreenWindows(): AxWindowEntry[];
  /** The active displays' bounds (points). */
  displays(): Rect[];
}

/** AX's messaging timeout for this process and every app element (seconds; the main process uses 0.25 s). */
export const AX_TIMEOUT_S = 0.8;
/** App elements kept (one per app read; the oldest is let go past this). */
const APPS_KEPT = 256;
/** CFRange as AXValueCreate reads it: two CFIndex (long). */
const RANGE_BYTES = 16;

/** Is this a failed call or attribute? */
export const isAxError = (v: unknown): v is AxError =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { axError?: unknown }).axError === "number";

/** An AxError for `code`. */
export const axError = (code: number): AxError => ({ axError: code });

/** The value of an attribute that isn't there (kAXErrorNoValue, as a batch's kCFNull slot reads too). */
export const NO_VALUE: AxError = Object.freeze({ axError: AX_ERROR.noValue });

/**
 * Batch errors after which the attributes are read one by one instead: an app (old Carbon ones) that doesn't
 * implement the batched call. A busy app, a gone element or a disabled API is an answer, never retried this way.
 */
const BATCH_UNSUPPORTED: ReadonlySet<number> = new Set([
  AX_ERROR.notImplemented, AX_ERROR.illegalArgument, AX_ERROR.failure, AX_ERROR.attributeUnsupported,
  AX_ERROR.parameterizedAttributeUnsupported,
]);
/**
 * Errors that end a one-by-one read at once, as the whole call's answer: after a CannotComplete every further call to
 * that app would wait out the messaging timeout too (25 of them: 20 s), and a gone element or a disabled API answers
 * every attribute alike.
 */
const ENDS_READ: ReadonlySet<number> = new Set([AX_ERROR.cannotComplete, AX_ERROR.invalidUIElement, AX_ERROR.apiDisabled]);

/** The koffi prototypes of the AX calls port/darwin's ax.ts doesn't bind (CFIndex is long; Boolean out is one byte). */
export const AX_EXTRA_PROTOTYPES = {
  AXUIElementCopyMultipleAttributeValues: "int32_t AXUIElementCopyMultipleAttributeValues(void *element, void *attributes, uint32_t options, _Out_ void **values)",
  AXUIElementGetAttributeValueCount: "int32_t AXUIElementGetAttributeValueCount(void *element, void *attribute, _Out_ long *count)",
  AXUIElementCopyAttributeValues: "int32_t AXUIElementCopyAttributeValues(void *element, void *attribute, long index, long maxValues, _Out_ void **values)",
  AXUIElementIsAttributeSettable: "int32_t AXUIElementIsAttributeSettable(void *element, void *attribute, _Out_ uint8_t *settable)",
  AXUIElementCopyActionNames: "int32_t AXUIElementCopyActionNames(void *element, _Out_ void **names)",
  AXUIElementCopyParameterizedAttributeValue: "int32_t AXUIElementCopyParameterizedAttributeValue(void *element, void *attribute, void *parameter, _Out_ void **result)",
  AXValueCreate: "void *AXValueCreate(uint32_t type, const void *value)",
} as const;

/** The one CoreFoundation function cf.ts doesn't bind: kCFNull's type, which a batch puts in a slot with no value. */
export const CF_EXTRA_PROTOTYPES = {
  CFNullGetTypeID: "unsigned long CFNullGetTypeID(void)",
} as const;

/** The extra functions as koffi binds them (a fake in the tests). */
export interface AxExtraRaw {
  AXUIElementCopyMultipleAttributeValues(element: Ref, attributes: Ref, options: number, values: (Ref | null)[]): number;
  AXUIElementGetAttributeValueCount(element: Ref, attribute: Ref, count: (number | bigint)[]): number;
  AXUIElementCopyAttributeValues(element: Ref, attribute: Ref, index: number, maxValues: number, values: (Ref | null)[]): number;
  AXUIElementIsAttributeSettable(element: Ref, attribute: Ref, settable: number[]): number;
  AXUIElementCopyActionNames(element: Ref, names: (Ref | null)[]): number;
  AXUIElementCopyParameterizedAttributeValue(element: Ref, attribute: Ref, parameter: Ref, result: (Ref | null)[]): number;
  AXValueCreate(type: number, value: Buffer): Ref | null;
  CFNullGetTypeID(): number | bigint;
}

/** What makeAxApi() works over: port/darwin's CF, AX and CoreGraphics, and the extra functions. */
export interface AxApiParts {
  cf: CF;
  ax: AX;
  cg: CGRaw;
  extra: AxExtraRaw;
  /** The messaging timeout given to every app element (seconds). */
  timeoutS?: number;
}

/** AxApi over bound (or fake) functions: see the module comment. */
export function makeAxApi(p: AxApiParts): AxApi {
  const { cf, ax, cg, extra } = p;
  const timeout = p.timeoutS ?? AX_TIMEOUT_S;
  let ids: { element: number; value: number; nil: number } | null = null;
  const typeIds = () => (ids ??= {
    element: Number(ax.raw.AXUIElementGetTypeID()),
    value: Number(ax.raw.AXValueGetTypeID()),
    nil: Number(extra.CFNullGetTypeID()),
  });
  const apps = new Map<number, Ref>();
  const isElement = (ref: Ref) => Number(cf.raw.CFGetTypeID(ref)) === typeIds().element;

  /** A borrowed CF object as an AxValue (elements retained for the caller), an AxError, or undefined when it can't be told. */
  const convert = (ref: Ref | null | undefined, max: number): AxValue | AxError | undefined => {
    if (!ref) return undefined;
    const t = typeIds();
    const id = Number(cf.raw.CFGetTypeID(ref));
    if (id === t.element) return cf.retain(ref) ?? undefined;
    if (id === t.nil) return NO_VALUE;
    if (id === t.value) {
      const v = ax.decode(ref);
      if (!v) return undefined;
      return v.type === "error" ? axError(v.code) : v;
    }
    switch (cf.kind(ref)) {
      case "string": return cf.string(ref, max) ?? undefined;
      case "number": return cf.number(ref) ?? undefined;
      case "boolean": return cf.boolean(ref) ?? undefined;
      case "array": {
        const out: AxValue[] = [];
        for (const item of cf.array(ref)) {
          const v = convert(item, max);
          if (v !== undefined && !isAxError(v)) out.push(v);
        }
        return out;
      }
      default: return undefined; // a CFURL, an attributed string…: nothing the provider reads
    }
  };
  /** An owned CF object as an AxValue (released here); a value nothing could be made of is "no value". */
  const take = (ref: Ref | null | undefined, max: number): AxValue | AxError => {
    try {
      return convert(ref, max) ?? NO_VALUE;
    } finally {
      cf.release(ref);
    }
  };
  /** A JS value as a new CF object for a set (+1), or a borrowed one (`own` false). */
  const toCF = (v: AxValue): { ref: Ref | null; own: boolean } => {
    if (typeof v === "string") return { ref: cf.createString(v), own: true };
    if (typeof v === "number") return { ref: cf.createNumber(v), own: true };
    if (typeof v === "boolean") return { ref: v ? cf.kTrue : cf.kFalse, own: false };
    if (typeof v === "bigint") return { ref: v, own: false };
    return { ref: null, own: false }; // structs and arrays are never set by the provider
  };
  /** The app element of `pid`, made once with the messaging timeout set, and kept (the oldest let go past APPS_KEPT). */
  const app = (pid: number): Ref | null => {
    const kept = apps.get(pid);
    if (kept) return kept;
    const made = ax.application(pid);
    if (!made) return null;
    ax.setTimeout(made, timeout);
    apps.set(pid, made);
    while (apps.size > APPS_KEPT) {
      const [oldest, ref] = apps.entries().next().value!;
      apps.delete(oldest);
      cf.release(ref);
    }
    return made;
  };
  /** Gives back every element reference in a converted value (arrays included). */
  const releaseRefs = (v: AxValue | AxError): void => {
    if (typeof v === "bigint") cf.release(v);
    else if (Array.isArray(v)) v.forEach(releaseRefs);
  };
  const one = (el: Ref, name: string, max: number): AxValue | AxError => {
    const { error, value } = ax.copy(el, name);
    return error !== AX_ERROR.success ? axError(error) : take(value, max);
  };

  return {
    trusted() {
      return ax.trusted(false);
    },
    systemWide() {
      return ax.systemWide();
    },
    app,
    attrs(el, names, max = 2000) {
      if (!names.length) return new Map();
      const list = cf.createArray(names.map(n => cf.key(n)));
      if (!list) return axError(AX_ERROR.failure);
      const out: (Ref | null)[] = [null];
      let error: number;
      try {
        error = extra.AXUIElementCopyMultipleAttributeValues(el, list, 0, out);
      } finally {
        cf.release(list);
      }
      if (error !== AX_ERROR.success) {
        cf.release(out[0]);
        if (!BATCH_UNSUPPORTED.has(error)) return axError(error);
        // The app can't batch: one by one, stopping at the first answer that ends the read (ENDS_READ).
        const each = new Map<string, AxValue | AxError>();
        for (const n of names) {
          const v = one(el, n, max);
          if (isAxError(v) && ENDS_READ.has(v.axError)) {
            for (const got of each.values()) releaseRefs(got);
            return v;
          }
          each.set(n, v);
        }
        return each;
      }
      const values = out[0];
      try {
        const items = cf.kind(values) === "array" ? cf.array(values) : [];
        return new Map(names.map((n, i) => [n, convert(items[i], max) ?? NO_VALUE]));
      } finally {
        cf.release(values);
      }
    },
    attr(el, name, max = 2000) {
      return one(el, name, max);
    },
    count(el, name) {
      const out: (number | bigint)[] = [0];
      const error = extra.AXUIElementGetAttributeValueCount(el, cf.key(name), out);
      return error === AX_ERROR.success ? Number(out[0]) : axError(error);
    },
    range(el, name, index, max) {
      const out: (Ref | null)[] = [null];
      const error = extra.AXUIElementCopyAttributeValues(el, cf.key(name), Math.max(0, index), Math.max(0, max), out);
      if (error !== AX_ERROR.success) {
        cf.release(out[0]);
        return axError(error);
      }
      try {
        return cf.array(out[0]).filter(isElement).map(r => cf.retain(r)!).filter(Boolean);
      } finally {
        cf.release(out[0]);
      }
    },
    settable(el, name) {
      const out = [0];
      const error = extra.AXUIElementIsAttributeSettable(el, cf.key(name), out);
      return error === AX_ERROR.success ? !!out[0] : axError(error);
    },
    actions(el) {
      const out: (Ref | null)[] = [null];
      const error = extra.AXUIElementCopyActionNames(el, out);
      if (error !== AX_ERROR.success) {
        cf.release(out[0]);
        return axError(error);
      }
      return cf.own(out[0], names => cf.array(names).map(n => cf.string(n, 200) ?? "").filter(Boolean)) ?? [];
    },
    set(el, name, v) {
      const { ref, own } = toCF(v);
      if (!ref) return axError(AX_ERROR.illegalArgument);
      try {
        const error = ax.set(el, name, ref);
        return error === AX_ERROR.success ? null : axError(error);
      } finally {
        if (own) cf.release(ref);
      }
    },
    perform(el, action) {
      const error = ax.perform(el, action);
      return error === AX_ERROR.success ? null : axError(error);
    },
    at(x, y, pid) {
      const base = pid === undefined ? ax.systemWide() : app(pid);
      if (!base) return axError(AX_ERROR.failure);
      const out: (Ref | null)[] = [null];
      const error = ax.raw.AXUIElementCopyElementAtPosition(base, x, y, out);
      if (error !== AX_ERROR.success || !out[0]) {
        cf.release(out[0]);
        return axError(error === AX_ERROR.success ? AX_ERROR.noValue : error);
      }
      return out[0];
    },
    textRange(el, location, length) {
      const buf = Buffer.alloc(RANGE_BYTES);
      buf.writeBigInt64LE(BigInt(Math.max(0, Math.floor(location))), 0);
      buf.writeBigInt64LE(BigInt(Math.max(0, Math.floor(length))), 8);
      const range = extra.AXValueCreate(AX_VALUE.cfRange, buf);
      if (!range) return axError(AX_ERROR.failure);
      const out: (Ref | null)[] = [null];
      let error: number;
      try {
        error = extra.AXUIElementCopyParameterizedAttributeValue(el, cf.key("AXStringForRange"), range, out);
      } finally {
        cf.release(range);
      }
      if (error !== AX_ERROR.success) {
        cf.release(out[0]);
        return axError(error);
      }
      const v = take(out[0], Math.max(0, length));
      return typeof v === "string" ? v : isAxError(v) ? v : axError(AX_ERROR.noValue);
    },
    pid(el) {
      return ax.pid(el) ?? 0;
    },
    windowId(win) {
      return ax.windowId(win);
    },
    hash(el) {
      return cf.hash(el);
    },
    same(a, b) {
      return cf.equal(a, b);
    },
    retain(el) {
      return cf.retain(el) ?? el;
    },
    release(el) {
      cf.release(el);
    },
    onScreenWindows() {
      const bounds = (dict: Ref | null): Rect | null => {
        if (!dict) return null;
        const out: Partial<CGRect> = {};
        return cg.CGRectMakeWithDictionaryRepresentation(dict, out) ? rectOf(out) : null;
      };
      const options = WINDOW_LIST.onScreenOnly | WINDOW_LIST.excludeDesktopElements;
      return cf.own(cg.CGWindowListCopyWindowInfo(options, NULL_WINDOW_ID), list => cf.array(list).flatMap(d => {
        const e = windowEntry({
          number: cf.number(cf.get(d, WINDOW_KEY.number)),
          pid: cf.number(cf.get(d, WINDOW_KEY.pid)),
          owner: cf.string(cf.get(d, WINDOW_KEY.owner), 256),
          name: cf.string(cf.get(d, WINDOW_KEY.name), 1024),
          bounds: bounds(cf.get(d, WINDOW_KEY.bounds)),
          layer: cf.number(cf.get(d, WINDOW_KEY.layer)),
          alpha: cf.number(cf.get(d, WINDOW_KEY.alpha)),
        });
        return e ? [e] : [];
      })) ?? [];
    },
    displays() {
      const max = 16;
      const buf = Buffer.alloc(max * 4), count = [0];
      if (cg.CGGetActiveDisplayList(max, buf, count) !== 0) return [];
      const out: Rect[] = [];
      for (let i = 0; i < Math.min(count[0] ?? 0, max); i++) {
        const r = rectOf(cg.CGDisplayBounds(buf.readUInt32LE(i * 4)));
        if (r) out.push(r);
      }
      return out;
    },
  };
}

/** Why the last openAxApi() returned null (for the provider's health). */
export let axApiError: unknown = null;
let opened: AxApi | null | undefined;

/**
 * The AX API for this process, bound once on first use with the 0.8 s messaging timeout (the first openAX() of a
 * process sets it: the host calls nothing else first). null off macOS or when a framework can't be bound
 * (axApiError says why).
 */
export function openAxApi(): AxApi | null {
  if (opened !== undefined) return opened;
  if (!onMacOS()) {
    axApiError = new Error(`macOS accessibility isn't available on ${process.platform}`);
    return null;
  }
  try {
    const cf = openCoreFoundation();
    if (!cf) throw cfError ?? new Error("CoreFoundation could not be bound");
    const ax = openAX(cf, AX_TIMEOUT_S);
    if (!ax) throw axBindError ?? new Error("ApplicationServices could not be bound");
    const cg = openCoreGraphics();
    if (!cg) throw cgError ?? new Error("CoreGraphics could not be bound");
    const koffi = koffiModule();
    const extra = {
      ...bindFunctions<Omit<AxExtraRaw, "CFNullGetTypeID">>(loadFirst(koffi, AX_PATHS), AX_EXTRA_PROTOTYPES),
      ...bindFunctions<Pick<AxExtraRaw, "CFNullGetTypeID">>(koffi.load(CF_PATH), CF_EXTRA_PROTOTYPES),
    };
    opened = makeAxApi({ cf, ax, cg, extra });
  } catch (err) {
    axApiError = err;
    opened = null;
  }
  return opened;
}
