/**
 * Turns Copilot session events into what Ember shows: mood, bubble text,
 * current step and talking. Pure apart from timers, so it is unit-tested with
 * scripted events.
 */

import type { EmberState } from "../../shared/overlay";
import type { Gesture } from "@ember/characters";
import { IDLE_BUBBLE } from "../../shared/overlay";

export interface PresenterEvent { type: string; data?: Record<string, unknown> }

const KEEP_CHARS = 600;
const clip = (s: string) => (s.length > KEEP_CHARS ? s.slice(0, KEEP_CHARS - 1).trimEnd() + "…" : s);
/** Answers longer than this don't fit the bubble: it offers "Read all". */
export const LONG_ANSWER = 260;

/** Markdown the model may use anyway, removed so the bubble and speech read naturally. */
export function plainText(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,!?]|$)/g, "$1$2")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)");
}

/**
 * One plain sentence for an error from Copilot, instead of the raw SDK or HTTP text.
 * `raw` is kept for the log by the caller. `provider`: the organisation's own endpoint
 * is configured (there is no GitHub sign-in to blame then).
 */
export function friendlyError(raw: string, errorType?: string, ctx: { statusCode?: number; provider?: boolean } = {}): string {
  const m = `${errorType ?? ""} ${raw}`;
  const status = ctx.statusCode ?? Number(/\b(?:HTTP|status|code)?\s*\(?(40[1-4]|429)\b/i.exec(raw)?.[1] ?? 0);
  const service = ctx.provider ? "your organisation's AI endpoint" : "Copilot";
  // Before the policy rule: a filtered prompt mentions a "content management policy", not the user's seat.
  if (/content.?(management|filter)|content_filter|filtered due to|responsible ?ai/i.test(m)) return "The AI service's content filter blocked that request. Try asking in other words.";
  if (ctx.provider && (errorType === "authentication" || status === 401 || status === 403 || /authenticat|unauthori[sz]ed|forbidden/i.test(m))) {
    return "Your organisation's AI endpoint refused the request. Ask your administrator to check Ember's endpoint settings.";
  }
  const refused = "Copilot refused this for your account (an organisation policy or a missing Copilot seat).";
  if (status === 403) return refused;
  if (errorType === "authentication" || status === 401 || /authenticat|unauthori[sz]ed|bad credentials|not signed in/i.test(m)) return "Copilot didn't accept the sign-in. Open settings to sign in again.";
  if (errorType === "rate_limit" || status === 429 || /quota|rate.?limit|\b402\b|credits/i.test(m)) return `${ctx.provider ? "The AI endpoint's" : "Copilot's"} usage limit was reached for now. Try again a bit later.`;
  if (/model_not_supported|model.{0,20}(not (available|supported|found))|unknown model|model_not_found/i.test(m) || (ctx.provider && status === 404)) return "The model I'm set to use isn't available. Pick another one in settings (Ctrl+Alt+E).";
  if (/policy|\b403\b|forbidden|\bseat\b|subscription/i.test(m)) return refused;
  if (/context.?(length|limit|window)|too (long|large)|max.?tokens/i.test(m)) return "That was too much for me to handle at once. Try a shorter request.";
  if (/ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|fetch failed|socket|could not connect|connection (is )?(disposed|closed|lost|refused)|disconnected/i.test(m)) return `I can't reach ${service} right now. Check the network, then ask again.`;
  const short = raw.replace(/\{[\s\S]*\}/g, "").replace(/^\w*Error:\s*/, "").trim();
  const who = ctx.provider ? "The AI endpoint" : "Copilot";
  return short ? `${who} reported a problem: ${short.length > 140 ? short.slice(0, 139) + "…" : short}` : `${who} reported a problem.`;
}

/**
 * Who wrote the bubble last. Several presenters share one bubble (the
 * conversation and each task); a presenter's timer only hides the bubble it
 * still owns, so the conversation can't hide a guide step that came after it.
 */
export interface BubbleOwner { current: object | null }

export const TOOL_STEPS: Record<string, string> = {
  set_appearance: "Changing how I look",
  describe_screen: "Looking at your screen",
  start_task: "Starting a task",
  perceive_window: "Reading the window",
  point_at: "Showing you",
  wait_for_click: "Waiting for your click",
  list_windows: "Looking at your windows",
  switch_window: "Switching windows",
  click: "Clicking",
  toggle: "Flipping a switch",
  type_text: "Typing",
  choose_option: "Choosing an option",
  set_value: "Setting a value",
  change_setting: "Changing a setting",
  open_app: "Opening an app",
  press_keys: "Pressing keys (your keyboard)",
  scroll: "Scrolling (your mouse)",
  report_progress: "Updating you",
  finish_task: "Wrapping up",
};

/** What Ember's body does during each tool. */
export const TOOL_GESTURES: Record<string, Gesture> = {
  describe_screen: "chin", perceive_window: "chin", list_windows: "chin",
  click: "tap", toggle: "tap", choose_option: "tap", set_value: "tap", change_setting: "tap", open_app: "tap", scroll: "tap",
  type_text: "type", press_keys: "type",
  point_at: "point", wait_for_click: "point",
  set_appearance: "wave", start_task: "thumbsUp", show_me: "point",
};

export class Presenter {
  private answering = false;
  private answer = "";
  /** A tool ran since the last reasoning text: the next reasoning starts a new thought. */
  private thoughtBreak = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  /** Stopped by the kill switch: nothing more is shown until the next request. */
  private silent = false;
  private state: EmberState = { emotion: "neutral", talking: false, bubble: IDLE_BUBBLE, tasks: [], status: null };

  constructor(
    private push: (patch: Partial<EmberState>) => void,
    private timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
    /** The character's name, shown as the speaker of answers. */
    private name: () => string = () => "Ember",
    /** Shared by every presenter writing the same bubble. */
    private owner: BubbleOwner = { current: null },
    /** A finished answer, in full (the bubble shows only the start of a long one). */
    private onFinalAnswer?: (text: string) => void,
    /** The organisation's own endpoint is configured: errors don't mention a GitHub sign-in. */
    private provider = false,
  ) {}

  private apply(patch: Partial<EmberState>): void {
    this.state = { ...this.state, ...patch, bubble: { ...this.state.bubble, ...(patch.bubble ?? {}) } };
    if (this.silent) return;
    if (patch.bubble) this.owner.current = this;
    this.push({ ...patch, ...(patch.bubble ? { bubble: this.state.bubble } : {}) });
  }

  private cancelHide(): void {
    if (this.hideTimer) { this.timers.clear(this.hideTimer); this.hideTimer = null; }
  }

  /** Thinking, streaming or working: a turn is under way. */
  get busy(): boolean {
    return this.state.bubble.streaming || this.state.emotion === "thinking" || this.state.emotion === "focused";
  }

  /** Someone else (main's own bubble) has the bubble now: no timer of this presenter hides it. */
  letGo(): void {
    this.cancelHide();
  }

  /** The kill switch's message is up: this turn (or task) shows nothing more. The next request speaks again. */
  quiet(): void {
    this.cancelHide();
    this.answering = false;
    this.silent = true;
  }

  private hideLater(ms: number): void {
    this.cancelHide();
    this.hideTimer = this.timers.set(() => {
      this.hideTimer = null;
      // Someone else has the bubble now (a task's step, a question): leave it alone.
      if (this.owner.current !== this) return;
      this.apply({ emotion: "neutral", talking: false, bubble: { ...IDLE_BUBBLE } });
    }, ms);
  }

  /** Something went wrong outside the session's own events (the runtime died, a send failed). */
  fail(message: string): void {
    this.cancelHide();
    this.answering = false;
    this.silent = false;
    this.apply({
      emotion: "sad", talking: false, gesture: "facepalm",
      bubble: { visible: true, mood: "error", title: "Something went wrong", thought: message, step: null, streaming: false, actions: [{ id: "ui:settings", label: "Open settings" }] },
    });
    this.hideLater(12000);
  }

  /** A short message from Ember itself (not the model), with optional buttons; it goes away on its own. */
  notice(n: { title: string; text: string; actions?: { id: string; label: string }[]; ms?: number }): void {
    this.cancelHide();
    this.answering = false;
    this.silent = false;
    this.apply({
      emotion: "confused", talking: false,
      bubble: { visible: true, mood: "error", title: n.title, thought: n.text, step: null, streaming: false, actions: n.actions ?? [] },
    });
    this.hideLater(n.ms ?? 12000);
  }

  /** The session went away mid-turn (restart, sign-out): nothing is left streaming or "thinking". */
  reset(): void {
    const wasBusy = this.busy;
    this.answering = false;
    this.answer = "";
    // Only a bubble this presenter still shows mid-turn is cleared; a notice or an answer keeps its own hide timer.
    if (wasBusy && this.owner.current === this) {
      this.cancelHide();
      this.apply({ emotion: "neutral", talking: false, bubble: { ...IDLE_BUBBLE } });
    }
  }

  /** The user asked something (voice or text). */
  userPrompt(text: string): void {
    this.cancelHide();
    this.answering = false;
    this.answer = "";
    this.silent = false;
    this.apply({
      emotion: "thinking", talking: false,
      bubble: { visible: true, mood: "thinking", title: "Thinking…", thought: `“${text.slice(0, 120)}”`, step: null, streaming: true, actions: [] },
    });
  }

  /** Guide mode: Ember points at something and says what to do; it stays until the next step. */
  guide(say: string, step: string): void {
    this.cancelHide();
    this.answering = false;
    this.silent = false;
    this.apply({
      emotion: "happy", talking: true, gesture: "point",
      bubble: { visible: true, mood: "guiding", title: this.name(), thought: say, step, streaming: false, actions: [] },
    });
    this.timers.set(() => this.apply({ talking: false }), 1200);
  }

  /** A worker started on a task: its bubble is titled with the task (this presenter's name). */
  taskStarted(): void {
    this.cancelHide();
    this.answering = false;
    this.answer = "";
    this.silent = false;
    this.apply({
      emotion: "focused", talking: false,
      bubble: { visible: true, mood: "acting", title: this.name(), thought: "", step: "Getting started", streaming: true, actions: [] },
    });
  }

  event(e: PresenterEvent): void {
    const d = e.data ?? {};
    switch (e.type) {
      case "assistant.intent":
        if (!this.answering && typeof d.intent === "string") this.apply({ bubble: { ...this.state.bubble, title: d.intent } });
        break;
      case "user.message":
      case "assistant.turn_start":
        // A new turn (a queued question, or the next step after a tool): its answer starts fresh.
        this.answering = false;
        this.answer = "";
        break;
      case "assistant.reasoning_delta": {
        if (this.answering) break;
        // After a tool ran, the next reasoning is a new thought: it replaces the last one instead of running on.
        const prev = this.state.bubble.thought.startsWith("“") || this.thoughtBreak ? "" : this.state.bubble.thought;
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
        // While guiding, the instruction stays up (Ember is waiting for the user, not working).
        const guiding = name === "wait_for_click" || name === "point_at";
        this.apply({
          emotion: guiding ? "happy" : "focused", talking: false, gesture: TOOL_GESTURES[name] ?? "rest",
          bubble: { ...this.state.bubble, visible: true, mood: guiding ? "guiding" : "acting", step: TOOL_STEPS[name] ?? name, streaming: !guiding },
        });
        break;
      }
      case "tool.execution_complete":
        if (d.success === false) this.apply({ emotion: "confused", gesture: "scratch", bubble: { ...this.state.bubble, step: null } });
        else this.apply({ bubble: { ...this.state.bubble, step: null } });
        break;
      case "assistant.message": {
        // The whole answer, from its start (the bubble shows the tail only while it streams). The message's own
        // text is complete even when a second question reset the streamed buffer half-way.
        const content = typeof d.content === "string" ? d.content.trim() : "";
        const toolCall = Array.isArray(d.toolRequests) && d.toolRequests.length > 0;
        if (this.answering || (content && !toolCall)) {
          const full = plainText(content || this.answer.trim());
          this.onFinalAnswer?.(full);
          this.apply({ talking: false, bubble: { ...this.state.bubble, thought: clip(full), streaming: false,
            actions: full.length > LONG_ANSWER ? [{ id: "ui:more", label: "Read all" }] : [] } });
        }
        break;
      }
      case "session.error":
        this.answering = false;
        this.apply({
          emotion: "sad", talking: false,
          bubble: { visible: true, mood: "error", title: "Something went wrong", thought: friendlyError(String(d.message ?? ""), typeof d.errorType === "string" ? d.errorType : undefined,
            { statusCode: typeof d.statusCode === "number" ? d.statusCode : undefined, provider: this.provider }), step: null, streaming: false, actions: [] },
        });
        this.hideLater(12000);
        break;
      case "session.idle": {
        const aborted = d.aborted === true;
        // Someone else has the bubble now (a task, a question, main's "Listening…"): the turn ends quietly.
        if (this.owner.current !== this && this.owner.current !== null) {
          this.state = { ...this.state, emotion: "neutral", talking: false, bubble: { ...this.state.bubble, streaming: false } };
          this.answering = false;
          break;
        }
        this.apply({ talking: false, emotion: aborted ? "neutral" : this.answering ? "happy" : this.state.emotion, bubble: { ...this.state.bubble, streaming: false, ...(aborted ? { title: "Stopped", mood: "idle" as const } : {}) } });
        // Long answers stay up longer (they also have "Read all", and the settings window keeps them).
        const chars = this.answer.length;
        this.hideLater(Math.min(30000, 6000 + chars * 50));
        this.answering = false;
        break;
      }
    }
  }
}
