/**
 * The Secure Form's decisions that need no page (pure, unit-tested): which key presses its Save does not take. The
 * form's window takes the keyboard when it opens, so what the person was typing into their own app lands in it, and
 * their next Enter would keep it and have Autopilot fill it (review integ-y-3). The timing is the prompt window's own
 * (PROMPT_ARM_MS) and the held key the agree buttons' own (heldPress): no second rule.
 */

import { PROMPT_ARM_MS } from "../prompt/copy";
import { heldPress } from "../../shared/provider";

/** Where a key was pressed in the form: a box of several lines, its Cancel (or Close), or anywhere else (a box, Save). */
export type VaultKeyTarget = "lines" | "cancel" | "other";

/**
 * Does Save leave this key-down alone (its default is then prevented, so nothing is sent)? An Enter that is the repeat
 * of a held key, at any time, and an Enter within the prompt window's arm time of the form taking the keyboard
 * (`keyboardAt`: when it was shown, or when its window last got the keyboard). Never a key on Cancel or Close, nor
 * Esc: a no is always safe, and is taken at once. Enter in a box of several lines is a new line there and saves nothing.
 */
export function saveHeldBack(e: { key: string; repeat: boolean }, target: VaultKeyTarget, now: number, keyboardAt: number): boolean {
  if (target !== "other" || e.key !== "Enter") return false;
  return heldPress(e) || now < keyboardAt + PROMPT_ARM_MS;
}
