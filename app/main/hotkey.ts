/**
 * The global-shortcut callback is not proof of a press. On X11 the active grab ends (and reports the shortcut again)
 * when the chord comes up, and another callback can arrive just after the keyboard buffer hands the grab back: the
 * ask box then opened on a Backspace or a click, with no Ctrl+Alt held. A callback only counts when the modifiers are
 * really down and it is not a repeat of the press that opened the box a moment ago.
 *
 * The chord check is an X11 re-report guard: Windows (RegisterHotKey) and macOS (Carbon hot keys) fire once per
 * press, so main passes no chord there (Platform.shortcutsReReported is false) and the press is trusted, debounced.
 *
 * holdShortcuts registers Ember's shortcuts, each by its default chord or else its fallback (owner decision D-45b),
 * through an injected registry, so it is tested with a fake of Electron's globalShortcut.
 */

import type { ShortcutId, ShortcutTable } from "../shared/shortcuts";

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

/** What holdShortcuts needs of Electron's globalShortcut (a fake in tests). */
export interface ShortcutRegistry {
  /** Ember (this process) holds the accelerator already. */
  isRegistered(accel: string): boolean;
  /** Registers the accelerator for shortcut `id`; false when another app holds it (or the system refused it). */
  register(id: ShortcutId, accel: string): boolean;
}

/** What holdShortcuts leaves: the accelerators another app holds, and the shortcuts Ember holds by neither chord. */
export interface HoldResult {
  /** A default whose fallback Ember holds, and both chords of a shortcut it holds by neither (heldShortcuts reads it). */
  taken: string[];
  /** The shortcuts Ember holds by neither chord: main tries them again later. */
  missing: ShortcutId[];
}

/**
 * Holds each shortcut by its default chord, else by its fallback (owner decision D-45b), and says what another app holds.
 * A shortcut Ember holds already is left as it is: a fallback is kept once its default comes free, so the chord the
 * setup check and the greeting named doesn't change while Ember runs. One held by neither chord is tried again, default
 * first, at each call (main calls it every minute while one is missing).
 */
export function holdShortcuts(ids: readonly ShortcutId[], sc: ShortcutTable, fallback: ShortcutTable, reg: ShortcutRegistry): HoldResult {
  const out: HoldResult = { taken: [], missing: [] };
  const hold = (id: ShortcutId, accel: string) => {
    try { return reg.register(id, accel); } catch { return false; } // an accelerator the system rejects is one Ember can't hold
  };
  for (const id of ids) {
    const def = sc[id].accel, spare = fallback[id].accel;
    if (reg.isRegistered(def)) continue;
    if (reg.isRegistered(spare)) { out.taken.push(def); continue; }
    if (hold(id, def)) continue;
    if (hold(id, spare)) { out.taken.push(def); continue; }
    out.taken.push(def, spare);
    out.missing.push(id);
  }
  return out;
}
