/**
 * Better recall (docs/MEMORY.md §2, step 8): each remembered fact as a vector from a small sentence-embedding model
 * (./embed-model.ts), so a question finds facts that mean what it asks even when they share no word with it ("my
 * manager" → "Priya leads the platform team"). A question's best matches feed recall (./recall.ts) as seeds of its
 * walk and as a score of their own; lexical matching and the walk still do the rest.
 *
 * - The model runs in Ember's memory process (./embed-process.ts) through an `Embedder`; main only searches.
 * - Vectors are derived from facts, so they follow the facts' rules: kept only on this computer, in
 *   memory-vectors.json (0600, written atomically, a broken file moved aside), next to memory.json; a forgotten fact's
 *   vector goes with it, "Forget everything" and sign-out delete the file, and a refused fact never reaches the index
 *   (it never reaches the graph).
 * - Each vector is keyed by its fact's id and a hash of the text it was made from, and the file by the model's
 *   SHA-256: a changed fact is embedded again, and a new model rebuilds the index.
 * - Search is brute force over unit vectors (a dot product each): 5,000 facts take about 3 ms (measured on a busy
 *   4-vCPU machine).
 * - With no model (not downloaded, memory off, or it failed), `seeds()` gives nothing, and recall is exactly lexical.
 *
 * Plain Node: no Electron (main injects the process).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Fact, MemoryGraph } from "./graph";
import { SEMANTIC_FLOOR } from "./recall";
import { nameKey } from "./text";

/** Turns texts into unit-length vectors (the memory process, or a fake in tests). */
export interface Embedder {
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  /** Ends any work in flight (its promises reject) and lets the model go. */
  stop(): void;
  /** Starts loading the model, if it isn't (a request is likely soon). */
  warm?(): void;
}

/** How many facts a question's vector search hands recall (its seeds). */
export const SEMANTIC_K = 8;

/**
 * How long a question waits for its vector (ms) before recall goes on without it: loading the model took 1.1 to 1.8 s
 * on a busy 4-vCPU machine, and opening Ask or the wake word starts it early.
 */
export const QUERY_WAIT_MS = 1500;
/** Facts embedded in one request to the process, so a stop or a forget is heard between batches. */
const BATCH = 16;
/** How long after a change the index catches up (ms): a burst of remembering is one pass. */
export const INDEX_DELAY_MS = 2000;

/** The words a fact's vector is made from: its sentence, then the names of what it is about (not the user's own). */
export function documentText(graph: MemoryGraph, f: Fact): string {
  const names = f.entities.flatMap(id => {
    const e = graph.entity(id);
    return e && nameKey(e.name) !== "user" ? [e.name, ...e.aliases] : [];
  });
  return names.length ? `${f.text} (${[...new Set(names)].join(", ")})` : f.text;
}

const hashOf = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/** A fact's vector, stored as int8 with its scale (a quarter of the size; cosines move by under 0.002). */
const RowSchema = z.object({ id: z.string().min(1).max(40), h: z.string().length(16), s: z.number().positive(), v: z.string().min(1).max(4096) });
const VectorDataSchema = z.object({ version: z.literal(1), model: z.string().length(64), dim: z.number().int().min(1).max(4096), rows: z.array(RowSchema).max(20_000) });

/** Unit vectors by fact id, each with the hash of the text it was made from. */
export class VectorIndex {
  private rows = new Map<string, { hash: string; v: Float32Array }>();
  constructor(readonly model: string) {}

  get size(): number { return this.rows.size; }
  ids(): string[] { return [...this.rows.keys()]; }
  /** Made from exactly this text (`hash` of documentText). */
  has(id: string, hash: string): boolean { return this.rows.get(id)?.hash === hash; }
  set(id: string, hash: string, v: Float32Array): void { this.rows.set(id, { hash, v }); }
  delete(id: string): boolean { return this.rows.delete(id); }
  clear(): void { this.rows.clear(); }

  /** The `k` facts most like `q` (a unit vector), at least `floor` alike: fact id → cosine, best first. */
  search(q: Float32Array, k = SEMANTIC_K, floor = SEMANTIC_FLOOR): Map<string, number> {
    const best: { id: string; s: number }[] = [];
    for (const [id, { v }] of this.rows) {
      if (v.length !== q.length) continue;
      let s = 0;
      for (let i = 0; i < v.length; i++) s += v[i] * q[i];
      if (s < floor || (best.length >= k && s <= best[best.length - 1].s)) continue;
      best.push({ id, s });
      best.sort((a, b) => b.s - a.s || a.id.localeCompare(b.id));
      if (best.length > k) best.pop();
    }
    return new Map(best.map(b => [b.id, b.s]));
  }

