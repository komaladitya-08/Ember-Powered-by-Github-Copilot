import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopilotRequestContext } from "@github/copilot-sdk";
import {
  CodingModelRequestHandler, CODING_MODEL_PLACEHOLDER_KEY, CODING_MODEL_PLACEHOLDER_URL, codingModelPlaceholderProvider,
} from "../../app/main/agent/coding-model-request-handler";
import { CodingModelBroker, type CodingModelTransport } from "../../app/main/agent/coding-model-broker";

const route = `${CODING_MODEL_PLACEHOLDER_URL}/chat/completions`;
const sessionId = "ember-coding-fixture";
const payload = JSON.stringify({ model: "mock-model", messages: [{ role: "user", content: "inspect the project" }], stream: false });
const limits = { requests: 10, concurrent: 2, requestBytes: 4096, responseBytes: 4096, totalBytes: 20_000, requestMs: 1000, lifetimeMs: 5000 };
const active: CodingModelRequestHandler[] = [];

class TestHandler extends CodingModelRequestHandler {
  http(request: Request, context: CopilotRequestContext) { return super.sendRequest(request, context); }
  websocket(context: CopilotRequestContext) { return super.openWebSocket(context); }
}

function context(overrides: Partial<CopilotRequestContext> = {}): CopilotRequestContext {
  return { requestId: "fixture-request", sessionId, transport: "http", url: route, headers: {}, signal: new AbortController().signal, ...overrides };
}
function request(url = route, init: RequestInit = {}): Request {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload, ...init });
}
function fixture(transport?: CodingModelTransport) {
  const owner = new AbortController();
  const send = vi.fn<CodingModelTransport>(transport ?? (async () => new Response('{"answer":"ready"}', { headers: { "content-type": "application/json" } })));
  const broker = new CodingModelBroker({ baseUrl: "https://host-provider.example/v1", model: "mock-model", apiKey: "host-only-synthetic-credential", limits, signal: owner.signal }, send);
  const handler = new TestHandler({ sessionId, broker, maxBodyBytes: limits.requestBytes });
  active.push(handler);
  return { handler, broker, send, owner };
}

afterEach(() => { for (const handler of active.splice(0)) handler.retire(); vi.restoreAllMocks(); });

