/** Bounded numeric diagnostics from Ember's own command card. No approval, input, text or execution authority. */
export interface CommandCardObservationData {
  schema: 1;
  /** 1: an existing measurement's paint; 2: an existing render or arm-timer paint. */
  source: 1 | 2;
  model: number;
  ui: number;
  /** Zero is unmeasured, never proof that geometry failed. */
  geometry: number;
  /** 0: unknown; 1: before the model's arm deadline; 2: at or past that deadline. */
  arm: 0 | 1 | 2;
  /** Last permitted observation: later state is unknown because the renderer retires this diagnostic stream. */
  capped: 0 | 1;
}
/** A standalone diagnostic on the existing cardSeen channel, deliberately without approval-bearing seen/inView. */
export interface CommandCardObservationMsg { n: number; diagnostic: CommandCardObservationData }

/** Closed domains shared by the browser-safe preload projection and main's stricter owned-message parser. */
export const COMMAND_CARD_OBSERVATION_RANGES = Object.freeze({
  schema: Object.freeze([1, 1] as const), source: Object.freeze([1, 2] as const), model: Object.freeze([0, 127] as const), ui: Object.freeze([0, 31] as const),
  geometry: Object.freeze([0, 511] as const), arm: Object.freeze([0, 2] as const), capped: Object.freeze([0, 1] as const),
} as const);
/** Fixed bit meanings only. No actual dimensions, commands, titles, identifiers or timestamps leave the renderer. */
export const COMMAND_CARD_OBSERVATION_BITS = Object.freeze({
  model: Object.freeze({ present: 1, fits: 2, atEnd: 4, seen: 8, inView: 16, sent: 32, retry: 64 }),
  ui: Object.freeze({ commandPresent: 1, allowPresent: 2, allowEnabled: 4, denyEnabled: 8, allowDisabled: 16 }),
  geometry: Object.freeze({ known: 1, fits: 2, atEnd: 4, onScreen: 8, visible: 16, inClip: 32, inViewport: 64, positive: 128, sticky: 256 }),
});
