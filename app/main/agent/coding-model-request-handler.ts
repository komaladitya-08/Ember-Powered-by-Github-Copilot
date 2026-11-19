/**
 * Experiment only: route one dedicated runtime's model requests over its existing SDK stdio connection to a
 * host-owned broker. The runtime receives a fixed, non-secret provider placeholder; no runtime URL or header can
 * select a credential or destination. This is neither OS isolation nor peer authentication for a shared runtime.
 *
 * SDK 1.0.21 buffers the request in its JSON-RPC adapter before calling sendRequest. The bound below limits accepted
 * bodies and our additional allocation, not that earlier SDK buffer. A production framing boundary remains necessary.
 */
import {
  CopilotRequestHandler, type CopilotRequestContext, type CopilotWebSocketHandler, type ProviderConfig,
} from "@github/copilot-sdk";
import { CodingModelBrokerError, type CodingModelBroker } from "./coding-model-broker";

export const CODING_MODEL_PLACEHOLDER_URL = "https://ember-coding.invalid/v1";
/** Public dummy value, deliberately unrelated to the host's provider credential. */
export const CODING_MODEL_PLACEHOLDER_KEY = "ember-coding-no-credential";
const ROUTE = `${CODING_MODEL_PLACEHOLDER_URL}/chat/completions`;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export function codingModelPlaceholderProvider(): ProviderConfig {
  return { type: "openai", baseUrl: CODING_MODEL_PLACEHOLDER_URL, apiKey: CODING_MODEL_PLACEHOLDER_KEY, wireApi: "completions" };
}

export interface CodingModelRequestHandlerOptions {
  /** Host-created session id. Use a separate stdio runtime, never the desktop/conductor runtime. */
  sessionId: string;
  /** One immutable host capability; never accept a broker or binding from a runtime request. */
  broker: Pick<CodingModelBroker, "handle" | "retire">;
  maxBodyBytes: number;
}

export class CodingModelRequestHandler extends CopilotRequestHandler {
  #sessionId: string;
  #handle: CodingModelBroker["handle"];
  #retireBroker: () => void;
  #maxBodyBytes: number;
  #retirement = new AbortController();
  #readingBody = false;

  constructor(options: CodingModelRequestHandlerOptions) {
    super();
    if (typeof options.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(options.sessionId) ||
        !Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1 || options.maxBodyBytes > MAX_BODY_BYTES ||
        typeof options.broker?.handle !== "function" || typeof options.broker?.retire !== "function") {
      throw new CodingModelBrokerError("binding");
    }
    this.#sessionId = options.sessionId;
    this.#handle = options.broker.handle.bind(options.broker);
    this.#retireBroker = options.broker.retire.bind(options.broker);
    this.#maxBodyBytes = options.maxBodyBytes;
  }

  retire(): void {
    if (this.#retirement.signal.aborted) return;
    this.#retirement.abort();
    this.#retireBroker();
  }

  protected override async sendRequest(request: Request, ctx: CopilotRequestContext): Promise<Response> {
    if (this.#retirement.signal.aborted) throw new CodingModelBrokerError("retired");
    if (ctx.transport !== "http" || ctx.sessionId !== this.#sessionId || ctx.url !== ROUTE || request.url !== ROUTE ||
        request.method !== "POST" || request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      throw new CodingModelBrokerError("request");
    }
    const signal = AbortSignal.any([ctx.signal, request.signal, this.#retirement.signal]);
    if (signal.aborted) throw new CodingModelBrokerError("cancelled");
    // Bound this adapter's own pre-broker allocations too. SDK-level framing still precedes this check.
    if (this.#readingBody) throw new CodingModelBrokerError("budget");
    this.#readingBody = true;
    let body: Uint8Array;
    try { body = await boundedBody(request, signal, this.#maxBodyBytes); }
    finally { this.#readingBody = false; }
    const result = await this.#handle({ method: "POST", path: "/chat/completions", body, signal });
    // The broker owns cancellation throughout the stream. Never copy upstream headers or exception text here.
    return new Response(result.body, { status: result.status, headers: { "content-type": result.contentType } });
  }

  protected override async openWebSocket(_ctx: CopilotRequestContext): Promise<CopilotWebSocketHandler> {
    // CopilotRequestHandler's default forwards to the caller's URL; every unsupported transport must be overridden.
    throw new CodingModelBrokerError(this.#retirement.signal.aborted ? "retired" : "request");
  }
}

async function boundedBody(request: Request, signal: AbortSignal, maximum: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) {
    throw new CodingModelBrokerError("budget");
  }
  if (!request.body) throw new CodingModelBrokerError("request");
  const reader = request.body.getReader();
  let rejectAbort!: (reason: CodingModelBrokerError) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  void aborted.catch(() => undefined);
  const abort = () => { rejectAbort(new CodingModelBrokerError("cancelled")); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw new CodingModelBrokerError("cancelled");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw new CodingModelBrokerError("budget");
      chunks.push(Uint8Array.from(chunk.value));
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error instanceof CodingModelBrokerError ? error : new CodingModelBrokerError("request");
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
