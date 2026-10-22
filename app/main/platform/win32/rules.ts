/**
 * Which Windows top-level windows count for what, decided from facts Ember reads about each one (visibility, DWM
 * cloaking, style bits, owner, class). Windows has no _NET_CLIENT_LIST or override-redirect flag, so these rules
 * stand in for them; they are pure so each decision is unit-tested on Linux:
 * - an app window ("what apps are open", clientWindows): what Alt+Tab would show;
 * - a findable window (findWindow): any titled top-level the user can see or restore, dialogs included;
 * - a covering window (stack): one that is on screen now and takes clicks there;
 * - a popup (overrideRedirect): a menu, tooltip, dropdown list or shadow that belongs to another window.
 */

/** Window styles (GWL_STYLE). */
export const WS = { POPUP: 0x80000000, CAPTION: 0x00c00000 } as const;

/** Extended window styles (GWL_EXSTYLE). */
export const WS_EX = {
  TRANSPARENT: 0x00000020, TOOLWINDOW: 0x00000080, APPWINDOW: 0x00040000, LAYERED: 0x00080000, NOACTIVATE: 0x08000000,
} as const;

/** The shell's own windows: the desktop (Progman, WorkerW) and the taskbars. Not apps (X11's DESKTOP and DOCK types). */
export const SHELL_CLASSES: ReadonlySet<string> = new Set(["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"]);

/** Menus, tooltips and the shadows Windows draws under menus. */
export const MENU_CLASS = "#32768";
export const TOOLTIP_CLASS = "tooltips_class32";
export const SHADOW_CLASS = "SysShadow";

/** What Ember reads about a top-level window to decide what it counts for. */
export interface WindowFacts {
  visible: boolean;
  /** Minimised. */
  iconic: boolean;
  /** Hidden by DWM though "visible": on another virtual desktop, or a suspended UWP frame. */
  cloaked: boolean;
  style: number;
  exStyle: number;
  className: string;
  title: string;
  /** Its owner window (GW_OWNER), 0 for none. */
  owner: number;
  /** Is the owner visible (a popup of a visible window is part of that window, not an app of its own)? */
  ownerVisible: boolean;
  /** Its visible frame's size (DWM extended frame bounds). */
  width: number;
  height: number;
}

const has = (bits: number, flag: number) => (bits & flag) !== 0;

/**
 * Is it an app's window, in "what apps are open"? Visible and not cloaked, with a title, not the shell's own; not a
 * tool window or a window that can't be activated, unless it asks for a taskbar button (WS_EX_APPWINDOW); not a
 * popup or dialog owned by another visible window (that window is listed instead; an owner that is itself hidden,
 * as some toolkits use, doesn't count). Minimised windows are listed, like X's _NET_CLIENT_LIST; windows on other
 * virtual desktops are cloaked, so they aren't.
 */
export function isAppWindow(f: WindowFacts): boolean {
  if (!f.visible || f.cloaked || !f.title || SHELL_CLASSES.has(f.className)) return false;
  if (!f.iconic && (f.width <= 0 || f.height <= 0)) return false;
  if (has(f.exStyle, WS_EX.APPWINDOW)) return true;
  if (has(f.exStyle, WS_EX.TOOLWINDOW) || has(f.exStyle, WS_EX.NOACTIVATE)) return false;
  return !(f.owner && f.ownerVisible);
}

/**
 * Can findWindow return it: a titled top-level the user can see or restore (dialogs and tool windows too: the window
 * a task works in may be the app's dialog), not cloaked and not the shell's own.
 */
export function isFindable(f: WindowFacts): boolean {
  if (!f.visible || f.cloaked || !f.title || SHELL_CLASSES.has(f.className)) return false;
  return f.iconic || (f.width > 0 && f.height > 0);
}

/**
 * Does it cover what is under it on screen now (stack)? Visible, not minimised or cloaked, bigger than a pixel, and
 * not a click-through layered window (WS_EX_LAYERED | WS_EX_TRANSPARENT: GPU overlays, recorders, Ember's own
 * overlay while it lets clicks through) or a fully transparent one (`layeredAlpha()` 0). Those take no clicks, and
 * counting them would make every window look covered (X11 leaves out InputOnly windows the same way).
 */
