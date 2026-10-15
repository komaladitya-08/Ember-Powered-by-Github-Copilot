/**
 * The reasoning bubble that rides under Ember: a state chip, a one-line intent,
 * the thought (its newest lines while it streams, then the whole of it from the
 * start), and the current step with its "why".
 *
 * It floats over any app, light or dark, so it always uses the same smoked-glass
 * look (dark and nearly opaque) instead of following a page theme.
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
}

/**
 * What a screen reader hears, once: finished answers and questions, never each
 * streamed token or the running commentary while Ember thinks or works.
 * "" means say nothing.
 */
export function announcement(v: BubbleView, speaker = "Ember"): string {
  if (!v.visible || v.streaming) return "";
  const text = v.thought.trim();
  const title = v.title.trim();
  const both = title && text ? `${/[.!?…:]$/.test(title) ? title : `${title}.`} ${text}` : title || text;
  switch (v.mood) {
    case "attention": return both ? `${speaker} needs you: ${both}` : "";
    case "error": return both ? `${speaker} has a problem: ${both}` : "";
    case "idle": case "done": case "guiding": return text || title ? `${speaker} says: ${text || title}` : "";
    default: return "";
  }
}

const MARGIN = 8;
const GAP = 6;

/**
 * Where the bubble's top-left corner goes. `anchor` is the base of Ember (its
 * centre + 0.4 × size). The bubble sits below-right of it and flips left or above
 * near the edges of `bounds`. Given Ember's `size` (px), it also keeps clear of
 * Ember's body and the emote over its head, so it never covers Ember in a corner;
 * if neither below nor above fits, it goes beside Ember.
 */
export function bubblePosition(anchor: Point, box: Size, bounds: Size, size = 0): Point {
  const { width: w, height: h } = box;
  const clampX = (x: number) => Math.min(Math.max(x, MARGIN), Math.max(MARGIN, bounds.width - w - MARGIN));
  const clampY = (y: number) => Math.min(Math.max(y, MARGIN), Math.max(MARGIN, bounds.height - h - MARGIN));
  const fitsY = (y: number) => y >= MARGIN && y + h <= bounds.height - MARGIN;
  const fitsX = (x: number) => x >= MARGIN && x + w <= bounds.width - MARGIN;

  const right = anchor.x - 22;
  const x = clampX(right + w > bounds.width - MARGIN ? anchor.x - w + 22 : right);
  const below = anchor.y + Math.max(18, size * 0.2 + GAP);
  const above = anchor.y - h - Math.max(52, size * 1.5 + GAP);
  if (fitsY(below)) return { x, y: below };
  if (fitsY(above)) return { x, y: above };
  if (size > 0) {
    const cy = anchor.y - size * 0.4;
    const y = clampY(cy - h / 2);
    if (fitsX(anchor.x + size * 0.75 + GAP)) return { x: anchor.x + size * 0.75 + GAP, y };
    if (fitsX(anchor.x - size * 0.75 - GAP - w)) return { x: anchor.x - size * 0.75 - GAP - w, y };
  }
  return { x, y: clampY(below + h > bounds.height - MARGIN ? above : below) };
}

const STYLE_ID = "ember-bubble-style";

