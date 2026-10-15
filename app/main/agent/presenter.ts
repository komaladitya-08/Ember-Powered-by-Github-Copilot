/**
 * Turns Copilot session events into what Ember shows: mood, bubble text,
 * current step and talking. Pure apart from timers, so it is unit-tested with
 * scripted events.
 */

import type { EmberState } from "../../shared/overlay";
import { IDLE_BUBBLE } from "../../shared/overlay";

export interface PresenterEvent { type: string; data?: Record<string, unknown> }

const KEEP_CHARS = 600;
const clip = (s: string) => (s.length > KEEP_CHARS ? s.slice(0, KEEP_CHARS - 1).trimEnd() + "…" : s);

export const TOOL_STEPS: Record<string, string> = {
  set_appearance: "Changing how I look",
  describe_screen: "Looking at your screen",
  start_task: "Starting a task",
};

export class Presenter {
  private answering = false;
  private answer = "";
  /** A tool ran since the last reasoning text: the next reasoning starts a new thought. */
  private thoughtBreak = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private state: EmberState = { emotion: "neutral", talking: false, bubble: IDLE_BUBBLE, tasks: [], status: null };

  constructor(
    private push: (patch: Partial<EmberState>) => void,
    private timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
    /** The character's name, shown as the speaker of answers. */
    private name: () => string = () => "Ember",
  ) {}

  private apply(patch: Partial<EmberState>): void {
    this.state = { ...this.state, ...patch, bubble: { ...this.state.bubble, ...(patch.bubble ?? {}) } };
    this.push({ ...patch, ...(patch.bubble ? { bubble: this.state.bubble } : {}) });
  }

  private cancelHide(): void {
    if (this.hideTimer) { this.timers.clear(this.hideTimer); this.hideTimer = null; }
  }

  private hideLater(ms: number): void {
    this.cancelHide();
    this.hideTimer = this.timers.set(() => this.apply({ emotion: "neutral", talking: false, bubble: { ...IDLE_BUBBLE } }), ms);
  }

  /** The user asked something (voice or text). */
  userPrompt(text: string): void {
    this.cancelHide();
    this.answering = false;
    this.answer = "";
    this.apply({
      emotion: "thinking", talking: false,
      bubble: { visible: true, mood: "thinking", title: "Thinking…", thought: `“${text.slice(0, 120)}”`, step: null, streaming: true, actions: [] },
    });
  }

  event(e: PresenterEvent): void {
    const d = e.data ?? {};
    switch (e.type) {
      case "assistant.intent":
        if (!this.answering && typeof d.intent === "string") this.apply({ bubble: { ...this.state.bubble, title: d.intent } });
        break;
      case "assistant.reasoning_delta": {
        if (this.answering) break;
        let prev = this.state.bubble.thought.startsWith("“") ? "" : this.state.bubble.thought;
        if (this.thoughtBreak && prev && !/\s$/.test(prev)) prev += " ";
        this.thoughtBreak = false;
        this.apply({ emotion: "thinking", bubble: { ...this.state.bubble, mood: "thinking", thought: (prev + String(d.deltaContent ?? "")).slice(-KEEP_CHARS), streaming: true } });
        break;
      }
      case "assistant.message_delta": {
        if (!this.answering) { this.answering = true; this.answer = ""; }
        this.answer += String(d.deltaContent ?? "");
        this.apply({
          emotion: "happy", talking: true,
          bubble: { ...this.state.bubble, visible: true, mood: "idle", title: this.name(), thought: this.answer.slice(-KEEP_CHARS), step: null, streaming: true },
        });
        break;
      }
      case "tool.execution_start": {
        const name = String(d.toolName ?? "");
        this.answering = false;
        this.thoughtBreak = true;
        this.apply({ emotion: "focused", talking: false, bubble: { ...this.state.bubble, visible: true, mood: "acting", step: TOOL_STEPS[name] ?? name, streaming: true } });
        break;
      }
      case "tool.execution_complete":
        if (d.success === false) this.apply({ emotion: "confused", bubble: { ...this.state.bubble, step: null } });
        else this.apply({ bubble: { ...this.state.bubble, step: null } });
        break;
      case "assistant.message":
        // The whole answer, from its start (the bubble shows the tail only while it streams).
        if (this.answering) this.apply({ talking: false, bubble: { ...this.state.bubble, thought: clip(this.answer), streaming: false } });
        break;
      case "session.error":
        this.answering = false;
        this.apply({
          emotion: "sad", talking: false,
          bubble: { visible: true, mood: "error", title: "Something went wrong", thought: String(d.message ?? "Copilot reported an error."), step: null, streaming: false, actions: [] },
        });
        this.hideLater(12000);
        break;
      case "session.idle": {
        const aborted = d.aborted === true;
        this.apply({ talking: false, emotion: aborted ? "neutral" : this.answering ? "happy" : this.state.emotion, bubble: { ...this.state.bubble, streaming: false, ...(aborted ? { title: "Stopped", mood: "idle" as const } : {}) } });
        const chars = this.answer.length;
        this.hideLater(Math.min(20000, 6000 + chars * 50));
        this.answering = false;
        break;
      }
    }
  }
}
