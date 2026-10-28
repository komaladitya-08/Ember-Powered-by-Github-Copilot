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
  // A WSL distro that is off is stopped (WSL's own word), not disconnected: it starts on the first command (review #189).
  const words = t.kind === "wsl" && state === "off" ? " (stopped)" : STATE_WORDS[state];
  return { text: t.label, state, label: `Working on ${t.label}${words}` };
}

/** The ask box's chip: "On build-01", "In Ubuntu (WSL)"; null for this computer. */
export function targetChip(t: TargetSummary | null | undefined): string | null {
  if (!t || t.id === "local" || t.kind === "local" || typeof t.label !== "string" || !t.label) return null;
  return t.kind === "wsl" ? `In ${t.label}` : `On ${t.label}`;
}

/**
 * The corner card's badge (no compositor), beside Ember's name: where the bubble's task acts when it says ("on
 * build-01"), before the picker's choice. A task's bubble that says nothing is on this computer, so it gets no badge
 * (never "build-01" beside a question about this PC); the conversation's bubble keeps the picker's badge.
 */
export function cardBadge(b: { where?: string; task: boolean }, t: TargetSummary | null | undefined): TargetBadge | null {
  const w = whereText(b.where);
  if (w) return { text: w, state: "ready", label: `Working ${w}` };
  return b.task ? null : targetBadge(t);
}

/** A `where` badge's words ("on build-01", "in Ubuntu (WSL)"), trimmed; null when there are none. */
export function whereText(where: unknown): string | null {
  if (typeof where !== "string") return null;
  const w = where.replace(/\s+/g, " ").trim();
  return w ? w.slice(0, 80) : null;
}

/** The longest place the bubble's badge shows whole (it then fits its capsule: overlay styles.css's .where). */
const SHORT_WHERE = 20;

/**
 * The bubble's badge words, shortened from the middle when long, so a host's start and end both show ("on
 * ip-10-0-…internal"): an ellipsis at the end hid the part that tells two hosts apart. Screen readers get whereText.
 */
export function shortWhere(where: unknown): string | null {
  const w = whereText(where);
  if (!w || w.length <= SHORT_WHERE) return w;
  return `${w.slice(0, 11).trimEnd()}…${w.slice(-8).trimStart()}`;
}
