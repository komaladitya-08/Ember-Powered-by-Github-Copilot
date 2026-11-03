/**
 * Memory that learns on its own (docs/MEMORY.md steps 3–5 and "Getting to know you"), around one MemoryService:
 * - after conversation turns and finished tasks it extracts facts (./learn.ts), off the hot path and within a budget;
 * - after IDLE_MS with no turn, no task and the screen unlocked, it consolidates and makes one model pass over what
 *   changed lately (./refine.ts), within REFINE_PER_DAY;
 * - at most once a day, while idle, it asks about the name recall keeps missing (./questions.ts);
 * - it takes the introduction (Home's form, or the spoken "get to know me" interview: ./intro.ts) and "forget that".
 *
 * Everything here happens only while memory is in force (`inForce`: on, its own consent, the admin's features.memory;
 * LOCKDOWN turns that off), and the kill switch stops it at once (`stopNow`, a StopPart). It gives the conductor the
 * same remember, recall and forget tools as MemoryService does, with two additions: a fact that isn't in the user's own
 * words and reads like an instruction is never kept, and requests recall finds nothing for are counted as gaps. Plain
 * Node: no Electron, no model client (main gives it a OneShot once Copilot is connected).
 */

import type { Fact, NewFact, Source } from "./graph";
import { IntroSchema, Interview, INTRO_MANAGED, INTRO_OFF, introFacts, isGetToKnowMe, type Intro } from "./intro";
import { CallBudget, Learner, soundsLikeInstruction, type LearnBudget, type OneShot } from "./learn";
import {
  ANSWER_WAIT_MS, FORGET_THAT_MS, Gaps, QUESTION_EVERY_MS, answersQuestion, declinesQuestion, describes, forgotReply, gapFact, gapQuestion, isForgetThat,
  looksLikeRequest,
} from "./questions";
import { REFINE_SYSTEM, applyRefinement, parseRefinement, recentFacts, refinePrompt } from "./refine";
import { ownFact, type AboutRef, type MemoryLog, type MemoryService } from "./service";
import { memoryBlock } from "./format";
import { fold } from "./text";

/** Idle this long (no turn, no task, screen unlocked) before the sleep-time pass or a question (ms). */
export const IDLE_MS = 5 * 60_000;
/** How often idleness is checked (ms). */
export const IDLE_CHECK_MS = 60_000;
/** Refinement passes a day, at most (and one per idle stretch). */
export const REFINE_PER_DAY = 6;
/** The interview lets go after this long without an answer (ms). */
export const INTERVIEW_WAIT_MS = 5 * 60_000;

/** A fact Ember learned, as the conversation's "Ember learned: …" line shows it. */
export interface LearnedItem { id: string; text: string; source: Source }

export interface LearningDeps {
  memory: MemoryService;
  /** Memory is on, agreed to and allowed (the admin's features.memory, LOCKDOWN) now. */
  inForce: () => boolean;
  /** The admin turned memory off (the interview says so rather than opening Settings). */
  managed?: () => boolean;
  /** The user lets Ember ask questions (settings memory.questions). */
  questionsOn: () => boolean;
  /** When Ember last asked one (ISO), kept across restarts, and setting it. */
  askedAt: () => string | null;
  setAskedAt: (iso: string) => void;
  /** No conversation turn and no task under way or waiting. */
  idle: () => boolean;
  /** The screen is locked (or that can't be told: then true). */
  locked: () => boolean;
  /** Says Ember's question in the conversation (and aloud when replies are spoken). False when it couldn't now. */
  say: (text: string) => boolean;
  /** Opens Settings › Memory (the interview asked for while memory is off). */
  openMemory?: () => void;
  /** New facts were kept (the "Ember learned" line). */
  onLearned?: (items: LearnedItem[]) => void;
  /** Everything was forgotten: what showed as learned goes. */
  onForgotAll?: () => void;
  log: MemoryLog;
  now?: () => number;
  budget?: Partial<LearnBudget>;
}

/** What the conductor gets: MemoryService's tools, plus `heard` at each turn's end. */
export interface LearningConductorMemory {
  remember(fact: string, about: AboutRef[], said: string, replaces?: string): string;
  context(query: string, history?: boolean): string;
  forRequest(request: string, own: boolean): string;
  forget(id: string): boolean;
  forgetAll(): void;
  heard(said: string, reply: string, own: boolean): void;
}

export class MemoryLearning {
  private model: OneShot | null = null;
  private readonly learner: Learner;
  private readonly refines = new CallBudget(REFINE_PER_DAY, REFINE_PER_DAY);
  private readonly gaps = new Gaps();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActive: number;
  /** A refinement ran in this idle stretch. */
  private refinedThisIdle = false;
  /** When the last refinement ran (ISO): the next reads what changed since. */
  private refinedAt: string | null = null;
  private refining: AbortController | null = null;
  private interview: Interview | null = null;
  private interviewAt = 0;
  private question: { name: string; at: number } | null = null;
  /** The facts kept lately, newest last, for "forget that". */
  private recent: { id: string; text: string; at: number }[] = [];

