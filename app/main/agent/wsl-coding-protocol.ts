/** Closed, bounded stdio messages between the trusted Windows controller and its credential-free Linux helper. */
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { z } from "zod";
import { CodingRpcFrameGuard, DEFAULT_CODING_RPC_FRAMING_LIMITS } from "./coding-rpc-framing";
import { createCodingReviewExport, type CodingExportTree } from "./coding-result-export";

export const WSL_CODING_PROTOCOL = 1;
export const WSL_CODING_MAX_PENDING = 8;
export const WSL_CODING_FRAME_BYTES = 16 * 1024 * 1024;
const fail = () => new Error("The isolated WSL coding transport could not be verified.");
const methods = ["hello", "provision", "open", "list", "readText", "writeText", "replaceText", "delete", "mkdir", "searchLiteral", "inspect", "run", "runNode", "stop", "sealFiles", "quiescent", "snapshot", "close"] as const;
export type WslCodingMethod = typeof methods[number];
const envelope = { episode: z.string().regex(/^[0-9a-f]{32}$/), nonce: z.string().regex(/^[0-9a-f]{32}$/) };
const requestSchema = z.object({ ...envelope, id: z.number().int().min(1).max(1_000_000), method: z.enum(methods), params: z.record(z.string(), z.unknown()) }).strict();
const responseSchema = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("result"), id: z.number().int().min(1).max(1_000_000), value: z.unknown() }).strict(),
  z.object({ ...envelope, kind: z.literal("failure"), id: z.number().int().min(1).max(1_000_000), code: z.enum(["unavailable", "request", "stopped", "failed", "cleanup"]) }).strict(),
  z.object({ ...envelope, kind: z.literal("output"), id: z.number().int().min(1).max(1_000_000), stream: z.enum(["stdout", "stderr"]), base64: z.string().max(128 * 1024) }).strict(),
]);
export type WslCodingRequest = z.infer<typeof requestSchema>;
export type WslCodingResponse = z.infer<typeof responseSchema>;
export type WslCodingResponsePayload = WslCodingResponse extends infer R ? R extends { episode: string; nonce: string } ? Omit<R, "episode" | "nonce"> : never : never;

/** Reject duplicate/escaped-alias object keys before JSON.parse discards that evidence. */
function parseJson(text: string): unknown {
  const stack: { kind: "object" | "array"; keys: Set<string>; key: boolean }[] = []; let containers = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i; for (i++; i < text.length; i++) { if (text[i] === "\\") i++; else if (text[i] === '"') break; }
      if (i >= text.length) throw fail();
      const parent = stack.at(-1);
      if (parent?.kind === "object" && parent.key) {
        if (i - start > 256) throw fail(); const key: unknown = JSON.parse(text.slice(start, i + 1));
        if (typeof key !== "string" || parent.keys.has(key)) throw fail(); parent.keys.add(key); parent.key = false;
      }
    } else if (c === "{" || c === "[") {
      if (stack.length >= 32 || ++containers > 128_000) throw fail(); stack.push({ kind: c === "{" ? "object" : "array", keys: new Set(), key: c === "{" });
    } else if (c === "}" || c === "]") {
      if (stack.pop()?.kind !== (c === "}" ? "object" : "array")) throw fail();
    } else if (c === ",") { const parent = stack.at(-1); if (parent?.kind === "object") parent.key = true; }
  }
  if (stack.length) throw fail(); return JSON.parse(text);
}
export function decodeWslCodingMessage(bytes: Buffer, direction: "request"): WslCodingRequest;
export function decodeWslCodingMessage(bytes: Buffer, direction: "response"): WslCodingResponse;
export function decodeWslCodingMessage(bytes: Buffer, direction: "request" | "response"): WslCodingRequest | WslCodingResponse {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > WSL_CODING_FRAME_BYTES) throw fail();
  const text = bytes.toString("utf8"); if (!Buffer.from(text).equals(bytes)) throw fail();
  try { return direction === "request" ? requestSchema.parse(parseJson(text)) : responseSchema.parse(parseJson(text)); } catch { throw fail(); }
}
export function wslCodingFrame(value: WslCodingRequest | WslCodingResponse): Buffer {
  const body = Buffer.from(JSON.stringify(value)); if (body.length > WSL_CODING_FRAME_BYTES) throw fail();
  return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n"), body]);
}

