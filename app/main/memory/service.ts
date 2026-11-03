/**
 * Ember's memory as main uses it (docs/MEMORY.md step 2): one graph, loaded from memory.json on first use, saved soon
 * after each change, tidied while nothing changes, and erased whole on request or at sign-out. The conductor's
 * remember, recall and forget_memory tools and the `<memory>` block before each request go through here, and so do
 * Settings › Conversation's list and Forget buttons.
 *
 * A fact the model saves counts as the user's own (`user`, the only source that may shape what Ember does) only when
 * most of its words are in what the user just said. Otherwise it is `conversation`: the model's inference, or text it
 * read somewhere, which is context and never more. Plain Node: no Electron.
 */

import { consolidateInSlices } from "./consolidate";
import type { SemanticMemory } from "./embed";
import { memoryBlock } from "./format";
import { ENTITY_KINDS, type AddResult, type EntityKind, type Fact, type GraphClock, MemoryGraph, type NewFact, type Source } from "./graph";
import { recall, type Recalled } from "./recall";
import { memoryFile, type MemoryFile } from "./store";
import { samePolarity, terms } from "./text";

/** How long after a change memory.json is written (ms): a burst of remembering is one write. */
export const SAVE_DELAY_MS = 1000;
/** How often the sleep-time pass runs while Ember runs (ms), when something changed since the last. */
export const UPKEEP_EVERY_MS = 30 * 60_000;
/** How many facts go with each request (the `<memory>` block). */
export const CONTEXT_FACTS = 6;
/** At least this share of a fact's words in what the user said makes it the user's own. */
export const OWN_WORDS = 0.6;

/** One remembered fact as Settings lists it. */
export interface MemoryItem { id: string; text: string; source: Source; at: string }

export interface MemoryLog { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void }

export interface MemoryServiceOptions {
  dir: string;
  log: MemoryLog;
  clock?: GraphClock;
  /** The file (tests pass their own). */
  file?: MemoryFile;
  /** Something Settings shows changed. */
  onChange?: () => void;
  /** Better recall's vectors (./embed.ts): kept up to date with the graph, and asked for a question's matches. */
  semantic?: SemanticMemory;
  /** Whether automatic upkeep may read and change the user's memory now. */
  inForce?: () => boolean;
}

/** What a fact the model saves is about: names, with an optional kind ("person", "project"…). */
export interface AboutRef { name: string; kind?: string }

/** Whether `fact` is mostly the user's own words (`said`): see OWN_WORDS. */
export function ownWords(fact: string, said: string): boolean {
  const f = [...new Set(terms(fact))];
  if (!f.length) return false;
  const s = new Set(terms(said));
  return f.filter(t => s.has(t)).length / f.length >= OWN_WORDS;
}

/**
 * Whether a remembered fact is the user's: mostly their own words (`ownWords`) and said the same way round
 * (`samePolarity`: "Priya is not my manager" never makes "Priya is the manager" theirs).
 */
export function ownFact(fact: string, said: string): boolean {
  return ownWords(fact, said) && samePolarity(fact, said);
}

const kindOf = (k: string | undefined): EntityKind | undefined => (ENTITY_KINDS as readonly string[]).includes(k ?? "") ? (k as EntityKind) : undefined;

export class MemoryService {
  private graph: MemoryGraph | null = null;
  private file: MemoryFile;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private upkeepTimer: ReturnType<typeof setInterval> | null = null;
  private upkeepRun: { controller: AbortController; done: Promise<boolean> } | null = null;
  /** Changed since the last sleep-time pass. */
  private changed = false;

  constructor(private o: MemoryServiceOptions) {
    this.file = o.file ?? memoryFile(o.dir, err => o.log.warn("memory.broken_file", { err: err instanceof Error ? err.message : String(err) }));
  }

  private get g(): MemoryGraph {
    if (!this.graph) {
      this.graph = this.file.load(this.o.clock);
      this.o.log.info("memory.loaded", this.graph.size);
    }
    return this.graph;
  }

  /** Starts the sleep-time pass (every UPKEEP_EVERY_MS, when something changed). */
  start(): void {
    if (this.upkeepTimer) return;
    this.upkeepTimer = setInterval(() => {
      if (this.changed) void this.upkeep().catch(err => this.o.log.warn("memory.upkeep_failed", { err }));
    }, UPKEEP_EVERY_MS);
    this.upkeepTimer.unref?.();
  }

