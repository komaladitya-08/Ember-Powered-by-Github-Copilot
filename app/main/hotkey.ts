/**
 * The global-shortcut callback is not proof of a press. On X11 the active grab ends (and reports the shortcut again)
 * when the chord comes up, and another callback can arrive just after the keyboard buffer hands the grab back: the
 * ask box then opened on a Backspace or a click, with no Ctrl+Alt held. A callback only counts when the modifiers are
 * really down and it is not a repeat of the press that opened the box a moment ago.
 *
 * The chord check is an X11 re-report guard: Windows (RegisterHotKey) and macOS (Carbon hot keys) fire once per
 * press, so main passes no chord there (Platform.shortcutsReReported is false) and the press is trusted, debounced.
 */

/** Two presses closer than this are one: the second is the shortcut's release/repeat, not the user asking again. */
export const ASK_DEBOUNCE_MS = 300;

/**
 * What the X server says is held when the callback runs (null: no X11 to ask, or an OS that doesn't re-report a
 * shortcut). Space itself is deliberately not required: the callback may be delivered on its release, a moment
 * before the modifiers come up.
 */
export interface Chord { control: boolean; alt: boolean }

/**
 * Whether `at` is a fresh press of the ask shortcut (Ctrl+Alt+Space on Linux). Without a display to check (Wayland,
 * headless) or off Linux (`chord` null) the accelerator is trusted, but the debounce still applies.
 */
export function freshAskPress(chord: Chord | null, at: number, last: number): boolean {
  if (at - last < ASK_DEBOUNCE_MS) return false;
  if (!chord) return true;
  return chord.control && chord.alt;
}
