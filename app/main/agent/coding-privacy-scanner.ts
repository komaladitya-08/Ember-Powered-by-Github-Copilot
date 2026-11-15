/**
 * Full-content privacy checks off Ember's main thread. This is trusted computation, not an OS sandbox.
 * Only build-time worker code is evaluated; project text is never code, a path, an import or a process argument.
 * A worker is reused only by one scanner handle. Handoff, idle expiry and close destroy its source-holding heap.
 */
import { Worker } from "node:worker_threads";
import { CODING_PRIVACY_MAX_TEXT_BYTES, codingPrivacyReason, type CodingPrivacyReason, type CodingPrivacyRequest } from "./coding-privacy-protocol";

declare const __EMBER_CODING_PRIVACY_WORKER_SOURCE__: string;

const MAX_QUEUED = 8, MAX_QUEUED_BYTES = 16 * 1024 * 1024, DEADLINE_MS = 30_000, IDLE_MS = 100, CURRENT_POLL_MS = 50;
type Failure = "unavailable" | "cancelled" | "stale" | "limit" | "failed" | "timeout";
const MESSAGES: Readonly<Record<Failure, string>> = Object.freeze({
  unavailable: "The coding privacy scanner is unavailable.",
  cancelled: "The coding privacy scan was cancelled.",
  stale: "The coding privacy scan no longer belongs to the current operation.",
  limit: "The coding privacy scan admission limit was exceeded.",
  failed: "The complete coding privacy scan could not be verified.",
  timeout: "The complete coding privacy scan exceeded its deadline.",
});
export class CodingPrivacyScanError extends Error {
  readonly code: Failure;
  constructor(code: Failure) { super(MESSAGES[code]); this.name = "CodingPrivacyScanError"; this.code = code; }
}
/** An observed thread-exit failure, which the host must retain and fence rather than classify as ordinary refusal. */
export class CodingPrivacyCleanupError extends CodingPrivacyScanError {
  constructor() { super("failed"); this.name = "CodingPrivacyCleanupError"; this.message = "The coding privacy worker could not be verified as stopped."; }
}
declare const scopeBrand: unique symbol;
/** Opaque host capability. Its identity is registered locally; JSON, IDs and forged objects cannot recreate it. */
export interface CodingPrivacyScope { readonly [scopeBrand]: true }
export interface CodingPrivacyScanOptions { signal?: AbortSignal; current?: () => boolean }
interface Owner { closed: boolean; jobs: Set<Job>; scope: CodingPrivacyScope }
interface Job {
  id: number; owner: Owner; text: string | null; bytes: number; signal?: AbortSignal; current?: () => boolean;
  resolve: (value: CodingPrivacyReason | null) => void; reject: (error: CodingPrivacyScanError) => void;
  abort: () => void; timer: ReturnType<typeof setTimeout>; watch: ReturnType<typeof setInterval> | null; settled: boolean;
}
interface Thread {
  worker: Worker; owner: Owner; ready: boolean; stopping: Promise<void> | null;
  idle: ReturnType<typeof setTimeout> | null; failure: CodingPrivacyScanError | null;
}
function checked(job: Pick<Job, "owner" | "signal" | "current">): CodingPrivacyScanError | null {
  if (job.owner.closed || job.signal?.aborted) return new CodingPrivacyScanError("cancelled");
  try { if (job.current && job.current() !== true) return new CodingPrivacyScanError("stale"); }
  catch { return new CodingPrivacyScanError("stale"); }
  // A host authority callback may itself revoke the operation. Recheck synchronous cancellation before delivery.
  if (job.owner.closed || job.signal?.aborted) return new CodingPrivacyScanError("cancelled");
  return null;
}
function source(): string {
  if (typeof __EMBER_CODING_PRIVACY_WORKER_SOURCE__ !== "string" || !__EMBER_CODING_PRIVACY_WORKER_SOURCE__) throw new CodingPrivacyScanError("unavailable");
  return __EMBER_CODING_PRIVACY_WORKER_SOURCE__;
}

