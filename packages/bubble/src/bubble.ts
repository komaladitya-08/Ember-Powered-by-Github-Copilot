/**
 * The reasoning bubble that rides under Ember: a state chip, a one-line intent,
 * the thought (its newest lines while it streams, then the whole of it from the
 * start), and the current step with its "why".
 *
 * It floats over any app, light or dark, so it always uses the same dark glass
 * (nearly opaque, lit at its edge) instead of following a page theme.
 *
 * It is drawn every frame, so it only touches the DOM when something changed and
 * only measures itself (a layout read) after its content changed.
 */

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

export interface BubbleView {
  visible: boolean;
  mood: BubbleMood;
  title: string;
  thought: string;
  streaming: boolean;
  /** Where its task acts when not on this computer ("on build-01"): the badge says it to the eye, this to the ear. */
  where?: string;
}

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
  switch (v.mood) {
    case "attention": return both ? `${speaker} needs you${at}: ${both}` : "";
    case "error": return both ? `${speaker} has a problem${at}: ${both}` : "";
    case "idle": case "done": case "guiding": return text || title ? `${speaker} says${at}: ${text || title}` : "";
    default: return "";
  }
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
  tries.push(fallback);
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

export const BUBBLE_CSS = `
/* What moves with Ember every frame: an empty, unstyled box (its layer is only as big as the bubble in it), so a move
   restyles nothing but this box's transform. Moving the styled bubble itself re-resolved its glass, shadows and
   springs every frame. The bubble's widths are therefore of the overlay (100vw), not of this box. */
.eb-mount { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; will-change: transform; }
.ember-bubble {
  /* The state's colour: its dot, and the glow while Ember thinks. Actions use the app's one accent. The page's
     tokens (shared/ember.css) when present, so Increase Contrast reaches the bubble; Apple's values otherwise. */
  --eb-mood: var(--accent, #ff9230);
  position: absolute; left: 0; top: 0;
  width: min(300px, calc(100vw - 24px));
  display: grid; gap: 6px;
  padding: 12px 14px 13px;
  border-radius: var(--r-xl, 18px);
  /* Glass without a backdrop blur: with software compositing the blur cost ~10% of a core while Ember animated
     beside it, and it can't see other apps anyway. An opaque frost (a translucent body would leave the text of the
     app behind readable through Ember's), a sheen, a rim lit from the top left over the body, an outer hairline
     (crisp over white pages) and two soft shadows give it the material's depth. The shadows are kept tight (a
     negative spread): everything they reach is redrawn on every frame the bubble moves. */
  border: 1px solid transparent;
  background: var(--glass,
    linear-gradient(180deg, rgba(46, 42, 44, 0.97), rgba(26, 23, 25, 0.985)) padding-box,
    linear-gradient(160deg, rgba(255, 255, 255, 0.3), rgba(255, 255, 255, 0.08) 35%, rgba(255, 255, 255, 0.05) 65%, rgba(255, 255, 255, 0.14)) border-box,
    linear-gradient(180deg, rgba(46, 42, 44, 0.97), rgba(26, 23, 25, 0.985)) border-box);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 0 0.5px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.16), 0 12px 28px -8px rgba(0, 0, 0, 0.42);
  color: var(--label, #f5f2ef);
  font: 400 14px/20px var(--ember-font, "Inter", "Atkinson Hyperlegible", system-ui, sans-serif);
  letter-spacing: -0.006em;
  pointer-events: none;
  /* Shown: it settles in on a spring from just below. The shadow changes with the mood at once (a box-shadow
     transition would repaint the whole bubble every frame). */
  transition: opacity 180ms ease, visibility 0s, translate 420ms var(--spring-snappy, ease-out);
}
/* Hidden is gone once it has faded: nothing in it takes a click or the keyboard. */
.ember-bubble[data-hidden="true"] { opacity: 0; visibility: hidden; translate: 0 4px; transition-delay: 0s, 180ms, 0s; transition-duration: 140ms, 0s, 140ms; }
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
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 0 0.5px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.16), 0 12px 28px -8px rgba(0, 0, 0, 0.42),
    0 0 18px color-mix(in srgb, var(--glow, #ff8226) 30%, transparent);
}
/* A grid item is as wide as its longest word by default: one long unbroken word (an app's name on a
   button) would widen the bubble past its edge. */
.ember-bubble > * { min-width: 0; }
.eb-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
/* The state: a dot in its colour and a word in the secondary label (lighter tints where the user must act). A
   finished answer needs no "Ready" beside Ember's name. */
.eb-chip {
  flex: none; display: inline-flex; align-items: center; gap: 6px;
  font: 500 12px/16px var(--ember-font, "Inter", system-ui, sans-serif); letter-spacing: 0;
  color: var(--label-2, rgba(245, 240, 236, 0.66));
}
.ember-bubble[data-mood="idle"]:not([data-streaming="true"]) .eb-chip { display: none; }
.ember-bubble[data-mood="attention"] .eb-chip { color: var(--purple-text, #eea2ff); }
.ember-bubble[data-mood="error"] .eb-chip { color: var(--red-text, #ff7a71); }
.eb-dot { position: relative; top: -0.5px; width: 8px; height: 8px; border-radius: 50%; background: var(--eb-mood); box-shadow: 0 0 0 3px color-mix(in srgb, var(--eb-mood) 24%, transparent); }
/* The dot pulses only while Ember is busy or waiting on you; a finished answer sits still. */
.ember-bubble:is([data-streaming="true"], [data-mood="listening"], [data-mood="thinking"], [data-mood="acting"], [data-mood="guiding"], [data-mood="attention"]) .eb-dot {
  animation: eb-pulse 1.4s ease-in-out infinite;
}
.eb-title { font-weight: 600; letter-spacing: -0.006em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Finished text reads from its start, at full contrast: up to six lines. */
.eb-thought {
  margin: 0; max-height: calc(20px * 6); overflow: hidden;
  display: flex; flex-direction: column; justify-content: flex-start;
  color: var(--label, #f5f2ef); white-space: pre-line; overflow-wrap: anywhere;
}
.eb-thought:empty { display: none; }
/* Running commentary (thinking, working, listening) is quieter: the secondary label, three lines. */
.ember-bubble:is([data-mood="thinking"], [data-mood="acting"], [data-mood="listening"]) .eb-thought {
  max-height: calc(20px * 3); color: var(--label-2, rgba(245, 240, 236, 0.66));
}
/* While text streams in, the newest lines show and the start slides away under a fade. */
.ember-bubble[data-streaming="true"] .eb-thought { max-height: calc(20px * 3); justify-content: flex-end; }
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
  max-height: calc(20px * 10); overflow-y: auto; overscroll-behavior: contain; pointer-events: auto;
  -webkit-mask-image: none; mask-image: none;
}
/* A question gets room for its answers on one row ("Allow", "Always in …", "Not now"). */
.ember-bubble[data-mood="attention"] { width: min(336px, calc(100vw - 24px)); }
.ember-bubble[data-expanded="true"] { width: min(380px, calc(100vw - 24px)); }
/* "Read all": the whole answer, scrolling inside the bubble when it is longer still. As specific as the overflow
   fade above (which it must undo: a fade over the scroll box would hide the last line however far it scrolled). */
.ember-bubble[data-expanded="true"]:not([data-streaming="true"]) .eb-thought {
  max-height: calc(20px * 16); overflow-y: auto; overscroll-behavior: contain; pointer-events: auto;
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
/* A question's step row is its keyboard hint ("Ctrl+Alt+Y allow · Ctrl+Alt+N not now"): quiet, under the buttons. */
.ember-bubble[data-mood="attention"] .eb-step { order: 1; padding-top: 0; border-top: 0; font-size: 12px; line-height: 16px; }
.ember-bubble[data-mood="attention"] .eb-step-arrow { display: none; }
.eb-actions { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 4px; pointer-events: auto; }
.eb-actions[hidden] { display: none; }
/* Capsules (the floating layer's large controls, 28 px). The prominent one is the app's accent; the others carry
   an edge of 3:1 or more (WCAG 1.4.11). */
.eb-actions button {
  font: 600 13px/16px var(--ember-font, "Inter", system-ui, sans-serif); letter-spacing: -0.003em;
  min-height: 28px; padding: 6px 14px; border-radius: var(--r-capsule, 999px); cursor: pointer;
  max-width: 100%; overflow-wrap: anywhere;
  border: 0; background: rgba(255, 255, 255, 0.08); color: var(--label, #f5f2ef);
  box-shadow: inset 0 0 0 1px var(--control-edge, rgba(255, 255, 255, 0.42));
  transition: background-color 140ms ease, filter 140ms ease, transform 220ms var(--spring-snappy, ease-out);
}
.eb-actions button.eb-primary { background: var(--accent, #ff9230); color: var(--on-accent, #1d1204); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3), 0 1px 2px rgba(0, 0, 0, 0.3); }
@media (hover: hover) {
  .eb-actions button:hover { background: rgba(255, 255, 255, 0.14); }
  .eb-actions button.eb-primary:hover { background: var(--accent, #ff9230); filter: brightness(1.08); }
}
.eb-actions button:active { transform: scale(0.97); }
.eb-actions button:focus-visible { outline: none; box-shadow: inset 0 0 0 1px var(--control-edge, rgba(255, 255, 255, 0.42)), var(--focus-ring, 0 0 0 3px rgba(255, 146, 48, 0.75)); }
.eb-actions button.eb-primary:focus-visible { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3), var(--focus-ring, 0 0 0 3px rgba(255, 146, 48, 0.75)); }
/* Read out by screen readers, never seen. */
.eb-live { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@keyframes eb-pulse { 50% { opacity: 0.45; } }
@keyframes eb-blink { 50% { opacity: 0; } }
@keyframes eb-glow { 50% { opacity: 0.55; } }
/* Nothing animates while the bubble is hidden (an endless animation keeps the compositor busy). */
.ember-bubble[data-hidden="true"] .eb-dot, .ember-bubble[data-hidden="true"] .eb-thought span::after, .ember-bubble[data-hidden="true"]::before { animation: none !important; }
/* Calm: the desktop's reduced-motion preference, or Ember's own Calm mode (html.calm). The glow stays, still. */
@media (prefers-reduced-motion: reduce) { .eb-dot, .eb-thought span::after, .ember-bubble::before { animation: none !important; } .ember-bubble { transition: none; translate: none; } }
html.calm .eb-dot, html.calm .eb-thought span::after { animation: none !important; }
html.calm .ember-bubble::before { animation: none !important; }
html.calm .ember-bubble { transition: none; translate: none; }
/* Increase contrast: the tokens firm up the body, rim and edges; the outline goes on the solid body. */
@media (prefers-contrast: more) {
  .ember-bubble { border-color: rgba(255, 255, 255, 0.5); background: var(--glass-fill, linear-gradient(#141112, #141112)) border-box; }
}
`;

