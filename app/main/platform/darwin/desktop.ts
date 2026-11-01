/**
 * The native side of the macOS backends: what CoreGraphics, CoreFoundation, AX, HIToolbox and libproc can tell and
 * do, as a small interface of plain values (DarwinDesktop for reading, DarwinPoster for posting events). windows.ts
 * and input.ts decide everything over these interfaces, so their logic is unit-tested with fakes on any OS; the
 * bindings themselves are only verified on a Mac (test/integration/darwin-desktop.test.ts). It never asks AX about
 * Ember's own process: from Electron's main thread that request would wait on the very thread that sends it, until
 * the timeout. A borrow polls it every 8 ms on that same thread, so the window list is cached for 30 ms and every
 * key's state is one GetKeys call where it binds.
 */

import { execFile } from "node:child_process";
import { openCoreFoundation, type CF } from "./cf";
import {
  EVENT, FIELD, HID_EVENT_TAP, NULL_WINDOW_ID, PERMIT_ALL_EVENTS, SCROLL_UNIT, SESSION_KEY, SOURCE_STATE, SUPPRESSION_STATE,
  WINDOW_KEY, WINDOW_LIST, openCoreGraphics, rectOf, type CGRaw, type CGRect,
} from "./cg";
import { AX_ERROR, MAIN_THREAD_AX_TIMEOUT, openAX, type AX } from "./ax";
import { openHIToolbox, type HIToolbox, type KeyboardLayoutSource } from "./hitoolbox";
import { MAX_CG_KEY } from "./keys";
import { bundleOf, dockTitled, isDockItself, keysInMap, processName, sameFrame, secureInputState, windowEntry, withDockStrip, type AXWindowInfo, type CGWindowEntry } from "./model";
import { bindOptional, koffiModule, onMacOS } from "./native";
import type { Ref } from "./native";
import type { Rect } from "../types";
import type { Logger } from "../../logger";

/** How long the window list is reused (a borrow step every 8 ms never needs a fresher one). */
export const WINDOW_CACHE_MS = 30;
/** How long the Dock's strip is kept: one AX read of the Dock (a system process that answers at once) a second. */
export const DOCK_CACHE_MS = 1000;
/**
 * How long raise() waits for macOS to activate the app before going through LaunchServices instead: macOS 14 and
 * later may decline an activation a background process asks for (cooperative activation), and CursorBorrow waits
 * up to a second for the window to have the keyboard.
 */
export const ACTIVATION_FALLBACK_MS = 300;

/** What CGSessionCopyCurrentDictionary() says about the session. */
export interface DarwinSession {
  /** The screen is locked, or this session isn't the one on the console (another user switched in). */
  locked: boolean;
  /** The process holding secure keyboard entry (kCGSSessionSecureInputPID), or null when none does. */
  secureInputPid: number | null;
}

