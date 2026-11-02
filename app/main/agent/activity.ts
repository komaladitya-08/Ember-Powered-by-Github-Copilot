/**
 * A task's activity: what it did and is doing, built from its worker's Copilot session events and Ember's own signals
 * (questions, refusals, the hand it works with, retries, problems, its result). Pure TypeScript with no Electron and no
 * clock of its own (the caller passes `now`), so it is unit-tested (test/unit/activity.test.ts).
 *
 * The words are Ember's: a step is named from its tool (TOOL_STEPS) and the app it worked in, never from the model's
 * arguments, its reasoning or screen text; a failure is counted, never quoted. The one model text kept is the worker's
 * own note (report_progress), marked as such. Items are capped at ACTIVITY_LIMIT, so a long task's card and IPC stay
 * small (the counts keep the whole).
 */

import {
  ACTIVITY_LIMIT, ANSWER_WORDS, HAND_ROW, NOT_STEPS, STATUS_WORDS, STEP_GROUP, activityRows, doingWords, retryWords,
  stepsWords, summarizeActivity, triedWords, type ActivityItem, type Answer, type AskedIn, type CardActivity, type TaskActivity,
} from "../../shared/activity";
import type { TaskHand } from "../../shared/view";

/** What a worker (or its TaskManager) tells a task's activity. */
export type ActivityEvent =
  /** A request went to Copilot: it is thinking. */
  | { type: "turn" }
  /** A tool call began. `step`: its words while it runs (stepOf); `app`: the app it works in, as people name it. */
  | { type: "tool-start"; id: string; tool: string; step?: string; app?: string }
  /** A tool call ended; `ok` false when it didn't work. */
  | { type: "tool-end"; id: string; ok: boolean }
  /** The worker's own note (report_progress): its text, and its few words for what it does now. */
  | { type: "note"; text: string; intent?: string }
  /** A step taken without asking (Work without asking): policy's words (Decision.announce), never the model's. */
  | { type: "announce"; text: string }
  /**
   * A question of this task went up. `asked`: what it asks in Ember's words (askedWords: never typed text or screen
   * text); `askedIn`: where the user answers it (the bubble, the command window, or a card in its own window).
   */
  | { type: "question"; asked?: string; askedIn?: AskedIn }
  /** It was answered (or not). */
  | { type: "answer"; answer: Answer }
  /** A step wasn't allowed; `reason` is Ember's (policy's) words. */
  | { type: "refused"; reason: string }
  /** The step under way was turned down (a "Not now", a refusal, a stop): stopped, not a step that didn't work. */
  | { type: "denied" }
  /** The task now works with another hand. */
  | { type: "hand"; hand: TaskHand }
  /** A call to the model failed and is tried again. */
  | { type: "retry" }
  /** Copilot answered again (a retry worked). */
  | { type: "heard" }
  /** Copilot has been quiet a while (true), or is heard again (false). */
  | { type: "slow"; on: boolean }
  /** Past 80% of the task's step or time limit. */
  | { type: "near-limit" }
  /** Something went wrong, in Ember's words. */
  | { type: "problem"; words: string }
  /** The task ended. */
  | { type: "end"; status: "done" | "failed" | "stopped" };

/** Longest words kept from a note or a reason (the card shows a line of it). */
const NOTE_MAX = 200;
const REASON_MAX = 120;
/** A kind of step a question is about, in Ember's words (the user's own mouse and keyboard named as such). */
const ASK_KIND: Readonly<Record<string, string>> = {
  read: "Read the window", click: "Click", toggle: "Flip a switch", text: "Type text", select: "Choose an option",
  value: "Set a value", setting: "Change a setting", open_app: "Open an app", cursor_click: "Click with your mouse",
  cursor_text: "Type with your keyboard", keys: "Press keys", scroll: "Scroll",
};

/**
 * What a question asked, as Home's Task activity shows it under the row: built by Ember from the step's kind and the
 * app's name only, never from the question's sentence, so the text a step would type and the names on the screen
 * (a button's, a cell's, a window's) never reach it ("Type text in Mail?", "Fill 3 cells in Calc?", "Run a command?").
 * On Ember's desk its own mouse and keyboard aren't the user's.
 */
