/**
 * The reasoning bubble that rides under Ember: a state chip, a one-line intent,
 * the thought (its newest lines while it streams, then the whole of it from the
 * start), and the current step with its "why".
 *
 * It floats over any app, light or dark, so it always uses the same dark glass
 * (Liquid Glass's regular density: the screen shows faintly through, never enough
 * to compete with its words; lit at its edge) instead of following a page theme.
 *
 * It is drawn every frame, so it only touches the DOM when something changed and
 * only measures itself (a layout read) after its content changed.
 */

import { WHOLE_LABEL, WHOLE_READ_HINT, WHOLE_READ_SAID, WHOLE_UNREAD_SAID, wholeInView, wholeJudged, wholeNext, wholePage, wholeUnreported, type WholeState, type WholeView } from "./whole";

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }

/** What the agent is doing; drives the chip colour and label. */
export type BubbleMood =
  | "idle" | "listening" | "thinking" | "acting" | "guiding" | "attention" | "error" | "done";

export const BUBBLE_LABEL: Record<BubbleMood, string> = {
  idle: "Ready",
  listening: "Listening",
  thinking: "Thinking",
  acting: "Working",
  guiding: "Showing you",
  attention: "Needs you",
  error: "Problem",
  done: "Done",
};

/** The chip's words: an answer that is still arriving reads "Answering", not "Ready". */
export function chipLabel(mood: BubbleMood, streaming: boolean): string {
  return mood === "idle" && streaming ? "Answering" : BUBBLE_LABEL[mood];
}

/** The title only says the chip's word again ("Thinking…" beside "Thinking"): the bubble shows it once, in the chip. */
export function titleRepeatsChip(title: string, chip: string): boolean {
  const norm = (s: string) => s.trim().replace(/[.…]+$/, "").toLowerCase();
  return !!norm(title) && norm(title) === norm(chip);
}

/**
 * A question's words as the bubble sets them (review #9): the decision itself (its first sentence, up to its "?"), set
 * strongest; what follows it (what the step does: "It sends … to Priya Shah"); and the task it is part of ("Your task:
 * …", quieter, under it). Null when the text isn't a question's (no "?" in its first line): it is shown as it is.
 */
export function questionParts(thought: string): { ask: string; rest: string; task: string } | null {
  const at = thought.indexOf("\nYour task: ");
  const body = at >= 0 ? thought.slice(0, at) : thought;
  const task = at >= 0 ? thought.slice(at + 1).trim() : "";
  const q = /^([^\n]*?\?)(\s+[\s\S]*)?$/.exec(body.trim());
  if (!q) return null;
  return { ask: q[1], rest: (q[2] ?? "").trim(), task };
}

/**
 * A step row that names keys ("Ctrl+Alt+Y allow · Ctrl+Alt+N not now"), as keycaps and the words beside them; null for
 * any other step (a route in words: "Or press Ctrl+Alt+E and go to Conversation.", what Ember is doing).
 */
export function keyHintParts(step: string | null | undefined): { keys: string[]; word: string }[] | null {
  const parts = step?.split(/\s+·\s+/) ?? [];
  if (!parts.length) return null;
  const out: { keys: string[]; word: string }[] = [];
  for (const p of parts) {
    const m = /^(\S+\+\S+)\s+(.+)$/.exec(p.trim());
    if (!m) return null;
    out.push({ keys: m[1].split("+").filter(Boolean), word: m[2] });
  }
  return out;
}

/** The words a risky question's tag says (beside "Needs you"): policy asks about this kind of step every time. */
export const RISKY_TAG = "Risky step";
/** The tag beside Ember's own announcement of a step it took without asking (BubbleState.autonomous): never model text. */
export const AUTONOMOUS_TAG = "Without asking";
/** The caption before Ember's suggestions of what the user might say next (setSuggestions): they're Ember's guesses. */
export const SUGGEST_CAPTION = "Ember suggests";
/** Bubbles made on this page so far (each caption's id is its own). */
let suggestCaptions = 0;

export interface BubbleView {
  visible: boolean;
  mood: BubbleMood;
  title: string;
  thought: string;
  streaming: boolean;
  /** Where its task acts when not on this computer ("on build-01"): the badge says it to the eye, this to the ear. */
  where?: string;
  /**
   * Its step row: under a question, how to answer it ("Ctrl+Alt+Y allow · Ctrl+Alt+N not now"); under a problem, how the
   * keyboard reaches what its buttons do ("Or press Ctrl+Alt+E and go to Computers."). Read after it.
   */
  step?: string | null;
  /** A question's whole text (a long typed text its sentence cuts short): heard after the question, before its keys. */
  whole?: string;
  /** Main says all of the whole text has been shown (its Allow works): until then, that Allow waits for it is said too. */
  wholeSeen?: boolean;
  /** A question about a risky step: heard as such first ("Risky step."), as the eye sees its tag. */
  risky?: boolean;
}

/** A step row as heard: its parts as a list ("Ctrl+Alt+Y allow; Ctrl+Alt+N not now"). */
const stepWords = (step: string | null | undefined): string => step?.replace(/\s+·\s+/g, "; ").replace(/\s+/g, " ").trim() ?? "";
/** A sentence ended with a stop, unless it has one. */
const sentence = (s: string): string => (/[.!?…:]$/.test(s) ? s : `${s}.`);

/**
 * What a screen reader hears, once: finished answers and questions, never each
 * streamed token or the running commentary while Ember thinks or works.
 * "" means say nothing. A bubble from another computer says which first.
 */
export function announcement(v: BubbleView, speaker = "Ember"): string {
  if (!v.visible || v.streaming) return "";
  const text = v.thought.trim();
  const title = v.title.trim();
  const both = title && text ? `${/[.!?…:]$/.test(title) ? title : `${title}.`} ${text}` : title || text;
  const where = v.where?.replace(/\s+/g, " ").trim();
  const at = where ? `, ${where}` : "";
  // A question's step row says how to answer it (or where it is shown whole), a problem's how the keyboard reaches what
  // its buttons do, an answer cut short's where it is whole: heard after it, as it is seen under it. (A guide's step,
  // what it points at, is not read.)
  const hint = stepWords(v.step);
  const end = sentence;
  const withHint = hint ? `${end(both)} ${end(hint)}` : both;
  // A question's whole text is heard whole too (the block that shows it is for the eye), after its sentence, and until
  // all of it has been shown, that Allow waits for that: the approve key shows it a part at a time (its step says so).
  const whole = v.whole?.trim();
  const asked = whole && both ? `${end(both)} ${WHOLE_LABEL}: ${v.wholeSeen === true ? whole : `${end(whole)} ${WHOLE_UNREAD_SAID}`}` : both;
  switch (v.mood) {
    case "attention": return both ? `${speaker} needs you${at}: ${v.risky ? `${RISKY_TAG}. ` : ""}${hint ? `${end(asked)} ${end(hint)}` : asked}` : "";
    case "error": return both ? `${speaker} has a problem${at}: ${withHint}` : "";
    case "idle": case "done": return text || title ? `${speaker} says${at}: ${hint ? `${end(text || title)} ${end(hint)}` : text || title}` : "";
    case "guiding": return text || title ? `${speaker} says${at}: ${text || title}` : "";
    default: return "";
  }
}

/**
 * What the live region says when only one thing changed since it said `prev`: the same question, whose whole text has now
 * all been shown. Just that and the keys that answer ("You can allow it now. Ctrl+Alt+Y allow; Ctrl+Alt+N not now."), not
 * the question and all of its text again. Null for anything else (the caller says the announcement).
 */
export function wholeReadNews(prev: BubbleView | null, next: BubbleView): string | null {
  if (!prev || !prev.visible || !next.visible || prev.streaming || next.streaming) return null;
  if (next.mood !== "attention" || prev.mood !== next.mood || prev.title !== next.title || prev.thought !== next.thought || prev.where !== next.where) return null;
  if (!next.whole || prev.whole !== next.whole || prev.wholeSeen === true || next.wholeSeen !== true) return null;
  const hint = stepWords(next.step);
  return hint ? `${WHOLE_READ_SAID} ${sentence(hint)}` : WHOLE_READ_SAID;
}

/**
 * Whether the finished thought scrolls inside the bubble when it is longer than it shows (BUBBLE_CSS): a question's and
 * a problem's (up to ten lines), and an answer opened with "Read all". Its scroll area then takes the pointer.
 */
export function thoughtScrolls(v: { mood: BubbleMood; expanded: boolean; streaming: boolean }): boolean {
  return !v.streaming && (v.mood === "attention" || v.mood === "error" || v.expanded);
}

const MARGIN = 8;
const GAP = 6;
/** The narrowest the bubble gets (border box, px) to fit beside something it keeps off. */
export const MIN_BUBBLE_WIDTH = 220;

/** Where the bubble goes: its top-left corner and the size it has there. */
export interface BubbleSpot extends Point { width: number; height: number }

