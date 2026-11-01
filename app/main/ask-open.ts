/**
 * The order in which the ask box opens (review #78, owner decision D-78). Where Ember holds the keyboard while the box
 * opens (Linux's keyboard hold), it reads where the user is first, as it always did: the letters typed meanwhile are
 * handed to the box. Where it can't (Windows, macOS), every letter typed before the box has the keyboard goes to the
 * user's app, so the box shows first and the screen is read after it, of the window the user was in, taken just before:
 * once the box is up, Windows' active window is the box, and macOS's AX names no focused app (or Ember) while the box's
 * panel has the keyboard, so a read of "the active window" then would find the box. Nothing in the user's window says it
 * has the keyboard by then either, so that read is told what had it (cross-review P1). Plain Node, no Electron.
 */

import type { FocusBefore } from "./perception/sidecar";

/** What one opening needs from main. `W`: the window system's window. */
export interface AskOpening<W> {
  /** Ember holds the keyboard while the box opens (Linux): the letters typed meanwhile go to the box. */
  holding: boolean;
  /** Ember reads where the user is (false: the handle's menu read it already, before it took the keyboard). */
  look: boolean;
  /** The window the user is in now; null when there is none or the window system can't tell. */
  activeWindow(): W | null;
  /** The native element with the keyboard in it, taken with activeWindow (0: none, or the window system can't tell). */
  keyboard?(): number;
  /**
   * Starts reading the screen: of `active` when given (taken before the box took the keyboard), else of the window
   * active now; `before`: what had the keyboard there then, where the box may have it by the time the read runs.
   */
  read(active?: W, before?: FocusBefore): void;
  /** Shows the box, which takes the keyboard. */
  show(): void;
}

/**
 * Opens the box in the order that loses the fewest letters: read, then show, where the keyboard is held or the user's
 * window can't be named (as before); else show, then read the window named just before. Where the keyboard isn't held,
 * the read runs once the box has it in either order, so it is told what had it.
 */
export function openAskInOrder<W>(o: AskOpening<W>): void {
  if (!o.look) { o.show(); return; }
  if (o.holding) {
    o.read();
    o.show();
    return;
  }
  const active = o.activeWindow();
  const keyboard = o.keyboard?.() ?? 0;
  const before: FocusBefore = keyboard ? { native: keyboard } : {};
  if (!active) {
    o.read(undefined, before);
    o.show();
    return;
  }
  o.show();
  o.read(active, before);
}

/** Where the user is, as a window system tells it (WindowSystem's members, structurally). `W`: its window. */
export interface UserWindows<W> {
  focusWindow(): W | null;
  activeWindow(): W | null;
  focusAndActive?(): { focus: W | null; active: W | null };
  /** The native element with the keyboard in the foreground window (WindowSystem.keyboardFocus), 0 when none. */
  keyboardFocus?(): number;
}

/**
 * The window with the keyboard (what the box opens over) and the active window (what is read once the box is up), taken
 * together just before the box shows: in one look where the window system can take both at once (macOS: one window list
 * and one AX round trip, not two of each before the box can have the keyboard), else one after the other. Both null
 * without a window system. `keyboard`: the native element with the keyboard in the active window, where the window
 * system can tell (Windows: its focused child window, one GetGUIThreadInfo), else 0 (cross-review P1).
 */
export function userWindowsNow<W>(ws: UserWindows<W> | null): { focus: W | null; active: W | null; keyboard: number } {
  if (!ws) return { focus: null, active: null, keyboard: 0 };
  const both = ws.focusAndActive ? ws.focusAndActive() : { focus: ws.focusWindow(), active: ws.activeWindow() };
  return { ...both, keyboard: keyboardIn(ws) };
}

/**
 * What a read that runs once one of Ember's windows has the keyboard is told had it in the user's window, taken before
 * Ember's window takes it (the handle's menu: its "Ask Ember…" opens the box without reading again): the native element
 * with it where the window system can tell (Windows), else {}, and the app is asked (macOS). Nothing where Ember holds
 * the keyboard (Linux): reads there aren't told (cross-review P1).
 */
export function focusBeforeNow(ws: Pick<UserWindows<unknown>, "keyboardFocus"> | null, holding: boolean): FocusBefore | undefined {
  if (holding) return undefined;
  const native = keyboardIn(ws);
  return native ? { native } : {};
}

/** The native element with the keyboard in the foreground window (WindowSystem.keyboardFocus), 0 when none or unknown. */
function keyboardIn(ws: Pick<UserWindows<unknown>, "keyboardFocus"> | null): number {
  try {
    return ws?.keyboardFocus?.() ?? 0;
  } catch {
    return 0; // Can't be told: the read finds what it can.
  }
}
