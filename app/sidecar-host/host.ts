/**
 * The sidecar host: answers Ember's accessibility protocol (the Python AT-SPI sidecar's methods, shapes and wording)
 * from an AxProvider's raw facts. One request at a time, like the Python sidecar, so a request's provider calls never
 * interleave with another's. Around every request it keeps the provider's handles in check: a handle no read holds is
 * given back at the end of the request, and when the provider restarted (its handles mean nothing now) every read is
 * forgotten, so an id from before can only be "no longer known", never another element.
 */

import { HandleRefs, Snapshots, firstId, type ReadRecord } from "./ids";
import { isProviderError, type AxProvider, type Handle, type RawNode, type RawWindow } from "./provider";
import { BUSY, BusyError, KeyError, encodeError, encodeResult, parseRequest } from "./protocol";
import { TOP, atspiRole, type RoleContext } from "./roles";
import { Secrets, type WireKey } from "./secrets";
import { KnownWindows } from "./windows";
import { READING } from "./reading";
import { ACTING } from "./actions";

/** A protocol method: params in, result out (errors carry the protocol's wording). */
export type Method = (host: Host, params: Record<string, unknown>) => Promise<unknown>;

/** Every method the Python sidecar answers. */
export const METHODS: Record<string, Method> = { ...READING, ...ACTING };

/**
 * Methods answered without the provider, so without waiting for it to start: ping, and remember_secrets, which Ember
 * sends ahead of a new process's first request without waiting for its answer. Were it to wait out a cold start of the
 * Windows bridge, the request Ember does wait on would be left only part of its first-request time, and a start
 * slower than that would be killed and begun again in a loop.
 */
const WITHOUT_PROVIDER = new Set(["ping", "remember_secrets"]);

export interface HostOptions {
  env?: NodeJS.ProcessEnv;
  /** How long toolkits get to apply a change before it is read back (80 ms, as the Python sidecar waits). */
  settleMs?: number;
  /** Notes for the log (stderr): events and sizes, never screen text. */
  note?: (event: string, fields?: Record<string, unknown>) => void;
}

export class Host {
  readonly refs = new HandleRefs();
  readonly snapshots: Snapshots;
  readonly secrets = new Secrets();
  readonly known = new KnownWindows();
  readonly settleMs: number;
  readonly note: (event: string, fields?: Record<string, unknown>) => void;
  private generation: number;
  /** Handles the provider gave out during the request going on. */
  private seen = new Set<Handle>();

  constructor(readonly provider: AxProvider, o: HostOptions = {}) {
    this.snapshots = new Snapshots(firstId(o.env ?? process.env), this.refs);
    this.settleMs = o.settleMs ?? 80;
    this.note = o.note ?? (() => undefined);
    this.generation = provider.generation;
  }

  get vocabulary(): "uia" | "ax" { return this.provider.vocabulary; }

  /** Answers one request line (null for a blank line): never throws. */
  async handle(line: string): Promise<string | null> {
    if (!line.trim()) return null;
    let id: unknown = null;
    try {
      const req = parseRequest(line);
      id = req.id;
      return encodeResult(id, await this.call(req.method, req.params));
    } catch (err) {
      return encodeError(id, this.wording(err));
    }
  }

  /** Runs one method (the provider started first, except for WITHOUT_PROVIDER's), then gives back the handles it left. */
  async call(method: unknown, params: Record<string, unknown>): Promise<unknown> {
    const run = typeof method === "string" && Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : undefined;
    if (!run) throw new KeyError(`unknown method: ${typeof method === "string" ? method : String(method)}`);
    if (WITHOUT_PROVIDER.has(method as string)) return run(this, params);
    try {
      await this.provider.start();
      this.sync();
      return await run(this, params);
    } finally {
      this.finish();
    }
  }

  /** The protocol's words for an error (a provider's busy is the BUSY text; one it can't say is "failed"). */
  wording(err: unknown): string {
    if (isProviderError(err, "busy")) return BUSY;
    if (err instanceof Error) return err.message;
    return String(err);
  }

  /** The provider restarted since the last request: none of its handles from before means anything now. */
  private sync(): void {
    if (this.provider.generation === this.generation) return;
    this.note("host.provider_restarted", { generation: this.provider.generation, reads: this.snapshots.kept });
    this.generation = this.provider.generation;
    this.snapshots.clear();
    this.refs.clear();
    this.seen.clear();
  }

  /**
   * The request is over: handles no read holds go back to the provider. (When it restarted during the request, those it
   * gave out before are the provider's to ignore; those it gave out since still go back.)
   */
  private finish(): void {
    const free = new Set(this.refs.take());
    for (const h of this.seen) if (!this.refs.held(h)) free.add(h);
    this.seen.clear();
    if (!free.size) return;
    try {
      this.provider.release([...free]);
    } catch (err) {
      this.note("host.release_failed", { count: free.size, error: this.wording(err) });
    }
  }

  /** Notes handles the provider gave out (given back at the end of the request unless a read holds them). */
  see<T extends { handle: Handle } | null | undefined>(x: T | T[]): void {
    // (A window whose app is busy comes with no handle: 0.)
    for (const n of Array.isArray(x) ? x : [x]) if (n && n.handle > 0) this.seen.add(n.handle);
  }

  /** The top-level windows (their handles noted). */
  async windows(): Promise<RawWindow[]> {
    const ws = await this.provider.topWindows();
    this.see(ws);
    return ws;
  }

  /** An element as it is now: null when it is gone; BusyError when its app didn't answer in time. */
  async look(h: Handle): Promise<RawNode | null> {
    try {
      const n = await this.provider.element(h);
      this.see(n);
      return n && !n.gone ? n : null;
    } catch (err) {
      if (isProviderError(err, "busy")) throw new BusyError();
      if (isProviderError(err, "gone")) return null;
      throw err;
    }
  }

  /** An element's children as they are now (none when it is gone). */
  async children(h: Handle, max: number): Promise<RawNode[]> {
    try {
      const kids = await this.provider.children(h, max);
      this.see(kids);
      return kids;
    } catch (err) {
      if (isProviderError(err, "busy")) throw new BusyError();
      if (isProviderError(err, "gone")) return [];
      throw err;
    }
  }

  /** An element's key on the wire. */
  keyOf(n: Pick<RawNode, "key"> | null | undefined): WireKey | null {
    return n ? Secrets.key(this.provider.kind, n) : null;
  }

  /** An element's role in AT-SPI's words, where it sits (`ctx`). */
  roleOf(n: RawNode, ctx: RoleContext = TOP): string {
    return atspiRole(this.vocabulary, n, ctx);
  }

  /** Is the window `read` was taken in the one the user is in now (null: it can't be told, or it is gone)? */
  async windowActive(read: ReadRecord): Promise<boolean | null> {
    try {
      const w = (await this.windows()).find(x => x.key === read.window.key);
      return w ? !!w.active : null;
    } catch {
      return null; // can't be told
    }
  }

  /** Waits for the toolkit to apply a change before it is read back. */
  settle(): Promise<void> {
    return new Promise(r => setTimeout(r, this.settleMs));
  }
}
