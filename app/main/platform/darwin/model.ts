/**
 * The window logic of the macOS backend, as pure functions over CGWindowList entries: which windows are app
 * windows, the X11-shaped stack (bottom to top), the frontmost window of an app, matching an AX window to its
 * CGWindowID, what a click at a point would land on, and finding a window by title with XInput's rules. The native
 * side (desktop.ts) only reads the entries; everything that decides is here, unit-tested on every OS.
 *
 * CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements) lists windows
 * front to back, in points. Layer 0 holds the apps' normal windows; everything else (menus at 101, the Dock at 20,
 * the menu bar at 24/25, status items, panels, Ember's own floating windows) is not an app window here.
 */

import type { Rect, StackedWindow, X11Window } from "../types";
import { OVERLAY_TITLE } from "../../perception/windows";
import { SECURITY_APP } from "../../policy/vocabulary";

export { OVERLAY_TITLE };

/** One on-screen window as CGWindowListCopyWindowInfo describes it (points, global display space, y down). */
export interface CGWindowEntry {
  /** kCGWindowNumber: the CGWindowID, Ember's window id on macOS. */
  id: number;
  /** kCGWindowOwnerPID. */
  pid: number;
  /** kCGWindowOwnerName: the app's localized name ("TextEdit"), Ember's `wmClass` on macOS. */
  owner: string;
  /** kCGWindowName: empty for other apps' windows without the Screen Recording permission. */
  title: string;
  /** kCGWindowBounds. */
  bounds: Rect;
  /** kCGWindowLayer: 0 for the apps' normal windows. */
  layer: number;
  /** kCGWindowAlpha. */
  alpha: number;
}

/** An entry's values as read from its dictionary (null where a key was missing or of another type). */
export interface RawWindowInfo {
  number: number | null;
  pid: number | null;
  owner: string | null;
  name: string | null;
  bounds: Rect | null;
  layer: number | null;
  alpha: number | null;
}

/** A window as AX reports it: its CGWindowID when _AXUIElementGetWindow told it (else 0), title and frame. */
export interface AXWindowInfo {
  id: number;
  title: string;
  /** Only read when `id` is 0 (it is what matches the window then); null otherwise or when unreadable. */
  frame: Rect | null;
}

/** Owners of layer-0 windows that are part of the system, not apps the user has open. */
export const SYSTEM_OWNERS: ReadonlySet<string> = new Set([
  "Window Server", "Dock", "SystemUIServer", "Control Center", "Notification Center", "WindowManager",
]);

/**
 * Owners of the system's windows that take credentials or consent, while which Ember takes no screenshot: the
 * authorisation prompts and Touch ID / password sheets (SecurityAgent, coreautha, coreauthd), "… would like to control
 * this computer using accessibility features" (universalAccessAuthWarn), privacy (TCC) prompts
 * (UserNotificationCenter), Gatekeeper (CoreServicesUIAgent), passkey and AutoFill sheets
 * (AuthenticationServicesAgent) and the screen saver's lock (ScreenSaverEngine). A screenshot or click while the
 * Accessibility prompt is up is the self-approval path to avoid.
 *
 * has() answers from SECURITY_APP.darwin (policy/vocabulary.ts), the one list the policy and the accessibility host's
 * shell_overlays read too, so the three can't drift (design §8.4): any case, other languages and bundle ids, Keychain
 * Access and the Passwords app included. Not loginwindow: it is a prompt only while it covers a display (the lock
 * screen, which the session's lock state and the host's own check tell). Listing gives the names above, as
 * CoreGraphics reports them.
 */
export const SECURITY_OWNERS: ReadonlySet<string> = new (class extends Set<string> {
  has(owner: string): boolean {
    return !/^(com\.apple\.)?loginwindow$/i.test(owner.trim()) && !!SECURITY_APP.darwin?.test(owner.trim());
  }
})([
  "SecurityAgent", "coreautha", "coreauthd", "universalAccessAuthWarn", "UserNotificationCenter", "CoreServicesUIAgent",
  "AuthenticationServicesAgent", "ScreenSaverEngine",
]);

/**
 * Secure keyboard entry as Ember decides it: `on` true or false, or null when Ember can't tell (it then acts as if
 * it were on). `pid` is the process holding it, when the session names one.
 */
export interface SecureInputState {
  on: boolean | null;
  pid: number | null;
}

