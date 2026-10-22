/**
 * The macOS accessibility C API (ApplicationServices/HIServices) through koffi: AXUIElement attribute reads and
 * writes, actions, the pid of an element, hit-testing, AXValue decoding, the process's Accessibility trust, and the
 * private but long-stable _AXUIElementGetWindow (element → CGWindowID; yabai, Hammerspoon and Rectangle rely on it),
 * bound only when present. Every AX call is a synchronous IPC to the target app, so openAX() sets the process-wide
 * messaging timeout first (0.25 s in Electron's main process, where these calls block the UI thread). Never ask
 * AX about Ember's own process from its main thread: the request would wait for the thread that is asking.
 * Shared with the future accessibility provider; imports no Electron and binds nothing until openAX() runs on macOS.
 */

import { bindFunctions, bindOptional, framework, globalPointer, koffiModule, loadFirst, onMacOS } from "./native";
import type { Ref } from "./native";
import type { CF } from "./cf";
import type { Rect } from "../types";

export const AX_PATHS = [framework("ApplicationServices"), framework("ApplicationServices", "HIServices")];

/** AXError values (AXError.h). */
export const AX_ERROR = {
  success: 0, failure: -25200, illegalArgument: -25201, invalidUIElement: -25202, invalidUIElementObserver: -25203,
  cannotComplete: -25204, attributeUnsupported: -25205, actionUnsupported: -25206, notificationUnsupported: -25207,
  notImplemented: -25208, notificationAlreadyRegistered: -25209, notificationNotRegistered: -25210, apiDisabled: -25211,
  noValue: -25212, parameterizedAttributeUnsupported: -25213, notEnoughPrecision: -25214,
} as const;

/** AXValueType values (AXValue.h). */
export const AX_VALUE = { cgPoint: 1, cgSize: 2, cgRect: 3, cfRange: 4, axError: 5 } as const;

/** The messaging timeout for AX calls made on Electron's main thread (seconds). */
export const MAIN_THREAD_AX_TIMEOUT = 0.25;

/** The koffi prototypes, by C name (pid_t is int32; the hit-test coordinates and the timeout are floats). */
export const AX_PROTOTYPES = {
  AXUIElementCreateSystemWide: "void *AXUIElementCreateSystemWide(void)",
  AXUIElementCreateApplication: "void *AXUIElementCreateApplication(int32_t pid)",
  AXUIElementCopyAttributeValue: "int32_t AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)",
  AXUIElementCopyAttributeNames: "int32_t AXUIElementCopyAttributeNames(void *element, _Out_ void **names)",
  AXUIElementSetAttributeValue: "int32_t AXUIElementSetAttributeValue(void *element, void *attribute, void *value)",
  AXUIElementPerformAction: "int32_t AXUIElementPerformAction(void *element, void *action)",
  AXUIElementGetPid: "int32_t AXUIElementGetPid(void *element, _Out_ int32_t *pid)",
  AXUIElementSetMessagingTimeout: "int32_t AXUIElementSetMessagingTimeout(void *element, float seconds)",
  AXUIElementCopyElementAtPosition: "int32_t AXUIElementCopyElementAtPosition(void *application, float x, float y, _Out_ void **element)",
  AXUIElementGetTypeID: "unsigned long AXUIElementGetTypeID(void)",
  AXValueGetTypeID: "unsigned long AXValueGetTypeID(void)",
  AXValueGetType: "uint32_t AXValueGetType(void *value)",
  AXValueGetValue: "bool AXValueGetValue(void *value, uint32_t type, void *out)",
  AXIsProcessTrusted: "bool AXIsProcessTrusted(void)",
  AXIsProcessTrustedWithOptions: "bool AXIsProcessTrustedWithOptions(void *options)",
} as const;

/** Private SPI, bound when present: the CGWindowID of an AX window. */
export const AX_GET_WINDOW_PROTOTYPE = "int32_t _AXUIElementGetWindow(void *element, _Out_ uint32_t *window)";

/** The AX functions as koffi binds them. */
export interface AXRaw {
  AXUIElementCreateSystemWide(): Ref | null;
  AXUIElementCreateApplication(pid: number): Ref | null;
  AXUIElementCopyAttributeValue(element: Ref, attribute: Ref, value: (Ref | null)[]): number;
  AXUIElementCopyAttributeNames(element: Ref, names: (Ref | null)[]): number;
  AXUIElementSetAttributeValue(element: Ref, attribute: Ref, value: Ref): number;
  AXUIElementPerformAction(element: Ref, action: Ref): number;
  AXUIElementGetPid(element: Ref, pid: number[]): number;
  AXUIElementSetMessagingTimeout(element: Ref, seconds: number): number;
  AXUIElementCopyElementAtPosition(application: Ref, x: number, y: number, element: (Ref | null)[]): number;
  AXUIElementGetTypeID(): number | bigint;
  AXValueGetTypeID(): number | bigint;
  AXValueGetType(value: Ref): number;
  AXValueGetValue(value: Ref, type: number, out: Buffer): boolean;
  AXIsProcessTrusted(): boolean;
  AXIsProcessTrustedWithOptions(options: Ref | null): boolean;
  _AXUIElementGetWindow?(element: Ref, window: number[]): number;
  /** kAXTrustedCheckOptionPrompt (an exported CFStringRef), or null. */
  readonly kAXTrustedCheckOptionPrompt: Ref | null;
}

