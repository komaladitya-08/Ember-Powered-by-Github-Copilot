/**
 * Questions Ember asks with buttons in its bubble ("Allow" / "Not now").
 * A click in Ember's own bubble answers them, or Ember's keys, or a short spoken
 * answer while the question is up (answerVoice: a yes from anyone heard while
 * Voice Match is off, its default, and only from the owner's voice as Voice
 * Match verified it while it is on; "Not now" from anyone; owner decisions of
 * 2026-11-02 and 2026-11-12, PLAN.md §2 "Approvals"). Never the model, never
 * typed text, and never "Always" by voice. One question shows at a time; the
 * rest wait their turn. Unanswered questions expire as "no", counted from when
 * they appear on screen.
 *
 * A question can't be answered by accident: clicks in its first moments are
 * ignored (a double-click or a click already on its way lands on nothing),
 * and the next question appears only after a short gap, so the second click of
 * a double-click never approves it. While Ember borrows the mouse, nothing is
 * answered at all (a borrowed click must never approve anything). Keyboard
 * users answer with shortcuts (main registers them while a question is up,
 * and the bubble names them).
 *
 * A question whose whole content shows in a window of Ember's own (the command card, a consent card: its `panel`) is
 * allowed only from that window's own buttons, carrying the hash of what it showed, or with the approve keys while that
 * window shows all of it (`panelReady`); never from the bubble, which only brings the window up (R7). "Not now" is
 * taken from anywhere. Without the `panelReady` wiring such a question can't be allowed at all (fail closed).
 *
 * A question whose sentence shows a typed text only in part (`detail`: its two ends and its length) shows all of it in a
 * block that scrolls under the sentence (review #116). Allow, from its button or the approve key, works only once the
 * page showing it has said all of it was in view (`wholeSeen`), as the command card's and the consent cards' do, and it
 * has been armed again since; before then the approve key shows the next part instead, and a key pressed again too soon
 * (held down, or once more than needed) never allows. Not now works at once. Such a question waits longer, by the
 * length of its text (timeoutOf).
 */

import type { BubbleState, EmberState } from "../../shared/overlay";
import { IDLE_BUBBLE } from "../../shared/overlay";
import type { ConsentPanel } from "../../shared/consent";
import type { ApprovalRefusal } from "../../shared/remote-ui";
import type { CommandCard } from "../commands/types";

/** How an answer arrived: a bubble button, Ember's approve/deny keys, the panel window's own buttons, or spoken. */
export type AnswerVia = "bubble" | "key" | "panel" | "voice";

/**
 * How a question was answered (the audit records it): `verified`, for a spoken answer, whether Voice Match verified it;
 * `trust`: a short yes taken on the asking task's voice trust ("task-voice", always with verified false).
 */
export interface AnswerChannel { via: AnswerVia; verified?: boolean; trust?: "task-voice" }

/**
 * What became of a spoken answer: taken ("answered"), or why not. A yes needs a verified voice, or Voice Match off
 * ("unverified"), never answers a question whose card only a click may allow ("click-only"), and waits as a key would
 * for the question to be armed, its whole text read, or its panel shown whole ("not-yet"). A short yes on a task's
 * trust only for that task's own question, never a panel's ("untrusted").
 */
export type VoiceAnswerResult = "answered" | "no-question" | "unverified" | "untrusted" | "click-only" | "not-yet" | "stale" | "locked";

/** A question whose full content shows in a window of Ember's own (the command card, a consent card). */
export type QuestionPanel =
  | { kind: "command"; card: CommandCard }
  | { kind: "consent"; consent: ConsentPanel };

