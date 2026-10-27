/**
 * When Windows won't let Ember's input through, decided from facts about tokens and desktops. UIPI drops injected
 * input to a window of a more privileged process (elevated, or a higher integrity level) without any error, so the
 * borrow must be refused up front. The secure desktop (UAC, Ctrl+Alt+Del, the lock screen) takes the keyboard and the
 * screen away from the user's desktop. Both fail closed: a check that can't run counts as blocked. Pure.
 */

/** What decides UIPI for a process: is its token elevated, and its integrity level (0x2000 medium, 0x3000 high…). */
export interface TokenFacts { elevated: boolean; integrity: number | null }

/** Why input can't reach a window: an elevated program's, or one Ember couldn't check. */
export type InputBlock = "elevated" | "unchecked";

/**
 * Would UIPI drop Ember's input to a process with `target`'s token? "elevated" when the target is elevated and Ember
 * isn't, or runs at a higher integrity level; "unchecked" when either token couldn't be read; null when input gets
 * through.
 */
export function uipiBlock(own: TokenFacts | null, target: TokenFacts | null): InputBlock | null {
  if (!own || !target) return "unchecked";
  if (target.elevated && !own.elevated) return "elevated";
  if (own.integrity === null || target.integrity === null) return "unchecked";
  return target.integrity > own.integrity ? "elevated" : null;
}

export const ELEVATED_REASON = "That window belongs to a program running as administrator, so Ember can't use the mouse or keyboard there.";
export const UNCHECKED_REASON = "Ember couldn't check whether that window belongs to a program running as administrator, so it won't use the mouse or keyboard there.";

/** The sentence for the user about a block (null when there is none). */
export function blockReason(block: InputBlock | null): string | null {
  return block === "elevated" ? ELEVATED_REASON : block === "unchecked" ? UNCHECKED_REASON : null;
}

/**
 * Is the input desktop the user's own ("Default")? Not when it is the secure desktop ("Winlogon": UAC, Ctrl+Alt+Del,
 * the lock screen) or a screen saver's, and not when it couldn't be opened (`name` null), which is what happens on
 * the secure desktop.
 */
export function onUsersDesktop(name: string | null): boolean {
  return name !== null && name.toLowerCase() === "default";
}
