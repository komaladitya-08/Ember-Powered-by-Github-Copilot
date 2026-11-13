/**
 * Ember's memory as main uses it (docs/MEMORY.md step 2): one graph, loaded from memory.json on first use, saved soon
 * after each change, tidied while nothing changes, and erased whole on request or at sign-out. The conductor's
 * remember, recall and forget_memory tools and the `<memory>` block before each request go through here, and so do
 * Settings › Memory's list and Forget buttons.
 *
 * A fact the model saves counts as the user's own (`user`, the only source that may shape what Ember does) only when
 * most of its words are in what the user just said. Otherwise it is `conversation`: the model's inference, or text it
 * read somewhere, which is context and never more. Plain Node: no Electron.
 */

import crypto from "node:crypto";
import { MEMORY_UNDO_MS } from "../../shared/ipc";
import { consolidateInSlices } from "./consolidate";
import type { SemanticMemory } from "./embed";
import { memoryBlock } from "./format";
import { ENTITY_KINDS, MAX_FACT_CHARS, type AddResult, type Entity, type EntityKind, type Fact, type GraphClock, MemoryGraph, type NewFact, type Source } from "./graph";
import { factRefusal } from "./fact-guard";
import { recall, type Recalled } from "./recall";
import { profileKind, profileSaid } from "./profile";
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
/**
 * How long Undo can put a forgotten fact back exactly (ms): the fact, Ember's notes that went with it and what it had
 * replaced, held in main's memory only (never written), and dropped at Forget everything and when Ember stops.
 */
export const UNDO_FORGET_MS = MEMORY_UNDO_MS;

/**
 * One remembered fact as Settings lists it. `kind`: one of Ember's own notes, its summary of a subject or a guess drawn
 * from several facts (./refine.ts), which Home labels as Ember's rather than as the conversation (memory-3).
 */
export interface MemoryItem {
  id: string; text: string; source: Source; at: string; revision?: number; correctedAt?: string; kind?: "summary" | "guess";
  /** Since when it is no longer true (a newer fact replaced it): kept as history, listed only by `review` (memory-c7-2). */
  until?: string;
}

/** Which of Ember's own notes a fact is, if it is one (`summary`, `reflection`). */
export const noteKind = (f: Pick<Fact, "predicate">): MemoryItem["kind"] => (f.predicate === "summary" ? "summary" : f.predicate === "reflection" ? "guess" : undefined);

const memoryItem = (f: Fact): MemoryItem => {
  const kind = noteKind(f);
  return { id: f.id, text: f.text, source: f.source, at: f.validAt,
    ...(f.revision === undefined ? {} : { revision: f.revision }), ...(f.correctedAt === undefined ? {} : { correctedAt: f.correctedAt }), ...(kind ? { kind } : {}),
    ...(f.invalidAt ? { until: f.invalidAt } : {}) };
};

/**
 * An earlier wording of one of Ember's own notes: closed by a newer note of the same kind (each sleep-time pass
 * rewords a subject's summary: ./refine.ts). It is the note's history, not something that stopped being true, so
 * Settings lists the note once, and it goes whenever the wording that replaced it does (memory-x7-4).
 */
const reworded = (g: MemoryGraph, f: Fact): boolean => {
  const kind = noteKind(f);
  const by = f.invalidAt && f.supersededBy ? g.fact(f.supersededBy) : undefined;
  return !!kind && !!by && noteKind(by) === kind;
};

/** What is wrong with memory.json this run (MemoryService.trouble; memory-r2). */
export type MemoryTrouble = "unreadable" | "reset" | "unsaved";

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

/**
 * Whose a fact the model saves is: the user's when it is mostly their own words said the same way round (`ownFact`),
 * or their own words this turn say the name or the answer length it holds (`profileSaid`: memory-r9-5); otherwise the
 * conversation's.
 */
export function rememberedSource(fact: string, said: string): Extract<Source, "user" | "conversation"> {
  return ownFact(fact, said) || profileSaid(fact, said) ? "user" : "conversation";
}

/** The predicates of what the user said about themselves that bear on every request (the introduction's: ./intro.ts). */
export const PROFILE_PREDICATES = ["called", "answer_length", "answer_style"] as const;

/**
 * The user's profile for every request (memory-5): the open facts they gave themselves (`user`) on what to call them
 * and how they like answers, one for each, newest first. Recall is unchanged: this is added beside it.
 */
