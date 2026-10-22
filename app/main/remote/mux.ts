/**
 * The framed stream both ends of an SSH link speak (§5.1.10; package MX): one byte stream (ssh's stdio) carrying four
 * streams in priority order (ctl > data > bulk > diag), with per-stream credits so a Stop never waits behind more
 * than a bounded amount of output (critique remote-23), and strict checks so anything malformed from the other end
 * resets the link instead of reaching Ember. The link worker (PC) and the remote agent use it unchanged, so it is
 * plain Node: no Electron, no koffi, no network module, no path module.
 *
 * Wire format (normative in §5.1.10):
 * - Preamble: the agent writes `\0EMBER-REMOTE/1 <partsId>\n`; the PC skips up to 64 KiB of noise before it (a
 *   .bashrc that prints), gives up after 20 s, and answers `\0EMBER-LOCAL/1 <partsId>\n`. Each side checks the other's
 *   partsId equals its own (the PC started exactly that version).
 * - Frame: `u32be length` (of what follows) `| u8 stream | u8 kind | payload`, at most 1 MiB.
 * - ctl (0): JSON messages ≤ 64 KiB (one frame each), CREDIT (`u8 stream | u32be bytes`), PING/PONG (`u64be` ms),
 *   RESET (`u16be code | reason ≤ 200 bytes`). Never credit-limited; always written first.
 * - data (1): JSON messages over 60 KiB in chunks (`u32be msgId | u8 last | bytes`), a message ≤ 4 MiB. Credited.
 * - bulk (2): BIN (`u32be channel | bytes`). Credited.
 * - diag (3): the agent's log lines as JSON `{ level, event }`, dropped while more than 64 KiB is queued.
 *
 * Choices this file makes where §5.1.10 leaves room (both ends run this code, so they agree by construction):
 * - A credit counts a data or bulk frame's payload bytes (sub-header included, the 6-byte frame header not), and the
 *   writer cuts chunks so that payload is at most 32 KiB: two full chunks fill the 64 KiB starting grant exactly.
 *   The reader accepts up to 32 KiB after the sub-header, as §5.1.10 words the limit.
 * - `ev: "log"` is the diag stream's message: an agent's `send({ t: "ev", ev: "log", d })` goes on diag, and a diag
 *   line arrives as that event.
 * - Order holds within a stream, not across them: a small answer on ctl overtakes bulk bytes written before it (that
 *   is the point of priorities). `ImageRef.bytes` and `cmd.exit`'s `outBytes` say how many bytes to wait for.
 * - The mux never ends or destroys the streams it is given: on close it stops reading and writing, and its owner
 *   (the link worker, the agent) ends the process or the stream.
 */

import { z } from "zod";
import type { Logger } from "../logger";
import { CAPS, ERR_CODES, EV_SCHEMAS, OP_SCHEMAS } from "./protocol";
import type { ErrCode, EvName, Msg, Op } from "./protocol";
import type { Mux } from "./types";

/** The streams of a frame. */
export const STREAM = { ctl: 0, data: 1, bulk: 2, diag: 3 } as const;
/** The kinds of a frame. */
export const KIND = { json: 1, bin: 2, credit: 3, ping: 4, pong: 5, reset: 6 } as const;
/** The codes a RESET carries (`reset(code, …)` may use any u16; these are the ones the mux sends itself). */
export const RESET_CODE = {
  /** An orderly close the owner asked for. */
  normal: 0,
  /** A malformed frame or preamble, an interleaved data message, a request id in use, a stream that carries text. */
  protocol: 1,
  /** A frame over 1 MiB, a ctl or diag JSON over 64 KiB, a chunk over 32 KiB, a data message over 4 MiB. */
  tooLarge: 2,
  /** An unknown stream, or a kind that stream doesn't carry. */
  unknown: 3,
  /** A message that isn't JSON or fails its envelope's, op's or event's schema. */
  schema: 4,
  /** The other end runs different parts, or another protocol version. */
  version: 5,
  /** More credit-limited bytes than were granted, or more credit than any window. */
  credit: 6,
  /** A message going the wrong way: a request from the agent, an answer or event from the PC, diag to the agent. */
  direction: 7,
  /** No preamble within 20 s. */
  timeout: 8,
} as const;

/** The partsId both ends compare (protocol.ts's `partsId` pattern). */
const PARTS_ID = /^[A-Za-z0-9._+-]{1,80}$/;
const AGENT_MARK = Buffer.from("\0EMBER-REMOTE/", "latin1");
const PC_MARK = Buffer.from("\0EMBER-LOCAL/", "latin1");
const PROTO_TEXT = "1";
/** The noise the PC skips before the agent's preamble (a .bashrc that prints). */
export const NOISE_MAX = 64 * 1024;
/** How long either end waits for the other's preamble. */
export const PREAMBLE_TIMEOUT_MS = 20_000;
/** The longest preamble line after its mark: the protocol version, a space, a partsId and the newline. */
const PREAMBLE_REST_MAX = PROTO_TEXT.length + 1 + 80 + 1;

/** The u32 length, the stream and the kind. */
const FRAME_HEAD = 6;
/** `u32be msgId | u8 last` before a data chunk's bytes. */
const DATA_HEAD = 5;
/** `u32be channel` before a bulk chunk's bytes. */
const BULK_HEAD = 4;
/** A JSON message this long or shorter goes on ctl; a longer one on data (§5.1.10: "larger than 60 KiB"). */
export const CTL_JSON_MAX = 60 * 1024;
/** Each credit-limited stream's grant at start (critique remote-23). */
export const WINDOW_START = 64 * 1024;
/** The most a stream's grant grows to (critique remote-23). */
export const WINDOW_MAX = 256 * 1024;
/** A grant grows only while the measured throughput moves every granted byte within this long (s). */
export const IN_FLIGHT_TARGET_S = 0.25;
/** The diag stream keeps at most this many bytes queued; later lines are dropped until it drains. */
export const DIAG_QUEUE_MAX = 64 * 1024;
/** A reader returns credit once at least this much of a grant is used (fewer CREDIT frames, never a stall: see cut()). */
const CREDIT_MIN = 8 * 1024;
/** A writer waits for credit rather than send a chunk smaller than this (unless that is all that is left). */
const CHUNK_MIN = 1024;
const RESET_REASON_MAX = 200;
/** Requests awaiting their answer, per direction: far more than any link has, few enough to bound the map. */
const PENDING_MAX = 4096;
/** rttMs is the lowest of the last few pings (the idle RTT the escalation deadline wants, §5.1.11). */
const RTT_SAMPLES = 8;
const PINGS_MAX = 32;
/** PONGs queued behind a blocked pipe: more would only let a peer that pings without reading grow this end's memory. */
const PONGS_QUEUED_MAX = 8;
/** A credit-limited stream counts as busy (its outstanding grant as in flight) this long after its last bytes. */
const BUSY_MS = 1000;