/** The existing guard bounds a declared length before this decoder retains a complete JSON frame. */
export function wslCodingFrameSink(receive: (bytes: Buffer) => void, signal?: AbortSignal): { guard: CodingRpcFrameGuard; sink: Writable } {
  const guard = new CodingRpcFrameGuard({ ...DEFAULT_CODING_RPC_FRAMING_LIMITS, totalBytes: 256 * 1024 * 1024 }, signal);
  let header = Buffer.alloc(0), remaining = 0, pieces: Buffer[] = [], size = 0;
  const sink = new Writable({ highWaterMark: 16 * 1024, write(chunk: Buffer, _encoding, done) {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!remaining) {
          const end = chunk.indexOf(10, offset); if (end < 0) { header = Buffer.concat([header, chunk.subarray(offset)]); if (header.length > 8192) throw fail(); break; }
          header = Buffer.concat([header, chunk.subarray(offset, end + 1)]); offset = end + 1;
          if (header.length > 8192) throw fail();
          if (!header.subarray(-4).equals(Buffer.from("\r\n\r\n"))) continue;
          const match = /^Content-Length: ([1-9][0-9]*)\r\n\r\n$/.exec(header.toString("ascii")); if (!match) throw fail();
          remaining = Number(match[1]); if (!Number.isSafeInteger(remaining) || remaining > WSL_CODING_FRAME_BYTES) throw fail(); header = Buffer.alloc(0);
        }
        const take = Math.min(remaining, chunk.length - offset); if (take) pieces.push(Buffer.from(chunk.subarray(offset, offset + take)));
        offset += take; remaining -= take; size += take;
        if (!remaining) { const body = Buffer.concat(pieces, size); pieces = []; size = 0; receive(body); }
      }
      done();
    } catch { done(fail()); }
  }, final(done) { done(header.length || remaining || pieces.length ? fail() : undefined); } });
  return { guard, sink };
}

const binding = z.object({ owner: z.string().regex(/^[0-9a-f]{64}$/), session: z.string().uuid(), snapshot: z.string().uuid() }).strict();
const directory = z.object({ path: z.string().max(4096), kind: z.literal("directory") }).strict();
const file = z.object({ path: z.string().max(4096), kind: z.literal("file"), base64: z.string().max(Math.ceil(4 * 1024 * 1024 / 3) * 4),
  bytes: z.number().int().min(0).max(4 * 1024 * 1024), sha256: z.string().regex(/^[0-9a-f]{64}$/), executable: z.boolean() }).strict();
const tree = z.object({ binding, entries: z.array(z.discriminatedUnion("kind", [directory, file])).max(10_000) }).strict();
export function encodeWslCodingTree(input: CodingExportTree): object {
  createCodingReviewExport({ binding: input.binding, baseline: input, proposed: input, current: input });
  return { binding: { ...input.binding }, entries: input.entries.map(e => e.kind === "directory" ? { ...e } : {
    path: e.path, kind: e.kind, base64: e.bytes.toString("base64"), bytes: e.bytes.length, sha256: createHash("sha256").update(e.bytes).digest("hex"), executable: e.executable }) };
}
export function decodeWslCodingTree(input: unknown): CodingExportTree {
  try {
    const data = tree.parse(input); let bytes = 0;
    const entries = data.entries.map(e => {
      if (e.kind === "directory") return e;
      if ((bytes += e.bytes) > 10 * 1024 * 1024 || e.base64.length !== Math.ceil(e.bytes / 3) * 4) throw fail();
      const body = Buffer.from(e.base64, "base64");
      if (body.length !== e.bytes || body.toString("base64") !== e.base64 || createHash("sha256").update(body).digest("hex") !== e.sha256) throw fail();
      return { path: e.path, kind: e.kind, bytes: body, executable: e.executable };
    });
    const result = { binding: data.binding, entries }; createCodingReviewExport({ binding: data.binding, baseline: result, proposed: result, current: result }); return result;
  } catch { throw fail(); }
}