/** The usual places for a bubble of this size, in order of preference, and the one to fall back on. */
function placesFor(anchor: Point, box: Size, bounds: Size, size: number): { places: Point[]; fallback: Point; below: number; above: number } {
  const { width: w, height: h } = box;
  const clampX = (x: number) => Math.min(Math.max(x, MARGIN), Math.max(MARGIN, bounds.width - w - MARGIN));
  const clampY = (y: number) => Math.min(Math.max(y, MARGIN), Math.max(MARGIN, bounds.height - h - MARGIN));
  const fitsY = (y: number) => y >= MARGIN && y + h <= bounds.height - MARGIN;
  const fitsX = (x: number) => x >= MARGIN && x + w <= bounds.width - MARGIN;

  const right = anchor.x - 22;
  const x = clampX(right + w > bounds.width - MARGIN ? anchor.x - w + 22 : right);
  const below = anchor.y + Math.max(18, size * 0.2 + GAP);
  const above = anchor.y - h - Math.max(52, size * 1.5 + GAP);
  const places: Point[] = [below, above].filter(fitsY).map(y => ({ x, y }));
  if (size > 0) {
    const cy = anchor.y - size * 0.4;
    const y = clampY(cy - h / 2);
    if (fitsX(anchor.x + size * 0.75 + GAP)) places.push({ x: anchor.x + size * 0.75 + GAP, y });
    if (fitsX(anchor.x - size * 0.75 - GAP - w)) places.push({ x: anchor.x - size * 0.75 - GAP - w, y });
  }
  return { places, fallback: { x, y: clampY(below + h > bounds.height - MARGIN ? above : below) }, below, above };
}

/** The first place that covers nothing in `avoid` (sliding sideways past it below or above Ember), or null. */
function clearPlace(anchor: Point, box: Size, bounds: Size, size: number, avoid: readonly Rect[]): Point | null {
  const { width: w, height: h } = box;
  const { places, fallback, below, above } = placesFor(anchor, box, bounds, size);
  const fitsX = (x: number) => x >= MARGIN && x + w <= bounds.width - MARGIN;
  // Below and above are clear of Ember at any x, so there the bubble may also slide sideways past what it
  // avoids: the shortest slide first (it stays by Ember rather than jump to the far side of a window).
  const tries: Point[] = [];
  for (const p of places) {
    tries.push(p);
    if (p.y !== below && p.y !== above) continue;
    const slides = avoid.flatMap(r => [r.x - w - GAP, r.x + r.width + GAP]).filter(fitsX).sort((a, b) => Math.abs(a - p.x) - Math.abs(b - p.x));
    for (const sx of slides) tries.push({ x: sx, y: p.y });
  }
  // The fallback ignores Ember (it is clamped to the screen only): never taken over Ember's body and its emote, so a
  // bubble too big for any clear place (an answer opened in full) goes beside Ember over the cards instead (the usual
  // placement), not over Ember's face.
  const e = size > 0 ? { x: anchor.x - size * 0.75, y: anchor.y - size * 1.5, width: size * 1.5, height: size * 1.7 } : null;
  if (!e || !(fallback.x < e.x + e.width && fallback.x + w > e.x && fallback.y < e.y + e.height && fallback.y + h > e.y)) tries.push(fallback);
  const clear = (p: Point) => !avoid.some(r => p.x < r.x + r.width + GAP && p.x + w > r.x - GAP && p.y < r.y + r.height + GAP && p.y + h > r.y - GAP);
  return tries.find(clear) ?? null;
}

/**
 * Where the bubble's top-left corner goes. `anchor` is the base of Ember (its
 * centre + 0.4 × size). The bubble sits below-right of it and flips left or above
 * near the edges of `bounds`. Given Ember's `size` (px), it also keeps clear of
 * Ember's body and the emote over its head, so it never covers Ember in a corner;
 * if neither below nor above fits, it goes beside Ember. `avoid` are things it
 * should rather not cover (Ember's handle, the task cards): the first placement
 * that clears them wins, sliding sideways past them if that is what it takes;
 * when nothing clears them, the usual placement stands.
 */
export function bubblePosition(anchor: Point, box: Size, bounds: Size, size = 0, avoid: readonly Rect[] = []): Point {
  const { places, fallback } = placesFor(anchor, box, bounds, size);
  return (avoid.length ? clearPlace(anchor, box, bounds, size, avoid) : null) ?? places[0] ?? fallback;
}

/**
 * Like `bubblePosition`, but only a place that covers nothing in `avoid`: at the
 * bubble's own width, or narrower (down to MIN_BUBBLE_WIDTH) to fit the room
 * beside what it avoids, e.g. next to a centred settings window. A narrower
 * bubble is chosen when its own width finds no place, or only one much further
 * from Ember (across the window from it). `heightAt` says how tall the bubble is
 * at a given width (its text wraps onto more lines). Null when no place clears them.
 */
export function bubbleFit(anchor: Point, box: Size, bounds: Size, size = 0, avoid: readonly Rect[] = [], heightAt?: (width: number) => number): BubbleSpot | null {
  const away = (p: Point, b: Size) => Math.hypot(p.x + b.width / 2 - anchor.x, p.y + b.height / 2 - anchor.y);
  const own = clearPlace(anchor, box, bounds, size, avoid);
  let best: BubbleSpot | null = own && { ...own, ...box };
  if (!heightAt) return best;
  // A narrower one must be nearer by more than the bubble's width; of the narrower ones, the nearest (the wider of two as near).
  let far = own ? away(own, box) - box.width : Infinity;
  for (const width of narrowerWidths(box.width, bounds, avoid)) {
    const b = { width, height: heightAt(width) };
    const q = clearPlace(anchor, b, bounds, size, avoid);
    if (!q) continue;
    const d = away(q, b);
    if (d < far - 1) { best = { ...q, ...b }; far = d; }
  }
  return best;
}

/** The room beside each thing to avoid (left of it, right of it), widest first, where a bubble narrower than `width` would fit. */
function narrowerWidths(width: number, bounds: Size, avoid: readonly Rect[]): number[] {
  const rooms = avoid.flatMap(r => [r.x - GAP - MARGIN, bounds.width - MARGIN - (r.x + r.width + GAP)]).map(Math.floor);
  return [...new Set(rooms.filter(w => w >= MIN_BUBBLE_WIDTH && w < width))].sort((a, b) => b - a);
}

const STYLE_ID = "ember-bubble-style";

/**
 * A position in CSS px snapped to the device's pixels (1/dpr): a whole CSS px is half a device pixel at 150 %, and a
 * layer placed there is resampled, which blurs its text.
 */
export function snapToDevice(v: number, dpr: number): number {
  const s = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  return Math.round(v * s) / s;
}

/**
 * Where the bubble grows from as it appears (its `transform-origin`, px from its top left): the point nearest Ember's
 * base, inside the bubble, so it comes out of Ember (Apple: a surface emerges from its source).
 */
export function growOrigin(anchor: Point, at: Point, box: Size): Point {
  const clamp = (v: number, hi: number) => Math.round(Math.min(Math.max(v, 0), Math.max(0, hi)));
  return { x: clamp(anchor.x - at.x, box.width), y: clamp(anchor.y - at.y, box.height) };
}

/** The quickest streamed text is drawn again (ms): 15 times a second at most (R8), however fast it arrives. */
export const STREAM_MS = 66;

/** How long streamed text that arrived at `now` waits before it is drawn, when it was last drawn at `drawnAt` (ms). */
export function streamDelay(drawnAt: number, now: number): number {
  return Math.max(0, drawnAt + STREAM_MS - now);
}