/** A message the mux refused to send (`send` and `sendBytes` throw it; nothing was queued). */
export class MuxError extends Error {
  constructor(readonly code: "too_large" | "invalid", message: string) {
    super(message);
    this.name = "MuxError";
  }
}

/** Test seams for `createMux`: a monotonic clock in ms (default `performance.now()`). */
export interface MuxTuning {
  now?: () => number;
}

/** The preamble line each role writes (`role` is the writer). */
export function preambleLine(role: "pc" | "agent", partsId: string): Buffer {
  return Buffer.concat([role === "agent" ? AGENT_MARK : PC_MARK, Buffer.from(`${PROTO_TEXT} ${partsId}\n`, "latin1")]);
}

/**
 * The credit rule of critique remote-23 for one stream, evaluated each time a full grant of it has been used: double
 * it (up to WINDOW_MAX) while every byte granted on both credit-limited streams would still arrive within 250 ms at
 * the measured throughput; halve it (down to WINDOW_START) once they wouldn't; else keep it. `other` is the other
 * credit-limited stream's grant; `throughput` is in bytes/s, 0 when not measured yet (no growth).
 */
export function nextWindow(current: number, other: number, throughput: number): number {
  const budget = throughput * IN_FLIGHT_TARGET_S;
  const grown = Math.min(WINDOW_MAX, current * 2);
  if (throughput > 0 && grown > current && grown + other <= budget) return grown;
  if (current > WINDOW_START && current + other > budget) return Math.max(WINDOW_START, Math.floor(current / 2));
  return current;
}

/**
 * Throughput of the credit-limited bytes arriving from the other end, in bytes/s. A sample spans at least 250 ms from
 * one read to a later one and counts the bytes of the reads after its first (those were already on their way before
 * its clock started); a read is all the frames that arrive at one instant, so a sample is closed by the first arrival
 * after it is long enough. It restarts after 500 ms of quiet. It errs low: a low figure only slows growth and
 * lengthens the escalation deadline.
 */
export class RateMeter {
  private start = -1;
  private last = -1;
  private bytes = 0;
  private est = 0;

  constructor(private readonly sampleMs = 250, private readonly idleMs = 500) {}

  /** `n` bytes arrived at time `t` (ms). */
  add(n: number, t: number): void {
    if (this.start < 0 || t - this.last > this.idleMs) {
      this.start = t;
      this.last = t;
      this.bytes = 0;
      return;
    }
    // More of the read that opened the sample.
    if (t === this.start) return;
    if (t !== this.last && this.last - this.start >= this.sampleMs) {
      const r = (this.bytes * 1000) / (this.last - this.start);
      this.est = this.est > 0 ? (this.est + r) / 2 : r;
      this.start = this.last;
      this.bytes = 0;
    }
    this.bytes += n;
    this.last = t;
  }

  /** The estimate (bytes/s), 0 until a sample completes. */
  rate(): number {
    return this.est;
  }
}

/** The bytes received and not yet parsed: a list of chunks, so a frame arriving a byte at a time costs O(n). */
class ByteQueue {
  private chunks: Buffer[] = [];
  private head = 0;
  length = 0;

  push(b: Buffer): void {
    if (!b.length) return;
    this.chunks.push(b);
    this.length += b.length;
  }

  /** The first `n` bytes (n ≤ length), not consumed. Shares memory with the queue when it can: read it, don't keep it. */
  peek(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    if (first.length - this.head >= n) return first.subarray(this.head, this.head + n);
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    let off = this.head;
    for (const c of this.chunks) {
      const k = Math.min(n - at, c.length - off);
      c.copy(out, at, off, off + k);
      at += k;
      off = 0;
      if (at === n) break;
    }
    return out;
  }

  /** Consumes and returns the first `n` bytes (n ≤ length). */
  take(n: number): Buffer {
    const out = this.peek(n);
    this.skip(n);
    return out;
  }

  skip(n: number): void {
    this.length -= n;
    while (n > 0) {
      const left = this.chunks[0].length - this.head;
      if (left > n) {
        this.head += n;
        return;
      }
      n -= left;
      this.chunks.shift();
      this.head = 0;
    }
  }

  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.length = 0;
  }
}

/** A frame with room for `n` payload bytes at offset FRAME_HEAD (the caller fills them). */
function frameFor(stream: number, kind: number, n: number): Buffer {
  const f = Buffer.allocUnsafe(FRAME_HEAD + n);
  f.writeUInt32BE(n + 2, 0);
  f[4] = stream;
  f[5] = kind;
  return f;
}