/** What the backends read from the system. Every method answers safely (null, [], false) when it can't tell. */
export interface DarwinDesktop {
  /** On-screen windows, front to back; the Dock's own window cut down to the Dock's strip where AX tells it (withDockStrip). */
  windows(): CGWindowEntry[];
  /** The pointer in global points (CGEventGetLocation of a fresh event). */
  pointer(): { x: number; y: number } | null;
  /** Is this CGMouseButton down (combined session state: the hardware's and posted events)? */
  buttonDown(button: number): boolean;
  /** CGEventSourceFlagsState of the combined session state. */
  flags(): number;
  /** Is this CGKeyCode down (combined session state)? */
  keyDown(cgKey: number): boolean;
  /** Every CGKeyCode down now: one GetKeys call where it binds, else keyDown() for each of the 128 codes. */
  keysDown(): number[];
  /** The frontmost app's pid (AX system-wide AXFocusedApplication), or null when AX can't tell. */
  frontmostPid(): number | null;
  /** The focused window of the app `pid` (AXFocusedWindow); null for Ember's own process. */
  focusedWindow(pid: number): AXWindowInfo | null;
  /** The app's windows as AX lists them (AXWindows); null when AX couldn't read them (or for Ember's own process). */
  appWindows(pid: number): AXWindowInfo[] | null;
  /**
   * Brings `window` of app `pid` to the front (AXFrontmost on the app, then AXRaise and AXMain on the window). When
   * the app still isn't frontmost 300 ms later and nothing else took the focus meanwhile, it activates the app through
   * LaunchServices (`open -a` with its bundle) and raises the window again. Never for Ember's own process.
   */
  raise(pid: number, window: number, bounds: Rect): boolean;
  /** AXIsProcessTrusted (with `prompt`, AXIsProcessTrustedWithOptions shows macOS's dialog). */
  trusted(prompt?: boolean): boolean;
  /** IsSecureEventInputEnabled; null when it can't be called (HIToolbox or the symbol is missing). */
  secureInput(): boolean | null;
  /** The session's lock state and secure-input holder; null when the session dictionary can't be read. */
  session(): DarwinSession | null;
  /** CGPreflightScreenCaptureAccess (false when it can't be asked). */
  screenAccess(): boolean;
  /**
   * CGPreflightListenEventAccess: may this process observe the keyboard (Input Monitoring)? null where the call
   * doesn't exist (before macOS 10.15, which has no such permission).
   */
  listenAccess(): boolean | null;
  /** CGRequestListenEventAccess: asks for Input Monitoring (macOS prompts once); null where the call doesn't exist. */
  requestListenAccess(): boolean | null;
  /** CGPreflightPostEventAccess: are the events this process posts delivered? null where the call doesn't exist. */
  postAccess(): boolean | null;
  /** Is the current input source a keyboard layout, not an input method? null when it can't be read. */
  inputSourceIsLayout(): boolean | null;
  /** A process's executable (proc_pidpath), or null when it can't be read. */
  processPath(pid: number): string | null;
  /** The main display's bounds in points. */
  mainDisplay(): Rect | null;
  /** How many displays contain the point (CGGetDisplaysWithPoint). */
  displaysAt(x: number, y: number): number;
  /** Is the main display asleep? */
  displayAsleep(): boolean;
  /** The keyboard layout in use (the same object while it is unchanged), or null where it can't be read. */
  keyboardLayout(): KeyboardLayoutSource | null;
  /** Lets go of what the desktop keeps between calls (the keyboard layout's input source, a pending activation). */
  dispose?(): void;
}

/**
 * Secure keyboard entry with the app holding it: `on` is null when Ember can't tell (callers act as if it were on),
 * `pid` the holder when the session names one, and `app` its name ("" when unknown): a window's owner name, else the
 * process's bundle or file name, so a stuck Secure Keyboard Entry (Terminal's, a password manager's) is named.
 */
export interface DarwinSecureInput {
  on: boolean | null;
  pid: number | null;
  app: string;
}

/** Secure keyboard entry as the desktop reports it (see secureInputState() for how the two signals combine). */
export function secureInputOf(desktop: Pick<DarwinDesktop, "secureInput" | "session" | "windows" | "processPath">): DarwinSecureInput {
  const api = desktop.secureInput();
  // The session is read only when it matters (the holder while on, the signal when the call can't answer): a borrow
  // asks before every character it types.
  const { on, pid } = secureInputState(api, api === false ? null : desktop.session());
  if (pid === null) return { on, pid, app: "" };
  return { on, pid, app: desktop.windows().find(e => e.pid === pid)?.owner || processName(desktop.processPath(pid)) };
}

/**
 * What holds Ember back while secure keyboard entry is on, as a clause in lower case without a full stop: the input's
 * refusal and the window system's systemDialogReason() both start from it (Terminal's “Secure Keyboard Entry” is on
 * for good on many managed Macs, and a password field left focused keeps it on, so "a system dialog is open" would
 * send the user looking for a dialog that isn't there).
 */
export function secureInputCause(app: string): string {
  const where = app ? ` in ${app}` : "";
  return `secure keyboard entry is on${where} (a password field, or Terminal's “Secure Keyboard Entry”)`;
}

/** Tunables and seams for makeDesktop() (the defaults are the real ones). */
export interface DesktopOptions {
  /** The process AX must never be asked about (Ember's own). */
  ownPid?: number;
  now?: () => number;
  windowCacheMs?: number;
  /** Runs `fn` after `ms`; returns the cancel. */
  later?: (ms: number, fn: () => void) => () => void;
  /** Activates an app through LaunchServices (`/usr/bin/open -a <bundle>`), calling `done` when that returns. */
  openApp?: (bundle: string, done: () => void) => void;
  /** proc_pidpath. */
  processPath?: (pid: number) => string | null;
  log?: Pick<Logger, "info">;
}

const defaultLater = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

const defaultOpenApp = (bundle: string, done: () => void): void => {
  execFile("/usr/bin/open", ["-a", bundle], { timeout: 5000 }, () => done());
};

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

