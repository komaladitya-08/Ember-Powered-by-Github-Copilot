/**
 * Reading and activating top-level windows through Win32Api: the helpers windows.ts and input.ts share, so both
 * describe a window, find its program and bring it to the front the same way (one HWND id space for both).
 *
 * The rule here: no synchronous cross-thread window call on the main thread. Ember runs these on Electron's main
 * thread, which also draws the overlay and receives the stop shortcut's WM_HOTKEY, so a call that waits for another
 * app's thread would freeze Ember whenever that app is merely busy, not only when it is hung. So no message is sent
 * to another process's window; restoring uses ShowWindowAsync; raising uses SetWindowPos with SWP_ASYNCWINDOWPOS,
 * never BringWindowToTop, ShowWindow or a plain SetWindowPos (they wait for the window's thread), and never while
 * Ember shares the window's thread's input queue (SWP_ASYNCWINDOWPOS posts only across queues); and the thread
 * attach that activation may need is never made with a hung thread.
 */

import type { Rect, X11Window } from "../types";
import type { Win32Api } from "./ffi";
import { SM } from "./ffi";
import { EMPTY_MOUSE_INPUT, encodeInputs } from "./layouts";
import {
  CONSOLE_HOST_PROGRAM, consoleClient, CORE_WINDOW_CLASS, hostedProgram, isConsoleWindow, isUwpFrame, programName,
  type CoreWindowSeen,
} from "./names";
import { walkZOrder, type WindowFacts } from "./rules";

/** The virtual desktop (every monitor's bounding box), in physical pixels; its origin may be negative. */
export function virtualScreen(api: Win32Api): Rect {
  return {
    x: api.systemMetric(SM.XVIRTUALSCREEN), y: api.systemMetric(SM.YVIRTUALSCREEN),
    width: api.systemMetric(SM.CXVIRTUALSCREEN), height: api.systemMetric(SM.CYVIRTUALSCREEN),
  };
}

/** Every top-level window, top to bottom (GetTopWindow/GW_HWNDNEXT: no callbacks). */
export function topLevels(api: Win32Api): number[] {
  return walkZOrder(api.topWindow(), h => api.nextWindow(h));
}

/** Program names by pid for one pass over the windows (many windows share a process; pids aren't kept longer). */
export type ProgramMemo = Map<number, string>;

/** The program of a process ("notepad"), "" when the system won't say (a protected process). */
export function programOf(api: Win32Api, pid: number, memo: ProgramMemo): string {
  let name = memo.get(pid);
  if (name === undefined) memo.set(pid, name = programName(api.processImage(pid) ?? ""));
  return name;
}

/**
 * The window's app name (`wmClass`): its program; for a UWP frame (ApplicationFrameHost) the program of the app it
 * hosts, so never-look and grants by app name work for UWP apps too; for a console window "conhost", the program
 * that draws it, whatever its first client runs (names.ts).
 */
export function appName(api: Win32Api, hwnd: number, pid: number, className: string, title: string, memo: ProgramMemo): string {
  if (isConsoleWindow(className)) return CONSOLE_HOST_PROGRAM;
  const program = programOf(api, pid, memo);
  if (!isUwpFrame(program, className)) return program;
  const seen = (parent: number): CoreWindowSeen[] => {
    const out: CoreWindowSeen[] = [];
    for (let w = api.findWindow(parent, 0, CORE_WINDOW_CLASS), n = 0; w && n < 64; w = api.findWindow(parent, w, CORE_WINDOW_CLASS), n++) {
      const p = api.threadProcess(w).pid;
      if (p) out.push({ pid: p, program: programOf(api, p, memo), title: parent ? undefined : api.title(w, false) });
    }
    return out;
  };
  // The top-level CoreWindows are only looked through when the frame has no hosted window of its own.
  return hostedProgram({ pid, title }, seen(hwnd), []) ?? hostedProgram({ pid, title }, [], seen(0)) ?? program;
}

/** A window's names as Ember's lists report them: `clientProgram` only on a console window, and only when known. */
export interface WindowNames {
  wmClass: string;
  /** A console window's first client's program ("python", "cmd"), for display: `wmClass` is "conhost". */
  clientProgram?: string;
}

/** appName(), plus the client program of a console window (the program of the process Windows reports for it). */
export function namesOf(api: Win32Api, hwnd: number, pid: number, className: string, title: string, memo: ProgramMemo): WindowNames {
  const wmClass = appName(api, hwnd, pid, className, title, memo);
  const client = isConsoleWindow(className) ? consoleClient(programOf(api, pid, memo)) : undefined;
  return client === undefined ? { wmClass } : { wmClass, clientProgram: client };
}

/** What rules.ts decides on, read for one top-level window (`frame`: its visible frame, when already read). */
export function factsOf(api: Win32Api, hwnd: number, ownPid: number, frame?: Rect | null): WindowFacts & { pid: number } {
  const pid = api.threadProcess(hwnd).pid;
  const owner = api.owner(hwnd);
  const box = frame !== undefined ? frame : visibleFrame(api, hwnd);
  return {
    pid,
    visible: api.isVisible(hwnd),
    iconic: api.isIconic(hwnd),
    cloaked: api.cloaked(hwnd),
    style: api.style(hwnd),
    exStyle: api.exStyle(hwnd),
    className: api.className(hwnd),
    title: api.title(hwnd, pid === ownPid),
    owner,
    ownerVisible: owner !== 0 && api.isVisible(owner),
    width: box?.width ?? 0,
    height: box?.height ?? 0,
  };
}

