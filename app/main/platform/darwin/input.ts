/**
 * Synthetic input on macOS: Ember's Input (XInput's members, so CursorBorrow and its fakes work unchanged) over
 * CGEvent. Events are posted at the HID tap from one event source whose local-event suppression is off, so the
 * user's own mouse and keyboard keep working and can take over at once. Keys keep X's vocabulary (keysym names and
 * numbers); key codes are CGKeyCode + 8 (kVK_ANSI_A is 0, and 0 means "no key" to callers); buttons and the button
 * mask are X's. The modifiers Ember holds are set as flags on every event it posts. Posting needs the Accessibility
 * permission, without which macOS drops events silently: blockedReason() says so, and also refuses (failing closed)
 * while secure keyboard entry is on or can't be checked, and without Input Monitoring (Ember might not see the user
 * take over the keyboard). While the input source is an input method, or can't be read, only typing is refused
 * (keyboardBlockedReason, and textKey itself): it would compose from the key code Ember's text carries, while a click,
 * a scroll or a Command shortcut is never composed. Posted events become visible asynchronously, so the input says
 * `pointerLags`. AX calls (focus, titles,
 * activation) run with a 0.25 s timeout on Electron's main thread and never target Ember's own process. Whatever
 * Ember holds is let go by releaseAll(), by close() and when the process exits (a key posted down stays down).
 * createDarwinInput() holds the logic over a DarwinDesktop and a DarwinPoster, so it is unit-tested with fakes.
 */

import { strokeFor, type KeyLayout } from "../../hands/keymap";
import type { Logger } from "../../logger";
import type { Input, OwnWindowHandle } from "../types";
import { EVENT, FLAG, MOUSE_BUTTON } from "./cg";
import { openDesktop, openPoster, desktopError, secureInputCause, secureInputOf, type DarwinDesktop, type DarwinPoster } from "./desktop";
import { resolveActive, resolveFocus } from "./focus";
import {
  SHORTCUT_FLAGS, VK, buildLayout, cgKeyOf, charKeysym, isModifierKey, keyFlags, keysymOf, modifierFlags, namedKey, toCode,
  usNeedsShift,
} from "./keys";
import { clientWindowsOf, findWindowIn, parseMediaSourceId, pointerLandsOn, sameFrame, type AXWindowInfo, type TitledWindow } from "./model";

/** Shown when Ember isn't trusted for Accessibility (macOS would drop its events without a word). */
export const ACCESSIBILITY_REASON =
  "Ember needs the Accessibility permission (System Settings › Privacy & Security › Accessibility) to use the mouse and keyboard.";

/** Shown while another app holds secure keyboard entry. */
export function secureInputReason(app: string): string {
  const cause = secureInputCause(app);
  return `${cause[0]!.toUpperCase()}${cause.slice(1)}, so Ember won't use the mouse or keyboard until it's off.`;
}

/** Shown when neither IsSecureEventInputEnabled nor the session can say whether secure keyboard entry is on. */
export const SECURE_INPUT_UNKNOWN_REASON = "Ember can't tell whether a password is being typed, so it won't use the keyboard.";

/**
 * Shown without Input Monitoring: the user's keyboard brake is Ember seeing a key it doesn't hold, and whether
 * macOS shows other apps' keys to a process without the permission is undocumented, so Ember refuses rather than
 * risk typing on while the user types (design Q10: dropped only with evidence that key-state polling isn't gated).
 * CI's evidence so far (macos-15, 15.7.9, CI runs 122 and 123): with Accessibility granted and no Input Monitoring row
 * at all, CGPreflightListenEventAccess() answers true (Ember.app's own check-up says "Allowed" too) and a key another
 * process holds shows in GetKeys and CGEventSourceKeyState; so this refusal only ever shows without Accessibility,
 * which is refused first. Kept until the manual check on a real Mac (design §12.3 item 5) agrees.
 */
