/** Owned stdio connection only. A transport loss is unknown shutdown, never an observed command completion. */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { decodeWslCodingMessage, wslCodingFrame, wslCodingFrameSink, WSL_CODING_MAX_PENDING, type WslCodingMethod } from "./wsl-coding-protocol";

const fail = () => new Error("The isolated WSL coding connection could not be verified.");
type Pending = { resolve(value: unknown): void; reject(error: Error): void; method: WslCodingMethod; nonce: string; output?: (bytes: Uint8Array, stream: "stdout" | "stderr") => void; bytes: number; timer: ReturnType<typeof setTimeout> };
declare const stopped: unique symbol;
export interface WslStoppedReceiptRef { readonly [stopped]: true }
const stoppedReceipts = new WeakMap<object, { connection: WslCodingConnection; episode: string; nonce: string; namespaces: number }>();
const episodes = new WeakMap<object, string>();
function kernelWitness(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "exited,kind,launched") throw fail();
  const x = value as Record<string, unknown>;
  if (x.kind !== "linux-pid-namespaces" || !Number.isInteger(x.launched) || (x.launched as number) < 0 || (x.launched as number) > 2000 || x.exited !== x.launched) throw fail();
  return x.launched as number;
}
/** A serialized object/boolean or another connection's acknowledgement cannot grant this stopped epoch. */
export function requireWslStoppedReceipt(ref: WslStoppedReceiptRef, connection: WslCodingConnection): void {
  const value = ref && typeof ref === "object" ? stoppedReceipts.get(ref) : undefined;
  if (!value || value.connection !== connection || value.episode !== episodes.get(connection)) throw fail();
}
export class WslCodingConnection {
  #child: ChildProcessWithoutNullStreams; #next = 0; #pending = new Map<number, Pending>(); #failure: Error | undefined;
  #transport = new AbortController(); #closed = false; #retired = false; #closing?: Promise<void>; #stopping?: Promise<WslStoppedReceiptRef>;
  #episode = randomBytes(16).toString("hex"); #namespaces = 0; #stopNonce?: string;
  #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    episodes.set(this, this.#episode);
    this.#exit = new Promise(resolve => child.once("close", (code, signal) => { this.#closed = true; resolve({ code, signal }); this.#break(); }));
    child.once("error", () => this.#break()); child.stdin.on("error", () => this.#break());
    child.stderr.on("data", () => undefined); // Diagnostic/error bytes stay private and never become a protocol frame.
    const { guard, sink } = wslCodingFrameSink(body => {
      const message = decodeWslCodingMessage(body, "response"), pending = this.#pending.get(message.id);
      if (!pending || message.episode !== this.#episode || message.nonce !== pending.nonce) throw fail();
      if (message.kind === "output") {
        const bytes = Buffer.from(message.base64, "base64");
        if (!pending.output || bytes.length > 64 * 1024 || bytes.toString("base64") !== message.base64 || (pending.bytes += bytes.length) > 1024 * 1024) throw fail();
        pending.output(bytes, message.stream); return;
      }
      const finish = () => { clearTimeout(pending.timer); this.#pending.delete(message.id); };
      if (message.kind === "failure") { finish(); pending.reject(fail()); }
      else if (pending.method === "run" || pending.method === "runNode") {
        if (!message.value || typeof message.value !== "object" || Array.isArray(message.value)) throw fail();
        const value = message.value as Record<string, unknown>, count = kernelWitness(value.witness);
        if (count !== this.#namespaces && count !== this.#namespaces + 1) throw fail(); this.#namespaces = count;
        const { witness: _witness, ...result } = value; finish(); pending.resolve(result);
      } else { finish(); pending.resolve(message.value); }
    }, this.#transport.signal);
    void pipeline(child.stdout, guard, sink).catch(() => this.#break());
  }
  #break(): void {
    this.#failure ??= fail(); this.#retired = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(this.#failure); }
    this.#pending.clear();
    try { this.#child.stdin.end(); } catch { /* A lost transport remains unverified even if its owned helper exits. */ }
  }
  /** Only a trusted host factory receives this connection. It is never exposed through a model or renderer. */
  call(method: WslCodingMethod, params: Record<string, unknown> = {}, options: {
    output?: (bytes: Uint8Array, stream: "stdout" | "stderr") => void; timeoutMs?: number;
  } = {}): Promise<unknown> {
    if (this.#failure || this.#closed || this.#retired && !["stop", "sealFiles", "snapshot", "close"].includes(method) || this.#pending.size >= WSL_CODING_MAX_PENDING || this.#next >= 2000) return Promise.reject(this.#failure ?? fail());
    const id = ++this.#next, nonce = randomBytes(16).toString("hex"), timeout = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 20 * 60_000) return Promise.reject(fail());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#break(); }, timeout); timer.unref?.();
      this.#pending.set(id, { resolve, reject, method, nonce, output: options.output, bytes: 0, timer });
      if (method === "stop") this.#stopNonce = nonce;
      try { this.#child.stdin.write(wslCodingFrame({ episode: this.#episode, nonce, id, method, params })); } catch { this.#break(); }
    });
  }
  /** Positive acknowledgement comes only from the helper after the Linux namespace exit proof. */
  stop(): Promise<WslStoppedReceiptRef> {
    this.#retired = true;
    this.#stopping ??= this.call("stop").then(value => {
      if (this.#failure || !this.#stopNonce || !value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "stopped,witness" || (value as { stopped?: unknown }).stopped !== true) throw fail();
      const witness = (value as { witness?: unknown }).witness;
      if (!witness || typeof witness !== "object" || Object.keys(witness).sort().join(",") !== "drained,epoch,exited,kind,launched,sealed") throw fail();
      const { epoch, sealed, drained, ...counts } = witness as Record<string, unknown>;
      if (epoch !== 1 || sealed !== true || drained !== true || kernelWitness(counts) !== this.#namespaces ||
          [...this.#pending.values()].some(p => !["stop", "sealFiles", "snapshot", "close", "hello"].includes(p.method))) throw fail();
      const ref = Object.freeze({}) as WslStoppedReceiptRef;
      stoppedReceipts.set(ref, { connection: this, episode: this.#episode, nonce: this.#stopNonce, namespaces: this.#namespaces }); return ref;
    });
    return this.#stopping;
  }
  /** A successful close includes the exact cleanup reply and unforced process exit 0 with all stdio closed. */
  close(): Promise<void> {
    this.#retired = true;
    this.#closing ??= (async () => {
      const result = await this.call("close");
      if (!result || typeof result !== "object" || Object.keys(result).sort().join(",") !== "cleanup,closed" ||
          (result as { closed?: unknown }).closed !== true || (result as { cleanup?: unknown }).cleanup !== "complete") throw fail();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const exit = await Promise.race([this.#exit, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(fail()), 5000); })]);
        if (exit.code !== 0 || exit.signal !== null) throw fail();
      } finally { clearTimeout(timer); }
      this.#transport.abort();
    })(); return this.#closing;
  }
}