export function askedWords(o: { kind: string; app?: string; onDesk?: boolean; cells?: number }): string {
  const what = o.cells !== undefined ? `Fill ${o.cells === 1 ? "a cell" : `${o.cells} cells`}` : o.kind === "command" ? "Run a command"
    : o.kind === "consent" ? "Agree to turn this on" : (ASK_KIND[o.kind] ?? "Take a step").replace(/ with your (mouse|keyboard)$/, o.onDesk ? "" : " with your $1");
  return `${what}${o.app ? ` in ${o.app}` : ""}${o.onDesk ? " on my desk" : ""}?`;
}

const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** One task's activity. */
export class ActivityLog {
  private a: TaskActivity;
  private n = 0;
  /** The question item waiting for its answer. */
  private question: ActivityItem | null = null;
  /** The retry item while Copilot is tried again. */
  private retrying: ActivityItem | null = null;
  /** What it was doing before a question or a retry took the live line. */
  private doing: string;

  constructor(startedAt: number) {
    this.doing = "Starting…";
    this.a = {
      startedAt, items: [], dropped: 0, steps: 0, failedSteps: 0, counts: {}, questions: 0, approvals: 0, asking: false,
      retry: 0, slow: false, nearLimit: false, live: this.doing,
    };
  }

  /** The whole activity (a copy: callers can't change it). */
  get(): TaskActivity {
    return { ...this.a, items: this.a.items.map(i => ({ ...i })), counts: { ...this.a.counts } };
  }

  get asking(): boolean { return this.a.asking; }
  get ended(): boolean { return this.a.endedAt !== undefined; }

  /** What its card shows. */
  card(): CardActivity {
    const a = this.a;
    const summary = summarizeActivity(a.counts, a.failedSteps);
    return {
      startedAt: a.startedAt, ...(a.endedAt !== undefined ? { endedAt: a.endedAt } : {}),
      live: a.live, ...(a.note ? { note: a.note } : {}), ...(summary ? { summary } : {}),
      approvals: a.approvals, nearLimit: a.nearLimit, rows: activityRows(a.items),
    };
  }