export function profileFacts(g: MemoryGraph): Fact[] {
  const out: Fact[] = [];
  for (const p of PROFILE_PREDICATES) {
    const f = g.allFacts(true).filter(x => x.source === "user" && x.predicate === p).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    if (f) out.push(f);
  }
  return out;
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
  /** What each recent Forget removed, by its Undo token, until `until` (UNDO_FORGET_MS). */
  private undoable = new Map<string, { entities: Entity[]; facts: Fact[]; reopened: { id: string; invalidAt: string; supersededBy: string | null }[]; until: number }>();

  /**
   * What is wrong with memory.json this run, for Settings › Memory to say (memory-r2): it couldn't be read and is left as
   * it was (`unreadable`), it wasn't memory and was moved aside (`reset`), or the last save failed (`unsaved`).
   */
  private problem: MemoryTrouble | null = null;

  constructor(private o: MemoryServiceOptions) {
    this.file = o.file ?? memoryFile(o.dir, (err, how) => {
      o.log.warn("memory.broken_file", { err: err instanceof Error ? err.message : String(err), how });
      // (Said by the view that read it: nothing is broadcast from inside a load.)
      this.problem = how === "out-of-reach" ? "unreadable" : "reset";
    });
  }

  /** What is wrong with memory.json this run, or null (memory-r2). */
  get trouble(): MemoryTrouble | null { return this.problem; }

  /**
   * memory.json is there and couldn't be read (it is read now if it hasn't been): nothing new is kept this run, as
   * Settings › Memory says. A fact kept in RAM alone would go with requests, be gone at the next start, and couldn't
   * be forgotten, since no save may replace the file (memory-r7-1).
   */
  get unreadable(): boolean {
    void this.g;
    return this.problem === "unreadable";
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
    this.undoable.clear();
    this.flush();
    this.o.semantic?.flush();
    this.o.semantic?.stop();
  }

  /** Better recall's model came (or changed): the vectors catch up with what is remembered, in the background. */
  index(): void {
    // Not loaded yet (Ember starting): memory.json is read when something first needs it, and the index catches up then.
    if (!this.graph) return;
    this.o.semantic?.changed(this.graph);
  }

  /**
   * The model saves a fact. `said`: what the user said in this turn (whose words make it theirs). The answer is for the
   * model: what happened, in a few words.
   */
  remember(fact: string, about: AboutRef[], said: string, replaces?: string): string {
    const refs = (about.length ? about : [{ name: "User", kind: "person" }]).map(a => ({ name: a.name, kind: kindOf(a.kind) }));
    const source: Source = ownFact(fact, said) ? "user" : "conversation";
    if (this.unreadable) return "Not remembered: Ember couldn't read its saved memory, so nothing new is kept until it starts again. Tell the user plainly.";
    // What to call the user, or how long answers should be, in their own words this turn: the profile's own fact,
    // theirs, which replaces the one before whatever the model called the relation (memory-r9-5).
    const own = profileSaid(fact, said, source === "user");
    const r = this.g.add(own ?? { text: fact, about: refs, source, ...(replaces ? { predicate: replaces, single: true } : {}) });
    if (r.kind === "refused") return `Not remembered: ${r.reason}. Tell the user plainly if they asked you to remember it.`;
    this.dirty();
    this.o.semantic?.changed(this.g);
    this.o.log.info("memory.remembered", { kind: r.kind, source: r.fact.source, chars: r.fact.text.length, ...(r.kind === "added" ? { closed: r.closed.length } : {}) });
    // Saving is failing (memory.json couldn't be saved this run): kept for now, and the model is told so it never
    // promises more (memory-r2).
    const unkept = this.problem === "unsaved" ? " Saving memory on this computer is failing, so tell the user it may be gone when Ember closes." : "";
    const beside = this.besideUsers(r.fact);
    if (r.kind === "reinforced") return `Already remembered [${r.fact.id}].${beside}${unkept}`;
    return `Remembered [${r.fact.id}]${r.closed.length ? `, replacing ${r.closed.map(f => `[${f.id}]`).join(", ")}` : ""}.${beside}${unkept}`;
  }

  /**
   * What the model is told when a fact that isn't the user's own stands beside what they told Ember about the same
   * thing (the same single relation, or the profile's name or answer length): the weaker source never overrules it
   * (./graph.ts), so that one still holds, and Ember says so rather than "I'll remember that" (memory-r9-5). "" otherwise.
   */
  private besideUsers(fact: Fact): string {
    if (fact.source === "user") return "";
    const kind = profileKind(fact.text);
    const theirs = this.g.allFacts(true).find(f => f.id !== fact.id && f.source === "user" && f.entities[0] === fact.entities[0] && f.text !== fact.text
      && ((!!fact.predicate && f.predicate === fact.predicate) || (!!kind && f.predicate === kind)));
    if (!theirs) return "";
    const always = (PROFILE_PREDICATES as readonly string[]).includes(theirs.predicate) ? " and goes with every request" : "";
    return ` It didn't replace what the user told Ember themselves, [${theirs.id}] “${theirs.text.replace(/[“”]/g, "")}”, which still holds${always}: only their own words change it. Tell the user plainly, and that they can say it again themselves or use Correct… in Settings › Memory.`;
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
    const found = await this.matches(request, history, allowed);
    return found ? memoryBlock(found) : "";
  }

  /**
   * The `<memory>` block before the user's own request: the user's profile first (what they asked Ember to call them
   * and how they like answers, `profileFacts`), whatever the request says, then what recall finds (memory-5).
   * `matched`: recall found something (what memory keeps missing is counted from that alone).
   */
  async requestContext(request: string, allowed: () => boolean = () => true): Promise<{ text: string; matched: boolean }> {
    const found = await this.matches(request, false, allowed);
    if (!found) return { text: "", matched: false };
    const profile = profileFacts(this.g);
    const rest = found.map(r => r.fact).filter(f => !profile.some(p => p.id === f.id));
    return { text: memoryBlock([...profile, ...rest]), matched: found.length > 0 };
  }

  /** Recall's matches for `request`, with Better recall's by meaning when it has them; null when no longer allowed. */
  private async matches(request: string, history: boolean, allowed: () => boolean): Promise<Recalled[] | null> {
    if (!allowed()) return null;
    // A restart may leave an older derived index beside a durable correction. Bind its hashes to the current graph
    // before the first query, even when the model became ready before index() could attach a lazy graph.
    let semantic: Map<string, number> | undefined;
    try { this.o.semantic?.changed(this.g, false); semantic = await this.o.semantic?.seeds(request); }
    catch { this.o.log.warn("memory.semantic_unavailable"); }
    if (!allowed()) return null;
    return this.recall(request, CONTEXT_FACTS, history, semantic);
  }

  /** Corrects exactly the shown open fact after a durable write, preserving its subject, provenance and authority. */
  correct(expected: MemoryItem, text: string): MemoryItem {
    const current = this.g.fact(expected.id);
    if (!current || current.invalidAt || current.text !== expected.text || current.source !== expected.source
      || current.validAt !== expected.at || (current.revision ?? 0) !== (expected.revision ?? 0)) {
      throw new Error("This memory changed. Close this edit and open it again before saving.");
    }
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean || clean.length > MAX_FACT_CHARS) throw new Error(`Keep the correction between 1 and ${MAX_FACT_CHARS} characters.`);
    if (factRefusal(clean)) throw new Error("This correction holds a secret, so Ember hasn't saved it.");
    const revision = (current.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error("This memory changed. Close this edit and open it again before saving.");
    const next = new MemoryGraph(structuredClone(this.g.toJSON()), this.o.clock);
    const corrected = { ...next.fact(current.id)!, text: clean, revision, correctedAt: this.now().toISOString() };
    next.replaceFact(corrected);
    // Ember's notes made from the old words would keep them: they go in the same write (memory-3).
    const notes = next.notesFrom(current.id);
    for (const n of notes) next.forgetFact(n);
    try {
      for (const n of notes) this.o.semantic?.forget(n);
      this.file.save(next);
    }
    catch (err) {
      // The notes' vectors may be gone already: rebuilt from the graph, which still holds them.
      if (notes.length) try { this.o.semantic?.changed(this.g); } catch { this.o.log.warn("memory.correction_index_recovery_failed"); }
      this.o.log.warn("memory.correction_failed", { err: err instanceof Error ? err.message : String(err) });
      throw new Error("Ember couldn't save this correction. The original memory is unchanged. Try again.", { cause: err });
    }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.cancelUpkeep();
    this.graph = next;
    this.changed = true;
    // Derived indexing and a view notification cannot turn an already committed correction into a reported failure.
    try { this.o.semantic?.changed(next); } catch { this.o.log.warn("memory.correction_index_failed"); }
    this.o.log.info("memory.corrected", { source: corrected.source, chars: corrected.text.length });
    try { this.o.onChange?.(); } catch { this.o.log.warn("memory.correction_notify_failed"); }
    return memoryItem(corrected);
  }

  /** Forgets one fact by id, and reopens what it had replaced (Undo puts the old value back). True if it was there. */
  forget(id: string, reopen = true): boolean {
    return this.forgetCounted(id, reopen) !== null;
  }

  /**
   * The words of a kept fact, or null (forget_memory checks the user asked about it: memory-v2). What is no longer
   * true has words too: recall gives the model its id, and the user may ask for it to go (memory-c7-2).
   */
  factText(id: string): string | null {
    return this.g.fact(id)?.text ?? null;
  }

  /**
   * `forget`, saying what went: the fact's words, how many of Ember's own notes made from it went with it (its
   * summaries and guesses, which hold its words: memory-3), the token `restore` takes to undo it, and (`back`) the
   * words of what it had replaced, open again. Null if it wasn't there. `reopen` false: the fact goes alone, and what
   * it replaced stays history (a deliberate Forget of what holds now: memory-12).
   */
  forgetCounted(id: string, reopen = true): { text: string; derived: number; undo: string; back?: string[] } | null {
    // Only an open fact gives back what it replaced: a closed one was itself replaced since, and reopening under it would
    // leave a single predicate with two open values.
    if (!this.g.fact(id)) return null;
    // Stage the edit separately: a failed disk write must not remove the visible fact or reopen its predecessor.
    const before = this.g;
    const next = new MemoryGraph(structuredClone(this.g.toJSON()), this.o.clock);
    const f = next.fact(id)!;
    const notes = next.notesFrom(id);
    // The notes the user could see in the list: Settings lists the closed ones too (memory-c7-2), but a note's
    // earlier wordings never (memory-x7-4).
    const shownNotes = notes.filter(n => !reworded(next, next.fact(n)!)).length;
    let reopened = 0;
    // What the fact itself gives back, in its words, so whoever says what went says this too (memory-12).
    const back = reopen && !f.invalidAt ? next.allFacts().filter(o => o.supersededBy === id && !notes.includes(o.id)).map(o => o.text) : [];
    // A note that replaced an older one gives it back, unless that one goes too.
    for (const x of [id, ...notes]) if (!next.fact(x)?.invalidAt && (reopen || x !== id)) reopened += next.reopenSuperseded(x);
    // A note's earlier wordings aren't listed, so they go with the wording that replaced them: none is left on disk
    // behind a note that is gone (memory-x7-4). One that was just given back is open, and stays.
    const going = new Set([id, ...notes]);
    for (let more = true; more;) {
      more = false;
      for (const o of next.allFacts()) {
        if (going.has(o.id) || !o.supersededBy || !going.has(o.supersededBy) || !reworded(next, o)) continue;
        going.add(o.id); notes.push(o.id); more = true;
      }
    }
    for (const x of [id, ...notes]) next.forgetFact(x);
    try {
      // Derived data first. If the graph write fails, missing vectors can safely be rebuilt from the retained graph.
      for (const x of [id, ...notes]) this.o.semantic?.forget(x);
      this.file.save(next);
    } catch (err) {
      try { this.o.semantic?.changed(this.g); } catch { this.o.log.warn("memory.delete_index_recovery_failed"); }
      this.o.log.warn("memory.erase_failed", { err: err instanceof Error ? err.message : String(err) });
      throw new Error("Ember couldn't finish deleting this memory. It is still listed; try Forget again.", { cause: err });
    }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.cancelUpkeep();
    this.graph = next;
    this.changed = true;
    // The deletion is durable; derived work and view notifications cannot reverse its acknowledgement.
    try { this.o.semantic?.changed(next); } catch { this.o.log.warn("memory.delete_index_failed"); }
    this.o.log.info("memory.forgot", { count: 1 + notes.length, reopened });
    try { this.o.onChange?.(); } catch { this.o.log.warn("memory.delete_notice_failed"); }
    const undo = this.keepForUndo(before, next, [id, ...notes]);
    return { text: f.text, derived: shownNotes, undo, ...(back.length ? { back } : {}) };
  }

  /**
   * Undo of a recent Forget: puts back exactly what it removed and closes again what it had reopened, as one staged
   * write (a failed write changes nothing). Once per token, within UNDO_FORGET_MS. False when it can't.
   */
  restore(token: string): boolean {
    const u = this.undoable.get(token);
    this.undoable.delete(token);
    if (!u || this.now().getTime() > u.until) return false;
    const next = new MemoryGraph(structuredClone(this.g.toJSON()), this.o.clock);
    next.putBack(u.entities, u.facts);
    for (const r of u.reopened) next.reclose(r.id, r.invalidAt, r.supersededBy);
    try { this.file.save(next); }
    catch (err) {
      this.o.log.warn("memory.restore_failed", { err: err instanceof Error ? err.message : String(err) });
      throw new Error("Ember couldn't put this memory back. Try Undo again.", { cause: err });
    }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.cancelUpkeep();
    this.graph = next;
    this.changed = true;
    try { this.o.semantic?.changed(next); } catch { this.o.log.warn("memory.restore_index_failed"); }
    this.o.log.info("memory.restored", { count: u.facts.length });
    try { this.o.onChange?.(); } catch { this.o.log.warn("memory.restore_notice_failed"); }
    return true;
  }

  /** Keeps what `next` no longer has of `before` (the facts `gone`, orphaned entities, reopened facts) for Undo. */
  private keepForUndo(before: MemoryGraph, next: MemoryGraph, gone: string[]): string {
    const now = this.now().getTime();
    for (const [k, u] of this.undoable) if (now > u.until) this.undoable.delete(k);
    const facts = gone.map(x => before.fact(x)).filter((f): f is Fact => !!f);
    const entities = before.allEntities().filter(e => !next.entity(e.id));
    const reopened = before.allFacts().filter(f => f.invalidAt && f.supersededBy && gone.includes(f.supersededBy) && next.fact(f.id) && !gone.includes(f.id))
      .map(f => ({ id: f.id, invalidAt: f.invalidAt!, supersededBy: f.supersededBy }));
    const token = crypto.randomUUID();
    this.undoable.set(token, { entities: structuredClone(entities), facts: structuredClone(facts), reopened, until: now + UNDO_FORGET_MS });
    return token;
  }

  /** Forgets everything only after both persistent stores have been erased successfully. */
  forgetAll(): void {
    this.cancelUpkeep();
    // Nothing forgotten earlier can come back after everything is.
    this.undoable.clear();
    try {
      this.o.semantic?.forgetAll();
      this.file.erase();
    } catch (err) {
      if (this.graph) {
        try { this.o.semantic?.changed(this.graph); } catch { this.o.log.warn("memory.delete_index_recovery_failed"); }
      }
      this.o.log.warn("memory.erase_failed", { err: err instanceof Error ? err.message : String(err) });
      throw new Error("Ember couldn't finish deleting memory from this computer. It is still listed; try Forget everything again.", { cause: err });
    }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.graph?.clear();
    this.changed = false;
    // The file and any copy set aside are gone: nothing is left to say about them.
    this.problem = null;
    this.o.log.info("memory.forgot_all");
    try { this.o.onChange?.(); } catch { this.o.log.warn("memory.delete_notice_failed"); }
  }

  /** How many facts are kept: what holds now, or (`history`) with what is no longer true, as `review` lists it. */
  kept(history = false): number {
    return history ? this.review().length : this.g.allFacts(true).length;
  }

  /** What Ember remembers now, newest first (what still holds). */
  list(): MemoryItem[] {
    return this.g.allFacts(true)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map(memoryItem);
  }

  /**
   * Everything kept, for Settings › Memory (memory-c7-2): what holds now as `list` gives it, then what is no longer
   * true (`until`), most recently replaced first. That history stays on disk for HISTORY_DAYS and recall can give it
   * to the model as what used to be true, so the user can see it and forget it. Not an earlier wording of one of
   * Ember's own notes (`reworded`): the note is listed once, as it reads now (memory-x7-4).
   */
  review(): MemoryItem[] {
    const closed = this.g.allFacts().filter(f => f.invalidAt && !reworded(this.g, f))
      .sort((a, b) => b.invalidAt!.localeCompare(a.invalidAt!) || b.id.localeCompare(a.id));
    return [...this.list(), ...closed.map(memoryItem)];
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
    if (this.unreadable) return { kind: "refused", reason: "saved memory can't be read" };
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
      // Saved again: what Settings said about the last save no longer holds.
      if (this.problem === "unsaved") { this.problem = null; this.notify(); }
    } catch (err) {
      this.o.log.warn("memory.save_failed", { err: err instanceof Error ? err.message : String(err) });
      // Settings › Memory says so (a file left as it was because it couldn't be read says that instead).
      if (this.problem !== "unreadable" && this.problem !== "unsaved") { this.problem = "unsaved"; this.notify(); }
    }
  }

  private notify(): void {
    try { this.o.onChange?.(); } catch { this.o.log.warn("memory.notice_failed"); }
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
