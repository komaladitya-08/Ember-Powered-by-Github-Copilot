/**
 * CoreGraphics through koffi: the event functions (reading the pointer, buttons and keys; creating and posting mouse,
 * keyboard and scroll events), the window list, and the display geometry. Everything is in points, the unit Ember
 * uses on macOS (CGEvent, CGWindowList, AX and Electron's screen agree on it). Like cf.ts it is shared with the
 * future accessibility provider, imports no Electron, and binds nothing until openCoreGraphics() runs on macOS.
 * The constants below are the CGEventTypes.h / CGWindow.h values the backends use.
 */

import { bindFunctions, bindOptional, framework, koffiModule, namedStruct, onMacOS } from "./native";
import type { Koffi, Ref } from "./native";

export const CG_PATH = framework("CoreGraphics");

/** CGEventSourceStateID. */
export const SOURCE_STATE = { private: -1, combinedSession: 0, hidSystem: 1 } as const;
/** CGEventTapLocation: kCGHIDEventTap (events enter where the hardware's do). */
export const HID_EVENT_TAP = 0;
/** CGEventType values. */
export const EVENT = {
  leftMouseDown: 1, leftMouseUp: 2, rightMouseDown: 3, rightMouseUp: 4, mouseMoved: 5,
  leftMouseDragged: 6, rightMouseDragged: 7, keyDown: 10, keyUp: 11, flagsChanged: 12, scrollWheel: 22,
  otherMouseDown: 25, otherMouseUp: 26, otherMouseDragged: 27,
} as const;
/** CGMouseButton values (3 and up are the other buttons: back, forward…). */
export const MOUSE_BUTTON = { left: 0, right: 1, center: 2 } as const;
/** CGEventField values. */
export const FIELD = { mouseClickState: 1, mouseButtonNumber: 3 } as const;
/** CGEventFlags masks. */
export const FLAG = {
  alphaShift: 0x10000, shift: 0x20000, control: 0x40000, alternate: 0x80000, command: 0x100000,
  numericPad: 0x200000, help: 0x400000, secondaryFn: 0x800000, nonCoalesced: 0x100,
} as const;
/** CGScrollEventUnit. */
export const SCROLL_UNIT = { pixel: 0, line: 1 } as const;
/** CGWindowListOption bits, and kCGNullWindowID. */
export const WINDOW_LIST = { onScreenOnly: 1, excludeDesktopElements: 16 } as const;
export const NULL_WINDOW_ID = 0;
/** kCGEventFilterMaskPermitAllEvents, and the two CGEventSuppressionState values. */
export const PERMIT_ALL_EVENTS = 7;
export const SUPPRESSION_STATE = { interval: 0, remoteMouseDrag: 1 } as const;

/** The keys of a CGWindowList entry (the exported kCGWindow* CFStrings have exactly these values). */
export const WINDOW_KEY = {
  number: "kCGWindowNumber", pid: "kCGWindowOwnerPID", owner: "kCGWindowOwnerName", name: "kCGWindowName",
  bounds: "kCGWindowBounds", layer: "kCGWindowLayer", alpha: "kCGWindowAlpha",
} as const;
/** Keys of CGSessionCopyCurrentDictionary() (the screen-lock and secure-input ones are undocumented but stable). */
export const SESSION_KEY = {
  screenLocked: "CGSSessionScreenIsLocked", onConsole: "kCGSSessionOnConsoleKey", secureInputPid: "kCGSSessionSecureInputPID",
} as const;

export interface CGPoint { x: number; y: number }
export interface CGSize { width: number; height: number }
export interface CGRect { origin: CGPoint; size: CGSize }

/**
 * The koffi prototypes, by C name. CGPoint and CGRect travel by value (koffi handles the x64 and arm64 ABIs);
 * Boolean/bool results are one byte, boolean_t (CGDisplayIsAsleep) is an int.
 */
export const CG_PROTOTYPES = {
  CGEventCreate: "void *CGEventCreate(void *source)",
  CGEventGetLocation: "EmberCGPoint CGEventGetLocation(void *event)",
  CGEventCreateMouseEvent: "void *CGEventCreateMouseEvent(void *source, uint32_t type, EmberCGPoint position, uint32_t button)",
  CGEventCreateKeyboardEvent: "void *CGEventCreateKeyboardEvent(void *source, uint16_t keycode, bool down)",
  // Not the variadic CGEventCreateScrollWheelEvent: Scroll2 has three fixed wheels (macOS 10.13+).
  CGEventCreateScrollWheelEvent2: "void *CGEventCreateScrollWheelEvent2(void *source, uint32_t units, uint32_t wheelCount, int32_t wheel1, int32_t wheel2, int32_t wheel3)",
  CGEventKeyboardSetUnicodeString: "void CGEventKeyboardSetUnicodeString(void *event, unsigned long length, const void *chars)",
  CGEventSetFlags: "void CGEventSetFlags(void *event, uint64_t flags)",
  CGEventSetIntegerValueField: "void CGEventSetIntegerValueField(void *event, uint32_t field, int64_t value)",
  CGEventPost: "void CGEventPost(uint32_t tap, void *event)",
  CGEventSourceCreate: "void *CGEventSourceCreate(int32_t state)",
  CGEventSourceSetLocalEventsSuppressionInterval: "void CGEventSourceSetLocalEventsSuppressionInterval(void *source, double seconds)",
  CGEventSourceSetLocalEventsFilterDuringSuppressionState: "void CGEventSourceSetLocalEventsFilterDuringSuppressionState(void *source, uint32_t filter, uint32_t state)",
  CGEventSourceButtonState: "bool CGEventSourceButtonState(int32_t state, uint32_t button)",
  CGEventSourceKeyState: "bool CGEventSourceKeyState(int32_t state, uint16_t key)",
  CGEventSourceFlagsState: "uint64_t CGEventSourceFlagsState(int32_t state)",
  CGWindowListCopyWindowInfo: "void *CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)",
  CGRectMakeWithDictionaryRepresentation: "bool CGRectMakeWithDictionaryRepresentation(void *dict, _Out_ EmberCGRect *rect)",
  CGMainDisplayID: "uint32_t CGMainDisplayID(void)",
  CGDisplayBounds: "EmberCGRect CGDisplayBounds(uint32_t display)",
  CGDisplayIsAsleep: "int CGDisplayIsAsleep(uint32_t display)",
  CGGetActiveDisplayList: "int32_t CGGetActiveDisplayList(uint32_t max, void *displays, _Out_ uint32_t *count)",
  CGGetDisplaysWithPoint: "int32_t CGGetDisplaysWithPoint(EmberCGPoint point, uint32_t max, void *displays, _Out_ uint32_t *count)",
  CGSessionCopyCurrentDictionary: "void *CGSessionCopyCurrentDictionary(void)",
} as const;

