/**
 * Voice personalisation in main (docs/ASSISTANT.md "Personalisation"), apart from the Electron wiring so it is
 * unit-tested: Voice Match learning from the owner's requests (app/voice/adapt.ts, with every guard), the transcript
 * corrected against the user's own words (correct.ts) and what they might say next (predict.ts). Everything stays on
 * this computer; the log gets counts and reason words only, never what was said.
 */

import { ADAPT_QUIET_MS, adapt, adaptGuard } from "../../voice/adapt";
import { decodePrint, encodePrint } from "../../voice/voiceprint";
import type { VoiceprintStore } from "../voiceprint-store";
import { correctTranscript, learnFrom, memoryNames, type Corrected, type LearnedCorrection, type LexiconEntry } from "./correct";
import { followUpMs, predictNext, type PredictInput, type Suggestion } from "./predict";
import type { LearnedWord, WordsStore } from "./words-store";

export interface PersonalLog { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void }

/** The settings that bear on it (Settings › Voice), with the administrator's policy applied. */
export interface PersonalSettings {
  /** Keep learning my voice (and Voice Match is on and in force). */
  learnVoice: boolean;
  matchOn: boolean;
  /** Learn my words. */
  learnWords: boolean;
  /** Suggest what I might say next. */
  suggest: boolean;
}

export interface PersonalOptions {
  log: PersonalLog;
  settings: () => PersonalSettings;
  voiceprints: VoiceprintStore;
  words: WordsStore;
  /** Installed apps' names (the platform's app catalog). */
  apps: () => readonly string[];
  /** Memory's facts while memory is in force (memoryWanted and the admin's features.memory), else null. */
  memory: () => readonly { text: string; source: string }[] | null;
  /** Whether words are about something risky (policy's isRiskyLabel for this OS). */
  risky: (words: string) => boolean;
  now?: () => number;
}

/** A request heard lately: what the conversation shows (corrected) and what the recogniser wrote, for "That's not what I said". */
export interface HeardItem { id: number; shown: string; raw: string; at: number }

/** Requests heard that can still be corrected (this session, in memory only). */
const HEARD_KEPT = 12;
/** Requests remembered for predictions (this session, in memory only). */
const HISTORY_KEPT = 30;
/** App names are read from the catalog again after this long (ms). */
const APPS_MS = 10 * 60_000;

/** What Voice Match learning knows of the request a sample belongs to (main's last utterance). */
export interface SampleRequest {
  verified: boolean;
  /** It ran on to the longest Ember listens. */
  cut: boolean;
  /** Ember spoke since its wake (VoiceService.selfSpokeSince). */
  selfSpoke: boolean;
  /** A question Voice Match locked (another voice was turned away) is up (Confirmer.lockVoice). */
  locked: boolean;
}

export class PersonalVoice {
  private heardList: HeardItem[] = [];
  private nextId = 1;
  private history: string[] = [];
  private strangerAt = Number.NEGATIVE_INFINITY;
  private stoppedAt = Number.NEGATIVE_INFINITY;
  private appNames: { at: number; names: readonly string[] } | null = null;
  private suggestions: Suggestion[] = [];
  private last: Omit<PredictInput, "history" | "hour" | "people"> | null = null;
  private readonly now: () => number;

  constructor(private o: PersonalOptions) {
    this.now = o.now ?? Date.now;
  }

  // ───── Voice Match that keeps learning ─────

  /** Voice Match turned another voice away (a wake or a request): nothing is learnt for a while. */
  strangerTurnedAway(): void {
    this.strangerAt = this.now();
  }

  /** The kill switch was pulled: nothing is learnt for a while, and the suggestions go. */
  stopped(): void {
    this.stoppedAt = this.now();
    this.suggestions = [];
  }