export interface Question {
  title: string;
  /** What the bubble is titled with once answered (e.g. the task's name), and its "Your task:" line unless `taskLine` says. */
  context?: string;
  /**
   * What its "Your task:" line says in place of `context` ("": no line): the user's own words, quoted, where the step
   * came up unasked or text on screen tried to steer the task, so the model's goal never reads as their request under
   * "You didn't ask for this" (tasks-approvals-5).
   */
  taskLine?: string;
  prompt: string;
  options: { id: string; label: string; primary?: boolean }[];
  /** The task asking (its id): the question's bubble, and the one after the answer, belong to it. */
  task?: string;
  /** Where the asking task acts ("on build-01"): a badge in the bubble and the panel. */
  where?: string;
  /** How long clicks are ignored after it shows (default ConfirmerTiming.armMs). */
  armMs?: number;
  /** Its full content shows in a panel window; only that window's buttons (or the keys while it is fully shown) allow it. */
  panel?: QuestionPanel;
  /** The keys can't allow it (consent cards: a click only). */
  clickOnly?: boolean;
  /**
   * The step is risky (policy's Decision.risky: asked every time, never "Always"): its bubble is set apart from a routine
   * question's (BubbleState.risky). It changes only how it looks; how it is answered stays the same.
   */
  risky?: boolean;
  /**
   * The whole of what its sentence shows only in part: a typed text cut to its two ends (Decision.detail), or fill_cells'
   * cells each with all of its content, one to a line. Shown as the sentence shows typed text (policy.ts typedUnits).
   */
  detail?: string;
}

/** What question `q`'s "Your task:" line says (its taskLine, else its context), or "" for no line: the bubble's and the prompt card's. */
export function taskLineOf(q: Pick<Question, "context" | "taskLine" | "prompt">): string {
  const t = (q.taskLine ?? q.context ?? "").trim();
  return t && t !== q.prompt ? t : "";
}

/**
 * How long a question's answer ("Thanks! Carrying on.", "Okay, I won't.") stays before what waited behind the question
 * shows, or, with nothing waiting, the bubble empties (ConfirmerTiming.afterAnswer).
 */
export const ANSWER_MS = 1500;
/**
 * How long a timed-out question's note stays (ConfirmerTiming.expiredMs), unless something replaces it: the user was
 * away, so a 1.5 s note was gone before they could come back and read it (tasks-approvals-4).
 */
export const EXPIRED_MS = 10_000;

/** What the bubble says when a question timed out: nothing was approved, and it was not a refusal. */
/** Under a timed-out question's thought: how to review it (the bubble has no button once the question has gone). */
export const EXPIRED_STEP = "To review it, say or type the request again.";
export const EXPIRED_THOUGHT = "Time ran out, so nothing was approved and I haven't done it. Ask me again if you'd like to review it.";
/**
 * The same for a task's question, said before the task ends: one that can't finish without the answer ends with Try
 * again on its card (and in Home) (tasks-approvals-r1), but one that finishes the rest ends done, with Close alone, so the
 * note says which (tasks-approvals-c2-2).
 */
export const EXPIRED_TASK_STEP = "If I can't finish without it, choose Try again on its card. Otherwise, say or type the request again.";
export const EXPIRED_TASK_THOUGHT = "Time ran out, so nothing was approved and I haven't done it.";

/**
 * What main does once a question's answer has been up its moment (ConfirmerTiming.afterAnswer): nothing when something
 * else has replaced it on screen (`onScreen`) or what the question held off or covered shows again (`reshow`, the shared
 * bubble's afterAnswer); otherwise the bubble empties and Ember's face rests. The answer's bubble belongs to no task or
 * turn, so nothing else would ever take it down: a task in the corner that ends after it ends on its card, and "Working ·
 * Thanks! Carrying on." stayed up for good, with the busy ring, after the task had closed Microsoft Edge (the owner's
 * report of 2026-11-03).
 */
export function afterAnswerPatch(onScreen: BubbleState, shown: BubbleState, reshow: () => boolean): Partial<EmberState> | null {
  if (onScreen !== shown || reshow()) return null;
  return { emotion: "neutral", talking: false, bubble: IDLE_BUBBLE };
}

/**
 * Ember was hidden and showed itself for an answer the user asked for (main's `shownForAnswer`): it hides again once
 * the bubble goes, the empty bubble after a question's answer (afterAnswerPatch) included.
 */
