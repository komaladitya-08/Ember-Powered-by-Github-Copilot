/**
 * The order in which the ask box opens (review #78, owner decision D-78). Where Ember holds the keyboard while the box
 * opens (Linux's keyboard hold), it reads where the user is first, as it always did: the letters typed meanwhile are
 * handed to the box. Where it can't (Windows, macOS), every letter typed before the box has the keyboard goes to the
 * user's app, so the box shows first and the screen is read after it, of the window the user was in, taken just before:
 * once the box is up, Windows' active window is the box, and macOS's AX names no focused app (or Ember) while the box's
 * panel has the keyboard, so a read of "the active window" then would find the box. Plain Node, no Electron.
 */

/** What one opening needs from main. `W`: the window system's window. */
export interface AskOpening<W> {
  /** Ember holds the keyboard while the box opens (Linux): the letters typed meanwhile go to the box. */
  holding: boolean;
  /** Ember reads where the user is (false: the handle's menu read it already, before it took the keyboard). */
  look: boolean;
  /** The window the user is in now; null when there is none or the window system can't tell. */
  activeWindow(): W | null;
  /** Starts reading the screen: of `active` when given (taken before the box took the keyboard), else of the window active now. */
  read(active?: W): void;
  /** Shows the box, which takes the keyboard. */
  show(): void;
}

/**
 * Opens the box in the order that loses the fewest letters: read, then show, where the keyboard is held or the user's
 * window can't be named (as before); else show, then read the window named just before.
 */
export function openAskInOrder<W>(o: AskOpening<W>): void {
  if (!o.look) { o.show(); return; }
  const active = o.holding ? null : o.activeWindow();
  if (!active) {
    o.read();
    o.show();
    return;
  }
  o.show();
  o.read(active);
}
