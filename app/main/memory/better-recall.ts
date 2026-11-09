/**
 * Better recall as main wires it (docs/MEMORY.md §2): the memory model's download, its memory process, and the vector
 * side of memory (./embed.ts), behind Settings › Memory's one-line prompt.
 *
 * - Nothing is fetched until the user clicks Download there, and only while memory is on (its own consent) and the
 *   organisation allows memory (`features.memory`). The click is the agreement, as for the speech models: the files
 *   are pinned by SHA-256 (app/voice/models.ts MEMORY_MODEL), come from that one address, and are used only once they
 *   verify.
 * - The model is used only while memory is on; Remove deletes it and the vectors made with it.
 * - The process (dist/app/memory-embed.cjs, "Ember memory") is started by main's `fork`; plain Node here.
 */

import type { Downloader } from "../../voice/models";
import { MEMORY_MODEL, MEMORY_MODEL_BYTES, ensureMemoryModel, memoryModelPaths, memoryModelReady, removeMemoryModel } from "../../voice/models";
import { EmbedClient, type EmbedChild } from "./embed-client";
import { SemanticMemory, type SemanticLog } from "./embed";

/** What Settings › Memory shows: whether the model is here, coming, or can't be had. */
export interface MemoryModelStatus {
  /** absent: not downloaded; downloading; ready; off: memory is off or the organisation turned it off. */
  state: "absent" | "downloading" | "ready" | "off";
  bytes: number;
  /** While downloading: bytes so far. */
  done?: number;
  /** Why the last download failed: it didn't match its pin, or it didn't finish (Home's copy.ts words it). */
  failed?: "checksum" | "network";
}

export interface BetterRecallOptions {
  /** Ember's data folder: memory-vectors.json goes here. */
  dir: string;
  /** The user's models folder (the speech models' `userRoot`). */
  modelsRoot: string;
  log: SemanticLog;
  /** Starts the memory process. */
  fork: () => EmbedChild;
  download: Downloader;
  /** Memory is on, agreed to, allowed by the organisation, and open for the verified account. */
  memoryOn: () => boolean;
  /**
   * Memory is on, agreed to and allowed, whether or not its account is being checked again (a reconnect): a download
   * under way finishes then, and only the model's use waits (memory-8). `memoryOn` when absent.
   */
  memoryWanted?: () => boolean;
  /** The status changed (Settings is told). */
  onStatus?: (s: MemoryModelStatus) => void;
  /** The model came: what is remembered gets its vectors. */
  onReady?: () => void;
}

export class BetterRecall {
  readonly semantic: SemanticMemory;
  private present: boolean;
  private fetching: Promise<void> | null = null;
  private done = 0;
  private failed: MemoryModelStatus["failed"];
  /** Cancels the download under way (memory turned off). */
  private cancel: AbortController | null = null;
  /** Memory was on at the last settings change. */
  private wasOn: boolean;

  constructor(private o: BetterRecallOptions) {
    this.present = memoryModelReady(o.modelsRoot);
    this.wasOn = o.memoryOn();
    const client = new EmbedClient({ spawn: o.fork, paths: () => (this.present ? memoryModelPaths(o.modelsRoot) : null), log: o.log });
    this.semantic = new SemanticMemory({ dir: o.dir, log: o.log, embedder: client, model: () => (this.present && o.memoryOn() ? MEMORY_MODEL[0].sha256 : null) });
  }

  status(): MemoryModelStatus {
    if (!this.o.memoryOn() && !this.fetching) return { state: "off", bytes: MEMORY_MODEL_BYTES };
    if (this.fetching) return { state: "downloading", bytes: MEMORY_MODEL_BYTES, done: this.done };
    if (this.present) return { state: "ready", bytes: MEMORY_MODEL_BYTES };
    return { state: "absent", bytes: MEMORY_MODEL_BYTES, ...(this.failed ? { failed: this.failed } : {}) };
  }

  /** The user clicked Download: fetches and verifies the model (refused while memory is off). */
  download(): Promise<void> {
    if (!this.o.memoryOn()) return Promise.reject(new Error("Turn on memory first."));
    if (this.present) return Promise.resolve();
    if (this.fetching) return this.fetching;
    this.done = 0;
    this.failed = undefined;
    let shown = -1;
    const cancel = new AbortController();
    this.cancel = cancel;
    this.o.log.info("memory.model_fetching", { bytes: MEMORY_MODEL_BYTES });
    const run = ensureMemoryModel(this.o.modelsRoot, this.o.download, done => {
      this.done = done;
      // Settings hears of it every 5% (a download's every chunk would flood it).
      const step = Math.floor((done / MEMORY_MODEL_BYTES) * 20);
      if (step !== shown) { shown = step; this.changed(); }
    }, cancel.signal).then(() => {
      this.present = true;
      this.o.log.info("memory.model_ready", { bytes: MEMORY_MODEL_BYTES });
      this.o.onReady?.();
    }, (err: unknown) => {
      if (cancel.signal.aborted) { this.o.log.info("memory.model_download_cancelled"); return; }
      this.failed = /checksum/.test(String(err)) ? "checksum" : "network";
      this.o.log.warn("memory.model_download_failed", { err: err instanceof Error ? err.message : String(err) });
    }).finally(() => { this.fetching = null; this.cancel = null; this.changed(); });
    this.fetching = run;
    this.changed();
    return run;
  }

  /** Remove: the model's files and every vector made with it go; recall is lexical again. */
  remove(): void {
    this.semantic.stop();
    this.semantic.forgetAll();
    this.present = false;
    try {
      removeMemoryModel(this.o.modelsRoot);
    } catch (err) {
      this.o.log.warn("memory.model_remove_failed", { err: err instanceof Error ? err.message : String(err) });
      this.present = memoryModelReady(this.o.modelsRoot);
    }
    this.o.log.info("memory.model_removed");
    this.changed();
  }

  /** Memory was turned on or off, or the policy changed: Settings shows it, and turning on catches the index up. */
  settingsChanged(): void {
    // Turned off (or not allowed): a download under way is cancelled, as nothing is fetched while memory is off. Only
    // waiting for the account to be checked again lets it finish (memory-8).
    if (!(this.o.memoryWanted ?? this.o.memoryOn)()) this.cancel?.abort();
    const on = this.o.memoryOn();
    if (on === this.wasOn) return;
    this.wasOn = on;
    // Not open: the model stops until it is.
    if (!on) this.semantic.stop();
    else if (this.present) this.o.onReady?.();
    this.changed();
  }

  /** Whether the model's files are in place (for the setup check and logs). */
  get ready(): boolean { return this.present; }

  private changed(): void {
    this.o.onStatus?.(this.status());
  }
}