  /** Takes in one event; returns whether anything the card shows changed. */
  add(e: ActivityEvent, now: number): boolean {
    const a = this.a;
    if (a.endedAt !== undefined) return false;
    const at = Math.max(0, now - a.startedAt);
    switch (e.type) {
      case "turn":
        return this.setDoing("Thinking…");
      case "tool-start": {
        if (NOT_STEPS.has(e.tool)) return false;
        const group = STEP_GROUP[e.tool] ?? "other";
        const words = doingWords(e.step, e.app);
        this.push({ id: e.id, kind: "step", at, state: "running", words, group, ...(e.app ? { app: e.app } : {}) });
        this.setDoing(words);
        return true;
      }
      case "tool-end": {
        const it = a.items.find(i => i.kind === "step" && i.id === e.id && i.state === "running");
        if (!it) return false;
        it.state = e.ok ? "done" : "failed";
        it.endedAt = at;
        it.words = e.ok ? stepsWords(it.group ?? "other", 1, it.app) : triedWords(it.group ?? "other", 1, it.app);
        a.steps++;
        a.counts[it.group ?? "other"] = (a.counts[it.group ?? "other"] ?? 0) + 1;
        if (!e.ok) a.failedSteps++;
        this.setDoing("Thinking…");
        return true;
      }
      case "note": {
        const text = clip(e.text, NOTE_MAX);
        const shown = clip(e.intent?.trim() ? e.intent : text, NOTE_MAX);
        if (!shown) return false;
        a.note = shown;
        if (text) this.push({ id: this.id("note"), kind: "note", at, state: "done", words: text, model: true });
        return true;
      }
      case "announce": {
        const words = clip(e.text, NOTE_MAX);
        if (!words) return false;
        this.push({ id: this.id("a"), kind: "announce", at, state: "done", words });
        return true;
      }
      case "question": {
        a.questions++;
        a.asking = true;
        const asked = e.asked ? clip(e.asked, NOTE_MAX) : "";
        this.question = this.push({ id: this.id("q"), kind: "question", at, state: "waiting", words: ANSWER_WORDS.waiting, ...(asked ? { asked } : {}), ...(e.askedIn ? { askedIn: e.askedIn } : {}) });
        a.live = STATUS_WORDS.waiting;
        return true;
      }
      case "answer": {
        const q = this.question;
        this.question = null;
        a.asking = false;
        if (e.answer === "allowed") a.approvals++;
        if (q) {
          q.words = ANSWER_WORDS[e.answer];
          q.state = e.answer === "allowed" || e.answer === "answered" ? "done" : "stopped";
          q.endedAt = at;
        }
        a.live = this.liveNow();
        return true;
      }
      case "refused": {
        const words = `Not allowed: ${clip(e.reason, REASON_MAX)}`;
        // The step it stopped becomes the refusal (one row, not a failed step beside it); it isn't counted as a step.
        const step = a.items.findLast(i => i.kind === "step" && i.state === "running");
        if (step) Object.assign(step, { kind: "refused", state: "stopped", words, endedAt: at });
        else this.push({ id: this.id("r"), kind: "refused", at, state: "stopped", words });
        this.setDoing("Thinking…");
        return true;
      }
      case "denied": {
        // Not counted as a step, nor as one that didn't work: the user (or policy) said no, nothing failed.
        const step = a.items.findLast(i => i.kind === "step" && i.state === "running");
        if (!step) return false;
        Object.assign(step, { state: "stopped", words: triedWords(step.group ?? "other", 1, step.app), endedAt: at });
        this.setDoing("Thinking…");
        return true;
      }
      case "hand":
        this.push({ id: this.id("h"), kind: "hand", at, state: "done", words: HAND_ROW[e.hand] });
        return true;
      case "retry": {
        a.retry++;
        if (!this.retrying) this.retrying = this.push({ id: this.id("retry"), kind: "retry", at, state: "running", words: "Copilot didn't answer, so I'm trying again" });
        a.live = this.liveNow();
        return true;
      }
      case "heard": {
        if (!a.retry && !a.slow) return false;
        a.retry = 0;
        a.slow = false;
        if (this.retrying) { this.retrying.state = "done"; this.retrying.endedAt = at; this.retrying = null; }
        a.live = this.liveNow();
        return true;
      }
      case "slow":
        if (a.slow === e.on) return false;
        a.slow = e.on;
        a.live = this.liveNow();
        return true;
      case "near-limit":
        if (a.nearLimit) return false;
        a.nearLimit = true;
        return true;
      case "problem":
        this.push({ id: this.id("p"), kind: "problem", at, state: "failed", words: e.words });
        return true;
      case "end": {
        for (const it of a.items) if (it.state === "running" || it.state === "waiting") { it.state = "stopped"; it.endedAt = at; }
        a.asking = false;
        a.retry = 0;
        a.slow = false;
        const words = STATUS_WORDS[e.status];
        this.push({ id: this.id("end"), kind: "result", at, state: e.status === "done" ? "done" : e.status === "failed" ? "failed" : "stopped", words });
        a.live = words;
        a.endedAt = now;
        return true;
      }
    }
  }

  /** The live line after a question or a retry: whichever still holds it, else what it was doing. */
  private liveNow(): string {
    const a = this.a;
    if (a.asking) return STATUS_WORDS.waiting;
    if (a.retry) return retryWords(a.retry);
    if (a.slow) return "Still waiting for Copilot…";
    return this.doing;
  }

  private setDoing(words: string): boolean {
    this.doing = words;
    const live = this.liveNow();
    if (live === this.a.live) return false;
    this.a.live = live;
    return true;
  }

  private id(prefix: string): string { return `${prefix}-${++this.n}`; }

  private push(it: ActivityItem): ActivityItem {
    const items = this.a.items;
    items.push(it);
    while (items.length > ACTIVITY_LIMIT) {
      // A question still waiting is kept (its answer finds it); the oldest other item goes.
      const i = items.findIndex(x => x !== this.question && x !== this.retrying);
      items.splice(i < 0 ? 0 : i, 1);
      this.a.dropped++;
    }
    return it;
  }
}
