/**
 * The native side of the macOS backends: what CoreGraphics, CoreFoundation, AX and HIToolbox can tell and do, as a
 * small interface of plain values (DarwinDesktop for reading, DarwinPoster for posting events). windows.ts and
 * input.ts decide everything over these interfaces, so their logic is unit-tested with fakes on any OS; this file is
 * only verified on a Mac (test/integration/darwin-desktop.test.ts). It never asks AX about Ember's own process: from
 * Electron's main thread that request would wait on the very thread that sends it, until the timeout.
 */

import { openCoreFoundation, type CF } from "./cf";
import {
  EVENT, FIELD, HID_EVENT_TAP, NULL_WINDOW_ID, PERMIT_ALL_EVENTS, SCROLL_UNIT, SESSION_KEY, SOURCE_STATE, SUPPRESSION_STATE,
  WINDOW_KEY, WINDOW_LIST, openCoreGraphics, rectOf, type CGRaw, type CGRect,
} from "./cg";
import { AX_ERROR, MAIN_THREAD_AX_TIMEOUT, openAX, type AX } from "./ax";
import { openHIToolbox, type HIToolbox, type KeyboardLayoutSource } from "./hitoolbox";
import { sameFrame, windowEntry, type AXWindowInfo, type CGWindowEntry } from "./model";
import type { Ref } from "./native";
import type { Rect } from "../types";

/** What the backends read from the system. Every method answers safely (null, [], false) when it can't tell. */
export interface DarwinDesktop {
  /** On-screen windows, front to back. */
  windows(): CGWindowEntry[];
  /** The pointer in global points (CGEventGetLocation of a fresh event). */
  pointer(): { x: number; y: number } | null;
  /** Is this CGMouseButton down (combined session state: the hardware's and posted events)? */
  buttonDown(button: number): boolean;
  /** CGEventSourceFlagsState of the combined session state. */
  flags(): number;
  /** Is this CGKeyCode down (combined session state)? */
  keyDown(cgKey: number): boolean;
  /** The frontmost app's pid (AX system-wide AXFocusedApplication), or null when AX can't tell. */
  frontmostPid(): number | null;
  /** The focused window of the app `pid` (AXFocusedWindow); null for Ember's own process. */
  focusedWindow(pid: number): AXWindowInfo | null;
  /** The app's windows as AX lists them (AXWindows); null when AX couldn't read them (or for Ember's own process). */
  appWindows(pid: number): AXWindowInfo[] | null;
  /** Brings `window` of app `pid` to the front (AXFrontmost on the app, then AXRaise and AXMain on the window). */
  raise(pid: number, window: number, bounds: Rect): boolean;
  /** AXIsProcessTrusted (with `prompt`, AXIsProcessTrustedWithOptions shows macOS's dialog). */
  trusted(prompt?: boolean): boolean;
  /** IsSecureEventInputEnabled (false when Carbon isn't available). */
  secureInput(): boolean;
  /** The session's lock state and the pid holding secure keyboard entry (CGSessionCopyCurrentDictionary). */
  session(): { locked: boolean; secureInputPid: number | null };
  /** CGPreflightScreenCaptureAccess (false when it can't be asked). */
  screenAccess(): boolean;
  /** The main display's bounds in points. */
  mainDisplay(): Rect | null;
  /** How many displays contain the point (CGGetDisplaysWithPoint). */
  displaysAt(x: number, y: number): number;
  /** Is the main display asleep? */
  displayAsleep(): boolean;
  /** The keyboard layout in use (the same object while it is unchanged), or null where it can't be read. */
  keyboardLayout(): KeyboardLayoutSource | null;
  /** Lets go of what the desktop keeps between calls (the keyboard layout's input source). */
  dispose?(): void;
}

/** Posting events (CGEventPost at the HID tap from one HID-state source with local suppression turned off). */
export interface DarwinPoster {
  mouse(type: number, x: number, y: number, button: number, clickState: number, flags: number): void;
  key(cgKey: number, down: boolean, flags: number): void;
  /** A key event that types `text` whatever the layout (CGEventKeyboardSetUnicodeString). */
  text(cgKey: number, text: string, down: boolean, flags: number): void;
  /** One scroll event, in lines: positive `lines` scrolls up, positive `columns` scrolls left. */
  scroll(lines: number, columns: number, flags: number): void;
  close(): void;
}

/** Why the last openDesktop() returned null (for the log). */
export let desktopError: unknown = null;

/** A CF value that means "yes": a true CFBoolean or a non-zero CFNumber. */
function truthy(cf: CF, ref: Ref | null): boolean | null {
  const b = cf.boolean(ref);
  if (b !== null) return b;
  const n = cf.number(ref);
  return n === null ? null : n !== 0;
}

