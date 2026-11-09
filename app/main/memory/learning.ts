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

import { memoryPausedReply } from "../../shared/memory-owner";
import type { Fact, NewFact, Source } from "./graph";
import { IntroSchema, Interview, INTRO_MANAGED, INTRO_OFF, SPOKEN_FACT, introFacts, isGetToKnowMe, type Intro } from "./intro";
import { CallBudget, Learner, soundsLikeInstruction, type LearnBudget, type OneShot } from "./learn";
import type { MemoryOwnerReason } from "./owner";
import {
  ANSWER_WAIT_MS, FORGET_THAT_MS, Gaps, INTRO_NOTE, NOTHING_TO_FORGET, QUESTION_EVERY_MS, answersQuestion, declinesQuestion, describes,
  forgetNote, forgetReply, forgetsWithMore, forgotReply, gapFact, gapQuestion, isForgetThat, looksLikeRequest, memoryAsk, rememberNote,
  remembersWithMore, type MemoryNote, type MemoryNotNow,
} from "./questions";
import { REFINE_SYSTEM, applyRefinement, parseRefinement, recentFacts, refinePrompt } from "./refine";
import { ownFact, type AboutRef, type MemoryItem, type MemoryLog, type MemoryService } from "./service";
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
  /**
   * Opens Settings › Memory: at its list for a forget request (`list`), at its note's words for the interview asked for
   * while memory is off (`note`). Never at the note's agree button (memory-r7).
   */
  openMemory?: (at: "list" | "note") => void;
  /**
   * Memory is on and agreed to, but its saved memory can't be opened now: why (memory-2); or memory is on under an
   * earlier note the user hasn't reviewed (`note`, memory-r4). Ember says so rather than asking for memory to be turned
   * on. Null or absent otherwise.
   */
  paused?: () => MemoryOwnerReason | "note" | null;
  /** New facts were kept (the "Ember learned" line). */
  onLearned?: (items: LearnedItem[]) => void;
  /** Everything was forgotten: what showed as learned goes. */
  onForgotAll?: () => void;
  /**
   * One fact was forgotten: its "Ember learned" line says so where it was, with the Undo that puts it back (`gone`:
   * what went, and restore's token: memory-c1-3). Without `gone` (a correction changed its words) the line goes.
   */
  onForgot?: (id: string, gone?: { text: string; derived: number; undo: string; back?: string[] }) => void;
  /**
   * The conductor forgot a fact the user asked it to (forget_memory): the conversation says so ("Ember forgot: …", in
   * the fact's stored words, never the model's), with Undo by `undo` (memory-v2).
   */
  onAskedForget?: (forgot: { id: string; text: string; derived: number; undo: string; back?: string[] }) => void;
  /** The user said in the spoken interview whether they like replies spoken: Ember's speaking choice follows (memory-5). */
  setSpoken?: (on: boolean) => void;
  log: MemoryLog;
  now?: () => number;
  budget?: Partial<LearnBudget>;
}

/** What the conductor gets: MemoryService's tools, plus `heard` at each turn's end. */
export interface LearningConductorMemory {
  remember(fact: string, about: AboutRef[], said: string, replaces?: string): string;
  context(query: string, history?: boolean): Promise<string>;
  forRequest(request: string, own: boolean): Promise<string>;
  forget(id: string): boolean;
  factText(id: string): string | null;
  forgetAll(): void;
  heard(said: string, reply: string, own: boolean): void;
}