export const BUBBLE_CSS = `
/* What moves with Ember every frame: an empty, unstyled box (its layer is only as big as the bubble in it), so a move
   restyles nothing but this box's transform. Moving the styled bubble itself re-resolved its glass, shadows and
   springs every frame. The bubble's widths are therefore of the overlay (100vw), not of this box. */
.eb-mount { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; will-change: transform; }
.ember-bubble {
  /* The state's colour: its dot, and the glow while Ember thinks. Actions use the app's one accent. The page's
     tokens (shared/ember.css) when present, so Increase Contrast reaches the bubble; Apple's values otherwise. */
  --eb-mood: var(--accent, #ff9230);
  /* Labels on glass one step firmer (ember.css --glass-label-*): its secondary words pass 4.5:1 over a white page. */
  --label-2: var(--glass-label-2, rgba(245, 240, 236, 0.74));
  --label-3: var(--glass-label-3, rgba(245, 240, 236, 0.66));
  position: absolute; left: 0; top: 0;
  width: min(300px, calc(100vw - 24px));
  display: grid; gap: 6px;
  padding: 12px 14px 13px;
  border-radius: var(--r-xl, 18px);
  /* Glass without a backdrop blur: with software compositing the blur cost ~10% of a core while Ember animated
     beside it, and it can't see other apps anyway. Apple's regular glass as a dense tint (0.88: the black text of a
     white page behind shows at under 1.5:1, so it never competes with Ember's), a sheen, a rim lit from the top left in
     its border, a lit top and darker bottom edge, a hairline of one device pixel (crisp over white pages) and two soft
     shadows give it the material's depth. The shadows are kept tight (a negative spread): everything they reach is
     redrawn on every frame the bubble moves. */
  border: 1px solid transparent;
  background: var(--glass,
    radial-gradient(140% 90% at 50% -30%, rgba(255, 255, 255, 0.08), transparent 60%) padding-box,
    linear-gradient(180deg, rgba(30, 27, 29, 0.88), rgba(20, 17, 19, 0.92)) padding-box,
    linear-gradient(160deg, rgba(255, 255, 255, 0.34), rgba(255, 255, 255, 0.1) 35%, rgba(255, 255, 255, 0.06) 65%, rgba(255, 255, 255, 0.18)) border-box);
  box-shadow: var(--glass-spec, inset 0 1px 0 rgba(255, 255, 255, 0.1), inset 0 -1px 0 rgba(0, 0, 0, 0.22)), var(--glass-hairline, 0 0 0 0.5px rgba(0, 0, 0, 0.6)), 0 2px 6px rgba(0, 0, 0, 0.18), 0 12px 28px -8px rgba(0, 0, 0, 0.42);
  color: var(--label, #f5f2ef);
  font: 400 14px/20px var(--ember-font, "Inter", "Atkinson Hyperlegible", system-ui, sans-serif);
  letter-spacing: -0.006em;
  pointer-events: none;
  /* Shown: it grows out of Ember (scale from the corner nearest Ember: place() sets the origin as it shows) on the
     brisk spring, from just below; it leaves the way it came, faster. Compositor only (opacity, translate, scale on
     the bubble's own layer). The shadow changes with the mood at once (a box-shadow transition would repaint the
     whole bubble every frame). */
  transition: opacity var(--t-fade-in, 180ms) ease-out, visibility 0s, translate var(--t-move, 420ms) var(--spring-brisk, ease-out), scale var(--t-move, 420ms) var(--spring-brisk, ease-out);
}
/* Hidden is gone once it has faded: nothing in it takes a click or the keyboard. */
.ember-bubble[data-hidden="true"] { opacity: 0; visibility: hidden; translate: 0 4px; scale: 0.96; transition-delay: 0s, 140ms, 0s, 0s; transition-duration: 140ms, 0s, 140ms, 140ms; transition-timing-function: ease-in; }
/* A question comes and goes by its opacity alone: nothing near a pending decision moves, grows or slides under the
   pointer (its buttons appear where they stay). The overlay never gives a hidden bubble a mood, so a question arrives
   on a bubble still posed as before (0.96, 4 px down): its translate and scale aren't transitioned at all, so they jump
   to rest the frame it shows, under its opacity 0 (bubble-motion-live.test.ts). */
.ember-bubble[data-mood="attention"], .ember-bubble[data-mood="attention"][data-hidden="true"] { translate: none; scale: none; }
.ember-bubble[data-mood="attention"] { transition: opacity var(--t-fade-in, 180ms) ease-out, visibility 0s; }
.ember-bubble[data-mood="attention"][data-hidden="true"] { transition: opacity 140ms ease-in, visibility 0s linear 140ms; }
.ember-bubble[data-mood="listening"] { --eb-mood: var(--yellow, #ffd600); }
.ember-bubble[data-mood="thinking"]  { --eb-mood: var(--accent-2, #ffb340); }
.ember-bubble[data-mood="acting"]    { --eb-mood: var(--accent, #ff9230); }
.ember-bubble[data-mood="guiding"]   { --eb-mood: var(--accent-2, #ffb340); }
.ember-bubble[data-mood="attention"] { --eb-mood: var(--purple, #db34f2); }
.ember-bubble[data-mood="error"]     { --eb-mood: var(--red, #ff4245); }
.ember-bubble[data-mood="done"]      { --eb-mood: var(--green, #30d158); }
/* While Ember thinks or listens, its own glow runs round the edge: embers, not an assistant's rainbow. It breathes three
   times as the state begins, then holds still (the dot keeps pulsing): while it breathes, the compositor redraws the
   whole bubble every frame, which with software compositing cost +60% of the display compositor's time for as long
   as Ember thought. Only its opacity animates, so it never repaints. */
.ember-bubble::before {
  content: ""; position: absolute; inset: -1px; border-radius: inherit; padding: 1.5px; pointer-events: none;
  background: conic-gradient(from 200deg, #ffb340, #ff9230 25%, #ff5a36 50%, #c2410c 72%, #ffb340);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
  opacity: 0; transition: opacity 400ms ease;
}
.ember-bubble:is([data-mood="thinking"], [data-mood="listening"]):not([data-hidden="true"])::before { opacity: 1; animation: eb-glow 1.6s ease-in-out 3; }
/* And a warm bloom round it (set once, not animated). */
.ember-bubble:is([data-mood="thinking"], [data-mood="listening"]) {
  box-shadow: var(--glass-spec, inset 0 1px 0 rgba(255, 255, 255, 0.1), inset 0 -1px 0 rgba(0, 0, 0, 0.22)), var(--glass-hairline, 0 0 0 0.5px rgba(0, 0, 0, 0.6)), 0 2px 6px rgba(0, 0, 0, 0.18), 0 12px 28px -8px rgba(0, 0, 0, 0.42),
    0 0 18px color-mix(in srgb, var(--glow, #ff8226) 30%, transparent);
}
/* A grid item is as wide as its longest word by default: one long unbroken word (an app's name on a
   button) would widen the bubble past its edge. */
.ember-bubble > * { min-width: 0; }
.eb-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* Nothing to say above the words (a finished answer: the bubble is Ember's, its name needn't title it). */
.eb-head[hidden] { display: none; }
/* The state is a tag, not a second title (review #9): its dot and word in the state's colour on a tint of it (the
   word in the colour's text tint), a capsule set apart from the title by its shape as well as its weight. A finished
   answer has none. */
.eb-chip {
  flex: none; display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px 1px 6px; border-radius: var(--r-capsule, 999px);
  font: 600 12px/16px var(--ember-font, "Inter", system-ui, sans-serif); letter-spacing: 0;
  color: var(--eb-chip-text, var(--label-2, rgba(245, 240, 236, 0.66))); background: color-mix(in srgb, var(--eb-mood) 16%, transparent);
}
.ember-bubble[data-mood="idle"]:not([data-streaming="true"]) .eb-chip { display: none; }
.ember-bubble[data-mood="idle"] { --eb-chip-text: var(--label-2, rgba(245, 240, 236, 0.66)); }
.ember-bubble[data-mood="listening"] { --eb-chip-text: var(--yellow, #ffd600); }
.ember-bubble:is([data-mood="thinking"], [data-mood="guiding"]) { --eb-chip-text: var(--accent-2, #ffb340); }
/* (Working: its word in Ember's warmer light, as the accent itself is under 4.5:1 on its own tint over a white page.) */
.ember-bubble[data-mood="acting"] { --eb-chip-text: var(--accent-2, #ffb340); }
.ember-bubble[data-mood="attention"] .eb-chip { color: var(--purple-text, #eea2ff); }
.ember-bubble[data-mood="error"] .eb-chip { color: var(--red-text, #ff7a71); }
.ember-bubble[data-mood="done"] { --eb-chip-text: var(--green-text, #5be37d); }
/* Clear glass (the Glass setting, html[data-glass="clear"]): a tag's word in the label's colour, as the state's colours
   fall under 4.5:1 there with a white page behind; its dot and tint keep the colour (and the word says the state). */
html[data-glass="clear"] .ember-bubble .eb-chip, html[data-glass="clear"] .ember-bubble .eb-risk, html[data-glass="clear"] .ember-bubble .eb-auto { color: var(--label, #f5f2ef); }
/* (Their tints darkened a little there, under the label's words: the lighter glass let them pale.) */
html[data-glass="clear"] .ember-bubble :is(.eb-chip, .eb-risk, .eb-auto) { background-image: linear-gradient(rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.2)); }
/* (A risky question's tag is the exception: there its tint paled to grey, so it is filled with Clear's light yellow
   under dark words, unmistakably the caution colour; the brackets and Allow's edge match it. Never in a contrast theme,
   where both tokens are system colours, a solid pill with its words in the highlight's text: invisible. The forced
   block below restates the tag too, after this rule, in case a browser ignores the media query's not.) */
@media not (forced-colors: active) {
  html[data-glass="clear"] .ember-bubble .eb-risk { color: var(--on-accent, #1d1204); background: var(--yellow, #fff0a0); }
}
.eb-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--eb-mood); }
/* The dot pulses only while Ember is busy; a finished answer sits still, and so does a question (it waits for you:
   nothing about it hurries you). */
.ember-bubble:is([data-streaming="true"], [data-mood="listening"], [data-mood="thinking"], [data-mood="acting"], [data-mood="guiding"]):not([data-mood="attention"]) .eb-dot {
  animation: eb-pulse 1.4s ease-in-out infinite;
}
/* A risky question's own tag beside "Needs you" (policy asks about such a step every time): the caution colour, which
   has no tint of its own, as a tag on its tint. */
.eb-risk {
  flex: none; display: none; padding: 1px 8px; border-radius: var(--r-capsule, 999px);
  font: 600 12px/16px var(--ember-font, "Inter", system-ui, sans-serif); letter-spacing: 0;
  color: var(--yellow, #ffd600); background: color-mix(in srgb, var(--yellow, #ffd600) 16%, transparent);
}
.ember-bubble[data-mood="attention"][data-risky="true"] .eb-risk { display: inline-flex; }
/* Ember's own announcement of a step it took without asking (Work without asking): its tag, on the status colour's tint,
   which only Ember sets (a task's own note never has it). Its word is in Ember's warmer light: the accent itself is under
   4.5:1 on its own tint with a white page behind the glass. */
.eb-auto {
  flex: none; display: none; padding: 1px 8px; border-radius: var(--r-capsule, 999px);
  font: 600 12px/16px var(--ember-font, "Inter", system-ui, sans-serif); letter-spacing: 0;
  color: var(--accent-2, #ffb340); background: color-mix(in srgb, var(--accent, #ff9230) 16%, transparent);
}
.ember-bubble[data-autonomous="true"] .eb-auto { display: inline-flex; }
.eb-title { font-weight: 600; letter-spacing: -0.006em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A question's title ("May I?", "May I run a command?") leads into it; the decision is its sentence below (.eb-ask). */
.ember-bubble[data-mood="attention"] .eb-title { font-size: 13px; line-height: 18px; color: var(--label-2, rgba(245, 240, 236, 0.66)); }
/* A question's or a problem's title carries the decision ("Pushing feature-x to origin, as you asked"): it wraps onto a
   second line rather than lose its end under an ellipsis. */
.ember-bubble:is([data-mood="attention"], [data-mood="error"]) .eb-title {
  white-space: normal; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
}
/* So does "Still waiting for Copilot…" beside Thinking at the larger text sizes (its Stop is under it). */
.ember-bubble[data-mood="thinking"] .eb-title { white-space: normal; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
/* A title that only repeats the chip's word ("Thinking…" beside Thinking) isn't shown twice. */
.ember-bubble .eb-title[hidden] { display: none; }
/* Finished text reads from its start, at full contrast: up to six lines. */
.eb-thought {
  margin: 0; max-height: 6lh; overflow: hidden;
  display: flex; flex-direction: column; justify-content: flex-start;
  color: var(--label, #f5f2ef); white-space: pre-line; overflow-wrap: anywhere;
}
.eb-thought:empty { display: none; }
/* A question's sentence (questionParts): the decision strongest, what it does after it, and the task it is part of
   quieter under it. */
.eb-ask { font-weight: 600; }
.eb-task { display: block; margin-top: 4px; font: 400 12px/16px var(--ember-font, "Inter", system-ui, sans-serif); color: var(--label-2, rgba(245, 240, 236, 0.66)); }
/* Running commentary (thinking, working, listening) is quieter: the secondary label, three lines. */
.ember-bubble:is([data-mood="thinking"], [data-mood="acting"], [data-mood="listening"]) .eb-thought {
  max-height: 3lh; color: var(--label-2, rgba(245, 240, 236, 0.66));
}
/* While text streams in, the newest lines show and the start slides away under a fade. */
.ember-bubble[data-streaming="true"] .eb-thought { max-height: 3lh; justify-content: flex-end; }
.ember-bubble[data-streaming="true"] .eb-thought[data-overflow="true"] {
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 1.1em);
  mask-image: linear-gradient(to bottom, transparent 0, #000 1.1em);
}
/* Finished text that doesn't fit fades out at the bottom (only then). */
.ember-bubble:not([data-streaming="true"]) .eb-thought[data-overflow="true"] {
  -webkit-mask-image: linear-gradient(to top, transparent 0, #000 1.1em);
  mask-image: linear-gradient(to top, transparent 0, #000 1.1em);
}
/* A question shows all of it (scrolling if it is very long) so a decision is never made on half a sentence; so does a
   problem, whose last sentence is usually what to do about it. */
.ember-bubble:is([data-mood="attention"], [data-mood="error"]):not([data-streaming="true"]) .eb-thought {
  max-height: 10lh; overflow-y: auto; overscroll-behavior: contain; pointer-events: auto;
  -webkit-mask-image: none; mask-image: none;
}
/* A question gets room for its answers on one row ("Allow", "Always in …", "Not now"). */
.ember-bubble[data-mood="attention"] { width: min(336px, calc(100vw - 24px)); }
.ember-bubble[data-expanded="true"] { width: min(380px, calc(100vw - 24px)); }
/* "Read all": the whole answer, scrolling inside the bubble when it is longer still. As specific as the overflow
   fade above (which it must undo: a fade over the scroll box would hide the last line however far it scrolled). */
.ember-bubble[data-expanded="true"]:not([data-streaming="true"]) .eb-thought {
  max-height: 16lh; overflow-y: auto; overscroll-behavior: contain; pointer-events: auto;
  -webkit-mask-image: none; mask-image: none;
}
/* Its scrollers' bars as on a Mac (a slim thumb, no track or arrows), with or without the page's tokens. */
.ember-bubble ::-webkit-scrollbar { width: 12px; background: transparent; }
.ember-bubble ::-webkit-scrollbar-thumb { min-height: 28px; border: 3px solid transparent; border-radius: var(--r-capsule, 999px); background: var(--scroll-thumb, rgba(255, 255, 255, 0.5)) padding-box; }
.ember-bubble ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
/* The caret exists only while text arrives (an invisible one could wrap onto a blank line of its own). */
.eb-thought span::after { content: ""; display: none; width: 2px; height: 1.05em; margin-left: 2px; border-radius: 1px; vertical-align: -0.15em; background: var(--eb-mood); }
.ember-bubble[data-streaming="true"] .eb-thought span::after { display: inline-block; opacity: 0.9; animation: eb-blink 1s steps(2) infinite; }
.eb-step { display: flex; gap: 7px; padding-top: 8px; border-top: 1px solid var(--separator, rgba(255, 255, 255, 0.09)); font: 400 13px/18px var(--ember-font, "Inter", system-ui, sans-serif); color: var(--label-2, rgba(245, 240, 236, 0.66)); }
.eb-step[hidden] { display: none; }
.eb-step-arrow { color: var(--eb-mood); font-weight: 600; }
/* A step that names keys (a question's "Ctrl+Alt+Y allow · Ctrl+Alt+N not now") shows them as keycaps beside their words. */
.eb-step kbd {
  display: inline-block; min-width: 1.5em; margin-right: 2px; padding: 0 4px; border-radius: var(--r-xs, 6px); text-align: center;
  font: 600 11px/16px var(--ember-font, "Inter", system-ui, sans-serif); letter-spacing: 0.01em; color: var(--label, #f5f2ef);
  background: rgba(255, 255, 255, 0.1); box-shadow: inset 0 0 0 1px var(--separator, rgba(255, 255, 255, 0.09)), 0 1px 0 rgba(0, 0, 0, 0.5);
}
.eb-step .eb-key-word { margin: 0 4px 0 2px; }
/* A question's step row is its keyboard hint ("Ctrl+Alt+Y allow · Ctrl+Alt+N not now"): quiet, under the buttons. So
   is a problem's, the keyboard's way to what its buttons do ("Or press Ctrl+Alt+E and go to Computers."), and an
   answer's cut short, where it is whole ("… go to Conversation."). */
.ember-bubble:is([data-mood="attention"], [data-mood="error"], [data-mood="idle"]) .eb-step { order: 1; padding-top: 0; border-top: 0; font-size: 12px; line-height: 16px; }
.ember-bubble:is([data-mood="attention"], [data-mood="error"], [data-mood="idle"]) .eb-step-arrow { display: none; }
/* A question's whole text (a long typed text its sentence cuts to two ends, review #116): every character as it will be
   typed, in a panel on the glass (a flat fill and a hairline, no glass on glass) that scrolls. It takes the wheel. */
.eb-whole {
  max-height: 7lh; overflow-y: auto; overscroll-behavior: contain; pointer-events: auto;
  /* Concentric with the bubble: its 18 px corner less the 14 px padding, at least 6 px. */
  padding: 6px 10px; border-radius: var(--r-xs, 6px);
  background: rgba(255, 255, 255, 0.06); box-shadow: inset 0 0 0 1px var(--separator, rgba(255, 255, 255, 0.09));
  color: var(--label, #f5f2ef); white-space: pre-wrap; overflow-wrap: anywhere;
}
.eb-whole[hidden] { display: none; }
/* Above the buttons until all of it has been in view, as the consent cards say it. */
.eb-whole-hint { margin: 0; font: 400 12px/16px var(--ember-font, "Inter", system-ui, sans-serif); color: var(--label-2, rgba(245, 240, 236, 0.66)); }
.eb-whole-hint[hidden] { display: none; }
.eb-actions { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 4px; pointer-events: auto; }
.eb-actions[hidden] { display: none; }
/* Capsules (the floating layer's large controls, 28 px). The prominent one is the app's accent; the others carry
   an edge of 3:1 or more (WCAG 1.4.11). */
.eb-actions button {
  font: 600 13px/16px var(--ember-font, "Inter", system-ui, sans-serif); letter-spacing: -0.003em;
  min-height: calc(28px * var(--text-scale, 1)); padding: 6px 14px; border-radius: var(--r-capsule, 999px); cursor: pointer;
  max-width: 100%; overflow-wrap: anywhere;
  border: 0; background: rgba(255, 255, 255, 0.08); color: var(--label, #f5f2ef);
  box-shadow: inset 0 0 0 1px var(--control-edge, rgba(255, 255, 255, 0.42));
  transition: background-color 140ms ease, filter 140ms ease, transform 220ms var(--spring-snappy, ease-out);
}
.eb-actions button.eb-primary { background: var(--accent, #ff9230); color: var(--on-accent, #1d1204); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3), 0 1px 2px rgba(0, 0, 0, 0.3); }
/* A risky question's Allow isn't the one that stands out (nothing invites a reflex yes): bordered in the caution
   colour, as quiet as Not now. */
.ember-bubble[data-risky="true"] .eb-actions button.eb-primary { background: rgba(255, 255, 255, 0.08); color: var(--label, #f5f2ef); box-shadow: inset 0 0 0 1.5px var(--yellow, #ffd600); }
@media (hover: hover) {
  .eb-actions button:hover { background: rgba(255, 255, 255, 0.14); }
  .eb-actions button.eb-primary:hover { background: var(--accent, #ff9230); filter: brightness(1.08); }
  .ember-bubble[data-risky="true"] .eb-actions button.eb-primary:hover { background: rgba(255, 255, 255, 0.14); filter: none; }
}
.eb-actions button:active { transform: scale(0.97); }
/* Allow before the whole text has all been in view: it takes no press yet. */
.eb-actions button[aria-disabled="true"] { opacity: 0.4; cursor: default; filter: none; transform: none; }
.eb-actions button:focus-visible { outline: none; box-shadow: inset 0 0 0 1px var(--control-edge, rgba(255, 255, 255, 0.42)), var(--focus-ring, 0 0 0 2px #121011, 0 0 0 4px rgba(255, 146, 48, 0.75)); }
.eb-actions button.eb-primary:focus-visible { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3), var(--focus-ring, 0 0 0 2px #121011, 0 0 0 4px rgba(255, 146, 48, 0.75)); }
/* What the user might say next (app/main/personal/predict.ts): Ember's suggestions, said so by the caption before them,
   as small quiet capsules (24 px) after the answer. Choosing one is the same as typing it. Never the accent: none of
   them is the one prominent action. */
.eb-suggest { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-top: 6px; pointer-events: auto; }
.eb-suggest[hidden] { display: none; }
.eb-suggest-cap { font: 400 12px/16px var(--ember-font, "Inter", system-ui, sans-serif); color: var(--label-2, rgba(245, 240, 236, 0.74)); }
.eb-suggest button {
  font: 500 12px/16px var(--ember-font, "Inter", system-ui, sans-serif); letter-spacing: 0;
  min-height: calc(24px * var(--text-scale, 1)); padding: 4px 10px; border-radius: var(--r-capsule, 999px); cursor: pointer;
  max-width: 100%; overflow-wrap: anywhere;
  border: 0; background: rgba(255, 255, 255, 0.06); color: var(--label, #f5f2ef);
  box-shadow: inset 0 0 0 1px var(--control-edge, rgba(255, 255, 255, 0.42));
  transition: background-color 140ms ease, transform 220ms var(--spring-snappy, ease-out);
}
@media (hover: hover) { .eb-suggest button:hover { background: rgba(255, 255, 255, 0.14); } }
.eb-suggest button:active { transform: scale(0.97); }
.eb-suggest button:focus-visible { outline: none; box-shadow: inset 0 0 0 1px var(--control-edge, rgba(255, 255, 255, 0.42)), var(--focus-ring, 0 0 0 2px #121011, 0 0 0 4px rgba(255, 146, 48, 0.75)); }
/* Needs you: four corner brackets lock onto the bubble once (Ember's HUD: a question is told apart by its shape, not
   only its colour), then hold still; in the caution colour on a risky question. Decorative, and outside the bubble's
   clickable parts. */
.eb-lock {
  --eb-lock: var(--accent, #ff9230);
  position: absolute; inset: -6px; display: none; pointer-events: none;
  background:
    linear-gradient(var(--eb-lock), var(--eb-lock)) left top / 14px 2px no-repeat,
    linear-gradient(var(--eb-lock), var(--eb-lock)) left top / 2px 14px no-repeat,
    linear-gradient(var(--eb-lock), var(--eb-lock)) right top / 14px 2px no-repeat,
    linear-gradient(var(--eb-lock), var(--eb-lock)) right top / 2px 14px no-repeat,
    linear-gradient(var(--eb-lock), var(--eb-lock)) left bottom / 14px 2px no-repeat,
    linear-gradient(var(--eb-lock), var(--eb-lock)) left bottom / 2px 14px no-repeat,
    linear-gradient(var(--eb-lock), var(--eb-lock)) right bottom / 14px 2px no-repeat,
    linear-gradient(var(--eb-lock), var(--eb-lock)) right bottom / 2px 14px no-repeat;
}
.ember-bubble[data-risky="true"] .eb-lock { --eb-lock: var(--yellow, #ffd600); }
.ember-bubble[data-mood="attention"]:not([data-hidden="true"]) .eb-lock { display: block; animation: eb-lock 180ms var(--spring-snappy, ease-out) 1; }
/* Read out by screen readers, never seen. */
.eb-live { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@keyframes eb-pulse { 50% { opacity: 0.45; } }
@keyframes eb-blink { 50% { opacity: 0; } }
@keyframes eb-glow { 50% { opacity: 0.55; } }
@keyframes eb-lock { from { opacity: 0; scale: 1.05; } }
/* Nothing animates while the bubble is hidden (an endless animation keeps the compositor busy). */
.ember-bubble[data-hidden="true"] .eb-dot, .ember-bubble[data-hidden="true"] .eb-thought span::after, .ember-bubble[data-hidden="true"]::before { animation: none !important; }
/* Calm: the desktop's reduced-motion preference, or Ember's own Calm mode (html.calm). The glow stays, still. */
@media (prefers-reduced-motion: reduce) { .eb-dot, .eb-thought span::after, .ember-bubble::before, .eb-lock { animation: none !important; } .ember-bubble { transition: opacity var(--t-calm-fade, 150ms) ease, visibility var(--t-calm-fade, 150ms) !important; translate: none !important; scale: none !important; } }
html.calm .eb-dot, html.calm .eb-thought span::after { animation: none !important; }
html.calm .eb-lock { animation: none !important; }
html.calm .ember-bubble::before { animation: none !important; }
/* Calm keeps one fade (R1, ember.css .calm-fade, written here too as the bubble also runs without ember.css): opacity
   over --t-calm-fade, no slide or growth. Outranks ember.css's html.calm * that stops every transition. */
html.calm .ember-bubble { transition: opacity var(--t-calm-fade, 150ms) ease, visibility var(--t-calm-fade, 150ms) !important; translate: none !important; scale: none !important; }
/* Increase contrast: the tokens firm up the body, rim and edges; the outline goes on the solid body. */
@media (prefers-contrast: more) {
  .ember-bubble { border-color: rgba(255, 255, 255, 0.5); background: var(--glass-fill, linear-gradient(#141112, #141112)) border-box; }
}
/* Windows contrast themes (forced colours): the system's colours, which drop every box-shadow. The buttons get real
   edges and a real focus outline, the prominent one the highlight's fill, and the dot and caret the text colour (the
   state's word is beside the dot). Written out here too, as the bubble also runs without ember.css. */
@media (forced-colors: active) {
  .ember-bubble, .ember-bubble[data-mood] { --eb-mood: CanvasText; }
  /* Its glass is gradients, which the system drops: a body of the window's colour, so its words aren't on the app's. */
  .ember-bubble { background: Canvas; }
  .eb-actions button { border: 1px solid ButtonText; }
  .eb-actions button.eb-primary, .eb-actions button.eb-primary:hover { forced-color-adjust: none; color: HighlightText; background: Highlight; border-color: Highlight; box-shadow: none; }
  .eb-actions button:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
  .eb-suggest button { border: 1px solid ButtonText; }
  .eb-suggest button:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
  .eb-actions button[aria-disabled="true"], .eb-actions button.eb-primary[aria-disabled="true"] { opacity: 1; color: GrayText; background: Canvas; border-color: GrayText; }
  .eb-whole { border: 1px solid CanvasText; }
  /* The state's tag and the risky tag keep an edge (their tint is dropped); the brackets are drawn as they are. */
  .eb-chip, .eb-risk, .eb-auto { border: 1px solid CanvasText; }
  /* The risky tag's words on the window's colour in every Glass setting (Clear fills it otherwise). */
  html[data-glass] .ember-bubble .eb-risk { color: CanvasText; background: Canvas; }
  .eb-lock, .ember-bubble[data-risky="true"] .eb-lock { forced-color-adjust: none; --eb-lock: CanvasText; }
  .ember-bubble[data-risky="true"] .eb-actions button.eb-primary, .ember-bubble[data-risky="true"] .eb-actions button.eb-primary:hover { forced-color-adjust: auto; color: ButtonText; background: ButtonFace; border: 2px solid CanvasText; }
  .eb-step kbd { outline: 1px solid CanvasText; outline-offset: -1px; }
}
/* Text size (Settings > Comfort & access: main sets html[data-text-size], ember.css the --text-scale): the words
   grow. The bubble keeps its width; its heights are counted in lines (lh), so it shows as many lines at every size. */
html[data-text-size] .ember-bubble { font-size: calc(14px * var(--text-scale, 1)); line-height: round(calc(20px * var(--text-scale, 1)), 1px); }
html[data-text-size] .eb-chip, html[data-text-size] .eb-risk, html[data-text-size] .eb-auto { font-size: calc(12px * var(--text-scale, 1)); line-height: round(calc(16px * var(--text-scale, 1)), 1px); }
html[data-text-size] .ember-bubble[data-mood="attention"] .eb-title { font-size: calc(13px * var(--text-scale, 1)); line-height: round(calc(18px * var(--text-scale, 1)), 1px); }
html[data-text-size] .eb-task { font-size: calc(12px * var(--text-scale, 1)); line-height: round(calc(16px * var(--text-scale, 1)), 1px); }
html[data-text-size] .eb-step kbd { font-size: calc(11px * var(--text-scale, 1)); line-height: round(calc(16px * var(--text-scale, 1)), 1px); }
html[data-text-size] .eb-step { font-size: calc(13px * var(--text-scale, 1)); line-height: round(calc(18px * var(--text-scale, 1)), 1px); }
html[data-text-size] .ember-bubble:is([data-mood="attention"], [data-mood="error"], [data-mood="idle"]) .eb-step { font-size: calc(12px * var(--text-scale, 1)); line-height: round(calc(16px * var(--text-scale, 1)), 1px); }
html[data-text-size] .eb-actions button { font-size: calc(13px * var(--text-scale, 1)); line-height: round(calc(16px * var(--text-scale, 1)), 1px); }
html[data-text-size] .eb-whole-hint { font-size: calc(12px * var(--text-scale, 1)); line-height: round(calc(16px * var(--text-scale, 1)), 1px); }
html[data-text-size] .eb-suggest-cap, html[data-text-size] .eb-suggest button { font-size: calc(12px * var(--text-scale, 1)); line-height: round(calc(16px * var(--text-scale, 1)), 1px); }
`;