describe("dedicated-runtime model request adapter", () => {
  it("replaces every runtime header with the immutable host binding and streams the broker response", async () => {
    const f = fixture();
    const response = await f.handler.http(request(route, { headers: {
      "content-type": "application/json", authorization: "Bearer runtime-chosen-secret", cookie: "chosen=1", "x-provider-url": "https://attacker.example",
    } }), context({ headers: { authorization: ["Bearer other-runtime-secret"] } }));
    expect(await response.json()).toEqual({ answer: "ready" });
    expect(f.send).toHaveBeenCalledTimes(1);
    const [url, init] = f.send.mock.calls[0];
    expect(url).toBe("https://host-provider.example/v1/chat/completions");
    expect(init.headers).toEqual({ "content-type": "application/json", accept: "application/json", authorization: "Bearer host-only-synthetic-credential" });
    expect(Buffer.from(init.body).toString()).toBe(payload);
    expect([...response.headers.keys()]).toEqual(["content-type"]);
    expect(codingModelPlaceholderProvider()).toEqual({ type: "openai", baseUrl: CODING_MODEL_PLACEHOLDER_URL, apiKey: CODING_MODEL_PLACEHOLDER_KEY, wireApi: "completions" });
  });

  it.each([
    ["another session", () => request(), () => context({ sessionId: "other-session" })],
    ["no session", () => request(), () => context({ sessionId: undefined })],
    ["another context URL", () => request(), () => context({ url: "https://attacker.example/v1/chat/completions" })],
    ["another request URL", () => request("https://attacker.example/v1/chat/completions"), () => context()],
    ["a query", () => request(`${route}?provider=attacker`), () => context()],
    ["a fragment", () => request(`${route}#other`), () => context()],
    ["responses", () => request(`${CODING_MODEL_PLACEHOLDER_URL}/responses`), () => context()],
    ["websocket transport", () => request(), () => context({ transport: "websocket" })],
    ["a GET", () => request(route, { method: "GET", body: undefined }), () => context()],
    ["non-JSON", () => request(route, { headers: { "content-type": "text/plain" } }), () => context()],
  ] as const)("rejects %s without calling a broker or network fallback", async (_name, makeRequest, makeContext) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const f = fixture();
    await expect(f.handler.http(makeRequest(), makeContext())).rejects.toThrow("The coding model request is not supported.");
    expect(f.send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects all WebSocket requests without constructing a forwarder", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const f = fixture();
    await expect(f.handler.websocket(context({ transport: "websocket", url: "wss://attacker.example" }))).rejects.toThrow("not supported");
    expect(fetch).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("captures the host session and broker capability before mutable options can change", async () => {
    const call = vi.fn(async () => ({ status: 200 as const, contentType: "application/json" as const,
      body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from("{}")); c.close(); } }) }));
    const broker = { handle: call, retire: vi.fn() };
    const options = { sessionId, broker, maxBodyBytes: 4096 };
    const handler = new TestHandler(options); active.push(handler);
    options.sessionId = "retargeted-session";
    broker.handle = vi.fn().mockRejectedValue(new Error("retargeted"));
    expect(await (await handler.http(request(), context())).text()).toBe("{}");
    expect(call).toHaveBeenCalledTimes(1);
    expect(broker.handle).not.toHaveBeenCalled();
  });

  it.each([true, false])("bounds incoming bodies before broker admission (declared=%s)", async declared => {
    const f = fixture();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (declared) headers["content-length"] = "5000";
    await expect(f.handler.http(request(route, { headers, body: "a".repeat(5000) }), context())).rejects.toThrow("budget");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("cancels a body read and never admits it after retirement", async () => {
    const cancelled = vi.fn();
    const f = fixture();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const pending = f.handler.http(request(route, { body, duplex: "half" } as RequestInit), context());
    f.handler.retire();
    await expect(pending).rejects.toThrow("cancelled");
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.broker.usage.retired).toBe(true);
    await expect(f.handler.http(request(), context())).rejects.toThrow("session has ended");
  });

  it("admits only one body allocation at a time before broker concurrency admission", async () => {
    const f = fixture();
    const body = new ReadableStream<Uint8Array>();
    const pending = f.handler.http(request(route, { body, duplex: "half" } as RequestInit), context());
    await expect(f.handler.http(request(), context())).rejects.toThrow("budget");
    expect(f.send).not.toHaveBeenCalled();
    f.handler.retire();
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("propagates runtime cancellation without its untrusted reason", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const f = fixture(async (_url, init) => { upstreamSignal = init.signal; return new Promise<Response>(() => undefined); });
    const cancelled = new AbortController();
    const pending = f.handler.http(request(), context({ signal: cancelled.signal }));
    await expect.poll(() => f.send.mock.calls.length).toBe(1);
    cancelled.abort(new Error("provider secret must never be printed"));
    await expect(pending).rejects.toThrow("The coding model request was cancelled.");
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("retires upstream work after response headers and withholds further stream data", async () => {
    const cancelled = vi.fn();
    const f = fixture(async () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), { headers: { "content-type": "application/json" } }));
    const response = await f.handler.http(request(), context());
    const reading = response.text();
    f.handler.retire();
    await expect(reading).rejects.toThrow("request was cancelled");
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(f.broker.usage.retired).toBe(true);
  });

  it("rejects malformed and retargeted model JSON through the broker", async () => {
    const f = fixture();
    for (const body of ["{", JSON.stringify({ model: "different-model", messages: [{}] }), JSON.stringify({ model: "mock-model", messages: [{}], baseUrl: "https://attacker.example" })]) {
      await expect(f.handler.http(request(route, { body }), context())).rejects.toThrow("not supported");
    }
    expect(f.send).not.toHaveBeenCalled();
  });
});