/**
 * Secure keyboard entry from IsSecureEventInputEnabled (`api`, null when it can't be called) and the session
 * dictionary's kCGSSessionSecureInputPID (`session`, null when the dictionary can't be read). The API decides when
 * it answers; without it the session's pid is the signal (present only while some process holds secure input);
 * without either, nobody can tell.
 */
export function secureInputState(api: boolean | null, session: { secureInputPid: number | null } | null): SecureInputState {
  const pid = session?.secureInputPid ?? null;
  if (api !== null) return { on: api, pid: api ? pid : null };
  if (!session) return { on: null, pid: null };
  return { on: pid !== null, pid };
}

/**
 * The application bundle an executable belongs to: the innermost ".app" folder above it
 * ("/Applications/TextEdit.app/Contents/MacOS/TextEdit" → "/Applications/TextEdit.app"), or null for a process
 * outside any bundle (a command-line tool), which LaunchServices can't activate.
 */
export function bundleOf(executable: string | null | undefined): string | null {
  if (!executable || !executable.startsWith("/")) return null;
  const parts = executable.split("/");
  for (let i = parts.length - 2; i > 0; i--) {
    if (parts[i]!.endsWith(".app") && parts[i]!.length > 4) return parts.slice(0, i + 1).join("/");
  }
  return null;
}

/** A process's name from its executable: its bundle's name ("1Password" for ".../1Password.app/..."), else the file's. */
export function processName(executable: string | null | undefined): string {
  if (!executable) return "";
  const bundle = bundleOf(executable);
  const base = (bundle ?? executable).split("/").pop() ?? "";
  return bundle ? base.slice(0, -".app".length) : base;
}

/** The CGKeyCodes down in a GetKeys KeyMap (16 bytes: key k is bit k & 7 of byte k >> 3). */
export function keysInMap(map: Buffer): number[] {
  const down: number[] = [];
  for (let k = 0; k < Math.min(map.length, 16) * 8; k++) if (map[k >> 3]! & (1 << (k & 7))) down.push(k);
  return down;
}

const MAX_WINDOW_ID = 0xffffffff;

/**
 * Checks and completes an entry. Without a number, an owner pid or bounds it is dropped. A missing layer or alpha
 * is taken as the cautious value (not an app window; opaque), so an odd window still covers what is below it.
 */
export function windowEntry(raw: RawWindowInfo): CGWindowEntry | null {
  const { number, pid, bounds } = raw;
  if (number === null || !Number.isInteger(number) || number <= 0 || number > MAX_WINDOW_ID) return null;
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return null;
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 0 || bounds.height < 0) return null;
  return {
    id: number,
    pid,
    owner: raw.owner ?? "",
    title: raw.name ?? "",
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    layer: raw.layer !== null && Number.isFinite(raw.layer) ? raw.layer : 1,
    alpha: raw.alpha !== null && Number.isFinite(raw.alpha) ? raw.alpha : 1,
  };
}

/** Something is drawn: not fully transparent and bigger than a pixel each way (X11's stack keeps the same). */
export const isVisible = (e: CGWindowEntry): boolean => e.alpha > 0 && e.bounds.width > 1 && e.bounds.height > 1;

/** An app's normal window (layer 0) that is drawn. */
export const isAppWindow = (e: CGWindowEntry): boolean => e.layer === 0 && isVisible(e);

/**
 * What covers what, bottom to top, as X11's stack(): every drawn window, its id as both `id` and `client`, its owner
 * name as `wmClass`, and its bounds as the covered area, `outer` and `inner` (AX frames are that same rectangle, so
 * matchFrame finds a scale of 1). Windows off layer 0 (menus, popovers, the Dock, the menu bar) are
 * `overrideRedirect`: popups to match against nothing, which still cover what is under them.
 */
export function stackOf(frontToBack: readonly CGWindowEntry[]): StackedWindow[] {
  const out: StackedWindow[] = [];
  for (let i = frontToBack.length - 1; i >= 0; i--) {
    const e = frontToBack[i]!;
    if (!isVisible(e)) continue;
    out.push({
      id: e.id, client: e.id, pid: e.pid, title: e.title, wmClass: e.owner,
      ...e.bounds, outer: { ...e.bounds }, inner: { ...e.bounds },
      overrideRedirect: e.layer !== 0,
    });
  }
  return out;
}

