/**
 * Element ids, as the Python sidecar hands them out (its Snapshots): integers from this process's own block
 * (EMBER_ATSPI_ID_BASE, a multiple of 10 000 000 the client gives every process), never reused, so an id from another
 * process, or from before a restart, never names an element here. The last 8 kept reads stay addressable, plus one
 * scratch read for quick looks (`keep: false`), which the next quick look replaces: quick looks never push out the
 * reads a worker acts on. Ids handed out after a read (secret_fields) go to the newest kept read.
 *
 * Each id holds the provider's handle for its element, counted (HandleRefs): a handle no read holds any more is given
 * back to the provider, so the Windows bridge's handle table doesn't fill up.
 */

import type { Handle, RawNode, RawWindow } from "./provider";
import type { RoleContext } from "./roles";
import { KeyError } from "./protocol";

/** Kept reads, as the Python sidecar keeps them. */
export const KEEP = 8;

/**
 * Where this process's ids start: after EMBER_ATSPI_ID_BASE, else after a random offset (2^20-aligned, well inside
 * JSON's safe integers), as first_id in ember_atspi.py.
 */
export function firstId(env: NodeJS.ProcessEnv = process.env, random: () => number = Math.random): number {
  const raw = env.EMBER_ATSPI_ID_BASE ?? "";
  const base = /^\s*[-+]?\d+\s*$/.test(raw) ? Number(raw) : 0;
  if (base > 0 && base <= 2 ** 50) return base + 1;
  return (Math.floor(random() * 2 ** 20) + 1) * 2 ** 20 + 1;
}

/**
 * One read of a window as the provider reported it: every element of the snapshot (listed or not), its role in AT-SPI's
 * words and its context, kept while any id from it is. Actions look at an element's surroundings here (the control a
 * click goes to, the containers that clip it) without asking the app again.
 */
export interface ReadRecord {
  window: RawWindow;
  raw: RawNode[];
  roles: string[];
  ctx: RoleContext[];
  /** The provider generation it was read in. */
  generation: number;
}

/** What an id stands for: its element's handle, and where it was read. */
export interface IdEntry { handle: Handle; read: ReadRecord; index: number }

/** How many reads and looks hold each handle; one no read holds is given back to the provider. */
export class HandleRefs {
  private counts = new Map<Handle, number>();
  private freed: Handle[] = [];

  retain(h: Handle): void {
    this.counts.set(h, (this.counts.get(h) ?? 0) + 1);
  }

  /** One holder fewer; at none it is due to be given back (see take). */
  drop(h: Handle): void {
    const n = (this.counts.get(h) ?? 0) - 1;
    if (n > 0) { this.counts.set(h, n); return; }
    this.counts.delete(h);
    this.freed.push(h);
  }

  held(h: Handle): boolean {
    return (this.counts.get(h) ?? 0) > 0;
  }

  /** The handles no longer held since the last time (each once). */
  take(): Handle[] {
    const out = [...new Set(this.freed)].filter(h => !this.held(h));
    this.freed = [];
    return out;
  }

  /** The provider restarted: its old handles mean nothing, and none is given back. */
  clear(): void {
    this.counts.clear();
    this.freed = [];
  }

  get size(): number {
    return this.counts.size;
  }
}

/** Recent reads' elements, addressable by id (Python's Snapshots). */
export class Snapshots {
  private reads: Map<number, IdEntry>[] = [];
  private scratch = new Map<number, IdEntry>();
  private current: Map<number, IdEntry> | null = null;
  private next: number;
  /** Keys of handles a read holds without an id (below zero: never an id). */
  private held = -1;

  constructor(start: number, private refs: HandleRefs) {
    this.next = start;
  }

  /** A read begins: kept (one of the last KEEP) or a quick look (replacing the last quick look). */
  begin(keep = true): void {
    if (keep) {
      this.reads.push(new Map());
      if (this.reads.length > KEEP) this.forget(this.reads.shift()!);
      this.current = this.reads[this.reads.length - 1];
    } else {
      this.forget(this.scratch);
      this.scratch = new Map();
      this.current = this.scratch;
    }
  }

  /** After a read: ids handed out later go to the newest kept read. */
  end(): void {
    this.current = this.reads.length ? this.reads[this.reads.length - 1] : null;
  }

  /** A new id for an element (into the read going on, or the newest kept one). */
  add(entry: IdEntry): number {
    const id = this.next++;
    if (!this.current) this.begin();
    this.current!.set(id, entry);
    this.refs.retain(entry.handle);
    return id;
  }

  /**
   * Keeps an element's handle with the read going on, without an id (a container an element's `shown` or a row's choice
   * is asked of again): given back with the read.
   */
  hold(entry: IdEntry): void {
    if (!this.current) this.begin();
    this.current!.set(this.held--, entry);
    this.refs.retain(entry.handle);
  }

  /** The element behind an id, newest read first, then the quick look; KeyError when no read has it. */
  get(id: number): IdEntry {
    if (!(id > 0)) throw new KeyError(`element ${id} is no longer known; read the window again`);
    for (let i = this.reads.length - 1; i >= 0; i--) {
      const e = this.reads[i].get(id);
      if (e) return e;
    }
    const e = this.scratch.get(id);
    if (e) return e;
    throw new KeyError(`element ${id} is no longer known; read the window again`);
  }

  /** The element behind an id, or undefined. */
  find(id: number): IdEntry | undefined {
    try {
      return this.get(id);
    } catch {
      return undefined; // not known: the caller skips it
    }
  }

  /** Forgets one id of the read going on (an element inside a secret field: not to be used by id either). */
  remove(id: number): void {
    const e = this.current?.get(id);
    if (!e) return;
    this.current!.delete(id);
    this.refs.drop(e.handle);
  }

  /** Every read is forgotten (the provider restarted); ids keep counting, so old ones stay unknown. */
  clear(): void {
    for (const r of this.reads) this.forget(r);
    this.forget(this.scratch);
    this.reads = [];
    this.scratch = new Map();
    this.current = null;
  }

  /** How many reads are kept (for tests and status). */
  get kept(): number {
    return this.reads.length;
  }

  private forget(read: Map<number, IdEntry>): void {
    for (const e of read.values()) this.refs.drop(e.handle);
    read.clear();
  }
}