/** A decoded AXValue. */
export type AXValue =
  | { type: "point"; x: number; y: number }
  | { type: "size"; width: number; height: number }
  | { type: "rect"; x: number; y: number; width: number; height: number }
  | { type: "range"; location: number; length: number };

/** The name of an AXError code, for logs ("cannotComplete"), or the number itself when unknown. */
export function axErrorName(code: number): string {
  for (const [name, value] of Object.entries(AX_ERROR)) if (value === code) return name;
  return String(code);
}

/** Decodes what AXValueGetValue wrote for `type` (CGPoint/CGSize: two doubles; CGRect: four; CFRange: two longs). */
export function decodeAXValue(type: number, buf: Buffer): AXValue | null {
  if (buf.length < 32) return null;
  const d = (i: number) => buf.readDoubleLE(i * 8);
  const finite = (...v: number[]) => v.every(Number.isFinite);
  switch (type) {
    case AX_VALUE.cgPoint: return finite(d(0), d(1)) ? { type: "point", x: d(0), y: d(1) } : null;
    case AX_VALUE.cgSize: return finite(d(0), d(1)) ? { type: "size", width: d(0), height: d(1) } : null;
    case AX_VALUE.cgRect: return finite(d(0), d(1), d(2), d(3)) ? { type: "rect", x: d(0), y: d(1), width: d(2), height: d(3) } : null;
    case AX_VALUE.cfRange: return { type: "range", location: Number(buf.readBigInt64LE(0)), length: Number(buf.readBigInt64LE(8)) };
    default: return null;
  }
}

/** The AX API, the JS way round. Elements are Refs; what a "copy" method returns is owned (+1) by the caller. */
export interface AX {
  readonly raw: AXRaw;
  readonly cf: CF;
  /** True when _AXUIElementGetWindow is available (else windows are matched by pid and frame). */
  readonly hasWindowIds: boolean;
  /** The system-wide element (kept for the process: never release it). */
  systemWide(): Ref | null;
  /** AXUIElementCreateApplication (+1), or null. */
  application(pid: number): Ref | null;
  /** AXUIElementCopyAttributeValue: the AXError and the owned value (null unless success). */
  copy(element: Ref, attribute: string): { error: number; value: Ref | null };
  /** An attribute as a string / number / boolean / decoded AXValue (copied, converted and released). */
  string(element: Ref, attribute: string, max?: number): string | null;
  number(element: Ref, attribute: string): number | null;
  boolean(element: Ref, attribute: string): boolean | null;
  value(element: Ref, attribute: string): AXValue | null;
  /** AXPosition + AXSize as a Rect (points). */
  frame(element: Ref): Rect | null;
  /** An element-valued attribute (+1: release it), e.g. AXFocusedWindow. */
  element(element: Ref, attribute: string): Ref | null;
  /**
   * Calls `fn` with the elements of an array-valued attribute (AXWindows, AXChildren), borrowed for the call, then
   * releases the array. null when the attribute couldn't be read (AX unavailable, not trusted, the app is busy).
   */
  withElements<T>(element: Ref, attribute: string, fn: (items: Ref[]) => T): T | null;
  attributeNames(element: Ref): string[];
  pid(element: Ref): number | null;
  /** The CGWindowID of an AX window (0 when unknown or the SPI is missing). */
  windowId(element: Ref): number;
  /** AXUIElementSetAttributeValue; returns the AXError. */
  set(element: Ref, attribute: string, value: Ref): number;
  /** AXUIElementPerformAction; returns the AXError. */
  perform(element: Ref, action: string): number;
  /** AXUIElementCopyElementAtPosition on `application` (the system-wide element for any app), +1. */
  elementAt(application: Ref, x: number, y: number): Ref | null;
  setTimeout(element: Ref, seconds: number): number;
  /** Is this process trusted for Accessibility? With `prompt`, macOS shows its "allow" dialog when it isn't. */
  trusted(prompt?: boolean): boolean;
}

