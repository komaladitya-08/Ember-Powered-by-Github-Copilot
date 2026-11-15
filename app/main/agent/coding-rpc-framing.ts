/**
 * Pre-SDK Content-Length framing limits for a dedicated coding runtime's stdio. The pinned SDK 1.0.21 uses
 * vscode-jsonrpc's StreamMessageReader/Writer; its writer emits one Content-Length header and CRLF CRLF.
 *
 * This guard parses no JSON and trusts no RPC method. It bounds each declared frame before forwarding its header,
 * never allocates the declared body size, and preserves byte payloads. Use exactly two guards with pipe/pipeline
 * sources that honor backpressure. Per guard, retained parser memory is one header plus one bounded input/output
 * chunk and the configured Node stream high-water marks. This does not bound the SDK's decoded object expansion,
 * pending handlers, OS pipe buffers, or a caller that ignores Writable.write(false). It is not OS isolation.
 */
import { Transform, type TransformCallback } from "node:stream";

export interface CodingRpcFramingLimits {
  headerBytes: number;
  bodyBytes: number;
  frames: number;
  /** Cumulative admitted wire bytes, including each complete declared body and its header. */
  totalBytes: number;
  chunkBytes: number;
  bufferBytes: number;
  /** Elapsed time to assemble one frame, including time blocked by a slow downstream. */
  frameMs: number;
  lifetimeMs: number;
}

const CAPS: CodingRpcFramingLimits = {
  headerBytes: 8192, bodyBytes: 16 * 1024 * 1024, frames: 100_000, totalBytes: 256 * 1024 * 1024,
  chunkBytes: 1024 * 1024, bufferBytes: 64 * 1024, frameMs: 120_000, lifetimeMs: 20 * 60_000,
};
export const DEFAULT_CODING_RPC_FRAMING_LIMITS: Readonly<CodingRpcFramingLimits> = Object.freeze({
  headerBytes: 8192, bodyBytes: 16 * 1024 * 1024, frames: 20_000, totalBytes: 128 * 1024 * 1024,
  chunkBytes: 256 * 1024, bufferBytes: 16 * 1024, frameMs: 30_000, lifetimeMs: 20 * 60_000,
});

export type CodingRpcFramingFailure = "limits" | "chunk" | "header" | "frame" | "count" | "bytes" |
  "truncated" | "timeout" | "cancelled" | "transport";
const ERRORS: Record<CodingRpcFramingFailure, string> = {
  limits: "The coding RPC limits are invalid.", chunk: "The coding RPC input chunk is too large.",
  header: "The coding RPC frame header is unsupported.", frame: "The coding RPC frame is too large.",
  count: "The coding RPC frame budget is exhausted.", bytes: "The coding RPC byte budget is exhausted.",
  truncated: "The coding RPC stream ended inside a frame.", timeout: "The coding RPC deadline expired.",
  cancelled: "The coding RPC stream was cancelled.", transport: "The coding RPC transport failed.",
};

/** Fixed text only: never include header contents, frame bodies, launch arguments or child stderr. */
export class CodingRpcFramingError extends Error {
  readonly code: CodingRpcFramingFailure;
  constructor(code: CodingRpcFramingFailure) { super(ERRORS[code]); this.code = code; this.name = "CodingRpcFramingError"; }
}

export function codingRpcFramingLimits(input: CodingRpcFramingLimits): Readonly<CodingRpcFramingLimits> {
  if (!input || Object.keys(input).some(field => !Object.hasOwn(CAPS, field))) throw new CodingRpcFramingError("limits");
  const limits = { ...input };
  for (const field of Object.keys(CAPS) as (keyof CodingRpcFramingLimits)[]) {
    if (!Number.isSafeInteger(limits[field]) || limits[field] < 1 || limits[field] > CAPS[field]) throw new CodingRpcFramingError("limits");
  }
  return Object.freeze(limits);
}

export class CodingRpcFrameGuard extends Transform {
  #limits: Readonly<CodingRpcFramingLimits>;
  #header: Buffer;
  #used = 0;
  #remaining: number | null = null;
  #frames = 0;
  #completed = 0;
  #reservedBytes = 0;
  #frameTimer: ReturnType<typeof setTimeout> | null = null;
  #lifetimeTimer: ReturnType<typeof setTimeout>;
  #signal: AbortSignal | undefined;
  #abort: () => void;