export function coversScreen(f: WindowFacts, layeredAlpha: () => number | null): boolean {
  if (!f.visible || f.iconic || f.cloaked || f.width <= 1 || f.height <= 1) return false;
  if (has(f.exStyle, WS_EX.LAYERED)) {
    if (has(f.exStyle, WS_EX.TRANSPARENT)) return false;
    if (layeredAlpha() === 0) return false;
  }
  return true;
}

/**
 * Is it a popup that belongs to another window (X11's override-redirect): a menu (#32768), a tooltip, a menu's
 * shadow, or a captionless WS_POPUP that is owned, a tool window or not activatable (Chromium's and Electron's menus
 * and dropdown lists are owned tool windows). An app's own captionless main window (unowned, with a taskbar button)
 * isn't one: its frame must still match its accessibility window.
 */
export function isPopup(f: Pick<WindowFacts, "className" | "style" | "exStyle" | "owner">): boolean {
  if (f.className === MENU_CLASS || f.className === TOOLTIP_CLASS || f.className === SHADOW_CLASS) return true;
  if (has(f.exStyle, WS_EX.APPWINDOW)) return false;
  const captionless = has(f.style, WS.POPUP) && (f.style & WS.CAPTION) !== WS.CAPTION;
  return captionless && (f.owner !== 0 || has(f.exStyle, WS_EX.TOOLWINDOW) || has(f.exStyle, WS_EX.NOACTIVATE));
}

/**
 * The top-level windows from `first` (GetTopWindow(NULL), the topmost) down through `next` (GW_HWNDNEXT), top to
 * bottom. Windows can be raised or destroyed during the walk, so a window seen twice ends it, as does `max`.
 */
export function walkZOrder(first: number, next: (hwnd: number) => number, max = 8192): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (let h = first; h && !seen.has(h) && out.length < max; h = next(h)) {
    seen.add(h);
    out.push(h);
  }
  return out;
}

/** A window findWindow may pick: its id, title, process, and the names it can be asked for by (program, class). */
export interface FindCandidate { id: number; title: string; pid: number | null; names: readonly string[] }

/**
 * The window titled `title`, with XInput.findWindow's rules: when `pid` has windows, only its windows count, and an
 * exact title wins over one that only contains it (case-insensitive); otherwise only an exact title counts, of the
 * app named `appName` when given (its program or its window class, any case, ".exe" or not). 0 when nothing or more
 * than one window matches: input sent to a guess could go anywhere.
 */
export function pickWindow(all: readonly FindCandidate[], title: string, pid?: number, appName?: string): number {
  if (!title) return 0;
  const only = (list: readonly FindCandidate[]) => (list.length === 1 ? list[0].id : 0);
  const theirs = pid !== undefined ? all.filter(w => w.pid === pid) : [];
  if (theirs.length) {
    const exact = theirs.filter(w => w.title === title);
    if (exact.length) return only(exact);
    const want = title.toLowerCase();
    return only(theirs.filter(w => w.title.toLowerCase().includes(want)));
  }
  const app = appName?.trim().replace(/\.exe$/i, "").toLowerCase();
  return only(all.filter(w => w.title === title && (!app || w.names.some(n => n.replace(/\.exe$/i, "").toLowerCase() === app))));
}

/** The top-level window under the pointer, as pointerOn sees it. */
export interface WindowAtPointer {
  /** The top-level (GA_ROOT of WindowFromPoint), 0 over nothing. */
  top: number;
  className: string;
  pid: number | null;
  /** isPopup() of it. */
  popup: boolean;
  /** Its owner, the owner's owner, … (GW_OWNER), nearest first. */
  owners: readonly number[];
}

/**
 * Would a click at the pointer land in one of `targets` (the window, and the window the element is in)? Yes on the
 * window itself; on its app's open menu (#32768 of the same process); on a popup it owns (a dropdown list) or one of
 * the same process. Not on a tooltip, and not on any other window of the app (a dialog over that spot: the click
 * would do something else there). WindowFromPoint already skips hidden, disabled and click-through windows.
 */
export function pointerLandsOn(at: WindowAtPointer, targets: readonly number[], targetPid: number | null): boolean {
  if (!at.top) return false;
  if (targets.includes(at.top)) return true;
  if (at.className === TOOLTIP_CLASS) return false;
  const samePid = at.pid !== null && targetPid !== null && at.pid === targetPid;
  if (at.className === MENU_CLASS) return samePid;
  return at.popup && (samePid || at.owners.some(o => targets.includes(o)));
}