export const INPUT_MONITORING_REASON =
  "Ember needs Input Monitoring (System Settings › Privacy & Security › Input Monitoring) to notice when you take over the keyboard, so it won't use the mouse or keyboard without it.";

/** Shown when Ember would type while the input source is an input method, which would compose from Ember's keys. */
export const INPUT_METHOD_REASON = "An input method (Japanese, Pinyin, Korean…) is selected, so Ember won't type with the keyboard: switch to a keyboard layout, or let Ember fill the field directly.";

/** Shown when Ember would type while the current input source can't be read (so it might be an input method). */
export const INPUT_SOURCE_UNKNOWN_REASON = "Ember can't tell whether an input method is in use, so it won't type with the keyboard.";

/** Control, Command (Meta and Super) and Option (Alt) keysyms: held with a key, they make it a shortcut. */
const SHORTCUT_MODIFIERS: ReadonlySet<number> = new Set([0xffe3, 0xffe4, 0xffe7, 0xffe8, 0xffe9, 0xffea, 0xffeb, 0xffec]);
/** Does this key type a character, which an input method composes from: any key of the layout, space, the keypad's? */
const typesCharacter = (sym: number): boolean => namedKey(sym) < 0 || sym === 0x20 || (sym >= 0xffaa && sym <= 0xffbd);

/** Lines one wheel notch scrolls (X's buttons 4–7 are one notch each; 3 matches Windows' default). */
export const LINES_PER_NOTCH = 3;
/** Two presses of a button this close in time and place make a double click (NSEvent's default interval). */
export const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP = 4;
/** How long findWindow() may spend reading app windows over AX (ms). */
const FIND_BUDGET_MS = 1000;

interface ButtonEvents { cg: number; down: number; up: number; drag: number }
const OTHER = { down: EVENT.otherMouseDown, up: EVENT.otherMouseUp, drag: EVENT.otherMouseDragged };
/** X button → CGMouseButton and its event types (8 and 9 are back and forward). */
const BUTTONS: Record<number, ButtonEvents> = {
  1: { cg: MOUSE_BUTTON.left, down: EVENT.leftMouseDown, up: EVENT.leftMouseUp, drag: EVENT.leftMouseDragged },
  2: { cg: MOUSE_BUTTON.center, ...OTHER },
  3: { cg: MOUSE_BUTTON.right, down: EVENT.rightMouseDown, up: EVENT.rightMouseUp, drag: EVENT.rightMouseDragged },
  8: { cg: 3, ...OTHER },
  9: { cg: 4, ...OTHER },
};
/** X wheel buttons → [lines, columns] for one notch (CG: positive lines scroll up, positive columns scroll left). */
const WHEEL: Record<number, [number, number]> = {
  4: [LINES_PER_NOTCH, 0], 5: [-LINES_PER_NOTCH, 0], 6: [0, LINES_PER_NOTCH], 7: [0, -LINES_PER_NOTCH],
};

/** X button-mask bits of the buttons, and X modifier-mask bits of the CGEventFlags. */
const BUTTON_MASKS: [cgButton: number, mask: number][] = [[MOUSE_BUTTON.left, 256], [MOUSE_BUTTON.center, 512], [MOUSE_BUTTON.right, 1024]];
const MODIFIER_MASKS: [flag: number, mask: number][] = [
  [FLAG.shift, 1], [FLAG.alphaShift, 2], [FLAG.control, 4], [FLAG.alternate, 8], [FLAG.command, 64],
];

/** What openDarwinInput() may take from main. */
export interface DarwinInputDeps {
  /**
   * Extension: Electron's BrowserWindow.getFocusedWindow(). When one of Ember's windows has the keyboard,
   * focusedWindow() says so (its id), so keys meant for another window are never typed into Ember's.
   */
  focusedOwnWindow?: () => OwnWindowHandle | null;
  /**
   * Where `platform.secure_input_unknown` goes (once) when Ember can't tell whether secure keyboard entry is on, and
   * `platform.activation_fallback` when an app is activated through LaunchServices.
   */
  log?: Pick<Logger, "warn" | "info">;
}