/**
 * A primary press is committed only on release inside the same, unmoved control. Pointer capture keeps the release
 * with the control when the native window passes other areas through. Mouse clicks never provide a second path;
 * keyboard Enter/Space produce the one detail-zero click. Replacing a question or hiding a surface cancels a press.
 */
export function onPress(button: HTMLElement, fn: () => void): void {
  /** How much of its size a pressed button may lose (its press is scale 0.97) and still be the same control. */
  const PRESS_GIVE = 0.04;
  let held: { pointer: number; bounds: DOMRect; label: string } | null = null;
  let watch: MutationObserver | null = null;
  const doc = button.ownerDocument;
  const hidden = () => { if (doc.visibilityState === "hidden") cancel(); };
  const available = () => button.isConnected && !button.hidden && !button.closest("[hidden]")
    && !button.hasAttribute("disabled") && button.getAttribute("aria-disabled") !== "true"
    && button.ownerDocument.visibilityState !== "hidden";
  const cancel = () => {
    const pointer = held?.pointer;
    held = null;
    watch?.disconnect();
    watch = null;
    doc.removeEventListener("visibilitychange", hidden);
    if (pointer !== undefined && button.hasPointerCapture?.(pointer)) button.releasePointerCapture(pointer);
  };
  button.addEventListener("pointerdown", e => {
    cancel();
    if (e.button !== 0 || e.isPrimary === false || !available()) return;
    const bounds = button.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    held = { pointer: e.pointerId, bounds, label: button.textContent ?? "" };
    try { button.setPointerCapture(e.pointerId); } catch { cancel(); return; }
    doc.addEventListener("visibilitychange", hidden);
    if (typeof MutationObserver === "function") {
      watch = new MutationObserver(changes => {
        if (changes.some(c => {
          if (!(c.target instanceof Element)) return button.contains(c.target);
          // Reapplying unchanged state (the overlay refreshes aria-expanded during progress) keeps a gesture alive.
          if (c.type === "attributes" && c.target.getAttribute(c.attributeName!) === c.oldValue) return false;
          return c.target === button || button.contains(c.target) || c.target.contains(button);
        })) cancel();
      });
      watch.observe(doc.documentElement, { attributes: true, attributeOldValue: true, childList: true, subtree: true });
    }
  });
  button.addEventListener("pointerup", e => {
    const press = held;
    if (!press || press.pointer !== e.pointerId || e.button !== 0) return;
    const r = button.getBoundingClientRect();
    const was = press.bounds;
    // Still where it was, by its centre: a pressed button shrinks towards it (scale 0.97, over 220 ms on a task card), so
    // its edges have moved by the time a click of 60 ms or more lets go, and comparing them cancelled every ordinary click.
    const same = Math.abs(r.x + r.width / 2 - (was.x + was.width / 2)) < .5 && Math.abs(r.y + r.height / 2 - (was.y + was.height / 2)) < .5
      && Math.abs(r.width / was.width - 1) < PRESS_GIVE && Math.abs(r.height / was.height - 1) < PRESS_GIVE;
    const inside = e.clientX >= was.left && e.clientX <= was.right && e.clientY >= was.top && e.clientY <= was.bottom;
    const act = available() && same && inside && press.label === (button.textContent ?? "");
    cancel();
    if (act) fn();
  });
  button.addEventListener("pointercancel", cancel);
  button.addEventListener("lostpointercapture", cancel);
  // A keyboard click is generated after the key's own native activation rules; a pointer click is already handled.
  button.addEventListener("click", e => { if (e.detail === 0 && available()) fn(); });
}