/**
 * Runs `fn` when `button` is pressed with the mouse (at the press, not the release) or activated from the keyboard.
 * Ember's windows let clicks through except over their buttons and learn where the pointer is by polling, so a
 * release can land after the window let go of the pointer (or the button moved under it): the press is the click.
 */
export function onPress(button: HTMLElement, fn: () => void): void {
  let pressedAt = -Infinity;
  button.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    pressedAt = performance.now();
    fn();
  });
  // A keyboard's Enter or Space (detail 0), or a mouse click whose press never came.
  button.addEventListener("click", e => {
    if (e.detail > 0 && performance.now() - pressedAt < 1500) return;
    fn();
  });
}

export interface BubbleAction {
  /** Identifies the button across updates (defaults to the label). */
  key?: string;
  label: string;
  primary?: boolean;
  onClick: () => void;
}

/** The bubble at one width: its size, where its clickable parts are, and whether its text overflows. */
interface Measured { box: Size; hot: Rect[]; over: boolean }

export class ReasoningBubble {
  readonly root: HTMLDivElement;
  /** The empty box the bubble sits in: the one element moved (by transform) as Ember moves. */
  private readonly mount: HTMLDivElement;
  private readonly chipText: HTMLSpanElement;
  private readonly title: HTMLSpanElement;
  private readonly thoughtBox: HTMLParagraphElement;
  private readonly thought: HTMLSpanElement;
  private readonly step: HTMLDivElement;
  private readonly stepText: HTMLSpanElement;
  private readonly actions: HTMLDivElement;
  /** The one place screen readers hear Ember from (see `announcement`). */
  private readonly live: HTMLDivElement;
  private actionKey = "";
  private handlers: (() => void)[] = [];
  private mood: BubbleMood = "idle";
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