/** DarwinDesktop over bound frameworks; `ownPid` is the process AX must never be asked about. */
export function makeDesktop(cf: CF, cg: CGRaw, ax: AX | null, hi: HIToolbox | null, ownPid = process.pid): DarwinDesktop {
  const listOptions = WINDOW_LIST.onScreenOnly | WINDOW_LIST.excludeDesktopElements;
  const bounds = (dict: Ref | null): Rect | null => {
    if (!dict) return null;
    const out: Partial<CGRect> = {};
    return cg.CGRectMakeWithDictionaryRepresentation(dict, out) ? rectOf(out) : null;
  };
  const entry = (d: Ref): CGWindowEntry | null => windowEntry({
    number: cf.number(cf.get(d, WINDOW_KEY.number)),
    pid: cf.number(cf.get(d, WINDOW_KEY.pid)),
    owner: cf.string(cf.get(d, WINDOW_KEY.owner), 256),
    name: cf.string(cf.get(d, WINDOW_KEY.name), 1024),
    bounds: bounds(cf.get(d, WINDOW_KEY.bounds)),
    layer: cf.number(cf.get(d, WINDOW_KEY.layer)),
    alpha: cf.number(cf.get(d, WINDOW_KEY.alpha)),
  });
  // The frame only matters when there is no window id to match by: each attribute read is a round trip that can
  // block Electron's main thread for the whole timeout, so AXPosition and AXSize aren't read when they aren't needed.
  const axWindow = (a: AX, w: Ref): AXWindowInfo => {
    const id = a.windowId(w);
    return { id, title: a.string(w, "AXTitle", 1024) ?? "", frame: id ? null : a.frame(w) };
  };
  /** Runs `fn` with another app's AX element (released afterwards); null without AX, and never for Ember itself. */
  const withApp = <T>(pid: number, fn: (app: Ref, a: AX) => T): T | null => {
    if (!ax || pid === ownPid) return null;
    return cf.own(ax.application(pid), app => fn(app, ax));
  };
  let layout: KeyboardLayoutSource | null = null;
  return {
    windows() {
      return cf.own(cg.CGWindowListCopyWindowInfo(listOptions, NULL_WINDOW_ID), list => {
        const out: CGWindowEntry[] = [];
        for (const d of cf.array(list)) {
          const e = entry(d);
          if (e) out.push(e);
        }
        return out;
      }) ?? [];
    },
    pointer() {
      return cf.own(cg.CGEventCreate(null), e => {
        const p = cg.CGEventGetLocation(e);
        return Number.isFinite(p?.x) && Number.isFinite(p?.y) ? { x: p.x, y: p.y } : null;
      });
    },
    buttonDown(button) {
      return !!cg.CGEventSourceButtonState(SOURCE_STATE.combinedSession, button);
    },
    flags() {
      return Number(cg.CGEventSourceFlagsState(SOURCE_STATE.combinedSession));
    },
    keyDown(cgKey) {
      return !!cg.CGEventSourceKeyState(SOURCE_STATE.combinedSession, cgKey);
    },
    frontmostPid() {
      const system = ax?.systemWide();
      if (!ax || !system) return null;
      return cf.own(ax.element(system, "AXFocusedApplication"), app => ax.pid(app));
    },
    focusedWindow(pid) {
      return withApp(pid, (app, a) => cf.own(a.element(app, "AXFocusedWindow"), w => axWindow(a, w)));
    },
    appWindows(pid) {
      return withApp(pid, (app, a) => a.withElements(app, "AXWindows", items => items.map(w => axWindow(a, w))));
    },
    raise(pid, window, at) {
      const yes = cf.kTrue;
      if (!yes) return false;
      return withApp(pid, (app, a) => {
        const fronted = a.set(app, "AXFrontmost", yes) === AX_ERROR.success;
        a.withElements(app, "AXWindows", items => {
          const byId = a.hasWindowIds ? items.filter(w => a.windowId(w) === window) : [];
          const found = byId.length ? byId : items.filter(w => sameFrame(a.frame(w), at));
          if (found.length !== 1) return; // no window, or several alike: raising a guess helps nobody
          a.perform(found[0]!, "AXRaise");
          a.set(found[0]!, "AXMain", yes);
        });
        return fronted;
      }) ?? false;
    },
    trusted(prompt) {
      return ax ? ax.trusted(prompt) : false;
    },
    secureInput() {
      return hi ? hi.secureInput() : false;
    },
    session() {
      return cf.own(cg.CGSessionCopyCurrentDictionary(), d => {
        const pid = cf.number(cf.get(d, SESSION_KEY.secureInputPid));
        // A session that isn't on the console (another user switched in) can't be seen either.
        const locked = truthy(cf, cf.get(d, SESSION_KEY.screenLocked)) === true || truthy(cf, cf.get(d, SESSION_KEY.onConsole)) === false;
        return { locked, secureInputPid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null };
      }) ?? { locked: false, secureInputPid: null };
    },
    screenAccess() {
      return cg.CGPreflightScreenCaptureAccess ? !!cg.CGPreflightScreenCaptureAccess() : false;
    },
    mainDisplay() {
      return rectOf(cg.CGDisplayBounds(cg.CGMainDisplayID()));
    },
    displaysAt(x, y) {
      const count = [0];
      return cg.CGGetDisplaysWithPoint({ x, y }, 0, null, count) === 0 ? count[0]! : 0;
    },
    displayAsleep() {
      return cg.CGDisplayIsAsleep(cg.CGMainDisplayID()) !== 0;
    },
    keyboardLayout() {
      if (!hi) return null;
      layout = hi.keyboardLayout(layout);
      return layout;
    },
    dispose() {
      layout?.release();
      layout = null;
    },
  };
}