export interface BubbleAction {
  /** Identifies the button across updates (defaults to the label). */
  key?: string;
  label: string;
  primary?: boolean;
  /** It works only once the question's whole text has all been in view (Allow; never Not now): until then it takes no press. */
  needsWhole?: boolean;
  onClick: () => void;
}

/** The bubble at one width: its size, where its clickable parts are, and whether its text overflows. */
interface Measured { box: Size; hot: Rect[]; over: boolean }

export class ReasoningBubble {
  readonly root: HTMLDivElement;
  /** The empty box the bubble sits in: the one element moved (by transform) as Ember moves. */
  private readonly mount: HTMLDivElement;
  private readonly head: HTMLDivElement;
  private readonly chipText: HTMLSpanElement;
  private readonly title: HTMLSpanElement;
  private readonly thoughtBox: HTMLParagraphElement;
  private readonly thought: HTMLSpanElement;
  private readonly step: HTMLDivElement;
  private readonly stepText: HTMLSpanElement;
  private readonly wholeBox: HTMLDivElement;
  private readonly wholeHint: HTMLParagraphElement;
  private readonly actions: HTMLDivElement;
  /** Ember's suggestions of what the user might say next (setSuggestions). */
  private readonly suggest: HTMLDivElement;
  private suggestKey = "";
  private suggestHandlers: (() => void)[] = [];
  /** The one place screen readers hear Ember from (see `announcement`). */
  private readonly live: HTMLDivElement;
  private actionKey = "";
  private handlers: (() => void)[] = [];
  /** Which buttons wait for the whole text (BubbleAction.needsWhole), by place. */
  private waits: boolean[] = [];
  /** The question's whole text shown now, and whether all of it has been in view (whole.ts). */
  private whole: WholeView | null = null;
  /** Main says all of it has been shown (its Allow works, the step names the keys that allow): what screen readers hear. */
  private wholeSeenByMain = false;
  /** What the live region last said it from (wholeReadNews: only the news once the whole text has been shown). */
  private announcedView: BubbleView | null = null;
  /**
   * Told the question's number once all of its whole text has been in view while the bubble showed it, and again on
   * each new state that doesn't yet say main knows (the page sends wholeSeenAction).
   */
  onWholeSeen: ((n: number) => void) | null = null;
  private mood: BubbleMood = "idle";
  /** The thought as given (a question's is drawn in parts: questionParts), and the step's words as given (keycaps drawn). */
  private thoughtRaw = "";
  private stepRaw: string | null = null;
  private risky = false;
  private streaming = false;
  private expanded = false;
  private visible = true;
  private speaker = "Ember";
  private where: string | undefined;
  private announced = "";
  private announceQueued = false;
  /** Content changed since the bubble last measured itself. */
  private dirty = true;
  /** What the bubble measured at each width tried since its content changed (0: its own width). */
  private sizes = new Map<number, Measured>();
  /** The width set on the bubble now (0: its own width). */
  private width = 0;
  private box: Size = { width: 0, height: 0 };
  private pos: Point | null = null;
  /** Clickable or scrollable parts, relative to the bubble's border box. */
  private hot: Rect[] = [];
  /** Hidden because there was no room for it beside what it must not cover (see `place`). */
  private crowded = false;
  /** Streamed text arrived sooner than STREAM_MS after the last drawing: drawn when the gap is up. */
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private streamAt = -Infinity;
  /** The origin it grows from (see `growOrigin`), set only while it is hidden. */
  private origin = "";

