/**
 * Credential-bearing model requests belong in the trusted host, outside a coding runtime. This is a request
 * handler, not a listener: a future authenticated SDK-RPC, Unix-socket or named-pipe adapter supplies framed bytes.
 * It neither authenticates that peer nor establishes an OS/process/network boundary. Do not enable native coding
 * on the strength of this module. The adapter must bound framing before allocating a request body.
 *
 * Only OpenAI-compatible HTTP chat completions are supported. This is the format exercised by the repository's
 * pinned SDK 1.0.21 offline model fixture. Responses, WebSocket, Azure, Anthropic and GitHub's default auth protocol
 * require separate adapters; no token-acquisition callback may hand this credential back to the runtime.
 */
import { endpointProblem, MAX_API_KEY, MODEL_ID } from "../../shared/provider";

export interface CodingModelBrokerLimits {
  requests: number;
  concurrent: number;
  /** Maximum bytes in one incoming JSON body, before parsing. */
  requestBytes: number;
  /** Maximum raw upstream bytes in one response, before any credential-echo check. */
  responseBytes: number;
  /** Cumulative incoming and outgoing bytes, including failed admitted requests. */
  totalBytes: number;
  requestMs: number;
  lifetimeMs: number;
}

export interface CodingModelBrokerBinding {
  baseUrl: string;
  model: string;
  /** Host-only; never serialize this binding to the native runtime. Null supports a keyless local provider. */
  apiKey: string | null;
  limits: CodingModelBrokerLimits;
  signal: AbortSignal;
}

export interface CodingModelBrokerRequest {
  method: string;
  /** Exactly /chat/completions, relative to the bound provider base URL; never a caller-supplied URL. */
  path: string;
  body: Uint8Array;
  signal?: AbortSignal;
}

export interface CodingModelBrokerResponse {
  status: 200;
  contentType: "application/json" | "text/event-stream";
  /** The consumer must drain or cancel this stream. Its lifetime counts against the concurrency budget. */
  body: ReadableStream<Uint8Array>;
}

/** A trusted transport must honor AbortSignal, redirect:error and credentials:omit (as the default fetch does). */
export type CodingModelTransport = (url: string, init: {
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: Uint8Array<ArrayBuffer>;
  signal: AbortSignal;
  redirect: "error";
  credentials: "omit";
  referrerPolicy: "no-referrer";
}) => Promise<Response>;

type FailureCode = "binding" | "request" | "budget" | "retired" | "cancelled" | "timeout" | "upstream" | "credential-echo";
const ERRORS: Record<FailureCode, string> = {
  binding: "The coding model binding is unavailable.",
  request: "The coding model request is not supported.",
  budget: "The coding model request budget is exhausted.",
  retired: "The coding model session has ended.",
  cancelled: "The coding model request was cancelled.",
  timeout: "The coding model request timed out.",
  upstream: "The coding model service did not return a supported response.",
  "credential-echo": "The coding model response was withheld because it contained a credential.",
};

/** Fixed host-authored errors only: no upstream body, status text, exception, header, URL or credential. */
export class CodingModelBrokerError extends Error {
  constructor(readonly code: FailureCode) { super(ERRORS[code]); this.name = "CodingModelBrokerError"; }
}

// Documented chat-completions JSON fields. No provider URL, headers, auth, file I/O or process operation is accepted.
const FIELDS = new Set([
  "model", "messages", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls",
  "temperature", "top_p", "stop", "max_tokens", "max_completion_tokens", "presence_penalty", "frequency_penalty",
  "logit_bias", "logprobs", "top_logprobs", "response_format", "reasoning_effort", "verbosity", "seed", "n",
  "user", "metadata", "store", "service_tier", "prediction", "modalities", "audio", "functions", "function_call",
]);
const CAPS: CodingModelBrokerLimits = {
  requests: 10_000, concurrent: 16, requestBytes: 16 * 1024 * 1024, responseBytes: 64 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024, requestMs: 120_000, lifetimeMs: 20 * 60_000,
};

interface ActiveRequest {
  abort(error: CodingModelBrokerError): void;
}