  toJSON(): z.infer<typeof VectorDataSchema> {
    const first = this.rows.values().next().value;
    return {
      version: 1, model: this.model, dim: first?.v.length ?? 1,
      rows: [...this.rows].map(([id, { hash, v }]) => {
        let max = 0;
        for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]));
        const s = max / 127 || 1;
        const q = new Int8Array(v.length);
        for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i] / s);
        return { id, h: hash, s, v: Buffer.from(q.buffer, q.byteOffset, q.byteLength).toString("base64") };
      }),
    };
  }

  static fromJSON(data: unknown): VectorIndex {
    const d = VectorDataSchema.parse(data);
    const index = new VectorIndex(d.model);
    for (const r of d.rows) {
      const raw = Buffer.from(r.v, "base64");
      if (raw.length !== d.dim) throw new Error("a vector has the wrong length");
      const q = new Int8Array(raw.buffer, raw.byteOffset, raw.length);
      const v = Float32Array.from(q, x => x * r.s);
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < v.length; i++) v[i] /= norm;
      index.set(r.id, r.h, v);
    }
    return index;
  }
}

export interface VectorFile {
  /** The vectors made by `model`, or none (none kept yet, another model's, or a broken file, which is moved aside). */
  load(model: string): VectorIndex;
  save(index: VectorIndex): void;
  /** Removes one fact's vector from the file, whichever model made it (a fact forgotten while the model isn't in use). */
  drop(id: string): void;
  /** Deletes the file (and any broken copy): "Forget everything", sign-out. */
  erase(): void;
  readonly path: string;
}

