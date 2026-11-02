/**
 * Ember's presence (docs/DESIGN.md "Presence"): one ring round Ember, and round its face on the handle, whose ticks say
 * what Ember is doing at a glance. It is decoration that repeats what the words say, never the only sign of a state:
 * the bubble's and the handle's words carry it for screen readers and at a glance alike. Pure, so the overlay and the
 * handle share one mapping and it is unit-tested.
 */

import type { BubbleState } from "./overlay";
import type { MicState } from "./voice";
import { LEVEL_STEPS } from "./level";

/**
 * The ring's states: idle (no ring by the cursor; a dim one on the handle), listening (its ticks light with the
 * microphone's level), thinking, acting (Ember works with your mouse and keyboard, or shows you), needs (a question:
 * the full ring, still), error (red, with a notch), done (it completes once, then goes).
 */
export type Presence = "idle" | "listening" | "thinking" | "acting" | "needs" | "error" | "done";

/** The presence for what Ember shows now: the bubble's state first, then the microphone hearing a request. */
export function presenceOf(s: { bubble: Pick<BubbleState, "visible" | "mood">; mic?: MicState }): Presence {
  const b = s.bubble;
  if (b.visible) {
    switch (b.mood) {
      case "attention": return "needs";
      case "error": return "error";
      case "listening": return "listening";
      case "thinking": return "thinking";
      case "acting": case "guiding": return "acting";
      case "done": return "done";
      default: break;
    }
  }
  return s.mic === "active" ? "listening" : "idle";
}

/** How many ticks the ring has (one every 15°). */
export const RING_TICKS = 24;

/** How many ticks a microphone level lights, clockwise from the top (0 for silence: never lit on nothing). */
export function ticksLit(level: number | null | undefined): number {
  if (typeof level !== "number" || !(level > 0)) return 0;
  return Math.round((Math.min(level, LEVEL_STEPS) / LEVEL_STEPS) * RING_TICKS);
}

/** The voice meter's five bars at a level of Ember's own voice (each a scale of its full height, 0.15 at rest). */
export function meterBars(level: number | null | undefined): number[] {
  const t = typeof level === "number" && level > 0 ? Math.min(level, LEVEL_STEPS) / LEVEL_STEPS : 0;
  return [0.55, 0.8, 1, 0.8, 0.55].map(w => Math.round((0.15 + 0.85 * t * w) * 100) / 100);
}

/** How long the done ring shows before it goes (ms): it completes once, then fades with its animation. */
export const DONE_RING_MS = 2200;