/** The AX helpers over raw functions (koffi's in openAX(), a fake in the tests). */
export function makeAX(raw: AXRaw, cf: CF): AX {
  let system: Ref | null | undefined;
  let valueTypeId: number | null = null;
  const isAXValue = (ref: Ref) => Number(cf.raw.CFGetTypeID(ref)) === (valueTypeId ??= Number(raw.AXValueGetTypeID()));
  const copy = (element: Ref, attribute: string) => {
    const out: (Ref | null)[] = [null];
    const error = raw.AXUIElementCopyAttributeValue(element, cf.key(attribute), out);
    const value = out[0] ?? null;
    if (error !== AX_ERROR.success) {
      cf.release(value); // a failed copy shouldn't return one, but never leak it if it does
      return { error, value: null };
    }
    return { error, value };
  };
  const decode = (ref: Ref): AXValue | null => {
    if (!isAXValue(ref)) return null;
    const type = raw.AXValueGetType(ref);
    const buf = Buffer.alloc(32);
    return raw.AXValueGetValue(ref, type, buf) ? decodeAXValue(type, buf) : null;
  };
  const ax: AX = {
    raw,
    cf,
    hasWindowIds: !!raw._AXUIElementGetWindow,
    systemWide() {
      if (system === undefined) system = raw.AXUIElementCreateSystemWide() ?? null;
      return system;
    },
    application(pid) {
      return Number.isInteger(pid) && pid > 0 ? raw.AXUIElementCreateApplication(pid) ?? null : null;
    },
    copy,
    string(element, attribute, max) {
      return cf.own(copy(element, attribute).value, v => cf.string(v, max));
    },
    number(element, attribute) {
      return cf.own(copy(element, attribute).value, v => cf.number(v));
    },
    boolean(element, attribute) {
      return cf.own(copy(element, attribute).value, v => cf.boolean(v));
    },
    value(element, attribute) {
      return cf.own(copy(element, attribute).value, decode);
    },
    frame(element) {
      const p = ax.value(element, "AXPosition"), s = ax.value(element, "AXSize");
      if (p?.type !== "point" || s?.type !== "size") return null;
      return { x: p.x, y: p.y, width: s.width, height: s.height };
    },
    element(element, attribute) {
      return copy(element, attribute).value;
    },
    withElements(element, attribute, fn) {
      const { value } = copy(element, attribute);
      if (!value) return null;
      try {
        return cf.kind(value) === "array" ? fn(cf.array(value)) : null;
      } finally {
        cf.release(value);
      }
    },
    attributeNames(element) {
      const out: (Ref | null)[] = [null];
      if (raw.AXUIElementCopyAttributeNames(element, out) !== AX_ERROR.success) {
        cf.release(out[0]);
        return [];
      }
      return cf.own(out[0], names => cf.array(names).map(n => cf.string(n) ?? "").filter(Boolean)) ?? [];
    },
    pid(element) {
      const out = [0];
      return raw.AXUIElementGetPid(element, out) === AX_ERROR.success && out[0]! > 0 ? out[0]! : null;
    },
    windowId(element) {
      if (!raw._AXUIElementGetWindow) return 0;
      const out = [0];
      return raw._AXUIElementGetWindow(element, out) === AX_ERROR.success && out[0]! > 0 ? out[0]! : 0;
    },
    set(element, attribute, value) {
      return raw.AXUIElementSetAttributeValue(element, cf.key(attribute), value);
    },
    perform(element, action) {
      return raw.AXUIElementPerformAction(element, cf.key(action));
    },
    elementAt(application, x, y) {
      const out: (Ref | null)[] = [null];
      if (raw.AXUIElementCopyElementAtPosition(application, x, y, out) !== AX_ERROR.success) {
        cf.release(out[0]);
        return null;
      }
      return out[0] ?? null;
    },
    setTimeout(element, seconds) {
      return raw.AXUIElementSetMessagingTimeout(element, seconds);
    },
    trusted(prompt = false) {
      if (!prompt || !raw.kAXTrustedCheckOptionPrompt || !cf.kTrue) return !!raw.AXIsProcessTrusted();
      const options = cf.createDictionary([[raw.kAXTrustedCheckOptionPrompt, cf.kTrue]]);
      if (!options) return !!raw.AXIsProcessTrusted();
      try {
        return !!raw.AXIsProcessTrustedWithOptions(options);
      } finally {
        cf.release(options);
      }
    },
  };
  return ax;
}

/** Why the last openAX() returned null (for the log). */
export let axError: unknown = null;
let boundRaw: AXRaw | null | undefined;
const made = new WeakMap<CF, AX>();

/**
 * The AX API over `cf`, bound once per process on first use, with the process-wide messaging timeout set to
 * `timeout` seconds (the first caller's value wins: every caller in one process should agree). null off macOS or
 * when ApplicationServices can't be bound (axError says why).
 */
export function openAX(cf: CF, timeout = MAIN_THREAD_AX_TIMEOUT): AX | null {
  const ready = made.get(cf);
  if (ready) return ready;
  if (!onMacOS()) return null;
  if (boundRaw === undefined) {
    try {
      const koffi = koffiModule();
      const lib = loadFirst(koffi, AX_PATHS);
      const raw = bindFunctions<AXRaw>(lib, AX_PROTOTYPES);
      const getWindow = bindOptional<NonNullable<AXRaw["_AXUIElementGetWindow"]>>(lib, AX_GET_WINDOW_PROTOTYPE);
      boundRaw = { ...raw, _AXUIElementGetWindow: getWindow, kAXTrustedCheckOptionPrompt: globalPointer(koffi, lib, "kAXTrustedCheckOptionPrompt") };
    } catch (err) {
      axError = err;
      boundRaw = null;
    }
  }
  if (!boundRaw) return null;
  const ax = makeAX(boundRaw, cf);
  // On the system-wide element this sets the default for every element of this process (otherwise about 6 s).
  const system = ax.systemWide();
  if (system) ax.setTimeout(system, timeout);
  made.set(cf, ax);
  return ax;
}
