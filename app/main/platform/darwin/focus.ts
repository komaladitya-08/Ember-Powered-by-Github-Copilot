/**
 * Which window has the keyboard, and which is active, on macOS: shared by the window system (focusWindow,
 * activeWindow) and the input backend (focusedWindow, activeWindow) so both answer with the same CGWindowID.
 * Ember's own windows come first and need no AX at all: one of Ember's non-activating panels can have the keyboard
 * while another app stays frontmost, and AX must never be asked about Ember's own process from its main thread.
 */

import { axWindowId, frontWindowOf, ownFrontWindow, type CGWindowEntry } from "./model";
import type { DarwinDesktop } from "./desktop";

/** What focus resolution needs to know. */
export interface FocusSource {
  desktop: Pick<DarwinDesktop, "frontmostPid" | "focusedWindow">;
  ownPid: number;
  /** The CGWindowID of Ember's own window with the keyboard, from Electron (0 for none). */
  ownFocusedId?: () => number;
}

/** A resolved window: Ember's own (id, with its entry when it is on screen), or another app's entry. */
export type Resolved =
  | { own: true; id: number; entry: CGWindowEntry | null; title: string }
  | { own: false; id: number; entry: CGWindowEntry; title: string };

const own = (id: number, entry: CGWindowEntry | null): Resolved => ({ own: true, id, entry, title: entry?.title ?? "" });

function ownFocused(s: FocusSource, list: readonly CGWindowEntry[]): Resolved | null {
  let id = 0;
  try {
    id = s.ownFocusedId?.() ?? 0;
  } catch {
    id = 0; // a destroyed window: Electron can't say, so fall through to the system's answer
  }
  return id > 0 ? own(id, list.find(e => e.id === id) ?? null) : null;
}

/**
 * The window with the keyboard: Ember's focused window (from Electron); else, when Ember's process is frontmost, its
 * front window; else the frontmost app's AXFocusedWindow mapped to its CGWindowID (null when it maps to no window on
 * screen); else, when AX can't name one, that app's front window. Without AX (not trusted), the first app window
 * front to back. null when the frontmost app shows no window.
 */
export function resolveFocus(s: FocusSource, list: readonly CGWindowEntry[]): Resolved | null {
  const mine = ownFocused(s, list);
  if (mine) return mine;
  return resolveFront(s, list, true);
}

/**
 * The active window: the frontmost app's frontmost normal window (Ember's front window when Ember is frontmost), its
 * title from AX when CGWindowList has none. A panel of Ember's that has the keyboard doesn't make Ember active.
 */
export function resolveActive(s: FocusSource, list: readonly CGWindowEntry[]): Resolved | null {
  return resolveFront(s, list, false);
}

function resolveFront(s: FocusSource, list: readonly CGWindowEntry[], focused: boolean): Resolved | null {
  const pid = s.desktop.frontmostPid();
  if (pid === null) {
    const e = frontWindowOf(list);
    if (!e) return null;
    return e.pid === s.ownPid ? own(e.id, e) : { own: false, id: e.id, entry: e, title: e.title };
  }
  if (pid === s.ownPid) {
    const e = ownFrontWindow(list, s.ownPid);
    return own(e?.id ?? 0, e);
  }
  const front = frontWindowOf(list, pid);
  // The focused window only when it matters: focus asks for it, an active window asks only for a missing title.
  const ax = focused || (front && !front.title) ? s.desktop.focusedWindow(pid) : null;
  const axId = ax ? axWindowId(ax, list, pid) : 0;
  if (focused && ax) {
    // AX named the window with the keyboard. If it isn't one on screen, the keyboard is in none of them: the app's
    // front window would only be a guess, and keys sent to a guess could go anywhere.
    const e = axId ? list.find(w => w.id === axId) : undefined;
    return e ? { own: false, id: e.id, entry: e, title: e.title || ax.title } : null;
  }
  if (!front) return null;
  return { own: false, id: front.id, entry: front, title: front.title || (ax && axId === front.id ? ax.title : "") };
}
