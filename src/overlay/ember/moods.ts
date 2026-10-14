/**
 * Ember's moods. Each agent state maps to a flame personality: its colour ramp
 * (from the hot core at birth to the cooling tip), how much it burns, and what
 * extra effects it shows.
 */

export type Mood =
  | "idle"       // resting next to the cursor
  | "listening"  // push-to-talk held; rings pulse with your voice
  | "thinking"   // model is reasoning; sparks orbit the flame
  | "acting"     // flying to a target and operating the real cursor
  | "guiding"    // pointing at something for you to click
  | "attention"  // needs your decision (confirm a risky step, answer a question)
  | "error"      // something failed; the flame gutters
  | "done";      // task finished; a short flare, then back to idle

export interface MoodStyle {
  /** Colour ramp sampled by particle age: core (t=0) → tip (t=1). */
  ramp: string[];
  /** Soft halo colour around the flame base. */
  glow: string;
  /** Flame particles emitted per second. */
  rate: number;
  /** Upward acceleration in px/s². Higher = taller, livelier flame. */
  lift: number;
  /** Starting particle radius in px. */
  size: number;
  /** Particle lifetime range in seconds. */
  life: [number, number];
  /** Horizontal turbulence. */
  sway: number;
  /** Free sparks per second rising off the tip. */
  sparks: number;
  /** Number of sparks orbiting the core (thinking). */
  orbiters: number;
  /** Speed of brightness flicker (Hz-ish). 0 = steady. */
  flicker: number;
  /** Dark smoke puffs per second (error). */
  smoke: number;
}

export const MOODS: Record<Mood, MoodStyle> = {
  idle: {
    ramp: ["#fff4d6", "#ffd889", "#ffa33d", "#f2641f", "#b8321b", "#4a140b"],
    glow: "#ff8a2a", rate: 94, lift: 195, size: 12.6, life: [0.45, 0.8],
    sway: 26, sparks: 1.2, orbiters: 0, flicker: 1.4, smoke: 0,
  },
  listening: {
    ramp: ["#ffffff", "#fff0b8", "#ffc45a", "#ff8a2a", "#e0461c", "#5a170c"],
    glow: "#ffb04a", rate: 148, lift: 273, size: 14.7, life: [0.5, 0.9],
    sway: 18, sparks: 2, orbiters: 0, flicker: 0.6, smoke: 0,
  },
  thinking: {
    ramp: ["#ffffff", "#fff6c9", "#ffd36b", "#ffa133", "#ea5a1e", "#5a170c"],
    glow: "#ffc457", rate: 128, lift: 240, size: 13.3, life: [0.45, 0.85],
    sway: 34, sparks: 3, orbiters: 7, flicker: 2.2, smoke: 0,
  },
  acting: {
    ramp: ["#ffffff", "#fff2bf", "#ffcb62", "#ff9330", "#f2541c", "#6a1a0c"],
    glow: "#ff9a35", rate: 189, lift: 156, size: 14.7, life: [0.35, 0.7],
    sway: 14, sparks: 5, orbiters: 0, flicker: 0.8, smoke: 0,
  },
  guiding: {
    ramp: ["#fff8e6", "#ffe39e", "#ffb54d", "#ff7d27", "#d9431b", "#4e150b"],
    glow: "#ffa040", rate: 115, lift: 214, size: 13.3, life: [0.45, 0.8],
    sway: 20, sparks: 1.5, orbiters: 0, flicker: 1.0, smoke: 0,
  },
  attention: {
    ramp: ["#ffffff", "#f3dcff", "#d29bff", "#a35cff", "#6c2bd9", "#24104a"],
    glow: "#a35cff", rate: 142, lift: 260, size: 14.0, life: [0.45, 0.85],
    sway: 30, sparks: 2.5, orbiters: 0, flicker: 3.2, smoke: 0,
  },
  error: {
    ramp: ["#ffd2a8", "#ff9a5a", "#d9482a", "#9c2616", "#521208", "#1f0804"],
    glow: "#a8301a", rate: 54, lift: 117, size: 10.5, life: [0.35, 0.65],
    sway: 40, sparks: 0.3, orbiters: 0, flicker: 5.5, smoke: 5,
  },
  done: {
    ramp: ["#ffffff", "#fffbe0", "#ffe08a", "#ffb347", "#ff7a26", "#6a1a0c"],
    glow: "#ffd36b", rate: 216, lift: 338, size: 16.1, life: [0.5, 0.95],
    sway: 22, sparks: 10, orbiters: 0, flicker: 0.4, smoke: 0,
  },
};

/** Human-readable label shown in the reasoning bubble's state chip. */
export const MOOD_LABEL: Record<Mood, string> = {
  idle: "Ready",
  listening: "Listening",
  thinking: "Thinking",
  acting: "Working",
  guiding: "Showing you",
  attention: "Needs you",
  error: "Stuck",
  done: "Done",
};
