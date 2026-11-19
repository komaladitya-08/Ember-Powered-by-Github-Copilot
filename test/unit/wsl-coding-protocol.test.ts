/** Framing and captured bytes, independent of Windows/WSL or an executing project. */
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { decodeWslCodingMessage, decodeWslCodingTree, encodeWslCodingTree, wslCodingFrame, wslCodingFrameSink } from "../../app/main/agent/wsl-coding-protocol";
const envelope = { episode: "a".repeat(32), nonce: "b".repeat(32) };
const enveloped = (source: string) => '{"episode":"' + envelope.episode + '","nonce":"' + envelope.nonce + '",' + source.slice(1);

describe("isolated WSL messages", () => {
  it("preserves exact argument boundaries and framed chunks", async () => {
    const value = { ...envelope, id: 1, method: "runNode" as const, params: { argv: ["file name.cjs", "$(no shell)", "λ"], cwd: "/work" } };
    const frame = wslCodingFrame(value), found: unknown[] = [], { guard, sink } = wslCodingFrameSink(body => found.push(decodeWslCodingMessage(body, "request")));
    await pipeline(Readable.from([...frame].map(byte => Buffer.from([byte]))), guard, sink); expect(found).toEqual([value]);
  });
  it.each(['{"id":1,"id":2,"method":"hello","params":{}}', '{"id":1,"\\u0069d":2,"method":"hello","params":{}}',
    '{"id":1,"method":"shell","params":{}}', '{"id":1,"method":"hello","params":{},"extra":1}', '{"id":0,"method":"hello","params":{}}'])(
    "refuses ambiguous or unsupported requests %s", source => { expect(() => decodeWslCodingMessage(Buffer.from(enveloped(source)), "request")).toThrow("could not be verified"); });
  it("refuses oversized and truncated frames before accepting a message", async () => {
    for (const frame of [Buffer.from("Content-Length: 16777217\r\n\r\n"), Buffer.from("Content-Length: 5\r\n\r\n{}")]) {
      const found: unknown[] = [], { guard, sink } = wslCodingFrameSink(body => found.push(body));
      await expect(pipeline(Readable.from([frame]), guard, sink)).rejects.toThrow(); expect(found).toEqual([]);
    }
  });
  it("accepts only fixed response shapes and valid UTF-8", () => {
    expect(() => decodeWslCodingMessage(Buffer.from(enveloped('{"kind":"failure","id":1,"code":"PRIVATE"}')), "response")).toThrow();
    expect(() => decodeWslCodingMessage(Buffer.from([0xff, 0xfe]), "response")).toThrow();
    expect(decodeWslCodingMessage(Buffer.from(enveloped('{"kind":"failure","id":1,"code":"cleanup"}')), "response")).toEqual({ ...envelope, kind: "failure", id: 1, code: "cleanup" });
  });
});
describe("WSL source and proposal transfer", () => {
  const binding = { owner: "a".repeat(64), session: randomUUID(), snapshot: randomUUID() };
  it("round-trips binary and empty entries without sharing caller-owned buffers", () => {
    const bytes = Buffer.from([0, 1, 255]), value = { binding, entries: [{ path: "empty", kind: "directory" as const }, { path: "a.bin", kind: "file" as const, bytes, executable: false }] };
    const encoded = encodeWslCodingTree(value), decoded = decodeWslCodingTree(encoded);
    expect(decoded).toEqual(value); bytes.fill(3); expect(decoded.entries.find(e => e.kind === "file")?.bytes).toEqual(Buffer.from([0, 1, 255]));
  });
  it.each(["digest", "size", "escape", "alias", "parent", "extra"])("rejects %s without admitting a partial tree", kind => {
    const encoded = encodeWslCodingTree({ binding, entries: [{ path: "a", kind: "file", bytes: Buffer.from("value"), executable: false }] }) as { entries: Record<string, unknown>[] };
    if (kind === "digest") encoded.entries[0].sha256 = "0".repeat(64);
    if (kind === "size") encoded.entries[0].bytes = 4;
    if (kind === "escape") encoded.entries[0].path = "../a";
    if (kind === "alias") encoded.entries.push({ ...encoded.entries[0], path: "A" });
    if (kind === "parent") encoded.entries[0].path = "missing/a";
    if (kind === "extra") encoded.entries[0].target = "/host";
    expect(() => decodeWslCodingTree(encoded)).toThrow("could not be verified");
  });
});