  /** Writes what is pending and stops the timers (quit). */
  stop(): void {
    if (this.upkeepTimer) { clearInterval(this.upkeepTimer); this.upkeepTimer = null; }
    this.cancelUpkeep();
    this.flush();
    this.o.semantic?.flush();
    this.o.semantic?.stop();
  }

  /** Better recall's model came (or changed): the vectors catch up with what is remembered, in the background. */
  index(): void {
    // Not loaded yet (Ember starting): memory.json is read when something first needs it, and the index catches up then.
    if (!this.graph) { this.indexPending = true; return; }
    this.o.semantic?.changed(this.graph);
  }
  /** index() came before memory.json was read: the first request catches the index up. */
  private indexPending = false;

  /**
   * The model saves a fact. `said`: what the user said in this turn (whose words make it theirs). The answer is for the
   * model: what happened, in a few words.
   */
  remember(fact: string, about: AboutRef[], said: string, replaces?: string): string {
    const refs = (about.length ? about : [{ name: "User", kind: "person" }]).map(a => ({ name: a.name, kind: kindOf(a.kind) }));
    const source: Source = ownFact(fact, said) ? "user" : "conversation";
    const r = this.g.add({ text: fact, about: refs, source, ...(replaces ? { predicate: replaces, single: true } : {}) });
    if (r.kind === "refused") return `Not remembered: ${r.reason}. Tell the user plainly if they asked you to remember it.`;
    this.dirty();
    this.o.semantic?.changed(this.g);
    this.o.log.info("memory.remembered", { kind: r.kind, source: r.fact.source, chars: r.fact.text.length, ...(r.kind === "added" ? { closed: r.closed.length } : {}) });
    if (r.kind === "reinforced") return `Already remembered [${r.fact.id}].`;
    return `Remembered [${r.fact.id}]${r.closed.length ? `, replacing ${r.closed.map(f => `[${f.id}]`).join(", ")}` : ""}.`;
  }

  /** The facts that bear on `query` (each counts as used); `semantic`: its matches by meaning (./embed.ts), if any. */
  recall(query: string, k = CONTEXT_FACTS, history = false, semantic?: Map<string, number>): Recalled[] {
    const found = recall(this.g, query, { k, history, now: this.now(), ...(semantic ? { semantic } : {}) });
    if (found.length) { this.g.touch(found.map(r => r.fact.id)); this.dirty(false); }
    return found;
  }

  /**
   * The `<memory>` block for a request ("" when nothing bears on it), with Better recall's matches by meaning when its
   * model is there (otherwise, or if they don't come in time, exactly the lexical recall). `history`: also what used to
   * be true (the recall tool's).
   */
  async context(request: string, history = false, allowed: () => boolean = () => true): Promise<string> {
    if (!allowed()) return "";
    if (this.indexPending) { this.indexPending = false; this.o.semantic?.changed(this.g); }
    const semantic = await this.o.semantic?.seeds(request);
    if (!allowed()) return "";
    return memoryBlock(this.recall(request, CONTEXT_FACTS, history, semantic));
  }

  /** Forgets one fact by id, and reopens what it had replaced (Undo puts the old value back). True if it was there. */
  forget(id: string): boolean {
    // Only an open fact gives back what it replaced: a closed one was itself replaced since, and reopening under it would
    // leave a single predicate with two open values.
    if (!this.g.fact(id)) return false;
    // Stage the edit separately: a failed disk write must not remove the visible fact or reopen its predecessor.
    const next = new MemoryGraph(structuredClone(this.g.toJSON()), this.o.clock);
    const f = next.fact(id)!;
    const reopened = !f.invalidAt ? next.reopenSuperseded(id) : 0;
    next.forgetFact(id);
    try {
      // Derived data first. If the graph write fails, missing vectors can safely be rebuilt from the retained graph.
      this.o.semantic?.forget(id);
      this.file.save(next);
    } catch (err) {
      this.o.semantic?.changed(this.g);
      this.o.log.warn("memory.erase_failed", { err: err instanceof Error ? err.message : String(err) });
      throw new Error("Ember couldn't finish deleting this memory. It is still listed; try Forget again.", { cause: err });
    }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.cancelUpkeep();
    this.graph = next;
    this.changed = true;
    this.o.semantic?.changed(next);
    this.o.log.info("memory.forgot", { count: 1, reopened });
    this.o.onChange?.();
    return true;
  }