export function hidesAgainAfter(shownForAnswer: boolean, next: Partial<EmberState>): boolean {
  return shownForAnswer && !!next.bubble && !next.bubble.visible;
}

/**
 * The Confirmer's afterAnswer as main wires it: `onScreen` reads main's last state's bubble, `reshow` is the shared
 * bubble's afterAnswer (AgentHost.afterAnswer) and `set` main's guarded setState.
 */
export function answerSettler(d: { onScreen: () => BubbleState; reshow: () => boolean; set: (patch: Partial<EmberState>) => void }): (shown: BubbleState) => void {
  return shown => {
    const patch = afterAnswerPatch(d.onScreen(), shown, d.reshow);
    if (patch) d.set(patch);
  };
}

/** The hash a panel question's yes must carry back: the command card's, or the consent card's. */
const panelSha256 = (panel: QuestionPanel): string => (panel.kind === "command" ? panel.card.sha256 : panel.consent.sha256);
/** A SHA-256 as sha256Hex writes it: a card whose hash isn't one (empty, cut short) can't be allowed (fail closed). */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A question with a whole text to read (Question.detail): whether all of it has been in view and since when (`seenAt`),
 * how many times the approve key asked for more, and when that key was last pressed (`keyAt`).
 */
interface WholeRead { seen: boolean; page: number; seenAt: number; keyAt: number }
interface Pending { n: number; q: Question; resolve: (answer: string | null) => void; timer: ReturnType<typeof setTimeout> | null; shownAt: number; deadline: number; off?: () => void; whole?: WholeRead; note?: string; voiceLocked?: boolean }

export interface ConfirmerTiming {
  /** How long a question stays up before it expires as "no" (read as each one shows: the user's setting may change). */
  timeoutMs?: number | (() => number);
  /** Clicks this soon after a question appears are ignored. */
  armMs?: number;
  /** The pause between one question being answered and the next appearing. */
  gapMs?: number;
  /**
   * How long a question's answer shows before afterAnswer (default ANSWER_MS), and a timed-out question's note (default
   * EXPIRED_MS): read as each shows, so main scales them by the user's More time to read and answer.
   */
  answerMs?: number | (() => number);
  expiredMs?: number | (() => number);
  /**
   * A question's answer (`shown`, the very bubble it wrote) has been up `answerMs` and no question has come up since:
   * main takes it down unless something replaced it (afterAnswerPatch). Absent (tests, the eval): it stays as before.
   */
  afterAnswer?: (shown: BubbleState) => void;
  now?: () => number;
  /** No answers are taken while this is true (Ember is using the mouse). */
  blocked?: () => boolean;
  /** A question appeared (or the last one went away): for keyboard shortcuts, speaking it, showing Ember. */
  onChange?: (q: { n: number; question: Question } | null) => void;
  /** The keys that answer a question, shown under it (e.g. "Ctrl+Alt+Y allow · Ctrl+Alt+N not now"). */
  keyHint?: () => string | undefined;
  /**
   * The keys under a question whose whole text hasn't all been shown yet, when the approve key shows its next part
   * instead of allowing (e.g. "Ctrl+Alt+Y shows the next part · Ctrl+Alt+N not now"). Absent: no keys are named then,
   * never keyHint's "allow", which the key doesn't do yet.
   */
  readKeyHint?: () => string | undefined;
  /**
   * Question n's panel window is on screen showing all of it (main wires TargetsRuntime.panelReady): only then may the
   * approve key allow a panel question. Absent (tests, the eval): panel questions can't be allowed at all.
   */
  panelReady?: (n: number) => boolean;
  /** Under a panel question, how to reach its window from the keyboard (main wires the targets runtime's panelHint). */
  panelHint?: (panel: QuestionPanel) => string | undefined;
}

