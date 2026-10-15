/**
 * The reasoning bubble that rides under Ember: a state chip, a one-line intent,
 * the streaming thought (last three lines), and the current step with its "why".
 *
 * It floats over any app, light or dark, so it always uses the same smoked-glass
 * look instead of following a page theme.
 */

export interface Point { x: number; y: number }

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
  error: "Stuck",
  done: "Done",
};

const STYLE_ID = "ember-bubble-style";

export const BUBBLE_CSS = `
.ember-bubble {
  --eb-mood: #ff9a3d;
  position: absolute; left: 0; top: 0;
  width: min(300px, calc(100% - 24px));
  display: grid; gap: 6px;
  padding: 10px 12px 11px;
  border-radius: 12px;
  background: rgba(26, 15, 11, 0.88);
  -webkit-backdrop-filter: blur(10px) saturate(1.2);
  backdrop-filter: blur(10px) saturate(1.2);
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
.eb-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--eb-mood); box-shadow: 0 0 8px var(--eb-mood); animation: eb-pulse 1.4s ease-in-out infinite; }
.eb-title { font-weight: 700; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eb-thought {
  margin: 0; max-height: calc(1.4em * 3); overflow: hidden;
  display: flex; flex-direction: column; justify-content: flex-end;
  color: rgba(251, 238, 227, 0.74); font-style: italic;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 1.1em);
  mask-image: linear-gradient(to bottom, transparent 0, #000 1.1em);
}
.eb-thought:empty { display: none; }
.ember-bubble[data-mood="idle"] .eb-thought, .ember-bubble[data-mood="done"] .eb-thought { font-style: normal; color: #fbeee3; }
/* A finished answer reads from its start: up to six lines, fading out if longer. */
.ember-bubble:is([data-mood="idle"], [data-mood="done"]):not([data-streaming="true"]) .eb-thought {
  max-height: calc(1.4em * 6); justify-content: flex-start;
  -webkit-mask-image: linear-gradient(to top, transparent 0, #000 1.1em);
  mask-image: linear-gradient(to top, transparent 0, #000 1.1em);
}
.eb-thought span::after { content: ""; display: inline-block; width: 0.5em; height: 0.9em; margin-left: 2px; vertical-align: -0.1em; background: var(--eb-mood); opacity: 0; }
.ember-bubble[data-streaming="true"] .eb-thought span::after { opacity: 0.8; animation: eb-blink 0.9s steps(2) infinite; }
.eb-step { display: flex; gap: 6px; padding-top: 6px; border-top: 1px solid rgba(255, 220, 190, 0.12); }
.eb-step[hidden] { display: none; }
.eb-step-arrow { color: var(--eb-mood); font-weight: 700; }
.eb-actions { display: flex; gap: 8px; padding-top: 2px; pointer-events: auto; }
.eb-actions[hidden] { display: none; }
.eb-actions button {
  font: 600 12px/1 var(--ember-font, system-ui, sans-serif); padding: 7px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--eb-mood) 55%, transparent); background: transparent; color: #fbeee3;
}
.eb-actions button.eb-primary { background: var(--eb-mood); border-color: var(--eb-mood); color: #1a0f0b; }
.eb-actions button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
@keyframes eb-pulse { 50% { opacity: 0.45; } }
@keyframes eb-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .eb-dot, .ember-bubble[data-streaming="true"] .eb-thought span::after { animation: none; } }
`;

export interface BubbleAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

export class ReasoningBubble {
  readonly root: HTMLDivElement;
  private readonly chipText: HTMLSpanElement;
  private readonly title: HTMLSpanElement;
  private readonly thought: HTMLSpanElement;
  private readonly step: HTMLDivElement;
  private readonly stepText: HTMLSpanElement;
  private readonly actions: HTMLDivElement;

  constructor(host: HTMLElement) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = BUBBLE_CSS;
      document.head.appendChild(style);
    }
    this.root = document.createElement("div");
    this.root.className = "ember-bubble";
    this.root.setAttribute("role", "status");
    this.root.setAttribute("aria-live", "polite");
    this.root.innerHTML = `
      <div class="eb-head"><span class="eb-chip"><i class="eb-dot"></i><span class="eb-chip-text"></span></span><span class="eb-title"></span></div>
      <p class="eb-thought"><span></span></p>
      <div class="eb-step" hidden><span class="eb-step-arrow">→</span><span class="eb-step-text"></span></div>
      <div class="eb-actions" hidden></div>`;
    this.chipText = this.root.querySelector(".eb-chip-text")!;
    this.title = this.root.querySelector(".eb-title")!;
    this.thought = this.root.querySelector(".eb-thought span")!;
    this.step = this.root.querySelector(".eb-step")!;
    this.stepText = this.root.querySelector(".eb-step-text")!;
    this.actions = this.root.querySelector(".eb-actions")!;
    host.appendChild(this.root);
    this.setMood("idle");
  }

  setMood(mood: BubbleMood): void {
    this.root.dataset.mood = mood;
    this.chipText.textContent = BUBBLE_LABEL[mood];
  }

  setTitle(text: string): void {
    this.title.textContent = text;
  }

  setThought(text: string): void {
    this.thought.textContent = text;
    this.thought.parentElement!.style.display = text ? "" : "none";
  }

  /** Append streamed reasoning text (e.g. from assistant.reasoning_delta). */
  appendThought(delta: string): void {
    this.thought.parentElement!.style.display = "";
    this.thought.textContent += delta;
  }

  setStreaming(on: boolean): void {
    this.root.dataset.streaming = String(on);
  }

  /** The step being performed and why; null hides the row. */
  setStep(text: string | null): void {
    this.step.hidden = !text;
    this.stepText.textContent = text ?? "";
  }

  setActions(actions: BubbleAction[] | null): void {
    this.actions.replaceChildren();
    this.actions.hidden = !actions?.length;
    for (const a of actions ?? []) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = a.label;
      if (a.primary) b.className = "eb-primary";
      b.addEventListener("click", a.onClick);
      this.actions.appendChild(b);
    }
  }

  setVisible(on: boolean): void {
    this.root.dataset.hidden = String(!on);
  }

  /**
   * Sit below-right of the flame base; flip left or above near the edges of
   * `bounds` (the overlay's size).
   */
  place(anchor: Point, bounds: { width: number; height: number }): void {
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    let x = anchor.x - 22;
    let y = anchor.y + 18;
    if (x + w > bounds.width - 8) x = anchor.x - w + 22;
    if (y + h > bounds.height - 8) y = anchor.y - h - 52;
    x = Math.min(Math.max(x, 8), Math.max(8, bounds.width - w - 8));
    y = Math.min(Math.max(y, 8), Math.max(8, bounds.height - h - 8));
    this.root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}