  constructor(host: HTMLElement) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = BUBBLE_CSS;
      document.head.appendChild(style);
    }
    this.root = document.createElement("div");
    this.root.className = "ember-bubble";
    this.root.innerHTML = `
      <div class="eb-head"><span class="eb-chip" aria-hidden="true"><i class="eb-dot"></i><span class="eb-chip-text"></span></span><span class="eb-title"></span></div>
      <p class="eb-thought"><span></span></p>
      <div class="eb-step" hidden><span class="eb-step-arrow" aria-hidden="true">→</span><span class="eb-step-text"></span></div>
      <div class="eb-actions" hidden></div>`;
    this.chipText = this.root.querySelector(".eb-chip-text")!;
    this.title = this.root.querySelector(".eb-title")!;
    this.thoughtBox = this.root.querySelector(".eb-thought")!;
    this.thought = this.root.querySelector(".eb-thought span")!;
    this.step = this.root.querySelector(".eb-step")!;
    this.stepText = this.root.querySelector(".eb-step-text")!;
    this.actions = this.root.querySelector(".eb-actions")!;
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
    this.speaker = name;
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
    this.changed();
  }

  setTitle(text: string): void {
    if (this.title.textContent === text) return;
    this.title.textContent = text;
    this.changed();
  }

  setThought(text: string): void {
    if (this.thought.textContent === text) return;
    this.thought.textContent = text;
    this.thoughtBox.style.display = text ? "" : "none";
    this.changed();
  }

  /** Append streamed reasoning text (e.g. from assistant.reasoning_delta). */
  appendThought(delta: string): void {
    this.thoughtBox.style.display = "";
    this.thought.textContent += delta;
    this.changed();
  }

  setStreaming(on: boolean): void {
    if (on === this.streaming) return;
    this.streaming = on;
    this.root.dataset.streaming = String(on);
    if (on) this.root.setAttribute("aria-busy", "true");
    else this.root.removeAttribute("aria-busy");
    this.updateChip();
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
    if (this.step.hidden === !text && this.stepText.textContent === (text ?? "")) return;
    this.step.hidden = !text;
    this.stepText.textContent = text ?? "";
    this.changed();
  }

  /**
   * Shows buttons. The same buttons are kept (not rebuilt) when only their
   * handlers change, so a click is never lost to a re-render between
   * mouse-down and mouse-up.
   */
  setActions(actions: BubbleAction[] | null): void {
    const list = actions ?? [];
    this.handlers = list.map(a => a.onClick);
    const key = JSON.stringify(list.map(a => [a.key ?? a.label, a.label, a.primary === true]));
    if (key === this.actionKey) return;
    this.actionKey = key;
    this.actions.replaceChildren();
    this.actions.hidden = !list.length;
    list.forEach((a, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = a.label;
      if (a.primary) b.className = "eb-primary";
      onPress(b, () => this.handlers[i]?.());
      this.actions.appendChild(b);
    });
    this.changed();
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
    const x = Math.round(p.x), y = Math.round(p.y);
    // A new measurement (the content changed, or another width) may move the buttons.
    const resized = m.box !== this.box || m.hot !== this.hot;
    const shown = this.setCrowded(false);
    this.box = m.box;
    this.hot = m.hot;
    if (!resized && !shown && this.pos?.x === x && this.pos.y === y) return false;
    this.pos = { x, y };
    this.mount.style.transform = `translate(${x}px, ${y}px)`;
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
    const text = announcement({
      visible: true, mood: this.mood, title: this.title.textContent ?? "", thought: this.thought.textContent ?? "", streaming: this.streaming, where: this.where,
    }, this.speaker);
    if (text === this.announced) return;
    this.announced = text;
    this.live.textContent = text;
  }
}