export const BUBBLE_CSS = `
.ember-bubble {
  --eb-mood: #ff9a3d;
  position: absolute; left: 0; top: 0;
  width: min(300px, calc(100% - 24px));
  display: grid; gap: 6px;
  padding: 10px 12px 11px;
  border-radius: 12px;
  /* Nearly opaque instead of a backdrop blur: with software compositing the blur cost ~10% of a core
     while Ember animated beside it, and at this opacity it made no visible difference. */
  background: rgba(26, 15, 11, 0.94);
  border: 1px solid color-mix(in srgb, var(--eb-mood) 38%, transparent);
  box-shadow: 0 0 22px color-mix(in srgb, var(--eb-mood) 22%, transparent), 0 10px 26px rgba(0, 0, 0, 0.35);
  color: #fbeee3;
  font: 13px/1.4 var(--ember-font, "Atkinson Hyperlegible", system-ui, sans-serif);
  pointer-events: none;
  will-change: transform;
  transition: opacity 160ms ease, border-color 300ms ease, box-shadow 300ms ease;
}
.ember-bubble[data-hidden="true"] { opacity: 0; }
.ember-bubble[data-mood="listening"] { --eb-mood: #ffc45a; }
.ember-bubble[data-mood="thinking"]  { --eb-mood: #ffd36b; }
.ember-bubble[data-mood="acting"]    { --eb-mood: #ff9330; }
.ember-bubble[data-mood="guiding"]   { --eb-mood: #ffb54d; }
.ember-bubble[data-mood="attention"] { --eb-mood: #b77bff; }
.ember-bubble[data-mood="error"]     { --eb-mood: #ff6a45; }
.ember-bubble[data-mood="done"]      { --eb-mood: #ffe08a; }
.eb-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.eb-chip {
  flex: none; display: inline-flex; align-items: center; gap: 6px;
  font: 600 10.5px/1 var(--ember-mono, ui-monospace, monospace);
  letter-spacing: 0.08em; text-transform: uppercase; color: var(--eb-mood);
}
.eb-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--eb-mood); box-shadow: 0 0 8px var(--eb-mood); }
/* The dot pulses only while Ember is busy or waiting on you; a finished answer sits still. */
.ember-bubble:is([data-streaming="true"], [data-mood="listening"], [data-mood="thinking"], [data-mood="acting"], [data-mood="guiding"], [data-mood="attention"]) .eb-dot {
  animation: eb-pulse 1.4s ease-in-out infinite;
}
.eb-title { font-weight: 700; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Finished text reads from its start, upright and at full contrast: up to six lines. */
.eb-thought {
  margin: 0; max-height: calc(1.4em * 6); overflow: hidden;
  display: flex; flex-direction: column; justify-content: flex-start;
  color: #fbeee3;
}
.eb-thought:empty { display: none; }
/* Running commentary (thinking, working, listening) is quieter: italic, three lines. */
.ember-bubble:is([data-mood="thinking"], [data-mood="acting"], [data-mood="listening"]) .eb-thought {
  max-height: calc(1.4em * 3); color: rgba(251, 238, 227, 0.74); font-style: italic;
}
/* While text streams in, the newest lines show and the start slides away under a fade. */
.ember-bubble[data-streaming="true"] .eb-thought { max-height: calc(1.4em * 3); justify-content: flex-end; }
.ember-bubble[data-streaming="true"] .eb-thought[data-overflow="true"] {
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 1.1em);
  mask-image: linear-gradient(to bottom, transparent 0, #000 1.1em);
}
/* Finished text that doesn't fit fades out at the bottom (only then). */
.ember-bubble:not([data-streaming="true"]) .eb-thought[data-overflow="true"] {
  -webkit-mask-image: linear-gradient(to top, transparent 0, #000 1.1em);
  mask-image: linear-gradient(to top, transparent 0, #000 1.1em);
}
/* A question shows all of it (scrolling if it is very long) so a decision is never made on half a sentence. */
.ember-bubble[data-mood="attention"]:not([data-streaming="true"]) .eb-thought {
  max-height: calc(1.4em * 10); overflow-y: auto; overscroll-behavior: contain; pointer-events: auto;
  -webkit-mask-image: none; mask-image: none;
  scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--eb-mood) 70%, transparent) transparent;
}
.eb-thought span::after { content: ""; display: inline-block; width: 0.5em; height: 0.9em; margin-left: 2px; vertical-align: -0.1em; background: var(--eb-mood); opacity: 0; }
.ember-bubble[data-streaming="true"] .eb-thought span::after { opacity: 0.8; animation: eb-blink 0.9s steps(2) infinite; }
.eb-step { display: flex; gap: 6px; padding-top: 6px; border-top: 1px solid rgba(255, 220, 190, 0.12); }
.eb-step[hidden] { display: none; }
.eb-step-arrow { color: var(--eb-mood); font-weight: 700; }
.eb-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 2px; pointer-events: auto; }
.eb-actions[hidden] { display: none; }
.eb-actions button {
  font: 600 12px/1 var(--ember-font, system-ui, sans-serif); padding: 7px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--eb-mood) 85%, transparent); background: transparent; color: #fbeee3;
}
.eb-actions button.eb-primary { background: var(--eb-mood); border-color: var(--eb-mood); color: #1a0f0b; }
.eb-actions button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
/* Read out by screen readers, never seen. */
.eb-live { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@keyframes eb-pulse { 50% { opacity: 0.45; } }
@keyframes eb-blink { 50% { opacity: 0; } }
/* Nothing animates while the bubble is hidden (an endless animation keeps the compositor busy). */
.ember-bubble[data-hidden="true"] .eb-dot, .ember-bubble[data-hidden="true"] .eb-thought span::after { animation: none !important; }
@media (prefers-reduced-motion: reduce) { .eb-dot, .eb-thought span::after { animation: none !important; } }
`;