/** Functions newer than some macOS Ember might meet, bound when present. */
export const CG_OPTIONAL_PROTOTYPES = {
  CGPreflightScreenCaptureAccess: "bool CGPreflightScreenCaptureAccess(void)",
  CGPreflightPostEventAccess: "bool CGPreflightPostEventAccess(void)",
} as const;

/** CoreGraphics as koffi binds it. */
export interface CGRaw {
  CGEventCreate(source: Ref | null): Ref | null;
  CGEventGetLocation(event: Ref): CGPoint;
  CGEventCreateMouseEvent(source: Ref | null, type: number, position: CGPoint, button: number): Ref | null;
  CGEventCreateKeyboardEvent(source: Ref | null, keycode: number, down: boolean): Ref | null;
  CGEventCreateScrollWheelEvent2(source: Ref | null, units: number, wheelCount: number, wheel1: number, wheel2: number, wheel3: number): Ref | null;
  CGEventKeyboardSetUnicodeString(event: Ref, length: number, chars: Buffer): void;
  CGEventSetFlags(event: Ref, flags: number): void;
  CGEventSetIntegerValueField(event: Ref, field: number, value: number): void;
  CGEventPost(tap: number, event: Ref): void;
  CGEventSourceCreate(state: number): Ref | null;
  CGEventSourceSetLocalEventsSuppressionInterval(source: Ref, seconds: number): void;
  CGEventSourceSetLocalEventsFilterDuringSuppressionState(source: Ref, filter: number, state: number): void;
  CGEventSourceButtonState(state: number, button: number): boolean;
  CGEventSourceKeyState(state: number, key: number): boolean;
  CGEventSourceFlagsState(state: number): number | bigint;
  CGWindowListCopyWindowInfo(option: number, relativeToWindow: number): Ref | null;
  CGRectMakeWithDictionaryRepresentation(dict: Ref, rect: Partial<CGRect>): boolean;
  CGMainDisplayID(): number;
  CGDisplayBounds(display: number): CGRect;
  CGDisplayIsAsleep(display: number): number;
  CGGetActiveDisplayList(max: number, displays: Buffer | null, count: number[]): number;
  CGGetDisplaysWithPoint(point: CGPoint, max: number, displays: Buffer | null, count: number[]): number;
  CGSessionCopyCurrentDictionary(): Ref | null;
  CGPreflightScreenCaptureAccess?(): boolean;
  CGPreflightPostEventAccess?(): boolean;
}

/** koffi's named types for CoreGraphics' structs (defined once per process). */
export function cgTypes(koffi: Koffi): void {
  namedStruct(koffi, "EmberCGPoint", { x: "double", y: "double" });
  namedStruct(koffi, "EmberCGSize", { width: "double", height: "double" });
  namedStruct(koffi, "EmberCGRect", { origin: "EmberCGPoint", size: "EmberCGSize" });
}

/** Why the last openCoreGraphics() returned null (for the log). */
export let cgError: unknown = null;
let bound: CGRaw | null | undefined;

/** CoreGraphics, bound once per process on first use; null off macOS or when it can't be bound (cgError says why). */
export function openCoreGraphics(): CGRaw | null {
  if (bound !== undefined) return bound;
  if (!onMacOS()) return null;
  try {
    const koffi = koffiModule();
    cgTypes(koffi);
    const lib = koffi.load(CG_PATH);
    const raw = bindFunctions<CGRaw>(lib, CG_PROTOTYPES);
    for (const [name, prototype] of Object.entries(CG_OPTIONAL_PROTOTYPES)) {
      const fn = bindOptional<() => boolean>(lib, prototype);
      if (fn) (raw as unknown as Record<string, unknown>)[name] = fn;
    }
    bound = raw;
  } catch (err) {
    cgError = err;
    bound = null;
  }
  return bound;
}

/** A CGRect as Ember's Rect. */
export function rectOf(r: CGRect | Partial<CGRect> | null | undefined): { x: number; y: number; width: number; height: number } | null {
  const o = r?.origin, s = r?.size;
  if (!o || !s) return null;
  const v = [o.x, o.y, s.width, s.height];
  if (!v.every(n => typeof n === "number" && Number.isFinite(n))) return null;
  return { x: o.x, y: o.y, width: s.width, height: s.height };
}
