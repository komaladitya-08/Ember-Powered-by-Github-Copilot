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

/**
 * How the box's read of the window it opened over runs (cifix-x9-9, a probe's switch only): at once, as always
 * ("now"), not at all ("off"), or `ms` after the box shows ("delay"). The Windows suite opens the box with each to see
 * whether the app underneath taking the foreground back moves with that read. Anything but "off" or "delay:<ms>" (0 to
 * 30 s) is "now", and main reads the switch through devEnv, so a packaged Ember always reads at once.
 */
export type AskReadPlan = { kind: "now" } | { kind: "off" } | { kind: "delay"; ms: number } | { kind: "skip"; stage: AskReadStage };

/**
 * A stage of the read the probe may leave out, one per opening ("skip:<stage>", cifix-x9-10), to find which part of it
 * hands the foreground to the window read: "read", the accessibility host's read_window call itself (what is left is
 * main's own part); in the host, "lookup", all after listing the windows and finding the one read (no tree walk);
 * "texts", the text and selection reads of its fields; "looks", the looks at fields around secret ones, with nothing of
 * the read given back at all (no field is then left unredacted). Each only reads less and gives back less.
 * "time-texts" leaves nothing out: the host times each text look and its steps, and main logs them (cifix-x9-11).
 */
export const ASK_READ_STAGES = ["read", "lookup", "texts", "looks", "time-texts"] as const;
export type AskReadStage = typeof ASK_READ_STAGES[number];

/** The plan for `value`, EMBER_TEST_ASK_READ as devEnv gives it (undefined when packaged or unset). */
export function askReadPlan(value: string | undefined): AskReadPlan {
  if (value === "off") return { kind: "off" };
  const skip = value === undefined ? null : /^skip:([a-z-]+)$/.exec(value);
  if (skip && (ASK_READ_STAGES as readonly string[]).includes(skip[1])) return { kind: "skip", stage: skip[1] as AskReadStage };
  const m = value === undefined ? null : /^delay:(\d{1,5})$/.exec(value);
  const ms = m ? Number(m[1]) : NaN;
  return m && ms <= 30_000 ? { kind: "delay", ms } : { kind: "now" };
}

/**
 * Runs the read as `plan` says and gives what it will answer: `start` begins the read and gives its answer (main's
 * captureContext), at once for "now" (the same promise, nothing else done); never for "off" (null); after `later`'s
 * delay for "delay", telling `started` when it begins.
 */
export function readAsPlanned<C>(plan: AskReadPlan, start: () => Promise<C | null>, later: (run: () => void, ms: number) => void,
  started?: () => void): Promise<C | null> {
  if (plan.kind === "now" || plan.kind === "skip") return start();
  if (plan.kind === "off") return Promise.resolve(null);
  return new Promise<C | null>(resolve => later(() => {
    started?.();
    start().then(resolve, () => resolve(null));
  }, plan.ms));
}

/**
 * The read_window parameters for `plan` (cifix-x9-10): null to make no host read at all ("skip:read"), the host's
 * stage named as `probeSkip` for the stages it leaves out, else `params` themselves, unchanged.
 */
export function probeReadParams<P extends object>(plan: AskReadPlan, params: P): (P & { probeSkip?: AskReadStage }) | null {
  if (plan.kind !== "skip") return params;
  if (plan.stage === "read") return null;
  return { ...params, probeSkip: plan.stage };
}
