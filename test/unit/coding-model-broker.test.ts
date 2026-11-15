import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import {
  CodingModelBroker, CodingModelBrokerError, type CodingModelBrokerBinding, type CodingModelBrokerLimits,
  type CodingModelBrokerRequest, type CodingModelTransport,
} from "../../app/main/agent/coding-model-broker";

const KEY = "fake-host-only-broker-key-927461";
const LIMITS: CodingModelBrokerLimits = {
  requests: 10, concurrent: 2, requestBytes: 4096, responseBytes: 4096, totalBytes: 16384,
  requestMs: 10_000, lifetimeMs: 60_000,
};
const brokers: CodingModelBroker[] = [];
function binding(patch: Partial<CodingModelBrokerBinding> = {}): CodingModelBrokerBinding {
  return { baseUrl: "https://model.example/v1", model: "bound-model", apiKey: KEY,
    limits: { ...LIMITS }, signal: new AbortController().signal, ...patch };
}
function broker(transport: CodingModelTransport = async () => json(), patch: Partial<CodingModelBrokerBinding> = {}) {
  const result = new CodingModelBroker(binding(patch), transport);
  brokers.push(result);
  return result;
}
function request(payload: object = {}, patch: Partial<CodingModelBrokerRequest> = {}): CodingModelBrokerRequest {
  return { method: "POST", path: "/chat/completions",
    body: Buffer.from(JSON.stringify({ model: "bound-model", messages: [{ role: "user", content: "Hello" }], ...payload })), ...patch };
}
function json(text = '{"choices":[]}') { return new Response(text, { headers: { "content-type": "application/json" } }); }
function streaming(chunks: (string | Uint8Array)[], cancel = vi.fn()) {
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }, cancel,
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}
async function text(body: ReadableStream<Uint8Array>) { return new Response(body).text(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
afterEach(() => { for (const value of brokers.splice(0)) value.retire(); vi.useRealTimers(); });

describe("the host-only coding model broker", () => {
  it("copies its immutable binding, replaces all caller headers and fixes the endpoint and model", async () => {
    const seen = vi.fn<CodingModelTransport>(async () => json());
    const original = binding();
    const host = new CodingModelBroker(original, seen);
    brokers.push(host);
    original.baseUrl = "https://attacker.example";
    original.model = "expensive-other-model";
    original.apiKey = "replacement";
    original.limits.requests = 1;
    const incoming = { ...request(), headers: { authorization: "caller-auth", cookie: "caller-cookie", host: "attacker.example" } };
    const first = await host.handle(incoming);
    await text(first.body);
    await text((await host.handle(request())).body);
    expect(seen).toHaveBeenCalledTimes(2);
    const [url, init] = seen.mock.calls[0];
    expect(url).toBe("https://model.example/v1/chat/completions");
    expect(init.headers).toEqual({ authorization: `Bearer ${KEY}`, "content-type": "application/json", accept: "application/json" });
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
    expect(JSON.parse(Buffer.from(init.body).toString()).model).toBe("bound-model");
    expect(JSON.stringify(host)).not.toContain(KEY);
    expect(JSON.stringify(host.usage)).not.toContain(KEY);
    expect(first).toMatchObject({ status: 200, contentType: "application/json" });
    expect(Object.keys(first).sort()).toEqual(["body", "contentType", "status"]);
  });

  it("copies the request bytes before yielding and supports a keyless local provider", async () => {
    const transport = vi.fn<CodingModelTransport>(async () => json());
    const host = broker(transport, { baseUrl: "http://127.0.0.1:12345/v1/", apiKey: null });
    const incoming = request();
    const result = host.handle(incoming);
    incoming.body.fill(0);
    await text((await result).body);
    expect(transport.mock.calls[0][0]).toBe("http://127.0.0.1:12345/v1/chat/completions");
    expect(transport.mock.calls[0][1].headers).not.toHaveProperty("authorization");
    expect(JSON.parse(Buffer.from(transport.mock.calls[0][1].body).toString()).model).toBe("bound-model");
  });

  it.each([
    { baseUrl: "file:///etc/passwd" }, { baseUrl: "http://remote.example/v1" },
    { baseUrl: "https://user:password@model.example/v1" }, { baseUrl: "https://model.example/v1?api_key=hidden" },
    { baseUrl: "https://model.example/v1#hidden" }, { baseUrl: "https://model.example/a%2fb" },
    { baseUrl: "https://model.example/a//b" }, { model: "bad model" }, { model: 42 },
    { apiKey: "line\nbreak" }, { apiKey: "" }, { apiKey: "a".repeat(8193) },
    { limits: { ...LIMITS, requests: Infinity } }, { limits: { ...LIMITS, concurrent: 0 } },
    { limits: { ...LIMITS, responseBytes: 100_000_000 } }, { signal: undefined },
  ])("refuses invalid bindings without echoing their values: %j", patch => {
    expect(() => broker(undefined, patch as Partial<CodingModelBrokerBinding>)).toThrow("The coding model binding is unavailable.");
  });

  it.each([
    { method: "GET" }, { path: "/models" }, { path: "/responses" }, { path: "/chat/completions?x=1" },
    { path: "https://attacker.example/chat/completions" }, { path: "//attacker.example/chat/completions" },
    { path: "/a/../chat/completions" }, { path: "/chat%2fcompletions" }, { path: "/chat/completions/" },
    { path: "file:///etc/passwd" }, { body: Buffer.from("not-json") }, { body: Buffer.from([0xff]) },
  ])("refuses unsupported routes and framing: %j", async patch => {
    const transport = vi.fn<CodingModelTransport>(async () => json());
    const host = broker(transport);
    await expect(host.handle(request({}, patch))).rejects.toMatchObject({ code: "request" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { model: "different-model" }, { messages: [] }, { messages: "not-messages" }, { stream: "true" },
    { n: 2 }, { store: true }, { baseUrl: "https://attacker.example" }, { headers: { authorization: "anything" } },
    { url: "file:///etc/passwd" }, { api_key: "caller-key" }, { command: "run-a-process" },
  ])("refuses unbound models, extra capabilities and invalid controls: %j", async payload => {
    const transport = vi.fn<CodingModelTransport>(async () => json());
    await expect(broker(transport).handle(request(payload))).rejects.toMatchObject({ code: "request" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("counts malformed admitted JSON against the request budget", async () => {
    const host = broker(undefined, { limits: { ...LIMITS, requests: 1 } });
    await expect(host.handle(request({}, { body: Buffer.from("{") }))).rejects.toMatchObject({ code: "request" });
    await expect(host.handle(request())).rejects.toMatchObject({ code: "budget" });
    expect(host.usage).toMatchObject({ requests: 1, bytes: 1 });
  });

  it("does not forward provider response headers, error bodies, redirects or exceptions", async () => {
    for (const response of [
      new Response(KEY, { status: 401, statusText: KEY, headers: { "content-type": "application/json", "set-cookie": KEY } }),
      new Response(KEY, { status: 302, headers: { location: `https://attacker.example/${KEY}` } }),
      new Response(KEY, { headers: { "content-type": "text/html" } }),
      new Response(null, { headers: { "content-type": "application/json" } }),
    ]) {
      const host = broker(async () => response);
      const error = await host.handle(request()).catch(error => error);
      expect(error).toBeInstanceOf(CodingModelBrokerError);
      expect(String(error)).not.toContain(KEY);
      expect(error).toMatchObject({ code: "upstream" });
      expect(host.usage.active).toBe(0);
    }
    const exception = broker(async () => { throw new Error(`credential=${KEY}`); });
    await expect(exception.handle(request())).rejects.toThrow("The coding model service did not return a supported response.");
  });

  it("refuses a transport that reports a redirected or changed response URL", async () => {
    for (const patch of [{ redirected: true }, { url: "https://attacker.example/" }]) {
      const response = json();
      for (const [field, value] of Object.entries(patch)) Object.defineProperty(response, field, { value });
      await expect(broker(async () => response).handle(request())).rejects.toMatchObject({ code: "upstream" });
    }
  });

  it("streams ordinary SSE byte-for-byte with backpressure and drains the concurrency slot", async () => {
    const chunks = ["data: ", '{"hello":"🙂"}', "\n\ndata: [DONE]\n\n"];
    const expected = chunks.join("");
    const upstream = streaming([...chunks]);
    const host = broker(async () => upstream);
    const result = await host.handle(request({ stream: true }));
    expect(result.contentType).toBe("text/event-stream");
    expect(host.usage.active).toBe(1);
    expect(await text(result.body)).toBe(expected);
    expect(host.usage.active).toBe(0);
  });

  it("does not prefetch upstream response bodies before a downstream read", async () => {
    const pull = vi.fn();
    const upstream = new Response(new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }), {
      headers: { "content-type": "application/json" },
    });
    const result = await broker(async () => upstream).handle(request());
    await Promise.resolve();
    expect(pull).not.toHaveBeenCalled();
    await result.body.cancel();
  });

  it.each([1, 2, 5, KEY.length - 1, KEY.length])("withholds credential echoes across chunks of %i bytes", async size => {
    const source = `data: {"answer":"before ${KEY} after"}\n\n`;
    const chunks = Array.from({ length: Math.ceil(source.length / size) }, (_, i) => source.slice(i * size, (i + 1) * size));
    const cancel = vi.fn();
    const host = broker(async () => streaming(chunks, cancel));
    const reader = (await host.handle(request({ stream: true }))).body.getReader();
    let delivered = "";
    let failure: unknown;
    try {
      while (true) { const next = await reader.read(); if (next.done) break; delivered += Buffer.from(next.value).toString(); }
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "credential-echo" });
    expect(delivered).not.toContain(KEY);
    expect(delivered).not.toContain("after");
    expect(String(failure)).not.toContain(KEY);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("withholds JSON-escaped credential echoes and raw stream exceptions", async () => {
    const unusual = 'fake"key\\with-escapes';
    const host = broker(async () => json(JSON.stringify({ answer: unusual })), { apiKey: unusual });
    await expect(text((await host.handle(request())).body)).rejects.toMatchObject({ code: "credential-echo" });
    const errorHost = broker(async () => new Response(new ReadableStream({
      pull() { throw new Error(KEY); },
    }), { headers: { "content-type": "application/json" } }));
    await expect(text((await errorHost.handle(request())).body)).rejects.toThrow("The coding model service did not return a supported response.");
  });

  it("bounds request bytes, response bytes and cumulative bytes", async () => {
    const transport = vi.fn<CodingModelTransport>(async () => json("x".repeat(100)));
    const bodySize = request().body.byteLength;
    const smallRequest = broker(transport, { limits: { ...LIMITS, requestBytes: bodySize - 1 } });
    await expect(smallRequest.handle(request())).rejects.toMatchObject({ code: "budget" });
    expect(transport).not.toHaveBeenCalled();
    const smallResponse = broker(transport, { limits: { ...LIMITS, responseBytes: 99 } });
    await expect(text((await smallResponse.handle(request())).body)).rejects.toMatchObject({ code: "budget" });
    const total = broker(transport, { limits: { ...LIMITS, totalBytes: bodySize + 99 } });
    await expect(text((await total.handle(request())).body)).rejects.toMatchObject({ code: "budget" });
    await expect(total.handle(request())).rejects.toMatchObject({ code: "budget" });
  });

  it("keeps concurrency reserved until response consumption or cancellation", async () => {
    const host = broker(undefined, { limits: { ...LIMITS, concurrent: 1 } });
    const first = await host.handle(request());
    await expect(host.handle(request())).rejects.toMatchObject({ code: "budget" });
    await first.body.cancel();
    await vi.waitFor(() => expect(host.usage.active).toBe(0));
    await text((await host.handle(request())).body);
  });

  it("reserves concurrency while a cancelled transport is still pending and cancels its late response", async () => {
    const pending = deferred<Response>(), cancel = vi.fn(), signal = new AbortController();
    const host = broker(() => pending.promise, { limits: { ...LIMITS, concurrent: 1 } });
    const first = host.handle(request({}, { signal: signal.signal }));
    await Promise.resolve();
    signal.abort(new Error(KEY));
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    await expect(host.handle(request())).rejects.toMatchObject({ code: "budget" });
    pending.resolve(streaming(["late"], cancel));
    await vi.waitFor(() => expect(host.usage.active).toBe(0));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retires pending headers and active streams together and denies all future requests", async () => {
    const owner = new AbortController(), pending = deferred<Response>(), cancel = vi.fn();
    const signals: AbortSignal[] = [];
    let call = 0;
    const host = broker(async (_url, init) => { signals.push(init.signal); return ++call === 1 ? streaming(["held"], cancel) : pending.promise; }, { signal: owner.signal });
    const first = await host.handle(request({ stream: true }));
    const second = host.handle(request());
    await Promise.resolve();
    owner.abort(KEY);
    await expect(text(first.body)).rejects.toMatchObject({ code: "retired" });
    await expect(second).rejects.toMatchObject({ code: "retired" });
    expect(signals.every(value => value.aborted)).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    await expect(host.handle(request())).rejects.toMatchObject({ code: "retired" });
    host.retire();
    pending.resolve(json());
    await vi.waitFor(() => expect(host.usage.active).toBe(0));
  });

  it("never starts a transport after immediate retirement", async () => {
    const transport = vi.fn<CodingModelTransport>(async () => json());
    const host = broker(transport);
    const result = host.handle(request());
    host.retire();
    await expect(result).rejects.toMatchObject({ code: "retired" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("closes responses when retirement races with header delivery", async () => {
    for (let ticks = 0; ticks < 10; ticks++) {
      const owner = new AbortController(), cancel = vi.fn();
      const transport = vi.fn<CodingModelTransport>(async () => streaming(["held"], cancel));
      const host = broker(transport, { signal: owner.signal });
      const opening = host.handle(request({ stream: true })).catch(error => error);
      for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
      owner.abort();
      const result = await opening;
      if (!(result instanceof CodingModelBrokerError)) await expect(text(result.body)).rejects.toMatchObject({ code: "retired" });
      else expect(result.code).toBe("retired");
      await vi.waitFor(() => expect(host.usage.active).toBe(0));
      expect(cancel).toHaveBeenCalledTimes(transport.mock.calls.length);
    }
  });

  it("honors already-aborted request and session bindings", async () => {
    const aborted = new AbortController();
    aborted.abort(KEY);
    const transport = vi.fn<CodingModelTransport>(async () => json());
    await expect(broker(transport).handle(request({}, { signal: aborted.signal }))).rejects.toMatchObject({ code: "cancelled" });
    await expect(broker(transport, { signal: aborted.signal }).handle(request())).rejects.toMatchObject({ code: "retired" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("enforces request and lifetime deadlines while headers or body reads are blocked", async () => {
    vi.useFakeTimers();
    const host = broker(async () => new Promise<Response>(() => undefined), { limits: { ...LIMITS, requestMs: 10, lifetimeMs: 30 } });
    const pending = host.handle(request()).catch(error => error);
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toMatchObject({ code: "timeout" });
    const streamHost = broker(async () => new Response(new ReadableStream<Uint8Array>({}), {
      headers: { "content-type": "application/json" },
    }), { limits: { ...LIMITS, requestMs: 100, lifetimeMs: 10 } });
    const result = await streamHost.handle(request());
    const reading = text(result.body).catch(error => error);
    await vi.advanceTimersByTimeAsync(11);
    expect(await reading).toMatchObject({ code: "retired" });
    expect(streamHost.usage.retired).toBe(true);
  });

  it("uses real HTTP without following redirects or leaking auth to their destinations", async () => {
    let received = 0, auth: string | undefined;
    const server = http.createServer(async (incoming, outgoing) => {
      received++;
      auth = incoming.headers.authorization;
      for await (const _chunk of incoming) { /* drain the fake request */ }
      outgoing.writeHead(307, { location: `http://127.0.0.1:${(server.address() as { port: number }).port}/stolen` });
      outgoing.end(KEY);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const host = broker((url, init) => fetch(url, init), { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` });
      await expect(host.handle(request())).rejects.toMatchObject({ code: "upstream" });
      expect(received).toBe(1);
      expect(auth).toBe(`Bearer ${KEY}`);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("closes a real upstream streaming connection when the owner retires", async () => {
    let closed = false;
    const server = http.createServer(async (incoming, outgoing) => {
      for await (const _chunk of incoming) { /* drain the fake request */ }
      outgoing.on("close", () => { closed = true; });
      outgoing.writeHead(200, { "content-type": "text/event-stream", "x-secret-header": KEY });
      outgoing.write(`data: {"delta":"${"x".repeat(80)}"}\n\n`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const owner = new AbortController();
    try {
      const host = new CodingModelBroker(binding({
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, signal: owner.signal,
      }));
      brokers.push(host);
      const result = await host.handle(request({ stream: true }));
      const reader = result.body.getReader();
      expect((await reader.read()).done).toBe(false);
      owner.abort();
      await expect(reader.read()).rejects.toMatchObject({ code: "retired" });
      await vi.waitFor(() => expect(closed).toBe(true));
      await vi.waitFor(() => expect(host.usage.active).toBe(0));
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