  /**
   * A sample from the voice process (a verified request that matched well) for the request `r`: learnt from when every
   * guard allows (adapt.ts adaptGuard, then adapt's own margin and limits). Returns the new print (base64) to use, or
   * null when nothing changed.
   */
  sample(s: { print: string; score: number; oneVoice: boolean; voiced: number }, r: SampleRequest | null): string | null {
    const set = this.o.settings();
    const now = this.now();
    const st = this.o.voiceprints.state();
    const why = adaptGuard({
      learning: set.learnVoice, matchOn: set.matchOn && !!st, verified: !!r?.verified, selfSpoke: r?.selfSpoke ?? true,
      strangerNear: !!r?.locked || now - this.strangerAt < ADAPT_QUIET_MS, busyRoom: !s.oneVoice || !!r?.cut,
      stoppedLately: now - this.stoppedAt < ADAPT_QUIET_MS, voicedSeconds: s.voiced, lastAt: this.o.voiceprints.learnt().at, now,
    });
    const print = decodePrint(s.print);
    if (why || !st || !print) { this.o.log.info("voice.match_learn", { learnt: false, why: why ?? "unreadable" }); return null; }
    const { state, outcome } = adapt(st, print, s.score);
    if (outcome !== "learnt") { this.o.log.info("voice.match_learn", { learnt: false, why: outcome }); return null; }
    try {
      this.o.voiceprints.writeState(state, now);
    } catch (err) {
      this.o.log.warn("voice.match_learn_not_saved", { err: err instanceof Error ? err.message : String(err) });
      return null;
    }
    this.o.log.info("voice.match_learn", { learnt: true, clips: state.clips.length });
    return encodePrint(state.print);
  }

  // ───── Personal vocabulary ─────

  /** The words corrections are made against now: apps, memory's names (in force only), what the user taught, what Ember expects. */
  lexicon(): { entries: LexiconEntry[]; learned: LearnedWord[] } {
    const set = this.o.settings();
    const entries: LexiconEntry[] = this.apps().map(text => ({ text, source: "app" as const }));
    const facts = this.o.memory();
    if (facts) for (const text of memoryNames(facts)) entries.push({ text, source: "memory" });
    if (set.suggest) for (const s of this.suggestions) for (const w of s.text.split(/\s+/)) if (/^\p{Lu}\p{L}{3,}$/u.test(w)) entries.push({ text: w, source: "predicted" });
    return { entries, learned: set.learnWords ? this.o.words.list() : [] };
  }

  /**
   * A request heard (the recogniser's words): corrected, kept for "That's not what I said" under its `id` (the
   * conversation's row carries it: TranscriptEntry.heardId), and the counts logged.
   */
  heard(raw: string): Corrected & { id: number } {
    let c: Corrected;
    try {
      c = correctTranscript(raw, this.lexicon(), this.o.risky);
    } catch (err) {
      // A correction that fails leaves the words as heard (never holds a request up).
      this.o.log.warn("voice.correct_failed", { err: err instanceof Error ? err.message : String(err) });
      c = { text: raw, raw, counts: {} };
    }
    if (Object.keys(c.counts).length || c.held === "newly-risky") this.o.log.info("voice.corrected", { ...c.counts, ...(c.held ? { held: c.held } : {}) });
    const id = this.nextId++;
    this.heardList = [...this.heardList, { id, shown: c.text, raw: c.raw, at: this.now() }].slice(-HEARD_KEPT);
    return { ...c, id };
  }

  /** What was heard lately, newest last (Home marks those rows of the conversation). */
  heardItems(): HeardItem[] {
    return [...this.heardList];
  }

  /**
   * The user retyped what they meant for the request Ember heard as `id` (its conversation row's). Kept as a correction
   * when Learn my words is on and the difference is a few words; the outcome says which, and what was learnt.
   */
  teach(id: number, meant: string): { outcome: "learnt" | "off" | "unknown" | "unlike" | "same"; word?: LearnedCorrection } {
    const h = this.heardList.find(x => x.id === id);
    if (!h) return { outcome: "unknown" };
    if (h.raw.trim().toLowerCase() === meant.trim().toLowerCase()) return { outcome: "same" };
    if (!this.o.settings().learnWords) return { outcome: "off" };
    const c = learnFrom(h.raw, meant, this.o.risky);
    if (!c) { this.o.log.info("voice.word_not_learnt"); return { outcome: "unlike" }; }
    this.o.words.add(c, new Date(this.now()));
    this.o.log.info("voice.word_learnt", { words: this.o.words.list().length });
    return { outcome: "learnt", word: c };
  }