/** A whole frame around `payload`. */
function frame(stream: number, kind: number, payload: Uint8Array): Buffer {
  const f = frameFor(stream, kind, payload.length);
  f.set(payload, FRAME_HEAD);
  return f;
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what's replaced here
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** Text for a RESET or a log line: control characters made spaces, at most `max` UTF-8 bytes, cut at a character. */
function plainText(s: string, max: number): string {
  const t = s.replace(CONTROL, " ");
  const b = Buffer.from(t, "utf8");
  return b.length <= max ? t : b.subarray(0, max).toString("utf8").replace(/\uFFFD+$/, "");
}

/** Where a schema failed (paths and codes only: never a value, which may be a window title or typed text). */
function issuesOf(e: z.ZodError): string {
  return plainText(e.issues.slice(0, 3).map(i => `${i.path.map(String).join(".") || "(top)"}: ${i.code}`).join("; "), 150);
}

function errText(e: unknown): string {
  return plainText(e instanceof Error ? e.message : String(e), 200);
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const OPS = Object.keys(OP_SCHEMAS) as [Op, ...Op[]];
const EVS = Object.keys(EV_SCHEMAS) as [EvName, ...EvName[]];
const ID = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** The envelope every ctl/data message has; `a`, `v` and `d` are then checked against their op's or event's schema. */
const ENVELOPE = z.union([
  z.object({ t: z.literal("req"), id: ID, op: z.enum(OPS), a: z.unknown() }).strict(),
  z.object({ t: z.literal("res"), id: ID, ok: z.literal(true), v: z.unknown() }).strict(),
  z.object({ t: z.literal("res"), id: ID, ok: z.literal(false), e: z.object({ code: z.enum(ERR_CODES), m: z.string().max(CAPS.str.reason) }).strict() }).strict(),
  z.object({ t: z.literal("ev"), ev: z.enum(EVS), d: z.unknown() }).strict(),
]);

type Role = "pc" | "agent";
type Limited = 1 | 2;
/** A data message or a bulk send not yet written in full: `id` is the msgId or the channel, `at` how far it got. */
interface Outgoing { id: number; bytes: Buffer; at: number }
/** A log line as the diag stream carries it (EvMap["log"]). */
interface LogLine { level: "debug" | "info" | "warn" | "error"; event: string }
/** A checked message ready to queue: its wire form, whether it goes on diag, and the state change sending it makes. */
interface Checked { wire: Msg | LogLine; diag: boolean; commit: () => void }
interface Problem { code: number; why: string }

class FramedMux implements Mux {
  private state: "preamble" | "open" | "closed" = "preamble";
  private why = "";
  private ownPreambleSent = false;
  private preambleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The bytes seen before the other end's preamble line ended (bounded: NOISE_MAX and one line at most). */
  private pre: Buffer;
  private preLen = 0;
  private preSearch = 0;

  private readonly inq = new ByteQueue();
  private lastFrameAt: number;
  /** The data message being reassembled: one buffer grown by doubling, so its memory stays near its size however it is cut. */
  private assembling: { id: number; buf: Buffer; len: number } | null = null;
  /** Reader side of the credits: what this end granted, received and aims to keep granted, per stream. */
  private readonly granted: Record<Limited, number> = { 1: WINDOW_START, 2: WINDOW_START };
  private readonly received: Record<Limited, number> = { 1: 0, 2: 0 };
  private readonly window: Record<Limited, number> = { 1: WINDOW_START, 2: WINDOW_START };
  private readonly sinceEval: Record<Limited, number> = { 1: 0, 2: 0 };
  private readonly lastArrival: Record<Limited, number> = { 1: -Infinity, 2: -Infinity };
  private readonly meter = new RateMeter();

  /** PING, PONG and CREDIT frames: tiny, and ahead even of ctl messages (an RTT sample and a stalled sender want them now). */
  private readonly urgent: Buffer[] = [];
  private pongsQueued = 0;
  private readonly ctl: Buffer[] = [];
  private readonly data: Outgoing[] = [];
  private readonly bulk: Outgoing[] = [];
  private readonly diag: Buffer[] = [];
  private diagBytes = 0;
  private diagDropped = 0;
  /** Writer side of the credits: what this end may still send, and the most it has been allowed at once. */
  private readonly avail: Record<Limited, number> = { 1: WINDOW_START, 2: WINDOW_START };
  private readonly availHigh: Record<Limited, number> = { 1: WINDOW_START, 2: WINDOW_START };
  /** When this end last sent bytes on, or got credit for, each credit-limited stream (its bytes may be in flight). */
  private readonly lastOut: Record<Limited, number> = { 1: -Infinity, 2: -Infinity };
  private waitingDrain = false;
  private pumping = false;
  private nextMsgId = 1;

  /** PC: requests sent and not answered; agent: requests received and not answered. id → op. */
  private readonly pending = new Map<number, Op>();
  private readonly pings = new Set<number>();
  private readonly rtts: number[] = [];

  private readonly msgFns = new Set<(msg: Msg) => void>();
  private readonly bytesFns = new Set<(channel: number, bytes: Uint8Array) => void>();
  private readonly closeFns = new Set<(why: string) => void>();

  private readonly onReadData = (chunk: unknown): void => this.receive(chunk);
  private readonly onReadEnd = (): void => this.close("the other end closed the link");
  private readonly onReadError = (e: unknown): void => this.close(`the link's input failed: ${errText(e)}`);
  private readonly onWriteClose = (): void => this.close("the link's output closed");
  private readonly onWriteError = (e: unknown): void => this.close(`the link's output failed: ${errText(e)}`);
  private readonly onDrain = (): void => {
    this.waitingDrain = false;
    this.pump();
  };

  constructor(
    private readonly read: NodeJS.ReadableStream,
    private readonly write: NodeJS.WritableStream,
    private readonly role: Role,
    private readonly partsId: string,
    private readonly log: Logger,
    private readonly now: () => number,
  ) {
    this.lastFrameAt = now();
    this.pre = Buffer.alloc(role === "agent" ? preambleLine("pc", partsId).length : NOISE_MAX + AGENT_MARK.length + PREAMBLE_REST_MAX);
    read.on("data", this.onReadData);
    read.on("end", this.onReadEnd);
    read.on("close", this.onReadEnd);
    read.on("error", this.onReadError);
    write.on("error", this.onWriteError);
    write.on("close", this.onWriteClose);
    this.preambleTimer = setTimeout(() => {
      if (this.state === "preamble") this.fail(RESET_CODE.timeout, `no preamble from the ${this.role === "pc" ? "remote agent" : "PC"} within ${PREAMBLE_TIMEOUT_MS / 1000} s`);
    }, PREAMBLE_TIMEOUT_MS);
    (this.preambleTimer as { unref?: () => void }).unref?.();
    if (role === "agent") this.sendPreamble();
    read.resume();
  }

  // -- The Mux interface ---------------------------------------------------------------------------------------------

  send(msg: Msg): void {
    if (this.state === "closed") return;
    const c = this.check(msg);
    const bytes = Buffer.from(JSON.stringify(c.wire), "utf8");
    if (c.diag) {
      if (bytes.length > CAPS.ctlBytes) throw new MuxError("too_large", `a log line of ${bytes.length} bytes`);
      c.commit();
      if (this.diagBytes + FRAME_HEAD + bytes.length > DIAG_QUEUE_MAX) {
        this.diagDropped++;
        return;
      }
      const f = frame(STREAM.diag, KIND.json, bytes);
      this.diag.push(f);
      this.diagBytes += f.length;
    } else {
      if (bytes.length > CAPS.dataMessageBytes) throw new MuxError("too_large", `a message of ${bytes.length} bytes (at most ${CAPS.dataMessageBytes})`);
      c.commit();
      if (bytes.length <= CTL_JSON_MAX) this.ctl.push(frame(STREAM.ctl, KIND.json, bytes));
      else {
        this.data.push({ id: this.nextMsgId, bytes, at: 0 });
        this.nextMsgId = (this.nextMsgId + 1) >>> 0;
      }
    }
    this.pump();
  }

  onMessage(fn: (msg: Msg) => void): () => void {
    this.msgFns.add(fn);
    return () => { this.msgFns.delete(fn); };
  }

  sendBytes(channel: number, bytes: Uint8Array): void {
    if (this.state === "closed") return;
    if (!Number.isInteger(channel) || channel < 0 || channel > 0xffff_ffff) throw new MuxError("invalid", "a bulk channel is a whole number from 0 to 2^32-1");
    if (!(bytes instanceof Uint8Array)) throw new MuxError("invalid", "bulk bytes come as a Uint8Array");
    if (!bytes.length) return;
    // A copy: the caller may reuse its buffer before the last chunk is written.
    this.bulk.push({ id: channel, bytes: Buffer.from(bytes), at: 0 });
    this.pump();
  }

  onBytes(fn: (channel: number, bytes: Uint8Array) => void): () => void {
    this.bytesFns.add(fn);
    return () => { this.bytesFns.delete(fn); };
  }

  ping(): void {
    // Before both preambles there is no link to measure: a ping queued then would only report the wait.
    if (this.state !== "open") return;
    const v = Math.max(0, Math.floor(this.now()));
    this.pings.add(v);
    if (this.pings.size > PINGS_MAX) this.pings.delete(this.pings.values().next().value as number);
    const f = frameFor(STREAM.ctl, KIND.ping, 8);
    f.writeBigUInt64BE(BigInt(v), FRAME_HEAD);
    this.urgent.push(f);
    this.pump();
  }

  silentMs(): number {
    return Math.max(0, this.now() - this.lastFrameAt);
  }

  get rttMs(): number {
    return this.rtts.length ? Math.min(...this.rtts) : 0;
  }

  inFlight(): { bytes: number; throughput: number } {
    const t = this.now();
    const busy = Math.max(BUSY_MS, 4 * this.rttMs);
    let bytes = 0;
    for (const s of [STREAM.data, STREAM.bulk] as const) {
      // Granted to the other end and not arrived: on its way (or about to be) if the stream has been busy lately.
      if (t - this.lastArrival[s] <= busy) bytes += this.granted[s] - this.received[s];
      // Sent by this end and not credited back yet, while it is still sending or credit is still coming back. Only
      // then: a reader that shrank its grant returns less credit than it got, which looks like bytes in flight forever.
      if (t - this.lastOut[s] <= busy) bytes += Math.max(0, this.availHigh[s] - this.avail[s]);
    }
    return { bytes, throughput: Math.round(this.meter.rate()) };
  }

  reset(code: number, reason: string): void {
    if (this.state === "closed") return;
    if (!Number.isInteger(code) || code < 0 || code > 0xffff) throw new MuxError("invalid", "a reset code is a whole number from 0 to 65535");
    const text = plainText(String(reason), RESET_REASON_MAX);
    this.log.info("remote.mux_reset_sent", { role: this.role, code });
    this.writeReset(code, text);
    this.close(`reset here (${code}): ${text}`);
  }

  onClose(fn: (why: string) => void): () => void {
    if (this.state === "closed") {
      const why = this.why;
      queueMicrotask(() => {
        try { fn(why); } catch (e) { this.log.error("remote.mux_listener_failed", { error: e }); }
      });
      return () => {};
    }
    this.closeFns.add(fn);
    return () => { this.closeFns.delete(fn); };
  }

  // -- Sending -------------------------------------------------------------------------------------------------------

  /** Checks a message this end is about to send, as strictly as the other end will; throws MuxError, changes nothing. */
  private check(msg: Msg): Checked {
    const m = msg as Partial<{ t: unknown; id: unknown; op: unknown; a: unknown; ok: unknown; v: unknown; e: unknown; ev: unknown; d: unknown }> | null;
    if (!m || typeof m !== "object") throw new MuxError("invalid", "a message is an object");
    const isId = (id: unknown): id is number => ID.safeParse(id).success;
    if (m.t === "req") {
      if (this.role !== "pc") throw new MuxError("invalid", "the agent never sends a request");
      if (!isId(m.id)) throw new MuxError("invalid", "a request's id is a whole number from 0");
      if (typeof m.op !== "string" || !Object.hasOwn(OP_SCHEMAS, m.op)) throw new MuxError("invalid", "a request for an unknown op");
      const id = m.id;
      const op = m.op as Op;
      if (this.pending.has(id)) throw new MuxError("invalid", `request ${id} is still waiting for its answer`);
      if (this.pending.size >= PENDING_MAX) throw new MuxError("invalid", "too many requests waiting for their answers");
      const a = (OP_SCHEMAS[op].args as z.ZodType<unknown>).safeParse(m.a);
      if (!a.success) throw new MuxError("invalid", `${op}'s arguments fail their schema (${issuesOf(a.error)})`);
      return { wire: { t: "req", id, op, a: a.data }, diag: false, commit: () => { this.pending.set(id, op); } };
    }
    if (m.t === "res") {
      if (this.role !== "agent") throw new MuxError("invalid", "the PC never sends an answer");
      if (!isId(m.id)) throw new MuxError("invalid", "an answer's id is a whole number from 0");
      const id = m.id;
      const op = this.pending.get(id);
      if (!op) throw new MuxError("invalid", `no request ${id} is waiting for an answer`);
      const commit = () => { this.pending.delete(id); };
      if (m.ok === true) {
        const v = (OP_SCHEMAS[op].result as z.ZodType<unknown>).safeParse(m.v);
        if (!v.success) throw new MuxError("invalid", `${op}'s result fails its schema (${issuesOf(v.error)})`);
        return { wire: { t: "res", id, ok: true, v: v.data }, diag: false, commit };
      }
      const e = m.e as { code?: unknown; m?: unknown } | null | undefined;
      if (m.ok !== false || !e || typeof e !== "object" || !(ERR_CODES as readonly unknown[]).includes(e.code) || typeof e.m !== "string") {
        throw new MuxError("invalid", "an answer is { ok: true, v } or { ok: false, e: { code, m } }");
      }
      // The error text is this end's own: cut to what the other end accepts rather than lose the answer.
      return { wire: { t: "res", id, ok: false, e: { code: e.code as ErrCode, m: e.m.slice(0, CAPS.str.reason) } }, diag: false, commit };
    }
    if (m.t === "ev") {
      if (this.role !== "agent") throw new MuxError("invalid", "the PC never sends an event");
      if (typeof m.ev !== "string" || !Object.hasOwn(EV_SCHEMAS, m.ev)) throw new MuxError("invalid", "an unknown event");
      const ev = m.ev as EvName;
      const d = (EV_SCHEMAS[ev] as z.ZodType<unknown>).safeParse(m.d);
      if (!d.success) throw new MuxError("invalid", `${ev}'s data fails its schema (${issuesOf(d.error)})`);
      if (ev === "log") return { wire: d.data as LogLine, diag: true, commit: () => {} };
      return { wire: { t: "ev", ev, d: d.data }, diag: false, commit: () => {} };
    }
    throw new MuxError("invalid", "a message's t is req, res or ev");
  }

  /** Writes queued frames in priority order while the stream accepts them and credit allows. */
  private pump(): void {
    if (this.pumping || this.waitingDrain || this.state !== "open") return;
    this.pumping = true;
    try {
      for (;;) {
        const f = this.nextFrame();
        if (!f) return;
        let ok: boolean;
        try {
          ok = this.write.write(f);
        } catch (e) {
          this.close(`the link's output failed: ${errText(e)}`);
          return;
        }
        if (this.state !== "open") return;
        if (!ok) {
          this.waitingDrain = true;
          this.write.once("drain", this.onDrain);
          return;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private nextFrame(): Buffer | null {
    const u = this.urgent.shift();
    if (u) {
      if (u[5] === KIND.pong) this.pongsQueued--;
      return u;
    }
    const c = this.ctl.shift();
    if (c) return c;
    const d = this.cut(STREAM.data);
    if (d) return d;
    const b = this.cut(STREAM.bulk);
    if (b) return b;
    const g = this.diag.shift();
    if (g) {
      this.diagBytes -= g.length;
      return g;
    }
    return null;
  }

  /** The next chunk of the stream's first message or send, sized to the credit left; null while credit is short. */
  private cut(s: Limited): Buffer | null {
    const q = s === STREAM.data ? this.data : this.bulk;
    const item = q[0];
    if (!item) return null;
    const head = s === STREAM.data ? DATA_HEAD : BULK_HEAD;
    const left = item.bytes.length - item.at;
    const n = Math.min(left, CAPS.chunkBytes - head, this.avail[s] - head);
    // The reader returns credit once 8 KiB of a ≥ 64 KiB grant is used, so this always ends when bytes arrive there.
    if (n < Math.min(left, CHUNK_MIN)) return null;
    const f = frameFor(s, s === STREAM.data ? KIND.json : KIND.bin, head + n);
    f.writeUInt32BE(item.id, FRAME_HEAD);
    const end = item.at + n;
    if (s === STREAM.data) f[FRAME_HEAD + 4] = end === item.bytes.length ? 1 : 0;
    item.bytes.copy(f, FRAME_HEAD + head, item.at, end);
    item.at = end;
    if (end === item.bytes.length) q.shift();
    this.avail[s] -= head + n;
    this.lastOut[s] = this.now();
    return f;
  }

  private sendPreamble(): void {
    this.ownPreambleSent = true;
    try {
      if (!this.write.write(preambleLine(this.role, this.partsId))) {
        this.waitingDrain = true;
        this.write.once("drain", this.onDrain);
      }
    } catch (e) {
      this.close(`the link's output failed: ${errText(e)}`);
    }
  }

  /** A RESET ahead of anything queued, once this end's preamble is out (before it, the other end isn't reading frames). */
  private writeReset(code: number, reason: string): void {
    if (!this.ownPreambleSent) return;
    const r = Buffer.from(reason, "utf8");
    const f = frameFor(STREAM.ctl, KIND.reset, 2 + r.length);
    f.writeUInt16BE(code, FRAME_HEAD);
    r.copy(f, FRAME_HEAD + 2);
    try {
      this.write.write(f);
    } catch {
      // The link is closing because something is wrong already; a RESET that can't be written changes nothing.
    }
  }

  // -- Receiving -----------------------------------------------------------------------------------------------------

  private receive(chunk: unknown): void {
    if (this.state === "closed") return;
    if (typeof chunk === "string") return this.fail(RESET_CODE.protocol, "the link's input carries text, not bytes (an encoding is set on it)");
    if (!(chunk instanceof Uint8Array)) return this.fail(RESET_CODE.protocol, "the link's input carries something other than bytes");
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (this.state === "preamble") this.takePreamble(b);
    else this.inq.push(b);
    if (this.state !== "open") return;
    this.parseFrames();
    if (this.state !== "open") return;
    this.grantCredits();
    this.pump();
  }

  /** Reads the other end's preamble; once it is whole and right, the bytes after it are frames. */
  private takePreamble(b: Buffer): void {
    const n = Math.min(b.length, this.pre.length - this.preLen);
    b.copy(this.pre, this.preLen, 0, n);
    this.preLen += n;
    const rest = b.subarray(n);
    const seen = this.pre.subarray(0, this.preLen);
    if (this.role === "agent") {
      const want = preambleLine("pc", this.partsId);
      if (!seen.equals(want.subarray(0, this.preLen))) {
        const k = Math.min(seen.length, PC_MARK.length);
        if (seen.subarray(0, k).equals(PC_MARK.subarray(0, k)) && seen.length > PC_MARK.length) {
          return this.fail(RESET_CODE.version, "the PC started a different version of Ember's parts or protocol than this agent");
        }
        return this.fail(RESET_CODE.protocol, "the PC's first bytes aren't Ember's preamble");
      }
      if (this.preLen === want.length) this.open(rest);
      return;
    }
    const at = seen.indexOf(AGENT_MARK, this.preSearch);
    if (at < 0) {
      if (this.preLen >= NOISE_MAX + AGENT_MARK.length) return this.fail(RESET_CODE.protocol, `more than ${NOISE_MAX / 1024} KiB came before the remote agent's preamble`);
      this.preSearch = Math.max(0, this.preLen - AGENT_MARK.length + 1);
      return;
    }
    if (at > NOISE_MAX) return this.fail(RESET_CODE.protocol, `more than ${NOISE_MAX / 1024} KiB came before the remote agent's preamble`);
    const lineStart = at + AGENT_MARK.length;
    const nl = seen.indexOf(0x0a, lineStart);
    if (nl < 0) {
      if (this.preLen - lineStart >= PREAMBLE_REST_MAX) this.fail(RESET_CODE.protocol, "the remote agent's preamble line is too long");
      return;
    }
    const line = seen.subarray(lineStart, nl).toString("latin1");
    const sp = line.indexOf(" ");
    const version = sp < 0 ? line : line.slice(0, sp);
    if (version !== PROTO_TEXT) return this.fail(RESET_CODE.version, `the remote agent speaks protocol ${plainText(version, 16)}, not ${PROTO_TEXT}`);
    if (line.slice(sp + 1) !== this.partsId) return this.fail(RESET_CODE.version, "the remote agent runs different parts of Ember than the PC started");
    if (at > 0) this.log.debug("remote.mux_noise_skipped", { bytes: at });
    // What followed the line in the same reads is the start of the agent's frames (copied: `pre` is let go).
    const after = Buffer.concat([seen.subarray(nl + 1), rest]);
    this.sendPreamble();
    this.open(after);
  }

  private open(rest: Buffer): void {
    if (this.state !== "preamble") return;
    this.state = "open";
    if (this.preambleTimer) clearTimeout(this.preambleTimer);
    this.preambleTimer = null;
    this.pre = Buffer.alloc(0);
    this.lastFrameAt = this.now();
    this.log.debug("remote.mux_open", { role: this.role });
    this.inq.push(rest);
  }

  private parseFrames(): void {
    while (this.state === "open" && this.inq.length >= 4) {
      const len = this.inq.peek(4).readUInt32BE(0);
      if (len > CAPS.frameBytes) return this.fail(RESET_CODE.tooLarge, `a frame of ${len} bytes (at most ${CAPS.frameBytes})`);
      if (len < 2) return this.fail(RESET_CODE.protocol, "a frame without its stream and kind");
      if (this.inq.length < FRAME_HEAD) return;
      const head = this.inq.peek(FRAME_HEAD);
      const stream = head[4];
      const kind = head[5];
      const problem = this.checkHead(stream, kind, len - 2);
      if (problem) return this.fail(problem.code, problem.why);
      if (this.inq.length < 4 + len) return;
      this.inq.skip(FRAME_HEAD);
      const payload = this.inq.take(len - 2);
      this.lastFrameAt = this.now();
      this.onFrame(stream, kind, payload);
    }
  }

  /** Whether a frame's stream, kind and size are allowed here, checked before its payload is buffered. */
  private checkHead(stream: number, kind: number, n: number): Problem | null {
    const wrongKind = (name: string): Problem => ({ code: RESET_CODE.unknown, why: `a frame of kind ${kind} on the ${name} stream` });
    switch (stream) {
      case STREAM.ctl:
        switch (kind) {
          case KIND.json: return n > CAPS.ctlBytes ? { code: RESET_CODE.tooLarge, why: `a ctl message of ${n} bytes (at most ${CAPS.ctlBytes})` } : null;
          case KIND.credit: return n === 5 ? null : { code: RESET_CODE.protocol, why: "a CREDIT that isn't 5 bytes" };
          case KIND.ping:
          case KIND.pong: return n === 8 ? null : { code: RESET_CODE.protocol, why: "a PING or PONG that isn't 8 bytes" };
          case KIND.reset: return n >= 2 && n <= 2 + RESET_REASON_MAX ? null : { code: RESET_CODE.protocol, why: "a RESET of the wrong size" };
          default: return wrongKind("ctl");
        }
      case STREAM.data:
      case STREAM.bulk: {
        const s = stream as Limited;
        const sub = s === STREAM.data ? DATA_HEAD : BULK_HEAD;
        if (kind !== (s === STREAM.data ? KIND.json : KIND.bin)) return wrongKind(s === STREAM.data ? "data" : "bulk");
        if (n <= sub) return { code: RESET_CODE.protocol, why: "an empty chunk" };
        if (n > sub + CAPS.chunkBytes) return { code: RESET_CODE.tooLarge, why: `a chunk of ${n - sub} bytes (at most ${CAPS.chunkBytes})` };
        if (n > this.granted[s] - this.received[s]) return { code: RESET_CODE.credit, why: "more bytes than this end granted" };
        return null;
      }
      case STREAM.diag:
        if (kind !== KIND.json) return wrongKind("diag");
        if (this.role !== "pc") return { code: RESET_CODE.direction, why: "log lines from the PC (only the agent sends them)" };
        return n > CAPS.ctlBytes ? { code: RESET_CODE.tooLarge, why: `a log line of ${n} bytes` } : null;
      default:
        return { code: RESET_CODE.unknown, why: `a frame on unknown stream ${stream}` };
    }
  }

  private onFrame(stream: number, kind: number, payload: Buffer): void {
    switch (stream) {
      case STREAM.ctl:
        switch (kind) {
          case KIND.json: return this.onJson(payload, false);
          case KIND.credit: return this.onCredit(payload);
          case KIND.ping: return this.onPing(payload);
          case KIND.pong: return this.onPong(payload);
          case KIND.reset: return this.onReset(payload);
        }
        return;
      case STREAM.data:
        this.arrived(STREAM.data, payload.length);
        return this.onChunk(payload);
      case STREAM.bulk:
        this.arrived(STREAM.bulk, payload.length);
        return this.onBulk(payload);
      case STREAM.diag:
        return this.onJson(payload, true);
    }
  }

  private arrived(s: Limited, n: number): void {
    const t = this.now();
    this.received[s] += n;
    this.sinceEval[s] += n;
    this.lastArrival[s] = t;
    this.meter.add(n, t);
  }

  private onBulk(payload: Buffer): void {
    const channel = payload.readUInt32BE(0);
    // Each listener gets bytes that own their ArrayBuffer, so the link worker can transfer it to the main thread.
    for (const fn of [...this.bytesFns]) {
      const bytes = new Uint8Array(payload.length - BULK_HEAD);
      bytes.set(payload.subarray(BULK_HEAD));
      try { fn(channel, bytes); } catch (e) { this.log.error("remote.mux_listener_failed", { error: e }); }
      if (this.state !== "open") return;
    }
  }

  private onChunk(payload: Buffer): void {
    const id = payload.readUInt32BE(0);
    const last = payload[4];
    if (last !== 0 && last !== 1) return this.fail(RESET_CODE.protocol, "a data chunk whose last flag isn't 0 or 1");
    if (this.assembling && this.assembling.id !== id) return this.fail(RESET_CODE.protocol, "a data message started before the last one ended");
    const a = this.assembling ?? (this.assembling = { id, buf: Buffer.allocUnsafe(WINDOW_START), len: 0 });
    const n = payload.length - DATA_HEAD;
    const need = a.len + n;
    if (need > CAPS.dataMessageBytes) return this.fail(RESET_CODE.tooLarge, `a data message over ${CAPS.dataMessageBytes} bytes`);
    if (need > a.buf.length) {
      const grown = Buffer.allocUnsafe(Math.min(CAPS.dataMessageBytes, Math.max(need, a.buf.length * 2)));
      a.buf.copy(grown, 0, 0, a.len);
      a.buf = grown;
    }
    payload.copy(a.buf, a.len, DATA_HEAD);
    a.len = need;
    if (!last) return;
    this.assembling = null;
    this.onJson(a.buf.subarray(0, a.len), false);
  }

  private onCredit(payload: Buffer): void {
    const s = payload[0];
    const n = payload.readUInt32BE(1);
    if (s !== STREAM.data && s !== STREAM.bulk) return this.fail(RESET_CODE.protocol, `credit for stream ${s}, which takes none`);
    if (n === 0) return this.fail(RESET_CODE.protocol, "a CREDIT of 0 bytes");
    // A reader never has more than WINDOW_MAX granted and not received, so a writer can never hold more to send.
    if (this.avail[s] + n > WINDOW_MAX) return this.fail(RESET_CODE.credit, "more credit than any window");
    this.avail[s] += n;
    this.availHigh[s] = Math.max(this.availHigh[s], this.avail[s]);
    this.lastOut[s] = this.now();
  }

  private onPing(payload: Buffer): void {
    if (this.pongsQueued >= PONGS_QUEUED_MAX) return;
    const f = frameFor(STREAM.ctl, KIND.pong, 8);
    payload.copy(f, FRAME_HEAD);
    this.urgent.push(f);
    this.pongsQueued++;
  }

  private onPong(payload: Buffer): void {
    const v = Number(payload.readBigUInt64BE(0));
    // Only an answer to one of this end's own pings is a sample; anything else is ignored.
    if (!this.pings.delete(v)) return;
    this.rtts.push(Math.max(0, this.now() - v));
    if (this.rtts.length > RTT_SAMPLES) this.rtts.shift();
  }

  private onReset(payload: Buffer): void {
    const code = payload.readUInt16BE(0);
    const reason = plainText(payload.subarray(2).toString("utf8"), RESET_REASON_MAX);
    this.log.warn("remote.mux_reset_received", { role: this.role, code, reason });
    this.close(`reset by the other end (${code}): ${reason}`);
  }

  private onJson(payload: Buffer, diag: boolean): void {
    let value: unknown;
    try {
      value = JSON.parse(UTF8.decode(payload));
    } catch {
      return this.fail(RESET_CODE.schema, diag ? "a log line that isn't JSON" : "a message that isn't JSON");
    }
    if (diag) {
      const d = EV_SCHEMAS.log.safeParse(value);
      if (!d.success) return this.fail(RESET_CODE.schema, `a log line that fails its schema (${issuesOf(d.error)})`);
      return this.deliver({ t: "ev", ev: "log", d: d.data });
    }
    const m = this.checkIncoming(value);
    if ("why" in m) return this.fail(m.code, m.why);
    this.deliver(m);
  }

  /** The other end's message, checked as §7.2 says: envelope, direction, request ids, then its op's or event's schema. */
  private checkIncoming(value: unknown): Msg | Problem {
    const env = ENVELOPE.safeParse(value);
    if (!env.success) return { code: RESET_CODE.schema, why: "a message whose envelope is malformed" };
    const m = env.data;
    if (m.t === "req") {
      if (this.role !== "agent") return { code: RESET_CODE.direction, why: `a ${m.op} request from the remote agent, which never sends one` };
      if (this.pending.has(m.id)) return { code: RESET_CODE.protocol, why: `request id ${m.id} reused before its answer` };
      if (this.pending.size >= PENDING_MAX) return { code: RESET_CODE.protocol, why: "too many requests waiting for their answers" };
      const a = (OP_SCHEMAS[m.op].args as z.ZodType<unknown>).safeParse(m.a);
      if (!a.success) return { code: RESET_CODE.schema, why: `${m.op}'s arguments fail their schema (${issuesOf(a.error)})` };
      this.pending.set(m.id, m.op);
      return { t: "req", id: m.id, op: m.op, a: a.data };
    }
    if (this.role !== "pc") return { code: RESET_CODE.direction, why: m.t === "res" ? "an answer from the PC, which only sends requests" : "an event from the PC, which only sends requests" };
    if (m.t === "res") {
      const op = this.pending.get(m.id);
      if (!op) return { code: RESET_CODE.protocol, why: `an answer to request ${m.id}, which isn't waiting for one` };
      if (m.ok) {
        const v = (OP_SCHEMAS[op].result as z.ZodType<unknown>).safeParse(m.v);
        if (!v.success) return { code: RESET_CODE.schema, why: `${op}'s result fails its schema (${issuesOf(v.error)})` };
        this.pending.delete(m.id);
        return { t: "res", id: m.id, ok: true, v: v.data };
      }
      this.pending.delete(m.id);
      return { t: "res", id: m.id, ok: false, e: m.e };
    }
    const d = (EV_SCHEMAS[m.ev] as z.ZodType<unknown>).safeParse(m.d);
    if (!d.success) return { code: RESET_CODE.schema, why: `${m.ev}'s data fails its schema (${issuesOf(d.error)})` };
    return { t: "ev", ev: m.ev, d: d.data };
  }

  private deliver(msg: Msg): void {
    for (const fn of [...this.msgFns]) {
      try { fn(msg); } catch (e) { this.log.error("remote.mux_listener_failed", { error: e }); }
      if (this.state !== "open") return;
    }
  }

  /** Returns credit for what has arrived, after growing or shrinking each grant by the 250 ms rule. */
  private grantCredits(): void {
    for (const s of [STREAM.data, STREAM.bulk] as const) {
      if (this.sinceEval[s] >= this.window[s]) {
        this.sinceEval[s] = 0;
        const other = this.window[s === STREAM.data ? STREAM.bulk : STREAM.data];
        const next = nextWindow(this.window[s], other, this.meter.rate());
        if (next !== this.window[s]) this.log.debug("remote.mux_window", { stream: s, bytes: next, throughput: Math.round(this.meter.rate()) });
        this.window[s] = next;
      }
      const top = this.window[s] - (this.granted[s] - this.received[s]);
      if (top < CREDIT_MIN) continue;
      this.granted[s] += top;
      const f = frameFor(STREAM.ctl, KIND.credit, 5);
      f[FRAME_HEAD] = s;
      f.writeUInt32BE(top, FRAME_HEAD + 1);
      this.urgent.push(f);
    }
  }

  // -- Closing -------------------------------------------------------------------------------------------------------

  private fail(code: number, why: string): void {
    if (this.state === "closed") return;
    this.log.warn("remote.mux_protocol_error", { role: this.role, code, why });
    this.writeReset(code, plainText(why, RESET_REASON_MAX));
    this.close(`protocol error: ${why}`);
  }

  private close(why: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.why = why;
    if (this.preambleTimer) clearTimeout(this.preambleTimer);
    this.preambleTimer = null;
    this.read.removeListener("data", this.onReadData);
    this.read.removeListener("end", this.onReadEnd);
    this.read.removeListener("close", this.onReadEnd);
    this.write.removeListener("close", this.onWriteClose);
    this.write.removeListener("drain", this.onDrain);
    // The error listeners stay (and do nothing now): an EPIPE after close must not become an uncaught exception.
    this.inq.clear();
    this.pre = Buffer.alloc(0);
    this.assembling = null;
    this.urgent.length = 0;
    this.ctl.length = 0;
    this.data.length = 0;
    this.bulk.length = 0;
    this.diag.length = 0;
    this.diagBytes = 0;
    this.pending.clear();
    this.log.info("remote.mux_closed", { role: this.role, why, ...(this.diagDropped ? { diagDropped: this.diagDropped } : {}) });
    const fns = [...this.closeFns];
    this.closeFns.clear();
    this.msgFns.clear();
    this.bytesFns.clear();
    for (const fn of fns) {
      try { fn(why); } catch (e) { this.log.error("remote.mux_listener_failed", { error: e }); }
    }
  }
}

/**
 * Both ends of the framed stream over `read`/`write`, the preamble included (§5.1.10). The agent writes its preamble
 * at once; the PC waits for it (skipping up to 64 KiB of noise, for 20 s at most) and answers. Until both preambles
 * are through, what is sent is queued and `ping()` does nothing.
 *
 * - `send` checks the message as strictly as the other end will (direction, request ids, its op's or event's schema)
 *   and throws MuxError (nothing queued, nothing changed) if it fails or is over 4 MiB, so an agent that can't send
 *   its result can still answer the same request with an error. An error answer's `m` is cut to 500 characters.
 *   After close, `send`, `sendBytes` and `ping` do nothing.
 * - `onMessage` sees only messages that passed those checks, with their values as the schemas parse them; anything
 *   else from the other end resets and closes the link.
 * - `onBytes` gets each bulk chunk as it arrives, in a Uint8Array that owns its ArrayBuffer.
 * - `inFlight()` is an upper bound of the bytes between the two ends on credit-limited streams (granted to the other
 *   end on a stream that received bytes in the last second, or 4 RTTs if longer; plus sent here and not yet credited
 *   back, on a stream that sent or got credit in that time) and the measured throughput of arriving bytes in bytes/s,
 *   0 until measured (a caller dividing by it guards the 0). `rttMs` is the lowest of the last 8 ping round trips, 0
 *   before one.
 * - `reset` writes a RESET ahead of anything queued and closes; `onClose` fires once, with why, on any close (a
 *   listener added after it is called on a microtask). The mux never ends or destroys `read` or `write`.
 */
export function createMux(o: { read: NodeJS.ReadableStream; write: NodeJS.WritableStream; role: "pc" | "agent"; partsId: string; log: Logger }, tuning?: MuxTuning): Mux {
  if (!o || typeof o.read?.on !== "function" || typeof o.read.resume !== "function" || typeof o.write?.write !== "function" || typeof o.write.on !== "function") {
    throw new TypeError("createMux needs a readable and a writable byte stream");
  }
  if (o.role !== "pc" && o.role !== "agent") throw new TypeError("createMux's role is pc or agent");
  if (typeof o.partsId !== "string" || !PARTS_ID.test(o.partsId)) throw new TypeError("createMux's partsId isn't a parts id");
  if (!o.log) throw new TypeError("createMux needs a logger");
  const now = tuning?.now ?? (() => performance.now());
  return new FramedMux(o.read, o.write, o.role, o.partsId, o.log, now);
}
