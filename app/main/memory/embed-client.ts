/**
 * Main's side of Ember's memory process (./embed-process.ts): an Embedder (./embed.ts) that starts the process on
 * first use, loads the model there, and ends it once nothing has asked for a vector in IDLE_MS, so the model's memory
 * (300 to 400 MB) is held only while memory is in use. A stop (the kill switch) ends it at once; work in flight fails,
 * and the next request starts it again.
 *
 * A process that fails to load the model, or dies, is started again on the next request, up to MAX_FAILURES times a
 * session; after that recall stays lexical until Ember restarts. Plain Node: main injects how the process starts
 * (Electron's utilityProcess.fork), and tests a fake.
 */

import type { Embedder, SemanticLog } from "./embed";
import type { EmbedIn, EmbedOut } from "./embed-process";

/** How long the process lives with nothing to do (ms). */
export const IDLE_MS = 5 * 60_000;
/** Load failures or crashes a session before the model is given up on. */
export const MAX_FAILURES = 3;
/**
 * The longest one request may take (ms), loading the model included: a batch of 16 facts took under a second and a
 * cold load under 2 s on a busy 4-vCPU machine, so this is only for a process that hangs.
 */
export const REQUEST_MS = 30_000;

/** The process, as main started it. */
export interface EmbedChild {
  postMessage(m: EmbedIn): void;
  onMessage(fn: (m: EmbedOut) => void): void;
  onExit(fn: (code: number | null) => void): void;
  kill(): void;
}

export interface EmbedClientOptions {
  spawn: () => EmbedChild;
  /** The model's files, while it is in place; null otherwise (nothing is started). */
  paths: () => { model: string; vocab: string } | null;
  log: SemanticLog;
  idleMs?: number;
  /** How long one request may take (ms; default REQUEST_MS). */
  requestMs?: number;
}

interface Pending { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }

export class EmbedClient implements Embedder {
  private child: EmbedChild | null = null;
  private ready = false;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  constructor(private o: EmbedClientOptions) {}

  /** Whether the model is loaded in a running process now. */
  get loaded(): boolean { return !!this.child && this.ready; }

  embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (!texts.length) return Promise.resolve([]);
    const child = this.start();
    if (!child) return Promise.reject(new Error("the memory model isn't available"));
    const id = this.nextId++;
    const done = new Promise<Float32Array[]>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    // A process that stops answering (hung in the model) is ended, as one that died: the next request starts another.
    const timer = setTimeout(() => {
      if (!this.pending.has(id) || this.child !== child) return;
      this.failures++;
      this.o.log.warn("memory.process_timeout", { ms: this.o.requestMs ?? REQUEST_MS, failures: this.failures });
      this.end(new Error("the memory process didn't answer"));
    }, this.o.requestMs ?? REQUEST_MS);
    timer.unref?.();
    const clear = () => clearTimeout(timer);
    done.then(clear, clear);
    child.postMessage({ type: "embed", id, texts: [...texts] });
    this.rest();
    return done;
  }

  warm(): void {
    if (this.start()) this.rest();
  }

  stop(): void {
    this.end(new Error("stopped"));
  }

  /** The running process, started (and told to load the model) if there is none; null if it can't be. */
  private start(): EmbedChild | null {
    if (this.child) return this.child;
    if (this.failures >= MAX_FAILURES) return null;
    const paths = this.o.paths();
    if (!paths) return null;
    let child: EmbedChild;
    try {
      child = this.o.spawn();
    } catch (err) {
      this.failures++;
      this.o.log.warn("memory.process_failed", { err: err instanceof Error ? err.message : String(err) });
      return null;
    }
    this.child = child;
    this.ready = false;
    child.onMessage(m => {
      if (this.child !== child) return;
      if ("type" in m) {
        if (m.type === "ready") { this.ready = true; this.failures = 0; this.o.log.info("memory.model_loaded", { loadMs: m.loadMs }); return; }
        this.failures++;
        this.o.log.warn("memory.model_failed", { message: m.message, failures: this.failures });
        this.end(new Error(`the memory model didn't load: ${m.message}`));
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.vectors) p.resolve(m.vectors);
      else p.reject(new Error(m.error ?? "no vectors"));
    });
    child.onExit(code => {
      if (this.child !== child) return;
      this.failures++;
      this.o.log.warn("memory.process_exit", { code, failures: this.failures });
      this.child = null;
      this.reject(new Error("the memory process ended"));
    });
    child.postMessage({ type: "init", ...paths });
    return child;
  }

  /** Ends the process after IDLE_MS with nothing pending. */
  private rest(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.idle = null;
      if (this.pending.size) { this.rest(); return; }
      if (this.child) this.o.log.info("memory.process_idle");
      this.end(new Error("idle"));
    }, this.o.idleMs ?? IDLE_MS);
    this.idle.unref?.();
  }

  private end(why: Error): void {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
    }
    this.reject(why);
  }

  private reject(why: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(why);
  }
}