  words(): LearnedWord[] {
    return this.o.words.list();
  }

  forgetWord(expected: unknown): LearnedWord[] {
    return this.o.words.forget(expected);
  }

  forgetWords(): void {
    this.o.words.forgetAll();
    this.heardList = [];
  }

  /**
   * Sign-out, another account or Forget everything: what was asked and heard this session was the person's who is
   * leaving. None of it is suggested to the next one, kept for "That's not what I said", or left showing (memory-r9-2).
   * The words learnt and the voiceprint stay: they have their own Forget.
   */
  forgetSession(): void {
    this.history = [];
    this.heardList = [];
    this.suggestions = [];
    this.last = null;
  }

  /** Forget my voice: the voiceprint and all it learnt, and the words learnt from what the user said, go. */
  forgetVoice(): void {
    this.o.voiceprints.forget();
    this.forgetWords();
  }

  // ───── What comes next ─────

  /**
   * A request went to Ember (typed, heard or a chosen suggestion). One heard where Ember can't tell the user from its
   * speakers (`unchecked`), or a chosen suggestion (`suggested`), isn't the user's own words: it never comes back as
   * a suggestion.
   */
  asked(text: string, o: { unchecked?: boolean; suggested?: boolean } = {}): void {
    if (!o.unchecked && !o.suggested) this.history = [...this.history, text].slice(-HISTORY_KEPT);
    // Where the words came from travels with them: only the user's own words may authorise a risky suggestion (predict.ts).
    this.last = { lastRequest: text, lastRequestOwn: !o.unchecked && !o.suggested, lastReply: "", spoken: false, task: null };
    this.suggestions = [];
  }

  /**
   * Ember answered (or its task ended): the predictions for what the user might say next (none while Suggest is off).
   * Returns them, and how long a spoken reply's follow-up window stays open.
   */
  answered(reply: string, o: { spoken: boolean; speaks?: boolean; task?: PredictInput["task"] }): { suggestions: Suggestion[]; followUpMs: number } {
    const follow = followUpMs({ lastReply: reply });
    if (!this.last) return { suggestions: [], followUpMs: follow };
    this.last = { ...this.last, lastReply: reply, spoken: o.spoken, ...(o.speaks === undefined ? {} : { speaks: o.speaks }), task: o.task ?? this.last.task ?? null };
    if (!this.o.settings().suggest) { this.suggestions = []; return { suggestions: [], followUpMs: follow }; }
    const facts = this.o.memory();
    const people = facts ? memoryNames(facts, 20) : [];
    const input: PredictInput = { ...this.last, history: this.history, hour: new Date(this.now()).getHours(), people };
    this.suggestions = predictNext(input, this.o.risky);
    return { suggestions: this.suggestions, followUpMs: follow };
  }

  /** The predictions shown now (cleared by a new request or a stop). */
  current(): Suggestion[] {
    return this.o.settings().suggest ? [...this.suggestions] : [];
  }

  /** Whether `text` is one of the suggestions shown now (a chip's click sends only those). */
  isSuggestion(text: string): boolean {
    return this.current().some(s => s.text === text);
  }

  private apps(): readonly string[] {
    const now = this.now();
    if (!this.appNames || now - this.appNames.at > APPS_MS) {
      try { this.appNames = { at: now, names: [...new Set(this.o.apps())].slice(0, 500) }; } catch (err) {
        this.o.log.warn("voice.apps_unreadable", { err: err instanceof Error ? err.message : String(err) });
        this.appNames = { at: now, names: [] };
      }
    }
    return this.appNames.names;
  }
}