/** A capability bound once by the host to one provider, model, credential, budget and session lifetime. */
export class CodingModelBroker {
  #url: string;
  #model: string;
  #key: string | null;
  #limits: Readonly<CodingModelBrokerLimits>;
  #transport: CodingModelTransport;
  #signal: AbortSignal;
  #ownerAbort: () => void;
  #timer: ReturnType<typeof setTimeout>;
  #active = new Set<ActiveRequest>();
  #retired = false;
  #requests = 0;
  #bytes = 0;

  constructor(binding: CodingModelBrokerBinding, transport: CodingModelTransport = (url, init) => fetch(url, init)) {
    try {
      if (endpointProblem(binding.baseUrl) || typeof binding.model !== "string" || !MODEL_ID.test(binding.model) ||
          (binding.apiKey !== null && (typeof binding.apiKey !== "string" || !binding.apiKey.length ||
            binding.apiKey.length > MAX_API_KEY || /[^\x21-\x7e]/.test(binding.apiKey)))) throw new Error();
      const base = new URL(binding.baseUrl);
      // No URL options or ambiguous encoded path components at a credential-bearing boundary.
      if (base.search || base.hash || /%|\\|\/\//.test(base.pathname)) throw new Error();
      this.#url = `${base.origin}${base.pathname.replace(/\/$/, "")}/chat/completions`;
      this.#model = binding.model;
      this.#key = binding.apiKey;
      const limits = { ...binding.limits };
      for (const field of Object.keys(CAPS) as (keyof CodingModelBrokerLimits)[]) {
        if (!Number.isSafeInteger(limits[field]) || limits[field] < 1 || limits[field] > CAPS[field]) throw new Error();
      }
      this.#limits = Object.freeze(limits);
      this.#signal = binding.signal;
      if (!(this.#signal instanceof AbortSignal)) throw new Error();
    } catch { throw new CodingModelBrokerError("binding"); }
    this.#transport = transport;
    this.#ownerAbort = () => this.retire();
    this.#timer = setTimeout(() => this.retire(), this.#limits.lifetimeMs);
    this.#timer.unref?.();
    this.#signal.addEventListener("abort", this.#ownerAbort, { once: true });
    if (this.#signal.aborted) this.retire();
  }

  /** No credential, endpoint, model text or request content is returned by diagnostics. */
  get usage(): Readonly<{ requests: number; bytes: number; active: number; retired: boolean }> {
    return Object.freeze({ requests: this.#requests, bytes: this.#bytes, active: this.#active.size, retired: this.#retired });
  }

  /** Revoke the capability, error all downstream streams and abort/cancel all outstanding upstream requests. */
  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#key = null;
    clearTimeout(this.#timer);
    this.#signal.removeEventListener("abort", this.#ownerAbort);
    for (const request of this.#active) request.abort(new CodingModelBrokerError("retired"));
  }

  async handle(request: CodingModelBrokerRequest): Promise<CodingModelBrokerResponse> {
    if (this.#retired) throw new CodingModelBrokerError("retired");
    if (!request || request.method !== "POST" || request.path !== "/chat/completions" ||
        !(request.body instanceof Uint8Array) ||
        (request.signal !== undefined && !(request.signal instanceof AbortSignal))) throw new CodingModelBrokerError("request");
    if (request.signal?.aborted) throw new CodingModelBrokerError("cancelled");
    if (this.#requests >= this.#limits.requests || this.#active.size >= this.#limits.concurrent ||
        request.body.byteLength > this.#limits.requestBytes || this.#bytes + request.body.byteLength > this.#limits.totalBytes) {
      throw new CodingModelBrokerError("budget");
    }
    // Copy once before the first await so a caller cannot retarget a request by mutating its backing buffer.
    const body = Uint8Array.from(request.body);
    this.#requests++;
    this.#bytes += body.byteLength;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
          Object.keys(payload).some(field => !FIELDS.has(field)) || payload.model !== this.#model ||
          !Array.isArray(payload.messages) || !payload.messages.length ||
          (payload.stream !== undefined && typeof payload.stream !== "boolean") ||
          (payload.n !== undefined && payload.n !== 1) || (payload.store !== undefined && payload.store !== false)) throw new Error();
    } catch { throw new CodingModelBrokerError("request"); }
    const key = this.#key;
    const headers = Object.freeze({
      "content-type": "application/json",
      accept: payload.stream ? "text/event-stream" : "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    });
    // Withhold the exact credential and its JSON-escaped form, including across arbitrary upstream chunk splits.
    const forbidden = key ? [...new Set([key, JSON.stringify(key).slice(1, -1)])].map(value => Buffer.from(value)) : [];
    const keep = Math.max(0, ...forbidden.map(value => value.length - 1));
    const abort = new AbortController();
    let failed: CodingModelBrokerError | null = null;
    let upstream: Response | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let downstream: ReadableStreamDefaultController<Uint8Array> | null = null;
    let headerPending = true;
    let finished = false;
    let rejectAbort!: (error: CodingModelBrokerError) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    // The promise is also used after headers have arrived, when there may be no active race.
    void aborted.catch(() => undefined);
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      this.#active.delete(active);
    };
    const active: ActiveRequest = { abort: error => {
      if (finished || failed) return;
      failed = error;
      abort.abort(); // Never propagate an untrusted AbortSignal.reason into transport errors.
      rejectAbort(error);
      downstream?.error(error);
      if (reader) void reader.cancel().then(cleanup, cleanup);
      else if (upstream) void (upstream.body?.cancel() ?? Promise.resolve()).then(cleanup, cleanup);
      else if (!headerPending) cleanup();
    } };
    const onAbort = () => active.abort(new CodingModelBrokerError("cancelled"));
    const timer = setTimeout(() => active.abort(new CodingModelBrokerError("timeout")), this.#limits.requestMs);
    timer.unref?.();
    this.#active.add(active);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    try {
      const pending = Promise.resolve().then(() => {
        if (failed) throw failed;
        return this.#transport(this.#url, {
          method: "POST", headers, body, signal: abort.signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
        });
      }).then(async result => {
        headerPending = false;
        upstream = result;
        if (failed) {
          await result.body?.cancel().catch(() => undefined);
          cleanup();
          throw failed;
        }
        return result;
      }, () => {
        headerPending = false;
        cleanup();
        throw failed ?? new CodingModelBrokerError("upstream");
      });
      response = await Promise.race([pending, aborted]);
      if (failed) throw failed;
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      const expected = payload.stream ? "text/event-stream" : "application/json";
      if (response.status !== 200 || response.redirected || (response.url && response.url !== this.#url) ||
          contentType !== expected || !response.body) {
        abort.abort();
        void response.body?.cancel().catch(() => undefined);
        cleanup();
        throw new CodingModelBrokerError("upstream");
      }
      reader = response.body.getReader();
      let responseBytes = 0;
      let tail = Buffer.alloc(0);
      const stream = new ReadableStream<Uint8Array>({
        start: controller => { downstream = controller; },
        pull: async controller => {
          try {
            // A short chunk may consist entirely of a possible credential prefix; retain it until it is decidable.
            while (true) {
              const chunk = await Promise.race([reader!.read(), aborted]);
              if (failed) throw failed;
              if (chunk.done) {
                if (tail.length) controller.enqueue(Uint8Array.from(tail));
                controller.close();
                cleanup();
                return;
              }
              responseBytes += chunk.value.byteLength;
              this.#bytes += chunk.value.byteLength;
              if (responseBytes > this.#limits.responseBytes || this.#bytes > this.#limits.totalBytes) {
                throw new CodingModelBrokerError("budget");
              }
              const joined = Buffer.concat([tail, chunk.value]);
              if (forbidden.some(value => joined.includes(value))) throw new CodingModelBrokerError("credential-echo");
              const emit = Math.max(0, joined.length - keep);
              tail = Buffer.from(joined.subarray(emit));
              if (emit) { controller.enqueue(Uint8Array.from(joined.subarray(0, emit))); return; }
            }
          } catch (error) {
            active.abort(new CodingModelBrokerError(error instanceof CodingModelBrokerError ? error.code : "upstream"));
          }
        },
        cancel: () => { active.abort(new CodingModelBrokerError("cancelled")); },
      }, { highWaterMark: 0 });
      return { status: 200, contentType: expected, body: stream };
    } catch (error) {
      const failure = failed ?? new CodingModelBrokerError(error instanceof CodingModelBrokerError ? error.code : "upstream");
      active.abort(failure);
      throw failure;
    }
  }
}