export interface BubbleAction {
  /** Identifies the button across updates (defaults to the label). */
  key?: string;
  label: string;
  primary?: boolean;
  onClick: () => void;
}

export class ReasoningBubble {
  readonly root: HTMLDivElement;
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
  private visible = true;
  private speaker = "Ember";
  private announced = "";
  private announceQueued = false;
  /** Content changed since the bubble last measured itself. */
  private dirty = true;
  private box: Size = { width: 0, height: 0 };
  private pos: Point | null = null;
  /** Clickable or scrollable parts, relative to the bubble's border box. */
  private hot: Rect[] = [];

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
    host.append(this.root, this.live);
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
      b.addEventListener("click", () => this.handlers[i]?.());
      this.actions.appendChild(b);
    });
    this.changed();
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    this.root.dataset.hidden = String(!on);
    if (on) this.root.removeAttribute("aria-hidden");
    else this.root.setAttribute("aria-hidden", "true");
    this.queueAnnounce();
  }

  /**
   * Sit below-right of the flame base (`anchor`), flipping left or above near the
   * edges of `bounds` (the overlay's size) and, given Ember's `size` in px, never
   * over Ember itself. Returns true when the bubble moved or changed size.
   */
  place(anchor: Point, bounds: Size, size = 0): boolean {
    const resized = this.dirty && this.measure();
    const p = bubblePosition(anchor, this.box, bounds, size);
    const x = Math.round(p.x), y = Math.round(p.y);
    if (!resized && this.pos?.x === x && this.pos.y === y) return false;
    this.pos = { x, y };
    this.root.style.transform = `translate(${x}px, ${y}px)`;
    return true;
  }

  /** The parts that take the pointer (buttons; a long question's scroll area), in host coordinates. */
  interactiveRects(pad = 4): Rect[] {
    const pos = this.pos;
    if (!this.visible || !pos) return [];
    return this.hot.map(r => ({ x: pos.x + r.x - pad, y: pos.y + r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 }));
  }

  private changed(): void {
    this.dirty = true;
    this.queueAnnounce();
  }

  private updateChip(): void {
    const label = chipLabel(this.mood, this.streaming);
    if (this.chipText.textContent !== label) this.chipText.textContent = label;
  }

  /** One layout read after the content changed: size, overflow, and where the clickable parts are. */
  private measure(): boolean {
    this.dirty = false;
    const t = this.thoughtBox;
    const over = t.style.display !== "none" && this.thought.offsetHeight > t.clientHeight + 1;
    if ((t.dataset.overflow === "true") !== over) t.dataset.overflow = String(over);
    const box = { width: this.root.offsetWidth, height: this.root.offsetHeight };
    const edge = this.root.clientLeft;
    const rel = (el: HTMLElement): Rect => ({ x: edge + el.offsetLeft, y: edge + el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
    const hot: Rect[] = [];
    if (!this.actions.hidden) hot.push(rel(this.actions));
    if (over && this.mood === "attention" && !this.streaming) hot.push(rel(t));
    const changed = box.width !== this.box.width || box.height !== this.box.height || JSON.stringify(hot) !== JSON.stringify(this.hot);
    this.box = box;
    this.hot = hot;
    return changed;
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
      visible: true, mood: this.mood, title: this.title.textContent ?? "", thought: this.thought.textContent ?? "", streaming: this.streaming,
    }, this.speaker);
    if (text === this.announced) return;
    this.announced = text;
    this.live.textContent = text;
  }
}