class PrivacyQueue {
  #generation = 0n;
  #scopes = new WeakMap<object, bigint>();
  #owners = new Set<Owner>();
  #queue: Job[] = [];
  #bytes = 0;
  #id = 0;
  #active: Job | null = null;
  #thread: Thread | null = null;
  #broken = false;
  #pumping = false;

  cleanupFailure(): CodingPrivacyCleanupError | null { return this.#broken ? new CodingPrivacyCleanupError() : null; }
  capture(): CodingPrivacyScope {
    if (this.#broken) throw new CodingPrivacyCleanupError();
    const scope = Object.freeze(Object.create(null)) as CodingPrivacyScope;
    this.#scopes.set(scope, this.#generation); return scope;
  }
  assert(scope: CodingPrivacyScope): void {
    if (this.#broken) throw new CodingPrivacyCleanupError();
    if (!scope || typeof scope !== "object" || this.#scopes.get(scope) !== this.#generation) throw new CodingPrivacyScanError("stale");
  }
  register(owner: Owner): void { this.assert(owner.scope); this.#owners.add(owner); }
  retire(): Promise<void> {
    this.#generation++;
    const owners = [...this.#owners];
    for (const owner of owners) owner.closed = true;
    const pending = owners.map(owner => this.close(owner));
    if (this.#thread) pending.push(this.#stop(this.#thread, new CodingPrivacyScanError("cancelled")));
    return Promise.all(pending).then(() => undefined);
  }
  add(owner: Owner, text: string, options: CodingPrivacyScanOptions): Promise<CodingPrivacyReason | null> {
    const unavailable = checked({ owner, signal: options.signal, current: options.current });
    if (unavailable) return Promise.reject(unavailable);
    if (this.#broken) return Promise.reject(new CodingPrivacyScanError("failed"));
    if (typeof text !== "string" || text.length > CODING_PRIVACY_MAX_TEXT_BYTES) return Promise.reject(new CodingPrivacyScanError("limit"));
    const bytes = Buffer.byteLength(text);
    if (bytes > CODING_PRIVACY_MAX_TEXT_BYTES || this.#queue.length >= MAX_QUEUED || bytes > MAX_QUEUED_BYTES - this.#bytes || this.#id >= Number.MAX_SAFE_INTEGER) return Promise.reject(new CodingPrivacyScanError("limit"));
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.#id, owner, text, bytes, signal: options.signal, current: options.current, resolve, reject,
        abort: () => this.#cancel(job, new CodingPrivacyScanError("cancelled")),
        timer: setTimeout(() => this.#cancel(job, new CodingPrivacyScanError("timeout")), DEADLINE_MS), watch: null, settled: false };
      if (job.current) {
        job.watch = setInterval(() => { const stale = checked(job); if (stale) this.#cancel(job, stale); }, CURRENT_POLL_MS);
        job.watch.unref();
      }
      job.timer.unref(); owner.jobs.add(job); this.#queue.push(job); this.#bytes += bytes;
      job.signal?.addEventListener("abort", job.abort, { once: true });
      const stale = checked(job); if (stale) this.#cancel(job, stale); else this.#pump();
    });
  }
  close(owner: Owner): Promise<void> {
    owner.closed = true; this.#owners.delete(owner);
    for (const job of [...owner.jobs]) this.#cancel(job, new CodingPrivacyScanError("cancelled"));
    return this.#thread?.owner === owner ? this.#stop(this.#thread, new CodingPrivacyScanError("cancelled")) : Promise.resolve();
  }
  #settle(job: Job, reason: CodingPrivacyReason | null, error?: CodingPrivacyScanError): void {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.timer); if (job.watch) clearInterval(job.watch); job.signal?.removeEventListener("abort", job.abort);
    job.owner.jobs.delete(job); job.text = null; job.current = undefined; job.signal = undefined;
    if (this.#active === job) this.#active = null;
    if (error) job.reject(error); else job.resolve(reason);
  }
  #cancel(job: Job, error: CodingPrivacyScanError): void {
    if (job.settled) return;
    job.text = null;
    const index = this.#queue.indexOf(job);
    if (index !== -1) { this.#queue.splice(index, 1); this.#bytes -= job.bytes; this.#settle(job, null, error); this.#pump(); }
    else if (this.#active === job && this.#thread) void this.#stop(this.#thread, error).catch(() => undefined);
  }
  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    try { this.#admit(); } finally { this.#pumping = false; }
  }
  #admit(): void {
    for (;;) {
      if (this.#active || this.#thread?.stopping || this.#broken) return;
      const next = this.#queue[0];
      if (!next) { this.#idle(); return; }
      const stale = checked(next);
      // current() may synchronously close/retire and remove this entry. Never shift or charge another job.
      if (next.settled || this.#queue[0] !== next) continue;
      if (stale) { this.#queue.shift(); this.#bytes -= next.bytes; this.#settle(next, null, stale); continue; }
      if (this.#active || this.#thread?.stopping || this.#broken) return;
      if (this.#thread && this.#thread.owner !== next.owner) { void this.#stop(this.#thread).catch(() => undefined); return; }
      this.#queue.shift(); this.#bytes -= next.bytes; this.#active = next;
      if (!this.#thread) {
        try { this.#spawn(next.owner); }
        catch (error) { this.#settle(next, null, new CodingPrivacyScanError(error instanceof CodingPrivacyScanError ? error.code : "failed")); continue; }
      }
      if (this.#thread!.idle) { clearTimeout(this.#thread!.idle); this.#thread!.idle = null; }
      if (this.#thread!.ready) this.#send(this.#thread!);
      return;
    }
  }
  #spawn(owner: Owner): void {
    const worker = new Worker(source(), { eval: true, argv: [], execArgv: [], env: {}, workerData: null,
      stdin: false, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    const thread: Thread = { worker, owner, ready: false, stopping: null, idle: null, failure: null };
    this.#thread = thread;
    worker.on("message", message => this.#message(thread, message));
    worker.on("error", () => { void this.#stop(thread, new CodingPrivacyScanError("failed")).catch(() => undefined); });
    // The fixed worker writes nothing. Never print unexpected output, which could contain project text.
    worker.stdout?.on("data", () => { void this.#stop(thread, new CodingPrivacyScanError("failed")).catch(() => undefined); });
    worker.stderr?.on("data", () => { void this.#stop(thread, new CodingPrivacyScanError("failed")).catch(() => undefined); });
    worker.on("exit", () => {
      if (this.#thread !== thread || thread.stopping) return;
      if (thread.idle) clearTimeout(thread.idle);
      this.#thread = null;
      if (this.#active) this.#settle(this.#active, null, new CodingPrivacyScanError("failed"));
      this.#pump();
    });
  }
  #send(thread: Thread): void {
    const job = this.#active;
    if (!job || this.#thread !== thread || thread.stopping) return;
    const stale = checked(job);
    if (stale) { void this.#stop(thread, stale).catch(() => undefined); return; }
    if (this.#thread !== thread || thread.stopping || this.#active !== job || job.settled || thread.owner !== job.owner) return;
    try { thread.worker.postMessage({ type: "scan", id: job.id, text: job.text! } satisfies CodingPrivacyRequest); job.text = null; }
    catch { void this.#stop(thread, new CodingPrivacyScanError("failed")).catch(() => undefined); }
  }
  #message(thread: Thread, value: unknown): void {
    if (this.#thread !== thread || thread.stopping) return;
    const message = value as Record<string, unknown> | null;
    const fail = () => { void this.#stop(thread, new CodingPrivacyScanError("failed")).catch(() => undefined); };
    if (!message || typeof message !== "object" || Array.isArray(message)) { fail(); return; }
    if (!thread.ready) {
      if (Object.keys(message).sort().join(",") !== "type,version" || message.type !== "ready" || message.version !== 1) { fail(); return; }
      thread.ready = true; this.#send(thread); return;
    }
    const job = this.#active;
    if (!job || message.type !== "result" || message.id !== job.id || Object.keys(message).sort().join(",") !== "id,reason,type" || !codingPrivacyReason(message.reason)) { fail(); return; }
    const stale = checked(job);
    if (stale) { void this.#stop(thread, stale).catch(() => undefined); return; }
    if (this.#thread !== thread || thread.stopping || this.#active !== job || job.settled || thread.owner !== job.owner) return;
    this.#settle(job, message.reason); this.#pump();
  }
  #idle(): void {
    const thread = this.#thread;
    if (thread && !thread.stopping && !thread.idle) {
      thread.idle = setTimeout(() => { void this.#stop(thread).catch(() => undefined); }, IDLE_MS); thread.idle.unref();
    }
  }
  #stop(thread: Thread, error?: CodingPrivacyScanError): Promise<void> {
    if (this.#thread !== thread) return Promise.resolve();
    if (error && !thread.failure) thread.failure = error;
    if (!thread.stopping) {
      if (thread.idle) { clearTimeout(thread.idle); thread.idle = null; }
      thread.stopping = (async () => {
        try { await thread.worker.terminate(); }
        catch {
          this.#broken = true;
          const cleanup = new CodingPrivacyCleanupError();
          if (this.#active) this.#settle(this.#active, null, cleanup);
          for (const job of this.#queue.splice(0)) this.#settle(job, null, new CodingPrivacyScanError("failed"));
          this.#bytes = 0;
          throw cleanup;
        }
        if (this.#thread === thread) {
          this.#thread = null;
          if (this.#active) this.#settle(this.#active, null, thread.failure ?? new CodingPrivacyScanError("failed"));
        }
        if (this.#broken) {
          for (const job of this.#queue.splice(0)) this.#settle(job, null, new CodingPrivacyScanError("failed"));
          this.#bytes = 0;
        } else this.#pump();
      })();
    }
    return thread.stopping;
  }
}
const queue = new PrivacyQueue();

/** Account/Forget/app-close hook, never a per-project Stop. Revoke every current handle and await worker exit. */
export function retireCodingPrivacyScanners(): Promise<void> { return queue.retire(); }
/** Capture before any source await and reuse for all child handles, including post-Stop partial export. */
export function captureCodingPrivacyScope(): CodingPrivacyScope { return queue.capture(); }
/** Check before/after filesystem awaits too: an old lease cannot bypass a retired scan generation. */
export function assertCodingPrivacyScope(scope: CodingPrivacyScope): void { queue.assert(scope); }
/** Fixed host diagnostic only; no source, scope identifier or exception contents are exposed. */
export function codingPrivacyCleanupFailure(): CodingPrivacyCleanupError | null { return queue.cleanupFailure(); }

/** A host lifetime, never model authority. Close on Stop/Forget; use a separate handle for inert partial export. */
export class CodingPrivacyScanner {
  #owner: Owner;
  #signal?: AbortSignal;
  #abort: () => void;
  #closing: Promise<void> | null = null;
  constructor(options: { signal?: AbortSignal; scope?: CodingPrivacyScope } = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new CodingPrivacyScanError("unavailable");
    this.#owner = { closed: false, jobs: new Set(), scope: options.scope ?? captureCodingPrivacyScope() };
    queue.register(this.#owner);
    this.#signal = options.signal; this.#abort = () => { void this.close().catch(() => undefined); };
    this.#signal?.addEventListener("abort", this.#abort, { once: true });
    if (this.#signal?.aborted) this.#abort();
  }
  /** Cheap authority check for path-only/binary branches which intentionally do not invoke the text guard. */
  assertCurrent(): void {
    const unavailable = checked({ owner: this.#owner, signal: this.#signal });
    if (unavailable) throw unavailable;
    queue.assert(this.#owner.scope);
  }
  refusal(text: string, options: CodingPrivacyScanOptions = {}): Promise<CodingPrivacyReason | null> {
    if (!options || typeof options !== "object" || Array.isArray(options) || (options.signal !== undefined && !(options.signal instanceof AbortSignal)) || (options.current !== undefined && typeof options.current !== "function")) return Promise.reject(new CodingPrivacyScanError("unavailable"));
    try { this.assertCurrent(); } catch (error) { return Promise.reject(error); }
    return queue.add(this.#owner, text, { signal: options.signal, current: options.current?.bind(options) });
  }
  close(): Promise<void> {
    this.#signal?.removeEventListener("abort", this.#abort);
    this.#closing ??= queue.close(this.#owner);
    return this.#closing;
  }
}