  constructor(host: HTMLElement) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = BUBBLE_CSS;
      document.head.appendChild(style);
    }
    this.root = document.createElement("div");
    // calm-fade: in Calm it still fades in and out (ember.css R1), rather than pop.
    this.root.className = "ember-bubble calm-fade";
    this.root.innerHTML = `
      <div class="eb-lock" aria-hidden="true"></div>
      <div class="eb-head"><span class="eb-chip" aria-hidden="true"><i class="eb-dot"></i><span class="eb-chip-text"></span></span><span class="eb-risk" aria-hidden="true"></span><span class="eb-auto" aria-hidden="true"></span><span class="eb-title"></span></div>
      <p class="eb-thought"><span></span></p>
      <div class="eb-whole" hidden></div>
      <p class="eb-whole-hint" hidden></p>
      <div class="eb-step" hidden><span class="eb-step-arrow" aria-hidden="true">→</span><span class="eb-step-text"></span></div>
      <div class="eb-actions" hidden></div>
      <div class="eb-suggest" role="group" hidden><span class="eb-suggest-cap"></span></div>`;
    // The group is named by its visible caption (one label, not two).
    const capId = `eb-suggest-cap-${++suggestCaptions}`;
    this.head = this.root.querySelector(".eb-head")!;
    this.root.querySelector(".eb-risk")!.textContent = RISKY_TAG;
    this.root.querySelector(".eb-auto")!.textContent = AUTONOMOUS_TAG;
    this.chipText = this.root.querySelector(".eb-chip-text")!;
    this.title = this.root.querySelector(".eb-title")!;
    this.thoughtBox = this.root.querySelector(".eb-thought")!;
    this.thought = this.root.querySelector(".eb-thought span")!;
    this.step = this.root.querySelector(".eb-step")!;
    this.stepText = this.root.querySelector(".eb-step-text")!;
    this.actions = this.root.querySelector(".eb-actions")!;
    this.suggest = this.root.querySelector(".eb-suggest")!;
    const cap = this.root.querySelector<HTMLElement>(".eb-suggest-cap")!;
    cap.id = capId;
    cap.textContent = SUGGEST_CAPTION;
    this.suggest.setAttribute("aria-labelledby", capId);
    this.wholeBox = this.root.querySelector(".eb-whole")!;
    this.wholeHint = this.root.querySelector(".eb-whole-hint")!;
    // Scrolled (by the wheel, or a page on by the approve key): judged again.
    this.wholeBox.addEventListener("scroll", () => this.wholeMeasured(), { passive: true });
    this.live = document.createElement("div");
    this.live.className = "eb-live";
    this.live.setAttribute("role", "status");
    this.live.setAttribute("aria-live", "polite");
    this.live.setAttribute("aria-atomic", "true");
    this.mount = document.createElement("div");
    this.mount.className = "eb-mount";
    this.mount.append(this.root);
    host.append(this.mount, this.live);
    this.root.dataset.mood = this.mood;
    this.root.dataset.streaming = "false";
    this.chipText.textContent = chipLabel(this.mood, false);
    // Late font loads and the like change the size without any setter running.
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => { this.dirty = true; }).observe(this.root);
  }

  /** Who is talking, for screen readers ("Cinder says: …"). */
  setSpeaker(name: string): void {
    if (name === this.speaker) return;
    this.speaker = name;
    this.updateTitle();
  }

  /** Where the bubble's task acts when not on this computer ("on build-01"), for screen readers (see `announcement`). */
  setWhere(where: string | undefined): void {
    if (where === this.where) return;
    this.where = where;
    this.queueAnnounce();
  }

  setMood(mood: BubbleMood): void {
    if (mood === this.mood) return;
    this.mood = mood;
    this.root.dataset.mood = mood;
    this.updateChip();
    this.paintThought();
    this.changed();
  }

  /** Ember's own announcement of a step it took without asking (BubbleState.autonomous): its "Without asking" tag. */
  setAutonomous(on: boolean): void {
    if (on === (this.root.dataset.autonomous === "true")) return;
    this.root.dataset.autonomous = String(on);
    this.changed();
  }

  /** A question about a risky step (BubbleState.risky): its own tag, caution brackets, and an Allow that doesn't stand out. */
  setRisky(on: boolean): void {
    if (on === this.risky) return;
    this.risky = on;
    this.root.dataset.risky = String(on);
    this.changed();
  }

  setTitle(text: string): void {
    if (this.title.textContent === text) return;
    this.title.textContent = text;
    this.updateTitle();
    this.changed();
  }

  setThought(text: string): void {
    if (this.thoughtRaw === text) return;
    this.thoughtRaw = text;
    this.drawThought();
  }

  /** Append streamed reasoning text (e.g. from assistant.reasoning_delta). */
  appendThought(delta: string): void {
    this.thoughtRaw += delta;
    this.drawThought();
  }

  /**
   * Draws the thought as it now is: at once, unless it streams and was drawn less than STREAM_MS ago (each drawing
   * lays out and re-rasters the bubble's lines, and tokens can come a hundred a second): then once the gap is up.
   */
  private drawThought(): void {
    if (this.streaming) {
      const wait = streamDelay(this.streamAt, performance.now());
      if (wait > 0) {
        this.streamTimer ??= setTimeout(() => { this.streamTimer = null; this.drawThought(); }, wait);
        return;
      }
    }
    this.flushThought();
  }

  private flushThought(): void {
    if (this.streamTimer) { clearTimeout(this.streamTimer); this.streamTimer = null; }
    this.streamAt = performance.now();
    this.paintThought(true);
    this.thoughtBox.style.display = this.thoughtRaw ? "" : "none";
    this.changed();
  }

  /**
   * Draws the thought: a finished question's in its parts (questionParts: the decision in weight 600, what it does, the
   * task under it), anything else as it is. All of it as text (textContent): it may hold what an app's screen said.
   */
  private paintThought(force = false): void {
    const parts = this.mood === "attention" && !this.streaming ? questionParts(this.thoughtRaw) : null;
    const key = parts ? "q" : "t";
    if (!force && this.thought.dataset.drawn === key) return;
    this.thought.dataset.drawn = key;
    if (!parts) { this.thought.textContent = this.thoughtRaw; return; }
    const ask = document.createElement("b");
    ask.className = "eb-ask";
    ask.textContent = parts.ask;
    const nodes: Node[] = [ask];
    if (parts.rest) nodes.push(document.createTextNode(` ${parts.rest}`));
    if (parts.task) {
      const task = document.createElement("small");
      task.className = "eb-task";
      task.textContent = parts.task;
      nodes.push(task);
    }
    this.thought.replaceChildren(...nodes);
  }

  setStreaming(on: boolean): void {
    if (on === this.streaming) return;
    // Text still waiting to be drawn is drawn now: the finished answer never waits on the stream's gap.
    if (this.streamTimer) this.flushThought();
    this.streaming = on;
    this.root.dataset.streaming = String(on);
    if (on) this.root.setAttribute("aria-busy", "true");
    else this.root.removeAttribute("aria-busy");
    this.updateChip();
    this.paintThought();
    this.changed();
  }

  /** The whole thought shows ("Read all"), scrolling inside the bubble if it must. */
  setExpanded(on: boolean): void {
    if (on === this.expanded) return;
    this.expanded = on;
    this.root.dataset.expanded = String(on);
    this.changed();
  }

  /** The step being performed and why; null hides the row. */
  setStep(text: string | null): void {
    if (this.step.hidden === !text && this.stepRaw === (text || null)) return;
    this.stepRaw = text || null;
    this.step.hidden = !text;
    // Keys it names show as keycaps beside their words ("Ctrl" "Alt" "Y" allow); anything else as words.
    const keys = keyHintParts(text);
    if (!keys) this.stepText.textContent = text ?? "";
    else {
      this.stepText.replaceChildren(...keys.flatMap((k, i) => {
        const caps = k.keys.map(key => Object.assign(document.createElement("kbd"), { textContent: key }));
        const word = Object.assign(document.createElement("span"), { className: "eb-key-word", textContent: k.word });
        return [...(i ? [document.createTextNode(" · ")] : []), ...caps, word];
      }));
    }
    this.changed();
  }

  /**
   * A question's whole text under its sentence (null: none), as main sends it: shown from its start in a block that
   * scrolls, with the read hint above the buttons until all of it has been in view here or main says it was. Each press
   * of the approve key since the last state (`page`) scrolls it on by a page.
   */
  setWhole(next: WholeState | null): void {
    const had = this.whole;
    const { view, fresh, pages } = wholeNext(had, next);
    this.whole = view;
    const told = !!view && next?.seen === true;
    if (told !== this.wholeSeenByMain) { this.wholeSeenByMain = told; this.queueAnnounce(); }
    if (!view) {
      if (!had) return;
      this.wholeBox.hidden = true;
      this.wholeBox.textContent = "";
      this.paintWhole();
      this.changed();
      return;
    }
    if (fresh) {
      this.wholeBox.textContent = view.text;
      this.wholeBox.hidden = false;
      this.wholeBox.scrollTop = 0;
      this.changed();
    }
    // Judged where it is drawn: once placed with this content (place) and as it scrolls, never here, where the bubble
    // may still stand where the last one was.
    if (pages) this.wholeBox.scrollTop += pages * wholePage(this.wholeBox.clientHeight, parseFloat(getComputedStyle(this.wholeBox).lineHeight));
    this.paintWhole();
    // Seen here and main doesn't say so yet (just now, or a word that was lost): told (again).
    if (wholeUnreported(this.whole, next)) this.onWholeSeen?.(view.n);
  }

  /**
   * Shows buttons. The same buttons are kept (not rebuilt) when only their
   * handlers change, so a click is never lost to a re-render between
   * mouse-down and mouse-up.
   */
  setActions(actions: BubbleAction[] | null): void {
    const list = actions ?? [];
    this.handlers = list.map(a => a.onClick);
    this.waits = list.map(a => a.needsWhole === true);
    const key = JSON.stringify(list.map(a => [a.key ?? a.label, a.label, a.primary === true]));
    if (key === this.actionKey) { this.paintWhole(); return; }
    this.actionKey = key;
    this.actions.replaceChildren();
    this.actions.hidden = !list.length;
    list.forEach((a, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = a.label;
      if (a.primary) b.className = "eb-primary";
      // A button that waits for the whole text takes no press until all of it has been in view (main refuses it too).
      onPress(b, () => { if (!(this.waits[i] && this.whole && !this.whole.seen)) this.handlers[i]?.(); });
      this.actions.appendChild(b);
    });
    this.paintWhole();
    this.changed();
  }

  /**
   * Shows Ember's suggestions of what the user might say next under an answer (null or empty: none), each a button that
   * runs `onClick` (main takes it as if typed). Kept, not rebuilt, while the same words show.
   */
  setSuggestions(list: { label: string; onClick: () => void }[] | null): void {
    const items = list ?? [];
    this.suggestHandlers = items.map(s => s.onClick);
    const key = JSON.stringify(items.map(s => s.label));
    if (key === this.suggestKey) return;
    this.suggestKey = key;
    for (const b of [...this.suggest.querySelectorAll("button")]) b.remove();
    this.suggest.hidden = !items.length;
    items.forEach((s, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = s.label;
      onPress(b, () => this.suggestHandlers[i]?.());
      this.suggest.appendChild(b);
    });
    this.changed();
  }

  /** The read hint and the waiting buttons as the whole text's state says (a hint that comes or goes resizes the bubble). */
  private paintWhole(): void {
    const unread = !!this.whole && !this.whole.seen;
    if (this.wholeHint.hidden === unread) {
      this.wholeHint.hidden = !unread;
      this.wholeHint.textContent = unread ? WHOLE_READ_HINT : "";
      this.dirty = true;
    }
    [...this.actions.children].forEach((b, i) => {
      if (unread && this.waits[i]) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
    });
  }

  /**
   * Measures the whole text's block (a layout read) while it waits to be read: true the first time all of it is in view
   * on screen while the bubble shows it.
   */
  private judgeWhole(): boolean {
    const v = this.whole;
    if (!v || v.seen) return false;
    const box = this.wholeBox;
    const r = box.getBoundingClientRect();
    const fontsLoaded = typeof document.fonts === "undefined" || document.fonts.status === "loaded";
    const shown = this.visible && !this.crowded && this.pos !== null;
    const { view, report } = wholeJudged(v, wholeInView(
      { scrollTop: box.scrollTop, scrollHeight: box.scrollHeight, clientHeight: box.clientHeight, top: r.top, bottom: r.bottom, viewportHeight: window.innerHeight },
      { shown, fontsLoaded },
    ));
    this.whole = view;
    return report;
  }

  /** The whole text's block scrolled or the bubble placed: judged, and main told the first time all of it is in view. */
  private wholeMeasured(): void {
    if (!this.judgeWhole() || !this.whole) return;
    this.paintWhole();
    this.onWholeSeen?.(this.whole.n);
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    this.showHide();
    this.queueAnnounce();
  }

  private showHide(): void {
    const shown = this.visible && !this.crowded;
    this.root.dataset.hidden = String(!shown);
    if (shown) this.root.removeAttribute("aria-hidden");
    else this.root.setAttribute("aria-hidden", "true");
  }

  /**
   * Sit below-right of the flame base (`anchor`), flipping left or above near the
   * edges of `bounds` (the overlay's size) and, given Ember's `size` in px, never
   * over Ember itself, nor (if it can help it) over the `avoid` rects, narrowing
   * itself to fit beside them if that is what it takes. `hideFrom` (also in
   * `avoid`) are places it would rather hide than cover, such as the settings
   * window the user works in: with no room beside them it hides until there is. `prefer` are places it keeps off
   * only when it can also keep off `avoid` (the control Ember works on): where it can't, they don't count.
   * Returns true when the bubble moved, changed size, or hid or showed for room.
   */
  place(anchor: Point, bounds: Size, size = 0, avoid: readonly Rect[] = [], hideFrom: readonly Rect[] = [], prefer: readonly Rect[] = []): boolean {
    if (this.dirty) { this.dirty = false; this.sizes.clear(); }
    const own = this.sized(0);
    const heightAt = (w: number) => this.sized(w).box.height;
    const fit = (keepOff: readonly Rect[]) => bubbleFit(anchor, own.box, bounds, size, keepOff, heightAt);
    // Clear of everything (the preferred places too, if it can be); else (with places to hide from) at least clear of
    // those; else the usual place.
    const spot = avoid.length || prefer.length
      ? (prefer.length ? fit([...avoid, ...prefer]) : null) ?? (avoid.length ? fit(avoid) : null) ?? (hideFrom.length ? fit(hideFrom) : undefined)
      : undefined;
    if (spot === null) {
      this.useWidth(0);
      return this.setCrowded(true);
    }
    const width = spot && spot.width < own.box.width ? spot.width : 0;
    const p = spot ?? bubblePosition(anchor, own.box, bounds, size, avoid);
    const m = this.sized(width);
    this.useWidth(width);
    if ((this.thoughtBox.dataset.overflow === "true") !== m.over) this.thoughtBox.dataset.overflow = String(m.over);
    // On the device's pixels (not only whole CSS px, half a device pixel apart at 150 %), so its text stays crisp.
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const x = snapToDevice(p.x, dpr), y = snapToDevice(p.y, dpr);
    // About to appear: it grows from the corner nearest Ember. Set only while hidden, never on a bubble on screen.
    if (this.root.dataset.hidden === "true") {
      const o = growOrigin(anchor, { x, y }, m.box);
      const origin = `${o.x}px ${o.y}px`;
      if (origin !== this.origin) { this.origin = origin; this.root.style.transformOrigin = origin; }
    }
    // A new measurement (the content changed, or another width) may move the buttons.
    const resized = m.box !== this.box || m.hot !== this.hot;
    const shown = this.setCrowded(false);
    this.box = m.box;
    this.hot = m.hot;
    if (!resized && !shown && this.pos?.x === x && this.pos.y === y) { this.wholeMeasured(); return false; }
    this.pos = { x, y };
    this.mount.style.transform = `translate(${x}px, ${y}px)`;
    this.wholeMeasured();
    return true;
  }

  /** The parts that take the pointer (buttons; a long question's scroll area), in host coordinates. */
  interactiveRects(pad = 4): Rect[] {
    const pos = this.pos;
    if (!this.visible || this.crowded || !pos) return [];
    return this.hot.map(r => ({ x: pos.x + r.x - pad, y: pos.y + r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 }));
  }

  private setCrowded(on: boolean): boolean {
    if (on === this.crowded) return false;
    this.crowded = on;
    this.showHide();
    return true;
  }

  /** The bubble's size at `width` (0: its own), measured once per content change. */
  private sized(width: number): Measured {
    let m = this.sizes.get(width);
    if (!m) {
      this.useWidth(width);
      m = this.measure();
      this.sizes.set(width, m);
    }
    return m;
  }

  private useWidth(width: number): void {
    if (width === this.width) return;
    this.width = width;
    this.root.style.width = width ? `${width}px` : "";
    this.root.style.boxSizing = width ? "border-box" : "";
  }

  private changed(): void {
    this.dirty = true;
    this.queueAnnounce();
  }

  private updateChip(): void {
    const label = chipLabel(this.mood, this.streaming);
    if (this.chipText.textContent !== label) this.chipText.textContent = label;
    this.updateTitle();
  }

  /**
   * Hides a title that only says the chip's word again (the chip shows unless it is a finished answer's "Ready"), or
   * only names Ember (an answer's "Ember": the bubble is Ember's already, review #9); and the head row with nothing in it.
   */
  private updateTitle(): void {
    const chipShown = !(this.mood === "idle" && !this.streaming);
    const title = this.title.textContent ?? "";
    const hide = (chipShown && titleRepeatsChip(title, chipLabel(this.mood, this.streaming))) || title.trim() === this.speaker;
    if (this.title.hidden !== hide) this.title.hidden = hide;
    // (A where badge the page put in the head keeps it.)
    const empty = !chipShown && (hide || !title.trim()) && !this.head.querySelector(".where:not([hidden])");
    if (this.head.hidden !== empty) this.head.hidden = empty;
  }

  /** One layout read: size, overflow, and where the clickable parts are. */
  private measure(): Measured {
    const t = this.thoughtBox;
    const over = t.style.display !== "none" && this.thought.offsetHeight > t.clientHeight + 1;
    const box = { width: this.root.offsetWidth, height: this.root.offsetHeight };
    const edge = this.root.clientLeft;
    const rel = (el: HTMLElement): Rect => ({ x: edge + el.offsetLeft, y: edge + el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
    const hot: Rect[] = [];
    if (!this.actions.hidden) hot.push(rel(this.actions));
    if (!this.suggest.hidden) hot.push(rel(this.suggest));
    // The whole text's block scrolls under the wheel, whether or not it runs on (it takes the pointer as a question's does).
    if (!this.wholeBox.hidden) hot.push(rel(this.wholeBox));
    if (over && thoughtScrolls({ mood: this.mood, expanded: this.expanded, streaming: this.streaming })) hot.push(rel(t));
    return { box, hot, over };
  }

  private queueAnnounce(): void {
    if (this.announceQueued) return;
    this.announceQueued = true;
    queueMicrotask(() => this.announce());
  }

  /** Runs after a batch of setters, so a whole update is judged at once. */
  private announce(): void {
    this.announceQueued = false;
    // Keep what was said while hidden: a hide/show flicker (Ember crossing a screen edge) doesn't repeat it.
    if (!this.visible) return;
    const view: BubbleView = {
      visible: true, mood: this.mood, title: this.title.textContent ?? "", thought: this.thoughtRaw, streaming: this.streaming, where: this.where,
      step: this.step.hidden ? null : this.stepRaw, ...(this.whole ? { whole: this.whole.text, wholeSeen: this.wholeSeenByMain } : {}),
      ...(this.risky && this.mood === "attention" ? { risky: true } : {}),
    };
    const text = announcement(view, this.speaker);
    if (text === this.announced) return;
    // The same question, its whole text now all shown: only that news, not the question and its text again.
    const said = wholeReadNews(this.announcedView, view) ?? text;
    this.announced = text;
    this.announcedView = view;
    this.live.textContent = said;
  }
}