/** memory-vectors.json in `dir`, as ./store.ts keeps memory.json: 0600, whole or not at all. */
export function vectorFile(dir: string, onBroken?: (err: unknown) => void): VectorFile {
  const file = path.join(dir, "memory-vectors.json");
  return {
    path: file,
    load(model) {
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        // None kept yet.
        return new VectorIndex(model);
      }
      try {
        const index = VectorIndex.fromJSON(JSON.parse(raw));
        // Another model's vectors mean nothing to this one: the index is made again (and the file replaced).
        return index.model === model ? index : new VectorIndex(model);
      } catch (err) {
        try { fs.renameSync(file, `${file}.broken`); } catch { /* left where it is: save() will replace it */ }
        onBroken?.(err);
        return new VectorIndex(model);
      }
    },
    save(index) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(index.toJSON()) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    drop(id) {
      let index: VectorIndex;
      try {
        index = VectorIndex.fromJSON(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch (err) {
        // Only absence is success. Unreadable or corrupt vectors may still contain the forgotten fact.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      if (!index.delete(id)) return;
      if (index.size) this.save(index);
      else this.erase();
    },
    erase() {
      for (const f of [file, `${file}.tmp`, `${file}.broken`]) fs.rmSync(f, { force: true });
    },
  };
}

export interface SemanticLog { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void }

export interface SemanticMemoryOptions {
  dir: string;
  log: SemanticLog;
  /** The model's SHA-256 while it may be used (downloaded and verified, memory on, the admin allows memory), else null. */
  model: () => string | null;
  embedder: Embedder;
  file?: VectorFile;
  /** How long a question waits for its vector (ms; default QUERY_WAIT_MS). */
  waitMs?: number;
  /** How long after a change the index catches up (ms; default INDEX_DELAY_MS). */
  indexDelayMs?: number;
}

/**
 * The vector side of memory, as MemoryService uses it: keeps the index up to date with the graph in the background,
 * and finds a question's best matches. Every failure leaves recall lexical, as it was without the model.
 */
export class SemanticMemory {
  private index: VectorIndex | null = null;
  private file: VectorFile;
  private graph: MemoryGraph | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  /** Something changed while a pass ran: another follows it. */
  private again = false;
  /** Bumped by stop(), erasure and replacement graphs: a pass reading the old graph cannot publish a batch. */
  private generation = 0;

  constructor(private o: SemanticMemoryOptions) {
    this.file = o.file ?? vectorFile(o.dir, err => o.log.warn("memory.vectors_broken", { err: err instanceof Error ? err.message : String(err) }));
  }

  /** The index for the model in use, loaded on first use; null while there is none to use. */
  private current(): VectorIndex | null {
    const model = this.o.model();
    if (!model) return null;
    if (this.index?.model !== model) {
      this.index = this.file.load(model);
      this.pruneStale(this.index);
    }
    return this.index;
  }

  /** The vectors for this many facts are kept now (0 while there is no model). */
  get size(): number { return this.current()?.size ?? 0; }

  /** The graph changed: the index catches up soon, in the background (nothing happens while there is no model). */
  changed(graph: MemoryGraph): void {
    if (this.graph !== graph) this.generation++;
    this.graph = graph;
    if (this.index) this.pruneStale(this.index);
    if (!this.o.model() || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.catchUp(); }, this.o.indexDelayMs ?? INDEX_DELAY_MS);
    this.timer.unref?.();
  }

  /** A changed sentence's old vector cannot seed recall while its replacement is still being embedded. */
  private pruneStale(index: VectorIndex): void {
    if (!this.graph) return;
    let dropped = false;
    for (const id of index.ids()) {
      const fact = this.graph.fact(id);
      if (!fact || !index.has(id, hashOf(documentText(this.graph, fact)))) { index.delete(id); dropped = true; }
    }
    if (dropped) this.saveSoon();
  }

  /** Removes a fact's persisted vector before acknowledging deletion, even with the model off. */
  forget(id: string): void {
    if (this.index) {
      const next = VectorIndex.fromJSON(this.index.toJSON());
      next.delete(id);
      if (next.size) this.file.save(next);
      else this.file.erase();
      this.generation++;
      this.clearTimers();
      this.index = next;
    } else {
      this.file.drop(id);
      this.generation++;
      this.clearTimers();
    }
  }

  /** Clears the index and cancels in-flight work only after its file is successfully erased. */
  forgetAll(): void {
    this.file.erase();
    this.generation++;
    this.clearTimers();
    this.index?.clear();
    this.graph = null;
  }

  /**
   * A request may come soon: the model starts loading if it isn't. Not while there is none to use, nor while no fact
   * has a vector yet (a question would be compared with nothing; a change starts the model when it has work).
   */
  warm(): void {
    if (this.current()?.size) this.o.embedder.warm?.();
  }

  /**
   * The facts most like `query` (fact id → cosine), for recall's `semantic`; undefined while there is no model, the
   * index is empty, or the question's vector didn't come in time (recall is then lexical).
   */
  async seeds(query: string): Promise<Map<string, number> | undefined> {
    const index = this.current();
    if (!index?.size || !query.trim()) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), this.o.waitMs ?? QUERY_WAIT_MS); });
    try {
      const got = await Promise.race([this.o.embedder.embed([query]), late]);
      if (!got) { this.o.log.info("memory.semantic_late", { waitMs: this.o.waitMs ?? QUERY_WAIT_MS }); return undefined; }
      // The model changed or was removed meanwhile: its vector means nothing to this index.
      if (this.current() !== index) return undefined;
      return index.search(got[0]);
    } catch (err) {
      this.o.log.warn("memory.semantic_failed", { err: err instanceof Error ? err.message : String(err) });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The kill switch: indexing stops, and the model process with it (the next change or question starts it again). */
  stop(): void {
    this.generation++;
    // What is pending is written first: a fact forgotten just before the stop must not keep its vector on disk.
    this.flush();
    this.clearTimers();
    this.o.embedder.stop();
  }

  /** Writes what is pending (quit). */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  /** Embeds the facts the index lacks or has an old text for, and drops the vectors of facts no longer there. */
  catchUp(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    const run = this.pass().finally(() => {
      if (this.running !== run) return;
      this.running = null;
      if (this.again) { this.again = false; void this.catchUp(); }
    });
    this.running = run;
    return run;
  }

  private async pass(): Promise<void> {
    const gen = this.generation;
    const graph = this.graph;
    const index = this.current();
    if (!graph || !index) return;
    const facts = new Map(graph.allFacts().map(f => [f.id, f]));
    let dropped = 0;
    for (const id of index.ids()) if (!facts.has(id)) { index.delete(id); dropped++; }
    const todo = [...facts.values()].map(f => ({ id: f.id, text: documentText(graph, f) })).map(t => ({ ...t, hash: hashOf(t.text) })).filter(t => !index.has(t.id, t.hash));
    let added = 0;
    const started = Date.now();
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      let vectors: Float32Array[];
      try {
        vectors = await this.o.embedder.embed(batch.map(t => t.text));
      } catch (err) {
        if (gen === this.generation) this.o.log.warn("memory.index_failed", { err: err instanceof Error ? err.message : String(err), added });
        break;
      }
      if (gen !== this.generation || this.current() !== index) return;
      batch.forEach((t, j) => {
        // Forgotten, or changed, while it was being embedded: not kept (the next pass embeds the new text).
        const f = graph.fact(t.id);
        if (f && hashOf(documentText(graph, f)) === t.hash && vectors[j]) { index.set(t.id, t.hash, vectors[j]); added++; }
      });
    }
    if (added || dropped) {
      this.o.log.info("memory.indexed", { added, dropped, size: index.size, ms: Date.now() - started });
      this.saveSoon();
    }
  }

  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 1000);
    this.saveTimer.unref?.();
  }

  private save(): void {
    if (!this.index) return;
    try {
      if (this.index.size) this.file.save(this.index);
      else this.file.erase();
    } catch (err) {
      this.o.log.warn("memory.vectors_save_failed", { err: err instanceof Error ? err.message : String(err) });
    }
  }

  private clearTimers(): void {
    this.again = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
  }
}