/** DarwinDesktop over bound frameworks (koffi's in openDesktop(), fakes in the tests). */
export function makeDesktop(cf: CF, cg: CGRaw, ax: AX | null, hi: HIToolbox | null, o: DesktopOptions = {}): DarwinDesktop {
  const ownPid = o.ownPid ?? process.pid;
  const now = o.now ?? Date.now;
  const cacheMs = o.windowCacheMs ?? WINDOW_CACHE_MS;
  const later = o.later ?? defaultLater;
  const openApp = o.openApp ?? defaultOpenApp;
  const processPath = (pid: number): string | null => {
    try {
      return o.processPath?.(pid) ?? null;
    } catch {
      return null; // can't tell: no bundle, so no LaunchServices activation and no holder name
    }
  };
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
  const readWindows = (): CGWindowEntry[] => cf.own(cg.CGWindowListCopyWindowInfo(listOptions, NULL_WINDOW_ID), list => {
    const out: CGWindowEntry[] = [];
    for (const d of cf.array(list)) {
      const e = entry(d);
      if (e) out.push(e);
    }
    return out;
  }) ?? [];
  const frontmostPid = (): number | null => {
    const system = ax?.systemWide();
    if (!ax || !system) return null;
    return cf.own(ax.element(system, "AXFocusedApplication"), app => ax.pid(app));
  };
  /** AXRaise and AXMain on the one AX window of `app` that is `window` (by id, else by frame). */
  const raiseWindow = (a: AX, app: Ref, window: number, at: Rect, yes: Ref) => {
    a.withElements(app, "AXWindows", items => {
      const byId = a.hasWindowIds ? items.filter(w => a.windowId(w) === window) : [];
      const found = byId.length ? byId : items.filter(w => sameFrame(a.frame(w), at));
      if (found.length !== 1) return; // no window, or several alike: raising a guess helps nobody
      a.perform(found[0]!, "AXRaise");
      a.set(found[0]!, "AXMain", yes);
    });
  };
  let layout: KeyboardLayoutSource | null = null;
  let cached: { at: number; list: CGWindowEntry[] } | null = null;
  let dock: { at: number; pid: number; strip: Rect | null } | null = null;
  /** The Dock's strip on screen (AX's frame of its list of icons), kept DOCK_CACHE_MS; null when AX can't tell. */
  const dockStrip = (pid: number, t: number): Rect | null => {
    if (dock && dock.pid === pid && t >= dock.at && t - dock.at < DOCK_CACHE_MS) return dock.strip;
    const strip = withApp(pid, (app, a) => a.withElements(app, "AXChildren", items => {
      const list = items.find(i => a.string(i, "AXRole") === "AXList");
      return list ? a.frame(list) : null;
    })) ?? null;
    dock = { at: t, pid, strip };
    return strip;
  };
  /** The pending LaunchServices fallback of the last raise(): a newer raise() or dispose() cancels it. */
  let pending: (() => void) | null = null;
  let generation = 0;
  const cancelPending = () => {
    generation++;
    pending?.();
    pending = null;
  };
  return {
    windows() {
      const t = now();
      if (cached && t >= cached.at && t - cached.at < cacheMs) return cached.list;
      // The Dock's own window covers the display: only its strip counts (withDockStrip).
      const read = readWindows();
      const titled = dockTitled(read);
      const own = read.find(e => isDockItself(e, titled));
      // Frozen: every caller shares the cached list for its 30 ms.
      const list = Object.freeze(own ? withDockStrip(read, dockStrip(own.pid, t)) : read) as CGWindowEntry[];
      cached = { at: t, list };
      return list;
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
    keysDown() {
      const map = hi?.keyMap();
      if (map) return keysInMap(map);
      const down: number[] = [];
      for (let k = 0; k <= MAX_CG_KEY; k++) if (cg.CGEventSourceKeyState(SOURCE_STATE.combinedSession, k)) down.push(k);
      return down;
    },
    frontmostPid,
    focusedWindow(pid) {
      return withApp(pid, (app, a) => cf.own(a.element(app, "AXFocusedWindow"), w => axWindow(a, w)));
    },
    appWindows(pid) {
      return withApp(pid, (app, a) => a.withElements(app, "AXWindows", items => items.map(w => axWindow(a, w))));
    },
    raise(pid, window, at) {
      const yes = cf.kTrue;
      if (!yes || !ax || pid === ownPid) return false;
      cancelPending();
      const before = frontmostPid();
      const fronted = withApp(pid, (app, a) => {
        const ok = a.set(app, "AXFrontmost", yes) === AX_ERROR.success;
        raiseWindow(a, app, window, at, yes);
        return ok;
      });
      if (fronted === null) return false;
      const mine = generation;
      pending = later(ACTIVATION_FALLBACK_MS, () => {
        pending = null;
        const front = frontmostPid();
        // Activated; or AX can't tell; or something else (the user) took the focus meanwhile, which isn't Ember's to
        // take back: only a declined activation, with the same app still in front, goes through LaunchServices.
        if (front === null || front === pid || front !== before) return;
        const bundle = bundleOf(processPath(pid));
        if (!bundle) return; // a process outside a bundle: LaunchServices can't activate it
        o.log?.info("platform.activation_fallback", { pid });
        openApp(bundle, () => {
          if (generation === mine) withApp(pid, (app, a) => raiseWindow(a, app, window, at, yes));
        });
      });
      return fronted;
    },
    trusted(prompt) {
      return ax ? ax.trusted(prompt) : false;
    },
    secureInput() {
      return hi ? hi.secureInput() : null;
    },
    session() {
      return cf.own(cg.CGSessionCopyCurrentDictionary(), d => {
        const pid = cf.number(cf.get(d, SESSION_KEY.secureInputPid));
        // A session that isn't on the console (another user switched in) can't be seen either.
        const locked = truthy(cf, cf.get(d, SESSION_KEY.screenLocked)) === true || truthy(cf, cf.get(d, SESSION_KEY.onConsole)) === false;
        return { locked, secureInputPid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null };
      });
    },
    screenAccess() {
      return cg.CGPreflightScreenCaptureAccess ? !!cg.CGPreflightScreenCaptureAccess() : false;
    },
    listenAccess() {
      return cg.CGPreflightListenEventAccess ? !!cg.CGPreflightListenEventAccess() : null;
    },
    requestListenAccess() {
      return cg.CGRequestListenEventAccess ? !!cg.CGRequestListenEventAccess() : null;
    },
    postAccess() {
      return cg.CGPreflightPostEventAccess ? !!cg.CGPreflightPostEventAccess() : null;
    },
    inputSourceIsLayout() {
      return hi ? hi.inputSourceIsLayout() : null;
    },
    processPath,
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
      cancelPending();
    },
  };
}