export class MemoryLearning {
  private model: OneShot | null = null;
  private recallRevision = 0;
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
    // A failing pass is logged, never an unhandled rejection.
    this.timer = setInterval(() => { this.tick().catch(err => this.d.log.warn("memory.tick_failed", { err: err instanceof Error ? err.message : String(err) })); }, IDLE_CHECK_MS);
    this.timer.unref?.();
  }

  /** Stops for good (quit). */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.stopNow();
  }

  /** The kill switch: every model call under way is abandoned, nothing waiting is learned, the interview ends. */
  stopNow(): void {
    ++this.recallRevision;
    this.d.memory.cancelUpkeep();
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
    const context = async (query: string, history = false): Promise<string> => {
      if (!this.d.inForce()) return "";
      const revision = this.recallRevision;
      const text = await m.context(query, history, () => this.d.inForce() && revision === this.recallRevision);
      return this.d.inForce() && revision === this.recallRevision ? text : "";
    };
    return {
      remember: (fact, about, said, replaces) => {
        if (!this.d.inForce()) return "Not remembered: memory is off.";
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
      // With Better recall's matches by meaning, as for a request (MemoryService.context).
      context,
      forRequest: async (request, own) => {
        if (!this.d.inForce()) return "";
        const revision = this.recallRevision;
        // With the user's profile (what to call them, how they like answers) whatever they ask (memory-5).
        const { text, matched } = await m.requestContext(request, () => this.d.inForce() && revision === this.recallRevision);
        if (!this.d.inForce() || revision !== this.recallRevision) return "";
        // Nothing bears on what the user asked themselves: the names in it are gaps (known names aren't, and checking
        // doesn't count as a use). Never from words Ember couldn't tell were the user's.
        if (!matched && own && this.d.inForce()) {
          const known = m.list().map(i => fold(i.text));
          this.gaps.missed(request, name => known.some(t => t.includes(fold(name))));
        }
        return text;
      },
      forget: id => {
        if (!this.d.inForce()) return false;
        const gone = this.forgetCounted(id);
        if (gone) {
          try { this.d.onAskedForget?.({ id, ...gone }); } catch { this.d.log.warn("memory.delete_notice_failed"); }
        }
        return !!gone;
      },
      factText: id => (this.d.inForce() ? m.factText(id) : null),
      forgetAll: () => this.forgetAll(),
      heard: (said, reply, own) => { this.active(); this.learner.heard(said, reply, own); },
    };
  }

  /**
   * One fact is forgotten (Home's Forget or Undo, forget_memory, "forget that"): "forget that" can no longer reach it,
   * and its "Ember learned" line goes (`onForgot`). True if it was there.
   */
  forget(id: string): boolean {
    return this.forgetCounted(id) !== null;
  }

  /**
   * `forget`, saying what went: the fact's words, how many of Ember's notes made from it went too (memory-3), the
   * token `restore` takes to undo it, and what is current again (`back`). Forgetting what Ember kept just now (within
   * FORGET_THAT_MS: its "Ember learned" line's Undo, "forget that", a Forget soon after) undoes it, so what it replaced
   * holds again; anything older is forgotten alone, and what it replaced stays history (memory-12).
   */
  forgetCounted(id: string): { text: string; derived: number; undo: string; back?: string[] } | null {
    // A refinement still reading this fact must never reintroduce it in a summary after Forget.
    this.refining?.abort();
    ++this.recallRevision;
    const kept = this.recent.find(r => r.id === id);
    const gone = this.d.memory.forgetCounted(id, !!kept && this.now() - kept.at <= FORGET_THAT_MS);
    this.recent = this.recent.filter(r => r.id !== id);
    if (gone) {
      try { this.d.onForgot?.(id, gone); } catch { this.d.log.warn("memory.delete_notice_failed"); }
    }
    return gone;
  }

  /**
   * Undo of a recent Forget (Home's list, or the conversation's "Ember forgot" line): true if it was put back. `open`:
   * the account's memory is open to its owner, as it is for Home's list and its Forget while memory is switched off
   * (memory-r3); by default, only while memory is in force.
   */
  restore(token: string, open = this.d.inForce()): boolean {
    if (!open) return false;
    ++this.recallRevision;
    return this.d.memory.restore(token);
  }

  /** An explicit local correction retires readers and learned lines that still describe the old wording. */
  correct(expected: MemoryItem, text: string): MemoryItem {
    if (!this.d.inForce()) throw new Error("Ember couldn't save this correction. Turn on memory and try again.");
    this.refining?.abort();
    ++this.recallRevision;
    const corrected = this.d.memory.correct(expected, text);
    // An extraction of the earlier conversation must not put the old sentence back after this explicit correction.
    this.learner.stop();
    this.recent = this.recent.filter(row => row.id !== expected.id);
    try { this.d.onForgot?.(expected.id); } catch { this.d.log.warn("memory.correction_notice_failed"); }
    return corrected;
  }

  /** Everything is forgotten (sign-out, Forget everything): what waits to be learned goes too. */
  forgetAll(): void {
    this.stopNow();
    this.d.memory.forgetAll();
    this.gaps.clear();
    this.recent = [];
    // The "Ember learned" lines and their Undo go too.
    try { this.d.onForgotAll?.(); } catch { this.d.log.warn("memory.delete_notice_failed"); }
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
      if (!this.d.inForce()) return this.notInForce();
      this.question = null;
      this.interview = new Interview(now);
      this.interviewAt = now;
      return this.interview.start();
    }
    // "Forget that" first: never an answer to a question (the interview's or Ember's own).
    if (isForgetThat(text)) {
      // A bare "forget that" while memory isn't in force is as likely "never mind": the conversation takes it.
      if (!this.d.inForce()) return null;
      const last = this.recent.at(-1);
      // Nothing kept lately: said in code, since forget_memory needs words that name the fact (memory-v1).
      if (!last || now - last.at > FORGET_THAT_MS) return NOTHING_TO_FORGET;
      const gone = this.forgetCounted(last.id);
      return gone ? forgotReply(last.text, gone.derived, gone.back) : NOTHING_TO_FORGET;
    }
    // "Forget my…" while memory can't: the truth, in code, never a model's "done" (memory-v1). "Remember that…" goes to
    // the conversation, which keeps it until Ember closes; Ember says after the answer that memory won't (rememberNote:
    // memory-c1-1).
    if (!this.d.inForce() && memoryAsk(text) === "forget") return this.notInForce("forget");
    // A request ("open Thunderbird and send the report to Bob") is never an answer: the question is let go of and the
    // conversation takes the request. "Call me Ram" to the interview's name question is its answer (memory-6).
    const request = looksLikeRequest(text);
    if (this.interview) {
      if (!this.d.inForce() || (request && !this.interview.answers(text))) { this.interview = null; return null; }
      const step = this.interview.answer(text, how.own);
      this.interviewAt = now;
      const kept = this.keepAll(step.keep);
      if (kept < step.keep.length && (this.d.memory.trouble === "unsaved" || this.d.memory.trouble === "unreadable")) {
        this.interview = null;
        return "I couldn't save that answer. I've stopped the questions; check Memory in settings, then try again.";
      }
      // "Spoken or not" is Ember's real choice, not only a fact (only what the user was heard to say reaches `keep`).
      const spoken = step.keep.find(f => f.predicate === "spoken_answers");
      if (spoken && how.own) {
        try { this.d.setSpoken?.(spoken.text === SPOKEN_FACT); } catch { this.d.log.warn("memory.spoken_not_saved"); }
      }
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

  /**
   * What Ember adds after the conversation's answer to "remember…" while memory isn't in force (memory-c1-1): the
   * conversation keeps it until Ember closes, memory doesn't. After a forget request with more in it ("Forget my
   * address and open Firefox"), that memory can't change what's saved; after a remember request with more in it
   * ("Remember that I'm vegetarian and book a table"), that memory won't keep it. Null for anything else, or while
   * memory is in force.
   */
  rememberNote(text: string): MemoryNote | null {
    if (this.d.inForce()) return null;
    if (memoryAsk(text) === "remember") return rememberNote(this.notNow());
    if (forgetsWithMore(text)) return forgetNote(this.notNow());
    // "Remember that I'm vegetarian and book a table": the request goes on, and memory still won't keep the fact (memory-r3-2).
    return remembersWithMore(text) ? rememberNote(this.notNow()) : null;
  }

  /** Why memory isn't in force now: managed by the organisation, on but paused (and why), or off. */
  private notNow(): MemoryNotNow {
    if (this.d.managed?.()) return "managed";
    return this.d.paused?.() ?? "off";
  }

  /**
   * What Ember says when asked for something only memory can do (get to know the user, forget) while it isn't in force:
   * managed by the organisation, on but paused (and why), or off (Settings › Memory opens: at its list to forget, else
   * at its note).
   */
  private notInForce(asked: "introduce" | "forget" = "introduce"): string {
    const why = this.notNow();
    if (asked === "forget") {
      const reply = forgetReply(why);
      if (reply.open) this.d.openMemory?.("list");
      return reply.text;
    }
    if (why === "managed") return INTRO_MANAGED;
    if (why === "off" || why === "note") {
      this.d.openMemory?.("note");
      return why === "off" ? INTRO_OFF : INTRO_NOTE;
    }
    const reply = memoryPausedReply(why);
    if (reply.open) this.d.openMemory?.("note");
    return reply.text;
  }

  /** One idle check: the sleep-time pass first, else a question. */
  async tick(): Promise<void> {
    const stillIdle = () => !this.d.locked() && this.d.idle() && this.now() - this.lastActive >= IDLE_MS;
    if (!this.d.inForce() || !stillIdle()) return;
    const now = this.now();
    if (!this.refinedThisIdle && this.model && !this.refining && this.refines.allows(now)) {
      this.refinedThisIdle = true;
      await this.refine(stillIdle);
      return;
    }
    this.maybeAsk();
  }

  /** The sleep-time pass: consolidate(), then one model pass over what changed lately. What it changed. */
  async refine(mayStart = () => true): Promise<number> {
    const m = this.d.memory;
    if (this.refining || !this.d.inForce()) return 0;
    const run = new AbortController();
    this.refining = run;
    try {
      if (!await m.upkeep() || run.signal.aborted || !this.d.inForce() || !mayStart()) return 0;
      const model = this.model;
      if (!model) return 0;
      let shown: Fact[] = [];
      let prompt = "";
      m.refine(g => { shown = recentFacts(g, this.refinedAt); prompt = shown.length ? refinePrompt(g, shown) : ""; return 0; });
      if (shown.length < 2) return 0;
      const now = this.now();
      this.refines.spend(now);
      this.refinedAt = new Date(now).toISOString();
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

/** A conversation line about memory, as main keeps it beside the conversation ("Ember learned: …", "Ember forgot: …"). */
export interface MemoryLine { t: string; who: "learned"; text: string; fact?: string; forgot?: string; derived?: number; back?: string[]; again?: true }
/** What a Forget gave back: its Undo's token, the notes that went with it and what holds again. */
type Gone = { undo: string; derived: number; back?: string[] };
const forgotFields = (gone: Gone) => ({
  forgot: gone.undo, ...(gone.derived ? { derived: gone.derived } : {}), ...(gone.back?.length ? { back: gone.back.slice(0, 3).map(b => b.slice(0, 400)) } : {}),
});

/**
 * The memory lines once fact `id` was forgotten (memory-c1-3): its "Ember learned" line stays where it was (its time,
 * so Home keeps the row and focus in place) and says Ember forgot it, with the Undo that puts it back (`gone`). Without
 * `gone` (a correction changed its words) the line goes. Null when no line was about it.
 */
export function linesAfterForget(lines: readonly MemoryLine[], id: string, gone?: Gone): MemoryLine[] | null {
  if (!lines.some(l => l.fact === id)) return null;
  return gone ? lines.map(l => (l.fact === id ? { t: l.t, who: "learned", text: l.text, ...forgotFields(gone) } : l)) : lines.filter(l => l.fact !== id);
}
/** And once the user asked Ember to forget it (forget_memory: memory-v2), unless its learned line says so already. */
export function linesAfterAskedForget(lines: readonly MemoryLine[], f: Gone & { text: string }, t: string): MemoryLine[] | null {
  if (lines.some(l => l.forgot === f.undo)) return null;
  return [...lines, { t, who: "learned" as const, text: f.text.slice(0, 400), ...forgotFields(f) }].slice(-30);
}
/** And once the Undo of `token` put the fact back: its line says it is remembered again, where it was. */
export function linesAfterRestore(lines: readonly MemoryLine[], token: string): MemoryLine[] | null {
  if (!lines.some(l => l.forgot === token)) return null;
  return lines.map(l => (l.forgot === token ? { t: l.t, who: "learned", text: l.text, again: true } : l));
}

/** The conversation as Home shows it: Ember's own lines, with the "Ember learned" lines in time order among them. */
export function withLearned<T extends { t: string }>(lines: readonly T[], learned: readonly T[]): T[] {
  if (!learned.length) return [...lines];
  return [...lines, ...learned].map((l, i) => ({ l, i })).sort((a, b) => a.l.t.localeCompare(b.l.t) || a.i - b.i).map(x => x.l);
}