export class Confirmer {
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private n = 0;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutMs: number | (() => number);
  private armMs: number;
  private gapMs: number;
  private now: () => number;
  private blocked: () => boolean;
  private onChange: ConfirmerTiming["onChange"];
  private keyHint: ConfirmerTiming["keyHint"];
  private readKeyHint: ConfirmerTiming["readKeyHint"];
  private panelReady: ConfirmerTiming["panelReady"];
  private panelHint: ConfirmerTiming["panelHint"];
  private answerMs: number | (() => number);
  private expiredMs: number | (() => number);
  private afterAnswer: ConfirmerTiming["afterAnswer"];
  /** The answer's bubble is up: afterAnswer runs when this fires. */
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
  /** Waiting for no question to be up or queued (settled()). */
  private settledWaiters: (() => void)[] = [];
  /** How each answered question was answered (howAnswered), kept only as long as the question object is. */
  private channels = new WeakMap<Question, AnswerChannel>();

  constructor(private show: (patch: Partial<EmberState>) => void, timing: number | ConfirmerTiming = {}) {
    const t = typeof timing === "number" ? { timeoutMs: timing } : timing;
    this.timeoutMs = t.timeoutMs ?? 120_000;
    this.armMs = t.armMs ?? 500;
    this.gapMs = t.gapMs ?? 700;
    this.now = t.now ?? Date.now;
    this.blocked = t.blocked ?? (() => false);
    this.onChange = t.onChange;
    this.keyHint = t.keyHint;
    this.readKeyHint = t.readKeyHint;
    this.panelReady = t.panelReady;
    this.panelHint = t.panelHint;
    this.answerMs = t.answerMs ?? ANSWER_MS;
    this.expiredMs = t.expiredMs ?? EXPIRED_MS;
    this.afterAnswer = t.afterAnswer;
  }