  constructor(input: CodingRpcFramingLimits = DEFAULT_CODING_RPC_FRAMING_LIMITS, signal?: AbortSignal) {
    const limits = codingRpcFramingLimits(input);
    super({ readableHighWaterMark: limits.bufferBytes, writableHighWaterMark: limits.bufferBytes });
    this.#limits = limits;
    this.#header = Buffer.alloc(limits.headerBytes);
    this.#signal = signal;
    this.#abort = () => this.destroy(new CodingRpcFramingError("cancelled"));
    this.#lifetimeTimer = setTimeout(() => this.destroy(new CodingRpcFramingError("timeout")), limits.lifetimeMs);
    this.#lifetimeTimer.unref?.();
    signal?.addEventListener("abort", this.#abort, { once: true });
    if (signal?.aborted) this.#abort();
  }

  get usage(): Readonly<{ frames: number; completed: number; reservedBytes: number; headerBytes: number; remaining: number | null }> {
    return Object.freeze({ frames: this.#frames, completed: this.#completed, reservedBytes: this.#reservedBytes,
      headerBytes: this.#used, remaining: this.#remaining });
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > this.#limits.chunkBytes) throw new CodingRpcFramingError("chunk");
      const output: Buffer[] = [];
      for (let offset = 0; offset < chunk.length;) {
        if (this.#remaining !== null) {
          const take = Math.min(this.#remaining, chunk.length - offset);
          output.push(chunk.subarray(offset, offset + take));
          offset += take;
          this.#remaining -= take;
          if (this.#remaining === 0) this.#complete();
          continue;
        }
        if (this.#used === 0) {
          this.#frameTimer = setTimeout(() => this.destroy(new CodingRpcFramingError("timeout")), this.#limits.frameMs);
          this.#frameTimer.unref?.();
        }
        this.#header[this.#used++] = chunk[offset++];
        const n = this.#used;
        if (n >= 4 && this.#header[n - 4] === 13 && this.#header[n - 3] === 10 && this.#header[n - 2] === 13 && this.#header[n - 1] === 10) {
          const header = this.#header.subarray(0, n);
          // Refuse duplicate/extra headers, folded lines, non-ASCII and ambiguous numeric forms before the SDK sees them.
          const match = /^Content-Length: (0|[1-9][0-9]*)\r\n\r\n$/i.exec(header.toString("latin1"));
          if (!match) throw new CodingRpcFramingError("header");
          const length = Number(match[1]);
          if (!Number.isSafeInteger(length) || length > this.#limits.bodyBytes) throw new CodingRpcFramingError("frame");
          if (this.#frames >= this.#limits.frames) throw new CodingRpcFramingError("count");
          if (n + length > this.#limits.totalBytes - this.#reservedBytes) throw new CodingRpcFramingError("bytes");
          this.#frames++;
          this.#reservedBytes += n + length;
          output.push(Buffer.from(`Content-Length: ${length}\r\n\r\n`, "ascii"));
          this.#used = 0;
          this.#remaining = length;
          if (length === 0) this.#complete();
        } else if (n >= this.#limits.headerBytes) throw new CodingRpcFramingError("header");
      }
      // One bounded output chunk per bounded input chunk lets Transform's normal backpressure govern the pipeline.
      callback(null, output.length ? Buffer.concat(output) : undefined);
    } catch (error) {
      callback(error instanceof CodingRpcFramingError ? new CodingRpcFramingError(error.code) : new CodingRpcFramingError("transport"));
    }
  }

  override _flush(callback: TransformCallback): void {
    callback(this.#used || this.#remaining !== null ? new CodingRpcFramingError("truncated") : null);
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    if (this.#frameTimer) clearTimeout(this.#frameTimer);
    clearTimeout(this.#lifetimeTimer);
    this.#signal?.removeEventListener("abort", this.#abort);
    callback(error ? new CodingRpcFramingError(error instanceof CodingRpcFramingError ? error.code : "transport") : null);
  }

  #complete(): void {
    this.#remaining = null;
    this.#completed++;
    if (this.#frameTimer) clearTimeout(this.#frameTimer);
    this.#frameTimer = null;
  }
}
