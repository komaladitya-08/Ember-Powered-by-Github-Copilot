import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CodingRpcFrameGuard, CodingRpcFramingError, DEFAULT_CODING_RPC_FRAMING_LIMITS,
  type CodingRpcFramingLimits,
} from "../../app/main/agent/coding-rpc-framing";

const guards: CodingRpcFrameGuard[] = [];
function guard(overrides: Partial<CodingRpcFramingLimits> = {}, signal?: AbortSignal) {
  const result = new CodingRpcFrameGuard({ ...DEFAULT_CODING_RPC_FRAMING_LIMITS, ...overrides }, signal);
  guards.push(result);
  return result;
}
function frame(value: string | Buffer): Buffer {
  const body = Buffer.from(value);
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}
async function run(chunks: Buffer[], target = guard()): Promise<Buffer> {
  const output: Buffer[] = [];
  await pipeline(Readable.from(chunks), target, new Writable({ write(chunk, _encoding, done) { output.push(Buffer.from(chunk)); done(); } }));
  return Buffer.concat(output);
}
afterEach(() => { for (const value of guards.splice(0)) value.destroy(); vi.useRealTimers(); });

describe("pre-SDK coding RPC framing", () => {
  it.each([1, 2, 3, 4, 7, 20, 1024])("preserves opaque payloads across arbitrary %i-byte splits", async size => {
    const bytes = Buffer.concat([frame('{"jsonrpc":"2.0","id":1,"text":"🙂"}'), frame(Buffer.from([0, 255, 13, 10])), frame("")]);
    const chunks = Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size));
    const target = guard();
    expect(await run(chunks, target)).toEqual(bytes);
    expect(target.usage).toEqual({ frames: 3, completed: 3, reservedBytes: bytes.length, headerBytes: 0, remaining: null });
  });

  it("admits a bounded header before streaming a body without allocating the declared body length", async () => {
    const target = guard({ bodyBytes: 16 * 1024 * 1024 });
    const output: Buffer[] = [];
    target.on("data", chunk => output.push(Buffer.from(chunk)));
    target.write("Content-Length: 16777216\r\n\r\n");
    target.write("small prefix");
    expect(Buffer.concat(output).toString()).toBe("Content-Length: 16777216\r\n\r\nsmall prefix");
    expect(target.usage).toMatchObject({ frames: 1, completed: 0, headerBytes: 0, remaining: 16 * 1024 * 1024 - 12 });
    target.on("error", () => undefined);
    target.destroy();
  });

  it.each([
    "Content-Length: -1\r\n\r\n", "Content-Length: +1\r\n\r\n", "Content-Length: 01\r\n\r\n",
    "Content-Length: 1x\r\n\r\n", "Content-Length: 1.0\r\n\r\n", "Content-Length: 1e9\r\n\r\n",
    "Content-Length: NaN\r\n\r\n", "Content-Length: Infinity\r\n\r\n", "Content-Length: 1\r\nContent-Length: 1\r\n\r\n",
    "Content-Length: 1\r\nX-Header: ignored\r\n\r\n", "Content-Type: application/json\r\n\r\n",
    "Content-Length:\t1\r\n\r\n", "Content-Length: 1\r\n folded\r\n\r\n", "Content-Length: 1\0\r\n\r\n",
  ])("rejects ambiguous/unsupported headers without forwarding their bytes: %j", async header => {
    const target = guard(), output: Buffer[] = [];
    target.on("data", chunk => output.push(Buffer.from(chunk)));
    await expect(run([Buffer.from(header + "x")], target)).rejects.toMatchObject({ code: "header" });
    expect(Buffer.concat(output).length).toBe(0);
  });

  it("accepts only case differences in the one documented header and canonicalizes them", async () => {
    expect((await run([Buffer.from("content-length: 1\r\n\r\nx")])).toString()).toBe("Content-Length: 1\r\n\r\nx");
  });

  it("rejects an oversized advertised body before forwarding any frame header or reading its body", async () => {
    const target = guard(), output: Buffer[] = [];
    target.on("data", chunk => output.push(Buffer.from(chunk)));
    await expect(run([Buffer.from("Content-Length: 999999999999999999999999\r\n\r\n")], target)).rejects.toMatchObject({ code: "frame" });
    expect(output).toHaveLength(0);
    expect(target.usage.frames).toBe(0);
  });

  it("bounds unterminated headers, input chunks and declared cumulative bytes", async () => {
    await expect(run([Buffer.from("x".repeat(8192))])).rejects.toMatchObject({ code: "header" });
    await expect(run([Buffer.alloc(101)], guard({ chunkBytes: 100 }))).rejects.toMatchObject({ code: "chunk" });
    await expect(run([frame("body")], guard({ totalBytes: frame("body").length - 1 }))).rejects.toMatchObject({ code: "bytes" });
    await expect(run([frame("a"), frame("b")], guard({ totalBytes: frame("a").length }))).rejects.toMatchObject({ code: "bytes" });
  });

  it("bounds the number of frames independently of their body size", async () => {
    const target = guard({ frames: 1 });
    await expect(run([frame(""), frame("")], target)).rejects.toMatchObject({ code: "count" });
    expect(target.usage).toMatchObject({ frames: 1, completed: 1 });
  });

  it.each(["Content-Len", "Content-Length: 3\r\n\r\nx", "Content-Length: 0\r\n\r\nContent-"])("fails closed on truncated EOF: %j", async input => {
    await expect(run([Buffer.from(input)])).rejects.toMatchObject({ code: "truncated" });
  });

  it("does not parse JSON, trust method names or reject opaque bounded payload bytes", async () => {
    const bytes = frame("not JSON, method=anything, file:///private, auth=FAKE_SECRET");
    expect(await run([bytes])).toEqual(bytes);
  });

  it("does not leak malformed header contents or transport exceptions through errors", async () => {
    const secret = "FAKE_PRIVATE_HEADER_VALUE";
    const failure = await run([Buffer.from(`Content-Length: ${secret}\r\n\r\n`)]).catch(error => error);
    expect(failure).toBeInstanceOf(CodingRpcFramingError);
    expect(String(failure)).not.toContain(secret);
    const target = guard();
    const error = new Promise<Error>(resolve => target.on("error", resolve));
    target.destroy(new Error(secret));
    expect(String(await error)).toBe("CodingRpcFramingError: The coding RPC transport failed.");
  });

  it("honors cancellation before parsing and while a frame is partially assembled", async () => {
    for (const partial of [false, true]) {
      const owner = new AbortController();
      if (!partial) owner.abort("untrusted reason");
      const target = guard({}, owner.signal);
      const failure = new Promise<Error>(resolve => target.on("error", resolve));
      if (partial) { target.write("Content-Length: 5\r\n\r\nhe"); owner.abort("untrusted reason"); }
      expect(await failure).toMatchObject({ code: "cancelled" });
      expect(target.destroyed).toBe(true);
    }
  });

  it("does not extend a frame deadline when a slow sender drips bytes", async () => {
    vi.useFakeTimers();
    const target = guard({ frameMs: 10, lifetimeMs: 100 });
    const failure = new Promise<Error>(resolve => target.on("error", resolve));
    target.write("C");
    await vi.advanceTimersByTimeAsync(6);
    target.write("o");
    await vi.advanceTimersByTimeAsync(5);
    expect(await failure).toMatchObject({ code: "timeout" });
  });

  it("expires an idle lifetime and clears a completed frame's assembly timer", async () => {
    vi.useFakeTimers();
    const target = guard({ frameMs: 10, lifetimeMs: 30 });
    target.resume();
    const failure = new Promise<Error>(resolve => target.on("error", resolve));
    target.write(frame("done"));
    await vi.advanceTimersByTimeAsync(11);
    expect(target.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await failure).toMatchObject({ code: "timeout" });
  });

  it("propagates backpressure to a cooperative source instead of buffering all frames", async () => {
    const chunk = frame("x".repeat(256));
    let generated = 0, release!: () => void;
    const source = Readable.from((function* () { for (let i = 0; i < 500; i++) { generated++; yield chunk; } })(), { highWaterMark: 1 });
    const target = guard({ bufferBytes: 64, chunkBytes: 512 });
    const sink = new Writable({ highWaterMark: 1, write(_chunk, _encoding, done) { release = done; } });
    const running = pipeline(source, target, sink).catch(error => error);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(generated).toBeLessThan(10);
    expect(target.readableLength).toBeLessThanOrEqual(chunk.length + 64);
    expect(target.writableLength).toBeLessThanOrEqual(chunk.length + 64);
    sink.destroy();
    release();
    await running;
  });

  it.each([
    { headerBytes: 8193 }, { bodyBytes: 16 * 1024 * 1024 + 1 }, { frames: 0 }, { totalBytes: Infinity },
    { chunkBytes: 0 }, { bufferBytes: 65537 }, { frameMs: NaN }, { lifetimeMs: -1 },
  ])("rejects invalid/unbounded guard limits: %j", overrides => {
    expect(() => guard(overrides)).toThrow("The coding RPC limits are invalid.");
  });
});