  /**
   * Resolves with the chosen option id, or null if it expired, was cancelled,
   * or `signal` aborted (the task stopped) before the user answered.
   */
  ask(q: Question, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      const p: Pending = { n: ++this.n, q, resolve, timer: null, shownAt: 0, deadline: Infinity, ...(q.detail ? { whole: { seen: false, page: 0, seenAt: 0, keyAt: 0 } } : {}) };
      if (signal) {
        const onAbort = () => this.finish(p, null);
        signal.addEventListener("abort", onAbort, { once: true });
        p.off = () => signal.removeEventListener("abort", onAbort);
      }
      this.queue.push(p);
      if (!this.current && !this.gapTimer) this.next();
    });
  }

  get waiting(): boolean {
    return this.current !== null;
  }

  /** Resolves once no question is up or waiting its turn (at once if none is). */
  settled(): Promise<void> {
    if (this.isSettled()) return Promise.resolve();
    return new Promise(resolve => this.settledWaiters.push(resolve));
  }

  private isSettled(): boolean {
    return !this.current && !this.queue.length && !this.gapTimer;
  }

  private checkSettled(): void {
    if (!this.isSettled()) return;
    for (const w of this.settledWaiters.splice(0)) w();
  }

  /**
   * An answer to the question up now: a bubble button (`via` "bubble"), Ember's keys ("key"), or a panel window's own
   * button ("panel", with the hash of what it showed in `proof`). Returns false if it didn't belong to the question up,
   * came too soon, or came from somewhere that may not give it (see allowedFrom).
   */
  answer(actionId: string, via: AnswerVia = "bubble", proof?: { sha256: string }): boolean {
    const m = /^q(\d+):(.+)$/.exec(actionId);
    if (!m || !this.current || Number(m[1]) !== this.current.n) return false;
    if (!this.current.q.options.some(o => o.id === m[2])) return false;
    if (this.lapsed(this.current)) return false;
    if (this.now() - this.current.shownAt < this.armOf(this.current.q) || this.blocked()) return false;
    if (!this.allowedFrom(this.current, m[2], via, proof)) return false;
    this.channels.set(this.current.q, { via });
    this.finish(this.current, m[2]);
    return true;
  }

  /**
   * Why `answer(actionId, "bubble")` would not be taken now, or null when it would: "not-yet" (too soon after the question
   * showed, its whole text not yet read and armed again, or Ember using the mouse) or "gone" (another question, answered
   * or expired). It changes nothing but a question already past its deadline, which it ends as expired: the prompt card says which, so a press that did nothing is never silent.
   */
  refusal(actionId: string): ApprovalRefusal | null {
    const m = /^q(\d+):(.+)$/.exec(actionId);
    const c = this.current;
    if (!m || !c || Number(m[1]) !== c.n || !c.q.options.some(o => o.id === m[2]) || this.lapsed(c)) return "gone";
    if (this.now() - c.shownAt < this.armOf(c.q) || this.blocked()) return "not-yet";
    return this.allowedFrom(c, m[2], "bubble", undefined) ? null : "not-yet";
  }

  /** How question `q` was answered, once it has been by the user (undefined: not yet, expired, cancelled or stopped). */
  howAnswered(q: Question): AnswerChannel | undefined {
    return this.channels.get(q);
  }

  /**
   * A short spoken answer to the question up now (main's onVoice, after voice-answer.ts judged the words): "allow" takes
   * the primary option ("Allow", never "Always"), "deny" Not now. A "Not now" is taken from anyone at once (the safer
   * way). A yes when `verified` (Voice Match matched the owner's voice), or with `anyone` (Voice Match switched off, its
   * default: a yes from whoever was heard, owner decision of 2026-11-12; main passes it only then, and without it an
   * unverified yes is refused), and either as the approve key would be: not while Ember borrows the mouse, not on a
   * click-only question (a consent card), not before the question is armed, its whole text has been in view or its panel
   * window (a command card) shows all of it. Or, unverified, a short yes on a task's voice trust (`trust`: the task main
   * found holding it, voice-answer.ts TaskVoiceTrust): only for a question that task raised itself, never one shown in
   * a panel window (the command card, a consent card) and never a click-only one, and otherwise as a verified yes
   * (owner decision of 2026-11-03).
   */
  answerVoice(which: "allow" | "deny", o: { verified: boolean; anyone?: boolean; question?: number | null; startedAt?: number; trust?: { task: string } }): VoiceAnswerResult {
    const c = this.current;
    if (!c) return "no-question";
    if (this.lapsed(c)) return "stale";
    // Tied to this question (security review of #127): said for it, after it was up and armed, never for one before it.
    if (o.question !== undefined && o.question !== c.n) return "stale";
    if (o.startedAt !== undefined && o.startedAt < c.shownAt + this.armOf(c.q)) return "stale";
    if (which === "deny") {
      if (!c.q.options.some(x => x.id === "deny")) return "not-yet";
      this.channels.set(c.q, { via: "voice", verified: o.verified === true });
      this.finish(c, "deny");
      return "answered";
    }
    const trusted = o.verified !== true && o.trust !== undefined;
    const anyone = o.verified !== true && !trusted && o.anyone === true;
    if (o.verified !== true && !trusted && !anyone) return "unverified";
    if (c.voiceLocked) return "locked";
    // A consent card only by a click: its clickOnly says so, and a consent panel counts as one without it (fail closed).
    if (c.q.clickOnly || c.q.panel?.kind === "consent") return "click-only";
    if (trusted && (c.q.panel || !c.q.task || c.q.task !== o.trust!.task)) return "untrusted";
    const opt = c.q.options.find(x => x.primary) ?? c.q.options[0];
    if (!opt || opt.id === "always" || opt.id === "deny") return "not-yet";
    if (this.now() - c.shownAt < this.armOf(c.q) || this.blocked()) return "not-yet";
    // As the approve key: its whole text read and armed again since, and a panel only while its window shows all of it.
    if (!this.allowedFrom(c, opt.id, "key", undefined)) return "not-yet";
    this.channels.set(c.q, trusted ? { via: "voice", verified: false, trust: "task-voice" } : { via: "voice", verified: o.verified === true });
    this.finish(c, opt.id);
    return "answered";
  }

  /** The question up now (its number), or null: main notes it at a wake, so a spoken answer is tied to it. */
  get currentNumber(): number | null {
    return this.current?.n ?? null;
  }

  /** The task that raised the question up now, or undefined (none up, or not a task's). */
  get currentTask(): string | undefined {
    return this.current?.q.task;
  }

  /**
   * Another voice than the owner's was heard while this question was up (Voice Match turned it away): no spoken yes is
   * taken for it from then on, only a click or the keys (security review of #127). False when no question is up.
   */
  /** The question up now is locked to clicks and keys: Voice Match turned another voice away during it (lockVoice). */
  get voiceLocked(): boolean {
    return !!this.current?.voiceLocked;
  }

  lockVoice(): boolean {
    if (!this.current) return false;
    this.current.voiceLocked = true;
    return true;
  }

  /**
   * A line under the question up now, before its key hint (why a spoken answer wasn't taken, and how it can be): the
   * question stays as it is, and so do the keys that answer it (tasks-approvals-6). False when no question is up.
   */
  note(text: string): boolean {
    const c = this.current;
    if (!c) return false;
    c.note = text.replace(/\s+/g, " ").trim().slice(0, 240) || undefined;
    this.show({ bubble: this.bubbleOf(c) });
    return true;
  }

  /**
   * May `option` be chosen for this question from `via`? "Not now" always. Otherwise: a click-only question never by the
   * keys; a panel window answers only its own question; a panel question only from its panel with the hash of exactly
   * what it showed, or by the keys while that panel shows all of it, and never without the `panelReady` wiring.
   */
  private allowedFrom(p: Pending, option: string, via: AnswerVia, proof: { sha256: string } | undefined): boolean {
    if (option === "deny") return true;
    // Its whole text not yet all in view: nothing but Not now (review #116). Once it has been, Allow is armed afresh, so
    // the press or scroll that brought its end into view can't also allow it.
    if (p.whole && (!p.whole.seen || this.now() - p.whole.seenAt < this.armOf(p.q))) return false;
    if (via === "key" && p.q.clickOnly) return false;
    const panel = p.q.panel;
    if (!panel) return via !== "panel";
    if (!this.panelReady) return false;
    if (via === "panel") {
      const want = panelSha256(panel);
      return typeof want === "string" && SHA256_HEX.test(want) && proof?.sha256 === want;
    }
    if (via !== "key") return false;
    // A readiness check that fails can't say the whole card is in view (fail closed).
    try {
      return this.panelReady(p.n) === true;
    } catch {
      return false;
    }
  }

  /** How to reach a panel question's window from the keyboard, or null when main doesn't say (a hint that throws says nothing). */
  private panelHintFor(panel: QuestionPanel): string | null {
    try { return this.panelHint?.(panel) || null; } catch { return null; }
  }

  /** How long the question showing now waits for an answer (a setting that can't be read: the default 2 minutes). */
  private timeout(): number {
    const t = this.timeoutMs;
    if (typeof t === "number") return t;
    try { const v = t(); return Number.isFinite(v) && v > 0 ? v : 120_000; } catch { return 120_000; }
  }

  /**
   * How long question `p` waits: the question time, and for a whole text to read, half as much again for every 1000
   * characters of it (a minute at the usual 2 minutes, ten with More time to read and answer), so paging through 5000
   * characters, or hearing them read out, doesn't run its time out (final review U1).
   */
  private timeoutOf(p: Pending): number {
    const t = this.timeout();
    return p.whole && p.q.detail ? Math.round(t * (1 + p.q.detail.length / 2000)) : t;
  }

  /**
   * Whether question `p` is past its fixed deadline (shown time plus its wait). The timer's callback can lag the clock, so
   * every answer path checks this itself: a press after the deadline approves nothing, and the question ends as expired.
   */
  private lapsed(p: Pending): boolean {
    if (this.now() < p.deadline) return false;
    this.finish(p, null, true);
    return true;
  }

  /** How long clicks are ignored after `q` shows: its own arm time, or the default when it has none (or none that is a time). */
  private armOf(q: Question): number {
    return typeof q.armMs === "number" && Number.isFinite(q.armMs) && q.armMs >= 0 ? q.armMs : this.armMs;
  }

  /**
   * A keyboard answer: the primary option ("Allow"), "deny" ("Not now") or "always". Before all of a question's whole text
   * has been in view, a yes by key shows the next part of it instead (the keyboard's way through it: the bubble takes no
   * keyboard focus), and answers nothing. After that, a yes by key is taken only once the key has rested for the arm time
   * since its last press: a press too soon is refused and starts the wait again, so a key held down (the system repeating
   * it) or pressed once more than needed pages through to the end but never allows.
   */
  answerKey(which: "primary" | "deny" | "always"): boolean {
    const c = this.current;
    if (!c || this.lapsed(c)) return false;
    if (which !== "deny" && c.whole) {
      const now = this.now();
      if (!c.whole.seen) {
        if (!this.blocked()) {
          c.whole.page += 1;
          c.whole.keyAt = now;
          this.show({ bubble: this.bubbleOf(c) });
        }
        return false;
      }
      if (now - c.whole.keyAt < this.armOf(c.q)) { c.whole.keyAt = now; return false; }
    }
    const opt = which === "primary" ? c.q.options.find(o => o.primary) ?? c.q.options[0] : c.q.options.find(o => o.id === which);
    return opt ? this.answer(`q${c.n}:${opt.id}`, "key") : false;
  }

  /**
   * The page showing question `n` says all of its whole text has been in view (scrolled to its end, or it fits): its
   * Allow works from now on. False if `n` isn't the question up, has no whole text, or was already read.
   */
  wholeSeen(n: number): boolean {
    const c = this.current;
    if (!c || c.n !== n || !c.whole || c.whole.seen) return false;
    c.whole.seen = true;
    c.whole.seenAt = this.now();
    this.show({ bubble: this.bubbleOf(c) });
    return true;
  }

  cancelAll(): void {
    if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
    for (const p of [...this.queue]) this.finish(p, null);
    if (this.current) this.finish(this.current, null);
    this.checkSettled();
  }

  private next(): void {
    this.gapTimer = null;
    this.current = this.queue.shift() ?? null;
    if (!this.current) { this.checkSettled(); return; }
    // The next question replaces the answer before it.
    this.cancelAnswer();
    const p = this.current;
    p.shownAt = this.now();
    p.deadline = p.shownAt + this.timeoutOf(p);
    p.timer = setTimeout(() => this.finish(p, null, true), this.timeoutOf(p));
    this.show({ emotion: "curious", talking: false, bubble: this.bubbleOf(p) });
    this.onChange?.({ n: p.n, question: p.q });
  }

  /** The bubble for question `p`: shown when it comes up, and again when its whole text has been read or paged on. */
  private bubbleOf(p: Pending): BubbleState {
    // The whole task, so a step like "press Enter" is read as part of what the user asked for (typing and saving too).
    const task = taskLineOf(p.q);
    const panel = p.q.panel;
    return {
      visible: true, mood: "attention", title: p.q.title,
      thought: task ? `${p.q.prompt}\nYour task: ${task}` : p.q.prompt,
      // A panel question is answered in its window, which names the keys while they work there; its step says how to
      // get there from the keyboard (the bubble's own buttons are mouse-only). Until all of a whole text has been shown,
      // the approve key shows its next part: the keys say that, not "allow".
      // A note (why a spoken answer wasn't taken) goes before the keys, never in their place: they are the keyboard's way
      // to answer, and the bubble's buttons are mouse-only (tasks-approvals-6).
      step: [p.note, (panel ? this.panelHintFor(panel) : (p.whole && !p.whole.seen ? this.readKeyHint?.() : this.keyHint?.())) || null].filter(Boolean).join("\n") || null, streaming: false,
      // A panel question's bubble only brings its window up (or says no): what is allowed must be seen whole first.
      actions: panel
        ? [{ id: `ui:panel:${p.n}`, label: panel.kind === "command" ? "Show the command" : "Read it" }, { id: `q${p.n}:deny`, label: "Not now" }]
        : p.q.options.map(o => ({ id: `q${p.n}:${o.id}`, label: o.label, primary: o.primary })),
      ...(p.q.task ? { task: p.q.task } : {}),
      ...(p.q.where ? { where: p.q.where } : {}),
      ...(p.q.risky ? { risky: true } : {}),
      // All of a typed text its sentence cuts short, under it (review #116).
      ...(p.whole && p.q.detail ? { whole: { n: p.n, text: p.q.detail, seen: p.whole.seen, page: p.whole.page } } : {}),
    };
  }

  /**
   * The answer `shown` went up: unless a question replaces it first, afterAnswer hears of it answerMs later (expiredMs
   * for a timed-out question's note).
   */
  private answerShown(shown: BubbleState, expired = false): void {
    this.cancelAnswer();
    const after = this.afterAnswer;
    if (!after) return;
    const fallback = expired ? EXPIRED_MS : ANSWER_MS;
    const ms = expired ? this.expiredMs : this.answerMs;
    let wait = fallback;
    // A setting that can't be read, or isn't a time: the usual time.
    try { const v = typeof ms === "function" ? ms() : ms; if (Number.isFinite(v) && v >= 0) wait = v; } catch { /* the usual time */ }
    this.answerTimer = setTimeout(() => {
      this.answerTimer = null;
      if (this.current) return;
      try { after(shown); } catch { /* main's bubble only: the next bubble replaces it anyway */ }
    }, wait);
  }

  private cancelAnswer(): void {
    if (this.answerTimer) { clearTimeout(this.answerTimer); this.answerTimer = null; }
  }

  private finish(p: Pending, answer: string | null, expired = false): void {
    if (p.timer) clearTimeout(p.timer);
    p.off?.();
    const queued = this.queue.includes(p);
    const wasCurrent = this.current === p;
    if (!queued && !wasCurrent) return; // already answered
    this.queue = this.queue.filter(x => x !== p);
    if (wasCurrent) {
      this.current = null;
      // "Not now" (or no answer) leaves Ember idle, not still working.
      const yes = !!answer && answer !== "deny";
      const shown: BubbleState = { visible: true, mood: yes ? "acting" : "idle", title: p.q.context ?? p.q.title, thought: yes ? "Thanks! Carrying on." : expired ? (p.q.task ? EXPIRED_TASK_THOUGHT : EXPIRED_THOUGHT) : "Okay, I won't.", step: expired && !yes ? (p.q.task ? EXPIRED_TASK_STEP : EXPIRED_STEP) : null, streaming: false, actions: [], ...(p.q.task ? { task: p.q.task } : {}), ...(p.q.where ? { where: p.q.where } : {}) };
      this.show({ emotion: yes ? "focused" : "neutral", talking: false, bubble: shown });
      this.answerShown(shown, expired && !yes);
    }
    p.resolve(answer);
    if (wasCurrent) this.onChange?.(null);
    if (wasCurrent && this.queue.length) {
      if (this.gapTimer) clearTimeout(this.gapTimer);
      this.gapTimer = setTimeout(() => this.next(), this.gapMs);
    }
    this.checkSettled();
  }
}

/**
 * Wraps a state setter so that, while a question is on screen, nothing else
 * replaces the bubble or Ember's face (a worker's reasoning would otherwise
 * wipe the buttons before the user can click them). Other fields still pass.
 */
export function guardWhileAsking(asking: () => boolean, show: (patch: Partial<EmberState>) => void): (patch: Partial<EmberState>) => void {
  return next => {
    if (asking() && (next.bubble || next.emotion || next.talking !== undefined)) {
      const { bubble: _b, emotion: _e, talking: _t, ...rest } = next;
      if (Object.keys(rest).length) show(rest);
      return;
    }
    show(next);
  };
}
