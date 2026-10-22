/**
 * Where Ember works, as the floating layer shows it (§2.4, §8.1): the handle's badge for the picker's target, the ask
 * box's chip, and the `where` badge on the bubble and task cards. Nothing at all for this computer, so with no other
 * target nothing on screen changes. Pure and renderer-safe; ui-copy.test.ts pins the words.
 */

import type { TargetSummary } from "../../shared/targets";

/** The handle's badge: the target's label, a dot for its state (never colour alone: the words say it too). */
export interface TargetBadge {
  text: string;
  state: "ready" | "connecting" | "off" | "lost";
  /** The accessible name and tooltip: "Working on build-01", with the state when it isn't ready. */
  label: string;
}

const STATE_WORDS: Readonly<Record<TargetBadge["state"], string>> = { ready: "", connecting: " (connecting…)", lost: " (lost)", off: " (not connected)" };

/** The handle's badge for the picker's target, or null for this computer (or none). */
export function targetBadge(t: TargetSummary | null | undefined): TargetBadge | null {
  if (!t || t.id === "local" || t.kind === "local" || typeof t.label !== "string" || !t.label) return null;
  const state: TargetBadge["state"] = t.state === "ready" ? "ready" : t.state === "connecting" ? "connecting" : t.state === "lost" ? "lost" : "off";
  return { text: t.label, state, label: `Working on ${t.label}${STATE_WORDS[state]}` };
}

/** The ask box's chip: "On build-01", "In Ubuntu (WSL)"; null for this computer. */
export function targetChip(t: TargetSummary | null | undefined): string | null {
  if (!t || t.id === "local" || t.kind === "local" || typeof t.label !== "string" || !t.label) return null;
  return t.kind === "wsl" ? `In ${t.label}` : `On ${t.label}`;
}

/** A `where` badge's words ("on build-01", "in Ubuntu (WSL)"), trimmed; null when there are none. */
export function whereText(where: unknown): string | null {
  if (typeof where !== "string") return null;
  const w = where.replace(/\s+/g, " ").trim();
  return w ? w.slice(0, 80) : null;
}