/** What a window visibly covers: the DWM frame bounds, else its window rectangle. */
export function visibleFrame(api: Win32Api, hwnd: number): Rect | null {
  return api.frameBounds(hwnd) ?? api.windowRect(hwnd);
}

/** A window as the "who is this" queries and the apps' list report it: X11's fields, its names and its class. */
export type DescribedWindow = X11Window & WindowNames & { wmClassName: string };

/** A window as the "who is this" queries report it: id, pid, title, visible frame and names; null when gone. */
export function describe(api: Win32Api, hwnd: number, ownPid: number, memo: ProgramMemo = new Map()): DescribedWindow | null {
  if (!hwnd) return null;
  const pid = api.threadProcess(hwnd).pid;
  if (!pid) return null;
  const frame = visibleFrame(api, hwnd) ?? { x: 0, y: 0, width: 0, height: 0 };
  const className = api.className(hwnd);
  const title = api.title(hwnd, pid === ownPid);
  return { id: hwnd, pid, title, ...frame, ...namesOf(api, hwnd, pid, className, title, memo), wmClassName: className };
}

/**
 * The top-level window that has the keyboard: the foreground thread's focused window (GetGUIThreadInfo) mapped to
 * its top-level (GA_ROOT), else its active window, else the foreground window itself. For one of Ember's windows this
 * is its top-level HWND (Chromium's focus is on a child window; GA_ROOT climbs out). 0 when nothing has it.
 */
export function focusedTopLevel(api: Win32Api): number {
  const fg = api.foregroundWindow();
  if (!fg) return 0;
  const info = api.guiThreadInfo(api.threadProcess(fg).tid);
  const inner = info ? info.focus || info.active : 0;
  return (inner && api.root(inner)) || fg;
}

/**
 * The window with the keyboard inside the foreground window's thread (GetGUIThreadInfo's hwndFocus: an edit box, a
 * document's own child window), 0 when none or it can't be told.
 */
export function focusedChild(api: Win32Api): number {
  const fg = api.foregroundWindow();
  if (!fg) return 0;
  return api.guiThreadInfo(api.threadProcess(fg).tid)?.focus ?? 0;
}

const SW_RESTORE = 9;

/**
 * Brings a top-level window to the front with the keyboard, in the documented order (input.md §7.6), stopping as soon
 * as it is the foreground window:
 * 1. restore it if minimised (ShowWindowAsync: never waits on its thread);
 * 2. if Ember has the foreground, SetForegroundWindow is allowed: hand it over;
 * 3. otherwise send an empty input event first (the foreground lock lets the process that sent the last input
 *    take the foreground), then SetForegroundWindow;
 * 4. last, join the foreground thread's input state (AttachThreadInput), raise the window without waiting for its
 *    thread (SetWindowPos with SWP_ASYNCWINDOWPOS, where BringWindowToTop would wait for a busy app) and
 *    SetForegroundWindow, and always detach. Never with a hung thread: attaching to it would hang Ember. Not when
 *    the foreground window is the target's own thread's either: attached to that thread, Ember would share the
 *    target's input queue, where SWP_ASYNCWINDOWPOS no longer posts and SetWindowPos waits for that thread.
 * Nothing else is called on the target: ShowWindowAsync, the async SetWindowPos, SetForegroundWindow and the
 * hung-guarded AttachThreadInput, plus the empty input event. No Alt tap: it toggles menu mnemonics in the user's
 * app. Callers verify with focusedWindow(), as on X11.
 */
export function activateWindow(api: Win32Api, hwnd: number, ownPid: number): void {
  if (!hwnd || !api.isWindow(hwnd)) return;
  if (api.isIconic(hwnd)) api.showWindowAsync(hwnd, SW_RESTORE);
  const done = () => api.foregroundWindow() === hwnd;
  if (done()) return;
  const fg = api.foregroundWindow();
  if (fg && api.threadProcess(fg).pid === ownPid) {
    api.setForeground(hwnd);
    if (done()) return;
  }
  if (api.canSendInput) api.sendInput(encodeInputs([EMPTY_MOUSE_INPUT]), 1);
  api.setForeground(hwnd);
  if (done()) return;
  const now = api.foregroundWindow();
  const own = api.currentThreadId();
  const theirs = now ? api.threadProcess(now).tid : 0;
  if (!theirs || theirs === own || api.isHung(now) || api.isHung(hwnd)) return;
  // Sharing the target's input queue would make the raise synchronous (SWP_ASYNCWINDOWPOS posts only across queues).
  if (api.threadProcess(hwnd).tid === theirs) return;
  if (!api.attachThreadInput(own, theirs, true)) return;
  try {
    api.bringToTopAsync(hwnd);
    api.setForeground(hwnd);
  } finally {
    api.attachThreadInput(own, theirs, false);
  }
}