  /** Forgets everything only after both persistent stores have been erased successfully. */
  forgetAll(): void {
    this.cancelUpkeep();
    try {
      this.o.semantic?.forgetAll();
      this.file.erase();
    } catch (err) {
      if (this.graph) this.o.semantic?.changed(this.graph);
      this.o.log.warn("memory.erase_failed", { err: err instanceof Error ? err.message : String(err) });
      throw new Error("Ember couldn't finish deleting memory from this computer. It is still listed; try Forget everything again.", { cause: err });
    }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.graph?.clear();
    this.indexPending = false;
    this.changed = false;
    this.o.log.info("memory.forgot_all");
    this.o.onChange?.();
  }

  /** What Ember remembers now, newest first (what still holds). */
  list(): MemoryItem[] {
    return this.g.allFacts(true)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((f: Fact) => ({ id: f.id, text: f.text, source: f.source, at: f.validAt }));
  }

  /** Joins the current sleep-time pass. False if it was cancelled or no longer allowed. */
  upkeep(): Promise<boolean> {
    if (this.upkeepRun) return this.upkeepRun.done;
    if (this.o.inForce?.() === false) return Promise.resolve(false);
    const controller = new AbortController();
    const done = this.runUpkeep(controller.signal).finally(() => { this.upkeepRun = null; });
    this.upkeepRun = { controller, done };
    return done;
  }

  /** Stop, consent changes and graph changes retire a detached pass before it can publish. */
  cancelUpkeep(): void { this.upkeepRun?.controller.abort(); }

  private async runUpkeep(signal: AbortSignal): Promise<boolean> {
    const next = new MemoryGraph(structuredClone(this.g.toJSON()), this.o.clock);
    const report = await consolidateInSlices(next, { now: this.now() }, signal);
    if (!report || signal.aborted || this.o.inForce?.() === false) return false;
    this.changed = false;
    this.o.log.info("memory.upkeep", { ...report, ...next.size });
    if (report.mergedEntities || report.mergedFacts || report.forgotten || report.orphans) {
      this.graph = next;
      this.dirty();
      this.o.semantic?.changed(next);
    }
    return true;
  }

  /** Writes memory.json now, if a write is pending. */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  // ───── Learning on its own (docs/MEMORY.md steps 3–5; ./learning.ts decides when, ./learn.ts and ./refine.ts what) ─────

  /**
   * Keeps a fact Ember learned by itself (extraction, an introduction, an answer to its question). The caller has
   * decided its source; the graph's guard still refuses any secret whole.
   */
  learn(input: NewFact): AddResult {
    const r = this.g.add(input);
    if (r.kind === "refused") return r;
    this.dirty();
    // Learned, introduced and answered facts are recalled by meaning too (Better recall).
    this.o.semantic?.changed(this.g);
    this.o.log.info("memory.learned", { kind: r.kind, source: r.fact.source, chars: r.fact.text.length, ...(r.kind === "added" ? { closed: r.closed.length } : {}) });
    return r;
  }

  /** A sleep-time change over the graph (./refine.ts): `change` says how many things it changed; saved when any did. */
  refine(change: (g: MemoryGraph) => number): number {
    const n = change(this.g);
    if (n > 0) { this.dirty(); this.o.semantic?.changed(this.g); }
    return n;
  }

  private now(): Date { return (this.o.clock?.now ?? (() => new Date()))(); }

  private save(): void {
    if (!this.graph) return;
    try {
      this.file.save(this.graph);
    } catch (err) {
      this.o.log.warn("memory.save_failed", { err: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Something changed: saved soon; `shown`: Settings' list changed too. */
  private dirty(shown = true): void {
    this.cancelUpkeep();
    this.changed = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, SAVE_DELAY_MS);
      this.saveTimer.unref?.();
    }
    if (shown) this.o.onChange?.();
  }
}