  constructor(private d: LearningDeps) {
    this.lastActive = this.now();
    this.learner = new Learner({
      model: () => this.model, keep: f => d.memory.learn(f), inForce: d.inForce, log: d.log, now: d.now, budget: d.budget,
      onLearned: facts => this.learned(facts),
    });
  }

  private now(): number { return (this.d.now ?? Date.now)(); }

  /** The model to use (a connected Copilot's one-shot sessions), or null. */
  setModel(model: OneShot | null): void { this.model = model; }

  /** Starts watching for idle time. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, IDLE_CHECK_MS);
    this.timer.unref?.();
  }

  /** Stops for good (quit). */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.stopNow();
  }

  /** The kill switch: every model call under way is abandoned, nothing waiting is learned, the interview ends. */
  stopNow(): void {
    this.learner.stop();
    this.refining?.abort();
    this.refining = null;
    this.interview = null;
    this.question = null;
  }

  /** Something happened (a request, a turn, a task): idle time starts again. */
  active(): void {
    this.lastActive = this.now();
    this.refinedThisIdle = false;
  }

  /** The conductor's memory: the service's tools, with the instruction check and gap counting, and `heard`. */
  conductorMemory(): LearningConductorMemory {
    const m = this.d.memory;
    return {
      remember: (fact, about, said, replaces) => {
        // Not the user's words and sounding like an order: never kept, whoever asked the model to keep it.
        if (!ownFact(fact, said) && soundsLikeInstruction(fact)) {
          this.d.log.info("memory.instruction_refused", { chars: fact.length });
          return "Not remembered: it reads like an instruction, and only what the user says themselves may tell me what to do.";
        }
        const before = new Set(m.list().map(i => i.id));
        const answer = m.remember(fact, about, said, replaces);
        this.noteNew(m.list().filter(i => !before.has(i.id)));
        return answer;
      },
      // The recall tool: its query is the model's, so it never counts gaps (the screen could choose the question).
      context: (query, history) => memoryBlock(m.recall(query, undefined, history === true)),
      forRequest: (request, own) => {
        const text = m.context(request);
        // Nothing bears on what the user asked themselves: the names in it are gaps (known names aren't, and checking
        // doesn't count as a use). Never from words Ember couldn't tell were the user's.
        if (!text && own && this.d.inForce()) {
          const known = m.list().map(i => fold(i.text));
          this.gaps.missed(request, name => known.some(t => t.includes(fold(name))));
        }
        return text;
      },
      forget: id => m.forget(id),
      forgetAll: () => this.forgetAll(),
      heard: (said, reply, own) => { this.active(); this.learner.heard(said, reply, own); },
    };
  }

  /** Everything is forgotten (sign-out, Forget everything): what waits to be learned goes too. */
  forgetAll(): void {
    this.stopNow();
    this.gaps.clear();
    this.recent = [];
    this.d.memory.forgetAll();
    // The "Ember learned" lines and their Undo go too.
    this.d.onForgotAll?.();
  }

  /** A task finished: learn from its result (source `task`). */
  taskDone(title: string, result: string): void {
    this.active();
    this.learner.taskDone(title, result);
  }

  /** Learns from what is waiting now (tests and the eval). */
  flush(): Promise<number> { return this.learner.flush(); }

  /** Model calls for extraction in the last day, and refinements. */
  get usage(): { extract: number; refine: number } { return { extract: this.learner.callsToday, refine: this.refines.used }; }

  /**
   * Home's introduction (first run, or Settings › Memory): checked whole, kept as `user` facts. How many were kept,
   * or null when memory isn't in force or the answers aren't valid.
   */
  introduce(sent: unknown): number | null {
    if (!this.d.inForce()) return null;
    const a = IntroSchema.safeParse(sent);
    if (!a.success) return null;
    // Typed into the form, and listed there at once: no "Ember learned" line for each ("forget that" still reaches them).
    return this.keepAll(introFacts(a.data as Intro), false);
  }

  /**
   * A request Ember answers itself, before the conversation: "get to know me" and its interview, the answer to its own
   * question, and "forget that". The reply to say, or null (the conversation takes it). `own`: heard from the user
   * (not where Ember can't tell them from its speakers).
   */
  intent(text: string, how: { own: boolean }): string | null {
    this.active();
    const now = this.now();
    if (this.interview && now - this.interviewAt > INTERVIEW_WAIT_MS) this.interview = null;
    if (this.question && now - this.question.at > ANSWER_WAIT_MS) this.question = null;
    if (isGetToKnowMe(text)) {
      if (!this.d.inForce()) {
        if (this.d.managed?.()) return INTRO_MANAGED;
        this.d.openMemory?.();
        return INTRO_OFF;
      }
      this.question = null;
      this.interview = new Interview(now);
      this.interviewAt = now;
      return this.interview.start();
    }
    // "Forget that" first: never an answer to a question (the interview's or Ember's own).
    if (isForgetThat(text)) {
      if (!this.d.inForce()) return null;
      const last = this.recent.at(-1);
      if (!last || now - last.at > FORGET_THAT_MS) return null;
      this.recent.pop();
      return this.d.memory.forget(last.id) ? forgotReply(last.text) : null;
    }
    // A request ("open Thunderbird and send the report to Bob") is never an answer: the question is let go of and the
    // conversation takes the request.
    const request = looksLikeRequest(text);
    if (this.interview) {
      if (!this.d.inForce() || request) { this.interview = null; return null; }
      const step = this.interview.answer(text, how.own);
      this.interviewAt = now;
      this.keepAll(step.keep);
      if (step.done) this.interview = null;
      return step.say;
    }
    if (this.question) {
      const q = this.question;
      if (declinesQuestion(text)) { this.question = null; return "All right."; }
      this.question = null;
      // Only a statement about the name answers it ("She leads the platform team"); "the build is broken" is not.
      if (request || !answersQuestion(text) || !describes(text, q.name) || !this.d.inForce()) return null;
      if (!how.own) return "I couldn't be sure that was you, so I didn't keep it.";
      if (soundsLikeInstruction(text)) return "I'll keep descriptions, not instructions, so I didn't keep that.";
      return this.keepAll([gapFact(q.name, text)]) ? `Thanks. I'll remember that about “${q.name}”.` : "I couldn't keep that.";
    }
    return null;
  }

  /** One idle check: the sleep-time pass first, else a question. */
  async tick(): Promise<void> {
    if (!this.d.inForce() || this.d.locked() || !this.d.idle()) return;
    const now = this.now();
    if (now - this.lastActive < IDLE_MS) return;
    if (!this.refinedThisIdle && this.model && !this.refining && this.refines.allows(now)) {
      this.refinedThisIdle = true;
      await this.refine();
      return;
    }
    this.maybeAsk();
  }

  /** The sleep-time pass: consolidate(), then one model pass over what changed lately. What it changed. */
  async refine(): Promise<number> {
    const m = this.d.memory;
    m.upkeep();
    const model = this.model;
    if (!model || !this.d.inForce()) return 0;
    let shown: Fact[] = [];
    let prompt = "";
    m.refine(g => { shown = recentFacts(g, this.refinedAt); prompt = shown.length ? refinePrompt(g, shown) : ""; return 0; });
    if (shown.length < 2) return 0;
    const now = this.now();
    this.refines.spend(now);
    this.refinedAt = new Date(now).toISOString();
    const run = new AbortController();
    this.refining = run;
    try {
      const raw = await model(REFINE_SYSTEM, prompt, run.signal);
      if (run.signal.aborted || !this.d.inForce()) return 0;
      const r = parseRefinement(raw);
      if (!r) { this.d.log.info("memory.refine_dropped", { answered: raw !== null }); return 0; }
      let report = { summaries: 0, closed: 0, reflections: 0 };
      const n = m.refine(g => { report = applyRefinement(g, r, shown); return report.summaries + report.closed + report.reflections; });
      this.d.log.info("memory.refined", { read: shown.length, ...report });
      return n;
    } finally {
      if (this.refining === run) this.refining = null;
    }
  }

  /** At most one question a day, while idle, about the gap recall missed most. */
  private maybeAsk(): void {
    if (this.question || this.interview || !this.d.questionsOn()) return;
    const last = Date.parse(this.d.askedAt() ?? "");
    const now = this.now();
    if (Number.isFinite(last) && now - last < QUESTION_EVERY_MS) return;
    const name = this.gaps.top();
    if (!name) return;
    if (!this.d.say(gapQuestion(name))) return;
    this.gaps.drop(name);
    this.question = { name, at: now };
    this.d.setAskedAt(new Date(now).toISOString());
    this.d.log.info("memory.asked");
  }

  /** Keeps facts the user gave (introduction, interview, an answer). How many were kept. */
  private keepAll(facts: NewFact[], announce = true): number {
    let kept = 0;
    const added: Fact[] = [];
    for (const f of facts) {
      const r = this.d.memory.learn(f);
      if (r.kind !== "refused") kept++;
      // (Said again: kept, and already known, so nothing new to show.)
      if (r.kind === "added") added.push(r.fact);
    }
    if (added.length) this.learned(added, announce);
    return kept;
  }

  private learned(facts: Fact[], announce = true): void {
    this.noteNew(facts.map(f => ({ id: f.id, text: f.text, source: f.source })), announce);
  }

  /** New facts: "forget that" can reach them, and (`announce`) the conversation says "Ember learned". */
  private noteNew(items: LearnedItem[], announce = true): void {
    if (!items.length) return;
    const at = this.now();
    this.recent = [...this.recent, ...items.map(i => ({ id: i.id, text: i.text, at }))].slice(-20);
    if (announce) this.d.onLearned?.(items);
  }
}

/** The conversation as Home shows it: Ember's own lines, with the "Ember learned" lines in time order among them. */
export function withLearned<T extends { t: string }>(lines: readonly T[], learned: readonly T[]): T[] {
  if (!learned.length) return [...lines];
  return [...lines, ...learned].map((l, i) => ({ l, i })).sort((a, b) => a.l.t.localeCompare(b.l.t) || a.i - b.i).map(x => x.l);
}