/** An entry as X11's window description: identity (id, pid, title, app name) plus its bounds. */
export function windowInfo(e: CGWindowEntry, title = e.title): X11Window & { wmClass: string } {
  return { id: e.id, pid: e.pid, title, ...e.bounds, wmClass: e.owner };
}

/**
 * The apps' open windows, front first: drawn layer-0 windows of anything but the system's own processes (the Dock,
 * Control Center, Stage Manager…). `wmClass` and `wmClassName` are both the app's localized name.
 */
export function clientWindowsOf(frontToBack: readonly CGWindowEntry[]): (X11Window & { wmClass: string; wmClassName: string })[] {
  return frontToBack
    .filter(e => isAppWindow(e) && !SYSTEM_OWNERS.has(e.owner))
    .map(e => ({ ...windowInfo(e), wmClassName: e.owner }));
}

/**
 * The frontmost app window of `pid`; without a pid (AX couldn't name the frontmost app), the frontmost one of any app
 * but the system's own processes, as clientWindowsOf() lists them. null when there is none.
 */
export function frontWindowOf(frontToBack: readonly CGWindowEntry[], pid?: number): CGWindowEntry | null {
  return frontToBack.find(e => isAppWindow(e) && (pid === undefined ? !SYSTEM_OWNERS.has(e.owner) : e.pid === pid)) ?? null;
}

/**
 * The window of Ember itself to report when Ember's process is the frontmost app but Electron didn't say which of
 * its windows has the keyboard: its frontmost normal window, else its frontmost drawn window that isn't the
 * click-through overlay, else null.
 */
export function ownFrontWindow(frontToBack: readonly CGWindowEntry[], ownPid: number): CGWindowEntry | null {
  const mine = frontToBack.filter(e => e.pid === ownPid && isVisible(e));
  return mine.find(e => e.layer === 0) ?? mine.find(e => e.title !== OVERLAY_TITLE) ?? null;
}

/** Equal within a point on every edge (AX and CG round the same rectangle). */
export function sameFrame(a: Rect | null | undefined, b: Rect | null | undefined, tolerance = 1): boolean {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
}

/**
 * The CGWindowID of an AX window of `pid`: the id AX gave when it gave one, else the one layer-0 window of that
 * process with the same frame (the title breaks a tie). 0 when nothing or several windows match: a guess could
 * send input to the wrong window.
 */
export function axWindowId(ax: AXWindowInfo, frontToBack: readonly CGWindowEntry[], pid: number): number {
  if (ax.id > 0) return ax.id;
  const same = frontToBack.filter(e => e.pid === pid && e.layer === 0 && sameFrame(ax.frame, e.bounds));
  if (same.length === 1) return same[0]!.id;
  const titled = same.filter(e => e.title !== "" && e.title === ax.title);
  return titled.length === 1 ? titled[0]!.id : 0;
}

/** Does `r` contain the point (left and top edges in, right and bottom out)? */
export const contains = (r: Rect, x: number, y: number): boolean => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;