/** Input on macOS, with the optional members it implements. */
export interface DarwinInput extends Input {
  /** CGEventPost hands events to the window server, which applies them a little later (CursorBorrow allows for it). */
  readonly pointerLags: true;
  textKey(ch: string, down: boolean): boolean;
  onScreen(x: number, y: number): boolean;
  blockedReason(window: number): string | null;
  keyboardBlockedReason(keys?: { modifiers: readonly number[]; sym: number }): string | null;
  layout(): KeyLayout | null;
  keyboardGrabbed(window?: number): boolean;
  pointerOn(window: number, elementWindow?: number): boolean;
  screenLocked(): boolean;
}

/** Tunables and seams for the tests. */
export interface DarwinInputOptions {
  ownPid?: number;
  now?: () => number;
  /** Registers `fn` to run at process exit; returns the unregister. Defaults to process.on("exit"). */
  onExit?: (fn: () => void) => () => void;
}

const defaultOnExit = (fn: () => void) => {
  process.on("exit", fn);
  return () => {
    process.off("exit", fn);
  };
};

/** Ember's Input over a DarwinDesktop and a DarwinPoster. */
export function createDarwinInput(desktop: DarwinDesktop, poster: DarwinPoster, deps: DarwinInputDeps = {}, o: DarwinInputOptions = {}): DarwinInput {
  const ownPid = o.ownPid ?? process.pid;
  const now = o.now ?? Date.now;
  let open = true;
  /** Key codes (CGKeyCode + 8) Ember holds, modifiers included, in the order they went down. */
  const keysHeld = new Set<number>();
  /** X buttons Ember holds (never the wheel). */
  const buttonsHeld = new Set<number>();
  /** Characters typed with textKey() that are down, and the CGKeyCode each went down on. */
  const textHeld = new Map<string, number>();
  let last: { x: number; y: number } | null = null;
  let lastDown: { button: number; at: number; x: number; y: number; count: number } | null = null;
  const layouts = new WeakMap<object, KeyLayout>();

  const ownFocusedId = () => {
    const win = deps.focusedOwnWindow?.();
    if (!win) return 0;
    try {
      return parseMediaSourceId(win.getMediaSourceId());
    } catch {
      return 0; // a destroyed window
    }
  };
  const focus = { desktop, ownPid, ownFocusedId };

  /** The flags every event carries: the modifiers Ember holds (with their device bits), like hardware events. */
  const heldFlags = (): number => {
    let flags = FLAG.nonCoalesced;
    for (const code of keysHeld) flags |= modifierFlags(code - 8);
    return flags;
  };
  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      // one failed post must not keep the rest of releaseAll() from letting go
    }
  };
  const where = () => desktop.pointer() ?? last;

  const layout = (): KeyLayout | null => {
    if (!open) return null;
    const source = desktop.keyboardLayout();
    if (!source) return null;
    let built = layouts.get(source);
    if (!built) layouts.set(source, (built = buildLayout((key, mods) => source.translate(key, mods))));
    return built;
  };
  const keycodeOf = (sym: number): number => {
    if (!open || !sym) return 0;
    const named = namedKey(sym);
    if (named >= 0) return toCode(named);
    // A character's key depends on the layout. Where it can't be read there is no safe guess: a US position on an
    // AZERTY keyboard turns Command+A into Command+Q.
    const l = layout();
    if (!l) return 0;
    return (strokeFor(sym, l.typing) ?? strokeFor(sym, l.shortcuts))?.code ?? 0;
  };
  const keycode = (code: number, down: boolean): void => {
    if (!open) return;
    const cg = cgKeyOf(code);
    if (cg < 0) return;
    // The held set first, so a modifier's own event already carries (or no longer carries) its flag.
    if (down) keysHeld.add(code);
    else keysHeld.delete(code);
    poster.key(cg, down, heldFlags() | keyFlags(cg));
  };
  const sendButton = (button: number, down: boolean, at: { x: number; y: number }, clickState: number) => {
    const b = BUTTONS[button]!;
    poster.mouse(down ? b.down : b.up, Math.round(at.x), Math.round(at.y), b.cg, clickState, heldFlags());
  };
  const clickCount = (button: number, at: { x: number; y: number }): number => {
    const t = now();
    const prev = lastDown;
    const again = !!prev && prev.button === button && t - prev.at <= DOUBLE_CLICK_MS
      && Math.abs(prev.x - at.x) <= DOUBLE_CLICK_SLOP && Math.abs(prev.y - at.y) <= DOUBLE_CLICK_SLOP;
    lastDown = { button, at: t, x: at.x, y: at.y, count: again ? prev!.count + 1 : 1 };
    return lastDown.count;
  };
  let unknownLogged = false;
  /**
   * Why secure keyboard entry stops Ember, or null when it is off. Whichever app holds it, a password is being typed:
   * when it is the target itself, its password field has the keyboard and Ember's keys would land in it, so the
   * target gets no exception. When it can't be told, Ember acts as if it were on (fail closed).
   */
  const secureReason = (): string | null => {
    const state = secureInputOf(desktop);
    if (state.on === false) return null;
    if (state.on === true) return secureInputReason(state.app);
    if (!unknownLogged) {
      unknownLogged = true;
      deps.log?.warn("platform.secure_input_unknown", { part: "input" });
    }
    return SECURE_INPUT_UNKNOWN_REASON;
  };
  /** Why the input source stops typing (an input method, or one that can't be read), or null for a keyboard layout. */
  const inputSourceReason = (): string | null => {
    const layout = desktop.inputSourceIsLayout();
    return layout === true ? null : layout === false ? INPUT_METHOD_REASON : INPUT_SOURCE_UNKNOWN_REASON;
  };
  const releaseAll = (): void => {
    if (!open) return;
    const codes = [...keysHeld];
    // Ordinary keys first, so each goes up with the modifiers it went down with; then the modifiers.
    for (const code of [...codes.filter(c => !isModifierKey(c - 8)), ...codes.filter(c => isModifierKey(c - 8))]) {
      keysHeld.delete(code);
      safely(() => poster.key(code - 8, false, heldFlags() | keyFlags(code - 8)));
    }
    for (const [ch, cg] of textHeld) safely(() => (cg === VK.ansiA ? poster.text(cg, ch, false, FLAG.nonCoalesced) : poster.key(cg, false, FLAG.nonCoalesced)));
    textHeld.clear();
    const at = where() ?? { x: 0, y: 0 };
    for (const b of buttonsHeld) safely(() => sendButton(b, false, at, lastDown?.button === b ? lastDown.count : 1));
    buttonsHeld.clear();
  };
  const unregisterExit = (o.onExit ?? defaultOnExit)(releaseAll);

  return {
    pointerLags: true,

    pointer() {
      if (!open) return null;
      const p = desktop.pointer();
      return p ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
    },

    pointerState() {
      if (!open) return null;
      const p = desktop.pointer();
      if (!p) return null;
      const flags = desktop.flags();
      let mask = 0;
      for (const [cg, bit] of BUTTON_MASKS) if (desktop.buttonDown(cg)) mask |= bit;
      for (const [flag, bit] of MODIFIER_MASKS) if (flags & flag) mask |= bit;
      return { x: Math.round(p.x), y: Math.round(p.y), mask };
    },

    move(x, y) {
      if (!open) return;
      const at = { x: Math.round(x), y: Math.round(y) };
      // While a button is held a move is a drag, as the hardware sends it (left wins, then right, then the others).
      const held = buttonsHeld.has(1) ? 1 : buttonsHeld.has(3) ? 3 : [...buttonsHeld][0];
      if (held !== undefined) {
        const b = BUTTONS[held]!;
        poster.mouse(b.drag, at.x, at.y, b.cg, lastDown?.button === held ? lastDown.count : 1, heldFlags());
      } else {
        poster.mouse(EVENT.mouseMoved, at.x, at.y, MOUSE_BUTTON.left, 0, heldFlags());
      }
      last = at;
    },

    button(button, down) {
      if (!open) return;
      const wheel = WHEEL[button];
      if (wheel) {
        // One notch on the press; the release has no wheel event (and is never held).
        if (down) poster.scroll(wheel[0], wheel[1], heldFlags());
        return;
      }
      if (!BUTTONS[button]) return;
      const at = where();
      if (down) {
        if (!at) return; // nowhere known to press: no click at a guess
        buttonsHeld.add(button);
        sendButton(button, true, at, clickCount(button, at));
      } else {
        buttonsHeld.delete(button);
        sendButton(button, false, at ?? { x: 0, y: 0 }, lastDown?.button === button ? lastDown.count : 1);
      }
    },

    keysym(sym, down) {
      if (!open) return false;
      const code = keycodeOf(sym);
      if (!code) return false;
      keycode(code, down);
      return true;
    },

    keycode,

    keysymOf(name) {
      return keysymOf(name);
    },

    keysDown() {
      if (!open) return [];
      // Caps Lock is left out: its key state can read as down while the lock is on, which isn't the user acting.
      return desktop.keysDown().filter(cg => cg !== VK.capsLock).map(toCode);
    },

    keycodeOf,

    needsShift(sym) {
      if (!open || namedKey(sym) >= 0) return false;
      const l = layout();
      if (l) return (strokeFor(sym, l.typing) ?? strokeFor(sym, l.shortcuts))?.shift ?? false;
      return usNeedsShift(sym);
    },

    activeWindow() {
      if (!open) return 0;
      // The same window WindowSystem.activeWindow() reports: the one to give the keyboard back to after a borrow.
      return resolveActive(focus, desktop.windows())?.id ?? 0;
    },

    screenSize() {
      if (!open) return { width: 0, height: 0 };
      const main = desktop.mainDisplay();
      return main ? { width: main.width, height: main.height } : { width: 0, height: 0 };
    },

    findWindow(title, pid, wmClass) {
      if (!open || !title) return 0;
      const apps = clientWindowsOf(desktop.windows());
      const theirs = pid !== undefined && apps.some(w => w.pid === pid);
      const considered = theirs ? apps.filter(w => w.pid === pid) : apps;
      // CGWindowList's titles need Screen Recording; AX has them (one AXWindows read per app, within a budget).
      const ax = new Map<number, AXWindowInfo[] | null>();
      const until = now() + FIND_BUDGET_MS;
      const windows: TitledWindow[] = considered.map(w => {
        if (w.title || w.pid === ownPid) return { id: w.id, pid: w.pid!, owner: w.wmClass, title: w.title };
        if (!ax.has(w.pid!)) ax.set(w.pid!, now() > until ? null : desktop.appWindows(w.pid!));
        const listed = ax.get(w.pid!);
        if (!listed) return { id: w.id, pid: w.pid!, owner: w.wmClass, title: null }; // unknown: findWindowIn won't guess
        const match = listed.filter(a => (a.id ? a.id === w.id : sameFrame(a.frame, w)));
        // AX read the app: a window it doesn't list, or lists twice alike, has no title Ember can use.
        return { id: w.id, pid: w.pid!, owner: w.wmClass, title: match.length === 1 ? match[0]!.title : "" };
      });
      return findWindowIn(windows, title, theirs ? pid : undefined, wmClass);
    },

    focusedWindow() {
      if (!open) return 0;
      return resolveFocus(focus, desktop.windows())?.id ?? 0;
    },

    activate(window) {
      if (!open || !window) return;
      const list = desktop.windows();
      const e = list.find(w => w.id === window);
      // Ember's own windows are focused by main through Electron: AX on Ember's process would block its main thread.
      if (!e || e.pid === ownPid) return;
      // Already the front window and the one with the keyboard: nothing to raise. The keyboard alone is not enough —
      // another window of the same app can sit in front of the one that has it, and that one is not active until raised.
      if (resolveFocus(focus, list)?.id === window && resolveActive(focus, list)?.id === window) return;
      desktop.raise(e.pid, window, e.bounds);
    },

    sync() {
      // CGEventPost hands each event over at once: there is nothing to flush.
    },

    releaseAll,

    close() {
      if (!open) return;
      releaseAll();
      open = false;
      unregisterExit();
      poster.close();
      desktop.dispose?.();
    },

    layout,

    textKey(ch, down) {
      if (!open || [...ch].length !== 1) return false;
      // Under Command, Control or Option a typed character would be a shortcut instead.
      if (heldFlags() & SHORTCUT_FLAGS) return false;
      const named = ch === "\n" || ch === "\r" ? VK.return : ch === "\t" ? VK.tab : -1;
      if (named < 0 && !charKeysym(ch)) return false; // control characters type nothing
      // An input method would compose from the A key's code instead of inserting the text (a key-up still goes out).
      if (down && inputSourceReason() !== null) return false;
      if (named >= 0) poster.key(named, down, FLAG.nonCoalesced);
      else poster.text(VK.ansiA, ch, down, FLAG.nonCoalesced);
      if (down) textHeld.set(ch, named >= 0 ? named : VK.ansiA);
      else textHeld.delete(ch);
      return true;
    },

    onScreen(x, y) {
      return open && Number.isFinite(x) && Number.isFinite(y) && desktop.displaysAt(x, y) > 0;
    },

    blockedReason() {
      if (!open) return null;
      if (!desktop.trusted()) return ACCESSIBILITY_REASON;
      const secure = secureReason();
      if (secure) return secure;
      // null: the call doesn't exist, which means a macOS older than the permission itself (10.15).
      if (desktop.listenAccess() === false) return INPUT_MONITORING_REASON;
      // The input source matters only for typing (keyboardBlockedReason): clicks and shortcuts aren't composed.
      return null;
    },

    keyboardBlockedReason(keys) {
      if (!open) return null;
      // Under Command, Control or Option a key is a shortcut, and a key that types nothing (Return, the arrows, the
      // F-keys) has nothing to compose: only typed text and character keys wait for a keyboard layout.
      if (keys && (keys.modifiers.some(m => SHORTCUT_MODIFIERS.has(m)) || !typesCharacter(keys.sym))) return null;
      return inputSourceReason();
    },

    keyboardGrabbed() {
      // CursorBorrow asks before every character: a password field taking the keyboard mid-borrow stops the typing.
      if (!open) return false;
      return secureReason() !== null;
    },

    pointerOn(window, elementWindow) {
      if (!open || !window) return false;
      const p = desktop.pointer();
      return !!p && pointerLandsOn(desktop.windows(), p.x, p.y, window, ownPid, elementWindow);
    },

    screenLocked() {
      if (!open) return false;
      return desktop.session()?.locked === true || desktop.displayAsleep();
    },
  };
}

/** Why the last openDarwinInput() returned null (for the log). */
export let darwinInputError: unknown = null;

/**
 * Synthetic input on macOS, or null off macOS or when CoreGraphics or an event source isn't available
 * (darwinInputError says why). It opens without the Accessibility permission; blockedReason() reports it missing.
 */
export function openDarwinInput(deps: DarwinInputDeps = {}): DarwinInput | null {
  if (process.platform !== "darwin") {
    darwinInputError = new Error("not macOS");
    return null;
  }
  try {
    const desktop = openDesktop({ log: deps.log });
    if (!desktop) {
      darwinInputError = desktopError;
      return null;
    }
    const poster = openPoster();
    if (!poster) {
      darwinInputError = new Error("cannot create a CoreGraphics event source");
      return null;
    }
    return createDarwinInput(desktop, poster, deps);
  } catch (err) {
    darwinInputError = err;
    return null;
  }
}