/**
 * The desktop, bound on first use. null off macOS, or when CoreFoundation or CoreGraphics can't be bound
 * (desktopError says why). AX and HIToolbox are optional: without them the answers that need them are safe defaults.
 */
export function openDesktop(): DarwinDesktop | null {
  const cf = openCoreFoundation();
  const cg = openCoreGraphics();
  if (!cf || !cg) {
    desktopError = new Error(process.platform === "darwin" ? "CoreFoundation or CoreGraphics could not be bound" : "not macOS");
    return null;
  }
  return makeDesktop(cf, cg, openAX(cf, MAIN_THREAD_AX_TIMEOUT), openHIToolbox(cf));
}

/** DarwinPoster over bound frameworks: one event source for the poster's life, released by close(). */
export function makePoster(cf: CF, cg: CGRaw): DarwinPoster | null {
  const source = cg.CGEventSourceCreate(SOURCE_STATE.hidSystem);
  if (!source) return null;
  // By default the user's own mouse and keyboard are ignored for 0.25 s after every posted event: while Ember glides
  // (an event every 8 ms) the user could never take over. No suppression, and local events allowed through anyway.
  cg.CGEventSourceSetLocalEventsSuppressionInterval(source, 0);
  cg.CGEventSourceSetLocalEventsFilterDuringSuppressionState(source, PERMIT_ALL_EVENTS, SUPPRESSION_STATE.interval);
  cg.CGEventSourceSetLocalEventsFilterDuringSuppressionState(source, PERMIT_ALL_EVENTS, SUPPRESSION_STATE.remoteMouseDrag);
  let open = true;
  const post = (event: Ref | null, flags: number, prepare?: (e: Ref) => void) => {
    cf.own(event, e => {
      prepare?.(e);
      cg.CGEventSetFlags(e, flags);
      cg.CGEventPost(HID_EVENT_TAP, e);
    });
  };
  const isClick = (type: number) => type !== EVENT.mouseMoved;
  return {
    mouse(type, x, y, button, clickState, flags) {
      if (!open) return;
      post(cg.CGEventCreateMouseEvent(source, type, { x, y }, button), flags, e => {
        if (isClick(type) && clickState > 0) cg.CGEventSetIntegerValueField(e, FIELD.mouseClickState, clickState);
      });
    },
    key(cgKey, down, flags) {
      if (!open) return;
      post(cg.CGEventCreateKeyboardEvent(source, cgKey, down), flags);
    },
    text(cgKey, text, down, flags) {
      if (!open) return;
      const units = Buffer.from(text, "utf16le");
      post(cg.CGEventCreateKeyboardEvent(source, cgKey, down), flags, e => cg.CGEventKeyboardSetUnicodeString(e, units.length >> 1, units));
    },
    scroll(lines, columns, flags) {
      if (!open) return;
      post(cg.CGEventCreateScrollWheelEvent2(source, SCROLL_UNIT.line, 2, lines, columns, 0), flags);
    },
    close() {
      if (!open) return;
      open = false;
      cf.release(source);
    },
  };
}

/** The poster, or null off macOS or when the frameworks or the event source aren't available. */
export function openPoster(): DarwinPoster | null {
  const cf = openCoreFoundation(), cg = openCoreGraphics();
  return cf && cg ? makePoster(cf, cg) : null;
}