/** The smallest rectangle around all of `rects`, or null when there are none. */
export function unionRect(rects: readonly Rect[]): Rect | null {
  const ok = rects.filter(r => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0);
  if (!ok.length) return null;
  const x0 = Math.min(...ok.map(r => r.x)), y0 = Math.min(...ok.map(r => r.y));
  const x1 = Math.max(...ok.map(r => r.x + r.width)), y1 = Math.max(...ok.map(r => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** kCGPopUpMenuWindowLevel: menus, context menus and pop-up buttons' lists. */
export const POPUP_MENU_LAYER = 101;

/** kCGDockWindowLevel: the Dock's own window. */
export const DOCK_LAYER = 20;

/**
 * The Dock's own window, as opposed to Mission Control's or Launchpad's (the Dock draws those too): on macos-15 it is
 * titled "Dock" and covers the whole display above every app's windows at rest (CI run 120), though only the Dock
 * itself, its strip of icons, is drawn and takes clicks. Known by its title where the window list gives titles (with
 * Screen Recording; `titled`: dockTitled says so), else by its level. Once titles are read, an untitled window of the
 * Dock's at its level is something else it draws (Mission Control adds two, CI run 122) and stays as listed, covering
 * what is below it (fail closed).
 */
export const isDockItself = (e: Pick<CGWindowEntry, "owner" | "title" | "layer">, titled = false): boolean =>
  e.owner === "Dock" && (e.title === "Dock" || (!titled && e.layer === DOCK_LAYER));

/** Does the window list give the Dock's own window its title ("Dock")? Then isDockItself goes by the title alone. */
export const dockTitled = (list: readonly Pick<CGWindowEntry, "owner" | "title">[]): boolean => list.some(e => e.owner === "Dock" && e.title === "Dock");

/**
 * The window list with the Dock's own window cut down to `strip`, the Dock as AX frames its list of icons: over the
 * rest of the display a click lands on the window below and a picture shows it, so nothing there is covered. Without
 * a strip (AX can't tell) the window stays as listed, covering everything below it (fail closed); a Dock window that
 * doesn't meet the strip (another display's) goes.
 */
export function withDockStrip(frontToBack: readonly CGWindowEntry[], strip: Rect | null): CGWindowEntry[] {
  if (!strip) return [...frontToBack];
  const titled = dockTitled(frontToBack);
  return frontToBack.flatMap(e => {
    if (!isDockItself(e, titled)) return [e];
    const x = Math.max(e.bounds.x, strip.x), y = Math.max(e.bounds.y, strip.y);
    const width = Math.min(e.bounds.x + e.bounds.width, strip.x + strip.width) - x;
    const height = Math.min(e.bounds.y + e.bounds.height, strip.y + strip.height) - y;
    return width > 0 && height > 0 ? [{ ...e, bounds: { x, y, width, height } }] : [];
  });
}

/**
 * Would a click at (x, y) land in `window` (or `elementWindow`)? The first drawn window there, front to back, is
 * what gets it. Ember's click-through overlay is passed over (it takes no clicks while Ember drives); Ember's other
 * windows are not. A menu or list the same app popped up over it counts as the app's own.
 */
export function pointerLandsOn(frontToBack: readonly CGWindowEntry[], x: number, y: number, window: number, ownPid: number, elementWindow?: number): boolean {
  const target = frontToBack.find(e => e.id === window);
  const top = frontToBack.find(e => isVisible(e) && contains(e.bounds, x, y) && !(e.pid === ownPid && e.title === OVERLAY_TITLE));
  if (!top || !target) return false;
  if (top.id === window || (elementWindow !== undefined && elementWindow !== 0 && top.id === elementWindow)) return true;
  return top.pid === target.pid && top.layer === POPUP_MENU_LAYER;
}

/** A window that findWindow() may pick: its id, owner and pid, and its title (null when it couldn't be read). */
export interface TitledWindow {
  id: number;
  pid: number;
  owner: string;
  title: string | null;
}

/**
 * XInput.findWindow's rules. When `pid` has windows, only those count: an exact title wins (exactly one), else a
 * title that contains `title`, any case (exactly one). Otherwise only an exact title counts (and, with `wmClass`, the
 * app's name must be it, any case), across every app. 0 when nothing matches or several do; also 0 when a window
 * whose title couldn't be read might have matched, since it could make the answer ambiguous.
 */
export function findWindowIn(windows: readonly TitledWindow[], title: string, pid?: number, wmClass?: string): number {
  if (!title) return 0;
  const only = (list: readonly TitledWindow[]) => (list.length === 1 ? list[0]!.id : 0);
  const theirs = pid !== undefined ? windows.filter(w => w.pid === pid) : [];
  if (theirs.length) {
    if (theirs.some(w => w.title === null)) return 0;
    const exact = theirs.filter(w => w.title === title);
    if (exact.length) return only(exact);
    const want = title.toLowerCase();
    return only(theirs.filter(w => w.title!.toLowerCase().includes(want)));
  }
  const cls = wmClass?.toLowerCase();
  const candidates = windows.filter(w => !cls || w.owner.toLowerCase() === cls);
  if (candidates.some(w => w.title === null)) return 0;
  return only(candidates.filter(w => w.title === title));
}

/**
 * The CGWindowID in an Electron media source id ("window:<CGWindowID>:0"), or 0 when it isn't one. On macOS
 * getNativeWindowHandle() is an NSView*, never a window id.
 */
export function parseMediaSourceId(id: unknown): number {
  if (typeof id !== "string") return 0;
  const m = /^window:(\d+):/.exec(id);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_WINDOW_ID ? n : 0;
}