/** libproc's home: proc_pidpath is exported by libSystem (in the dyld shared cache, like the frameworks). */
export const LIBSYSTEM_PATH = "/usr/lib/libSystem.B.dylib";
export const PROC_PIDPATH_PROTOTYPE = "int proc_pidpath(int pid, void *buffer, uint32_t buffersize)";
/** PROC_PIDPATHINFO_MAXSIZE (4 * MAXPATHLEN). */
const PROC_PIDPATH_MAX = 4096;

let pidPathFn: ((pid: number, buffer: Buffer, size: number) => number) | null | undefined;

/** proc_pidpath, bound once per process; null when libSystem can't be bound. */
function bindProcessPath(): ((pid: number) => string | null) | null {
  if (pidPathFn === undefined) {
    try {
      pidPathFn = bindOptional(koffiModule().load(LIBSYSTEM_PATH), PROC_PIDPATH_PROTOTYPE) ?? null;
    } catch {
      pidPathFn = null; // no libproc: no bundle paths, so no LaunchServices activation and holders by window only
    }
  }
  const fn = pidPathFn;
  if (!fn) return null;
  return pid => {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const buf = Buffer.alloc(PROC_PIDPATH_MAX);
    const n = fn(pid, buf, PROC_PIDPATH_MAX);
    return n > 0 ? buf.toString("utf8", 0, Math.min(n, PROC_PIDPATH_MAX)) : null;
  };
}

/**
 * The desktop, bound on first use. null off macOS, or when CoreFoundation or CoreGraphics can't be bound
 * (desktopError says why). AX, HIToolbox and libproc are optional: without them the answers that need them are safe
 * defaults (null where a safety check depends on them, so callers fail closed).
 */
export function openDesktop(o: Pick<DesktopOptions, "log" | "windowCacheMs"> = {}): DarwinDesktop | null {
  const cf = openCoreFoundation();
  const cg = openCoreGraphics();
  if (!cf || !cg) {
    desktopError = new Error(onMacOS() ? "CoreFoundation or CoreGraphics could not be bound" : "not macOS");
    return null;
  }
  const processPath = bindProcessPath() ?? undefined;
  return makeDesktop(cf, cg, openAX(cf, MAIN_THREAD_AX_TIMEOUT), openHIToolbox(cf), { ...o, processPath });
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
