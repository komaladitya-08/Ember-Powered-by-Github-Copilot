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

import { consolidate } from "./consolidate";
import { memoryBlock } from "./format";
import { ENTITY_KINDS, type EntityKind, type Fact, type GraphClock, type MemoryGraph, type Source } from "./graph";
import { recall, type Recalled } from "./recall";
import { memoryFile, type MemoryFile } from "./store";
import { terms } from "./text";

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

const kindOf = (k: string | undefined): EntityKind | undefined => (ENTITY_KINDS as readonly string[]).includes(k ?? "") ? (k as EntityKind) : undefined;

export class MemoryService {
  private graph: MemoryGraph | null = null;
  private file: MemoryFile;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private upkeepTimer: ReturnType<typeof setInterval> | null = null;
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
    this.upkeepTimer = setInterval(() => { if (this.changed) this.upkeep(); }, UPKEEP_EVERY_MS);
    this.upkeepTimer.unref?.();
  }

  /** Writes what is pending and stops the timers (quit). */
  stop(): void {
    if (this.upkeepTimer) { clearInterval(this.upkeepTimer); this.upkeepTimer = null; }
    this.flush();
  }

  /**
   * The model saves a fact. `said`: what the user said in this turn (whose words make it theirs). The answer is for the
   * model: what happened, in a few words.
   */
  remember(fact: string, about: AboutRef[], said: string, replaces?: string): string {
    const refs = (about.length ? about : [{ name: "User", kind: "person" }]).map(a => ({ name: a.name, kind: kindOf(a.kind) }));
    const source: Source = ownWords(fact, said) ? "user" : "conversation";
    const r = this.g.add({ text: fact, about: refs, source, ...(replaces ? { predicate: replaces, single: true } : {}) });
    if (r.kind === "refused") return `Not remembered: ${r.reason}. Tell the user plainly if they asked you to remember it.`;
    this.dirty();
    this.o.log.info("memory.remembered", { kind: r.kind, source: r.fact.source, chars: r.fact.text.length, ...(r.kind === "added" ? { closed: r.closed.length } : {}) });
    if (r.kind === "reinforced") return `Already remembered [${r.fact.id}].`;
    return `Remembered [${r.fact.id}]${r.closed.length ? `, replacing ${r.closed.map(f => `[${f.id}]`).join(", ")}` : ""}.`;
  }

  /** The facts that bear on `query` (each counts as used). */
  recall(query: string, k = CONTEXT_FACTS, history = false): Recalled[] {
    const found = recall(this.g, query, { k, history, now: this.now() });
    if (found.length) { this.g.touch(found.map(r => r.fact.id)); this.dirty(false); }
    return found;
  }

  /** The `<memory>` block for a request ("" when nothing bears on it). */
  context(request: string): string {
    return memoryBlock(this.recall(request));
  }

  /** Forgets one fact by id. True if it was there. */
  forget(id: string): boolean {
    const had = this.g.forgetFact(id);
    if (had) { this.dirty(); this.o.log.info("memory.forgot", { count: 1 }); }
    return had;
  }

  /** Forgets everything: the graph and the file. */
  forgetAll(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.graph?.clear();
    try { this.file.erase(); } catch (err) { this.o.log.warn("memory.erase_failed", { err: err instanceof Error ? err.message : String(err) }); }
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

  /** The sleep-time pass now (merge, dedupe, forget what went stale). */
  upkeep(): void {
    const report = consolidate(this.g, { now: this.now() });
    this.changed = false;
    this.o.log.info("memory.upkeep", { ...report, ...this.g.size });
    if (report.mergedEntities || report.mergedFacts || report.forgotten || report.orphans) this.dirty();
  }

  /** Writes memory.json now, if a write is pending. */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
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
    this.changed = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, SAVE_DELAY_MS);
      this.saveTimer.unref?.();
    }
    if (shown) this.o.onChange?.();
  }
}
