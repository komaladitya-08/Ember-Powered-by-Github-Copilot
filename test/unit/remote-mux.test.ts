/**
 * The framed stream both ends of an SSH link speak (§5.1.10, design §10.1 MX row): the preamble and its noise limit,
 * the frame, chunk and message caps, credits (64 KiB at start, growth only under the 250 ms rule, never exceeded),
 * priorities (a Stop's answer overtakes 4 MiB of queued bulk), reassembly of a 4 MiB data message, RESET on anything
 * malformed, the agent never sending a request, and both roles over in-memory streams cut at random places with every
 * byte value going both ways. OS-neutral: in-memory streams, an injected clock, no process, file or network.
 *
 * The other end is either a second mux or a peer written by hand here, with its own frame codec, so the mux is never
 * checked only against itself.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough, Transform, Writable } from "node:stream";
import type { Logger } from "../../app/main/logger";
import { CAPS, emberNamesRegExp, type Msg } from "../../app/main/remote/protocol";
import type { RunnerFacts } from "../../app/main/commands/types";
import type { Mux } from "../../app/main/remote/types";
import {
  DIAG_QUEUE_MAX, MuxError, NOISE_MAX, RESET_CODE, RateMeter, WINDOW_MAX, WINDOW_START, createMux, nextWindow,
} from "../../app/main/remote/mux";

const PARTS = "0.1.0-0123456789ab";
const AGENT_PREAMBLE = Buffer.from(`\0EMBER-REMOTE/1 ${PARTS}\n`, "latin1");
const PC_PREAMBLE = Buffer.from(`\0EMBER-LOCAL/1 ${PARTS}\n`, "latin1");
const KiB = 1024;
const MiB = 1024 * KiB;
const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => log, file: "" };

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────── An independent frame codec ───────────────

interface Frame { stream: number; kind: number; payload: Buffer }

function rawFrame(stream: number, kind: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(6 + payload.length);
  b.writeUInt32BE(2 + payload.length, 0);
  b[4] = stream;
  b[5] = kind;
  b.set(payload, 6);
  return b;
}
const jsonBytes = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8");
const ctlJson = (v: unknown) => rawFrame(0, 1, jsonBytes(v));
function dataChunk(msgId: number, last: boolean, bytes: Uint8Array): Buffer {
  const p = Buffer.alloc(5 + bytes.length);
  p.writeUInt32BE(msgId, 0);
  p[4] = last ? 1 : 0;
  p.set(bytes, 5);
  return rawFrame(1, 1, p);
}
function bulkChunk(channel: number, bytes: Uint8Array): Buffer {
  const p = Buffer.alloc(4 + bytes.length);
  p.writeUInt32BE(channel, 0);
  p.set(bytes, 4);
  return rawFrame(2, 2, p);
}
function credit(stream: number, n: number): Buffer {
  const p = Buffer.alloc(5);
  p[0] = stream;
  p.writeUInt32BE(n, 1);
  return rawFrame(0, 3, p);
}
function u64(v: number): Buffer {
  const p = Buffer.alloc(8);
  p.writeBigUInt64BE(BigInt(v));
  return p;
}
function resetFrame(code: number, reason: string): Buffer {
  const r = Buffer.from(reason, "utf8");
  const p = Buffer.alloc(2 + r.length);
  p.writeUInt16BE(code, 0);
  r.copy(p, 2);
  return rawFrame(0, 6, p);
}

/** Parses what a mux writes: its preamble line, then frames. */
class Reader {
  readonly frames: Frame[] = [];
  preamble: string | null = null;
  private buf = Buffer.alloc(0);

  push(b: Buffer): void {
    this.buf = Buffer.concat([this.buf, b]);
    if (this.preamble === null) {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) return;
      this.preamble = this.buf.subarray(0, nl + 1).toString("latin1");
      this.buf = this.buf.subarray(nl + 1);
    }
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) return;
      this.frames.push({ stream: this.buf[4], kind: this.buf[5], payload: Buffer.from(this.buf.subarray(6, 4 + len)) });
      this.buf = this.buf.subarray(4 + len);
    }
  }

  of(stream: number, kind?: number): Frame[] {
    return this.frames.filter(f => f.stream === stream && (kind === undefined || f.kind === kind));
  }

  /** The bytes the mux granted on a stream through CREDIT frames. */
  credited(stream: number): number {
    return this.of(0, 3).filter(f => f.payload[0] === stream).reduce((n, f) => n + f.payload.readUInt32BE(1), 0);
  }

  resets(): { code: number; reason: string }[] {
    return this.of(0, 6).map(f => ({ code: f.payload.readUInt16BE(0), reason: f.payload.subarray(2).toString("utf8") }));
  }

  json(stream: number): unknown[] {
    return this.of(stream, 1).map(f => JSON.parse(f.payload.toString("utf8")));
  }
}

// ─────────────── Harnesses ───────────────

/** Lets the in-memory streams deliver what is queued. */
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r));
}

async function until(cond: () => boolean, what: string, rounds = 20_000): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await new Promise(r => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A mux under test and the other end written by hand: `send` writes raw bytes to the mux; `reader` parses its output. */
function rawPeer(role: "pc" | "agent", o: { now?: () => number; write?: NodeJS.WritableStream } = {}) {
  const toMux = new PassThrough();
  const fromMux = new PassThrough();
  const reader = new Reader();
  fromMux.on("data", (b: Buffer) => reader.push(b));
  const mux = createMux({ read: toMux, write: o.write ?? fromMux, role, partsId: PARTS, log }, { now: o.now });
  const closed: string[] = [];
  const msgs: Msg[] = [];
  const bytes: [number, Buffer][] = [];
  mux.onClose(w => closed.push(w));
  mux.onMessage(m => msgs.push(m));
  mux.onBytes((c, b) => bytes.push([c, Buffer.from(b)]));
  return { mux, reader, closed, msgs, bytes, toMux, fromMux, send: (b: Buffer) => { toMux.write(b); } };
}
type RawPeer = ReturnType<typeof rawPeer>;

/** A PC mux whose remote agent is written by hand, past the preamble. */
async function openPc(o: { now?: () => number } = {}): Promise<RawPeer> {
  const p = rawPeer("pc", o);
  p.send(AGENT_PREAMBLE);
  await settle();
  expect(p.reader.preamble).toBe(PC_PREAMBLE.toString("latin1"));
  return p;
}

/** An agent mux whose PC is written by hand, past the preamble. */
async function openAgent(o: { now?: () => number; write?: NodeJS.WritableStream } = {}): Promise<RawPeer> {
  const p = rawPeer("agent", o);
  p.send(PC_PREAMBLE);
  await settle();
  return p;
}

/** Splits every chunk into pieces of 1..max bytes at random (seeded) places. */
function rechunker(seed: number, max: number): Transform {
  const rand = mulberry32(seed);
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      for (let at = 0; at < chunk.length;) {
        const n = 1 + Math.floor(rand() * max);
        this.push(chunk.subarray(at, at + n));
        at += n;
      }
      cb();
    },
  });
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two muxes, PC and agent, over a pair of PassThroughs (optionally cut at random places), with taps on both ways. */
function pair(o: { now?: () => number; chunks?: { seed: number; max: number } } = {}) {
  const pcToAgent = new PassThrough();
  const agentToPc = new PassThrough();
  const tapUp = new Reader();
  const tapDown = new Reader();
  agentToPc.on("data", (b: Buffer) => tapUp.push(b));
  pcToAgent.on("data", (b: Buffer) => tapDown.push(b));
  const pcIn = o.chunks ? agentToPc.pipe(rechunker(o.chunks.seed, o.chunks.max)) : agentToPc;
  const agentIn = o.chunks ? pcToAgent.pipe(rechunker(o.chunks.seed + 1, o.chunks.max)) : pcToAgent;
  // The PC first: the taps keep both streams flowing, so the agent's preamble would pass before a later PC listened.
  const pc = createMux({ read: pcIn, write: pcToAgent, role: "pc", partsId: PARTS, log }, { now: o.now });
  const agent = createMux({ read: agentIn, write: agentToPc, role: "agent", partsId: PARTS, log }, { now: o.now });
  const closed: string[] = [];
  pc.onClose(w => closed.push(`pc: ${w}`));
  agent.onClose(w => closed.push(`agent: ${w}`));
  return { pc, agent, tapUp, tapDown, closed };
}

/** Answers every request the agent gets with `answer(req)` (undefined: no answer). */
function serve(agent: Mux, answer: (req: Extract<Msg, { t: "req" }>) => unknown): Extract<Msg, { t: "req" }>[] {
  const got: Extract<Msg, { t: "req" }>[] = [];
  agent.onMessage(m => {
    if (m.t !== "req") return;
    got.push(m);
    const v = answer(m);
    if (v !== undefined) agent.send({ t: "res", id: m.id, ok: true, v });
  });
  return got;
}

/** The answers the PC gets, by request id. */
function answers(pc: Mux): Map<number, Msg> {
  const got = new Map<number, Msg>();
  pc.onMessage(m => { if (m.t === "res") got.set(m.id, m); });
  return got;
}

/** An `audit.recent` result whose answer message is exactly `bytes` long (64 keys of ≤ 4000 characters per entry). */
function auditResult(bytes: number): { entries: Record<string, string>[] } {
  const entries: Record<string, string>[] = [];
  const size = () => Buffer.byteLength(JSON.stringify({ t: "res", id: 1, ok: true, v: { entries } }));
  const perEntry = 64 * (4000 + 9);
  for (let e = 0; e <= Math.ceil(bytes / perEntry) && e < CAPS.auditEntries; e++) {
    const entry: Record<string, string> = {};
    for (let k = 0; k < 64; k++) entry[`k${String(k).padStart(2, "0")}`] = "x".repeat(4000);
    entries.push(entry);
  }
  let excess = size() - bytes;
  if (excess < 0) throw new Error("auditResult: too small");
  for (let e = entries.length - 1; e >= 0 && excess > 0; e--) {
    for (const k of Object.keys(entries[e]).reverse()) {
      const cut = Math.min(excess, entries[e][k].length);
      entries[e][k] = entries[e][k].slice(cut);
      excess -= cut;
      if (!excess) break;
    }
  }
  expect(size()).toBe(bytes);
  return { entries };
}

const facts: RunnerFacts = {
  os: "linux", shells: ["bash", "sh"], shellPaths: { bash: "/usr/bin/bash", sh: "/bin/sh" }, script: { path: "/usr/bin/script", kind: "util-linux" },
  home: "/home/deploy", user: "deploy", privileged: false, pty: true,
  ember: { paths: ["/home/deploy/.local/share/ember-remote"], pids: [4242], names: emberNamesRegExp(["ember-remote", "ember_atspi.py"]) },
  extraPath: [],
};

/** Every byte value, `times` over. */
function allBytes(times: number): Buffer {
  const b = Buffer.alloc(256 * times);
  for (let i = 0; i < b.length; i++) b[i] = i & 0xff;
  return b;
}

/** Every character from U+0000 to U+00FF, then astral, line-separator, BOM and lone-surrogate code units. */
const EVERY_CHAR = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("") + "😀  ﻿\ud800x\udfff";

// ─────────────── createMux ───────────────

describe("createMux", () => {
  it("refuses options without streams, a role or a parts id", () => {
    const s = () => ({ read: new PassThrough(), write: new PassThrough(), role: "pc" as const, partsId: PARTS, log });
    expect(() => createMux({} as Parameters<typeof createMux>[0])).toThrow(TypeError);
    expect(() => createMux({ ...s(), role: "remote" as "pc" })).toThrow(TypeError);
    expect(() => createMux({ ...s(), partsId: "0.1.0 x" })).toThrow(TypeError);
    expect(() => createMux({ ...s(), partsId: "" })).toThrow(TypeError);
  });
});

// ─────────────── The preamble ───────────────

describe("the preamble", () => {
  it("lets the PC skip up to 64 KiB of noise before the agent's preamble, then answers with its own", async () => {
    const p = rawPeer("pc");
    // A .bashrc that prints, with near-misses of the mark in it, cut into pieces.
    let noise = Buffer.from("Welcome to build-01\n\0EMBER-\0EMBER-REMOTE\0EMBER-REMOTE-1 \n".repeat(2000), "latin1").subarray(0, NOISE_MAX - 14);
    noise = Buffer.concat([noise, Buffer.from("\0EMBER-REMOTE ", "latin1")]);
    expect(noise.length).toBe(NOISE_MAX);
    for (let at = 0; at < noise.length; at += 999) p.send(noise.subarray(at, at + 999));
    await settle();
    expect(p.reader.preamble).toBeNull();
    // The preamble and a PING in the same write, cut through the middle of the line.
    const rest = Buffer.concat([AGENT_PREAMBLE, rawFrame(0, 4, u64(77))]);
    p.send(rest.subarray(0, 9));
    p.send(rest.subarray(9));
    await settle();
    expect(p.reader.preamble).toBe(`\0EMBER-LOCAL/1 ${PARTS}\n`);
    expect(p.reader.of(0, 5).map(f => f.payload)).toEqual([u64(77)]);
    expect(p.closed).toEqual([]);
  });

  it("refuses more than 64 KiB of noise before it, without answering", async () => {
    const p = rawPeer("pc");
    p.send(Buffer.alloc(NOISE_MAX + 1, 0x41));
    p.send(AGENT_PREAMBLE);
    await settle();
    expect(p.closed).toHaveLength(1);
    expect(p.closed[0]).toMatch(/more than 64 KiB came before the remote agent's preamble/);
    expect(p.reader.preamble).toBeNull();
    // Noise and never a preamble: refused as soon as no preamble can still be in time.
    const q = rawPeer("pc");
    q.send(Buffer.alloc(NOISE_MAX + 20, 0x42));
    await settle();
    expect(q.closed[0]).toMatch(/more than 64 KiB/);
  });

  it("gives up after 20 s without a preamble", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = rawPeer("pc");
    vi.advanceTimersByTime(19_999);
    expect(p.closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(p.closed[0]).toMatch(/no preamble from the remote agent within 20 s/);
    // The agent gives up too, and says why in a RESET after its own preamble.
    const a = rawPeer("agent");
    vi.advanceTimersByTime(20_000);
    await settle();
    expect(a.closed[0]).toMatch(/no preamble from the PC within 20 s/);
    expect(a.reader.preamble).toBe(AGENT_PREAMBLE.toString("latin1"));
    expect(a.reader.resets().map(r => r.code)).toEqual([RESET_CODE.timeout]);
  });

  it("refuses an agent that runs different parts, or another protocol, at the PC", async () => {
    const p = rawPeer("pc");
    p.send(Buffer.from("\0EMBER-REMOTE/1 0.1.0-ffffffffffff\n", "latin1"));
    await settle();
    expect(p.closed[0]).toMatch(/different parts/);
    expect(p.reader.preamble).toBeNull();
    const q = rawPeer("pc");
    q.send(Buffer.from(`\0EMBER-REMOTE/2 ${PARTS}\n`, "latin1"));
    await settle();
    expect(q.closed[0]).toMatch(/protocol 2, not 1/);
    const r = rawPeer("pc");
    r.send(Buffer.concat([Buffer.from("\0EMBER-REMOTE/1 ", "latin1"), Buffer.alloc(200, 0x61)]));
    await settle();
    expect(r.closed[0]).toMatch(/preamble line is too long/);
  });

  it("refuses a PC with different parts, or bytes that aren't a preamble, at the agent, with a RESET", async () => {
    const a = rawPeer("agent");
    await settle();
    expect(a.reader.preamble).toBe(`\0EMBER-REMOTE/1 ${PARTS}\n`);
    a.send(Buffer.from("\0EMBER-LOCAL/1 0.1.0-0123456789ac\n", "latin1"));
    await settle();
    expect(a.closed[0]).toMatch(/different version/);
    expect(a.reader.resets().map(r => r.code)).toEqual([RESET_CODE.version]);
    const b = rawPeer("agent");
    b.send(Buffer.from("hello\n"));
    await settle();
    expect(b.closed[0]).toMatch(/aren't Ember's preamble/);
    expect(b.reader.resets().map(r => r.code)).toEqual([RESET_CODE.protocol]);
  });

  it("holds what is sent until both preambles are through", async () => {
    const p = rawPeer("pc");
    p.mux.send({ t: "req", id: 1, op: "stop", a: { epoch: 3 } });
    p.mux.ping();
    await settle();
    expect(p.reader.preamble).toBeNull();
    expect(p.fromMux.readableLength).toBe(0);
    p.send(AGENT_PREAMBLE);
    await settle();
    expect(p.reader.json(0)).toEqual([{ t: "req", id: 1, op: "stop", a: { epoch: 3 } }]);
    // A ping before the link was open measures nothing and isn't sent.
    expect(p.reader.of(0, 4)).toEqual([]);
  });
});

// ─────────────── Frames and checks ───────────────

describe("frames from the other end", () => {
  it("reset the link on a frame over 1 MiB, before its bytes arrive", async () => {
    const p = await openPc();
    const head = Buffer.alloc(6);
    head.writeUInt32BE(CAPS.frameBytes + 1, 0);
    head[4] = 2;
    head[5] = 2;
    p.send(head);
    await settle();
    expect(p.reader.resets().map(r => r.code)).toEqual([RESET_CODE.tooLarge]);
    expect(p.closed[0]).toMatch(/a frame of 1048577 bytes/);
  });

  it("reset the link on a ctl message over 64 KiB or a chunk over 32 KiB", async () => {
    const ctl = await openPc();
    ctl.send(rawFrame(0, 1, Buffer.alloc(CAPS.ctlBytes + 1, 0x20)));
    await settle();
    expect(ctl.reader.resets().map(r => r.code)).toEqual([RESET_CODE.tooLarge]);
    const data = await openPc();
    data.send(dataChunk(1, true, Buffer.alloc(CAPS.chunkBytes + 1, 0x20)));
    await settle();
    expect(data.reader.resets().map(r => r.code)).toEqual([RESET_CODE.tooLarge]);
    const bulk = await openPc();
    bulk.send(bulkChunk(1, Buffer.alloc(CAPS.chunkBytes + 1)));
    await settle();
    expect(bulk.reader.resets().map(r => r.code)).toEqual([RESET_CODE.tooLarge]);
    // 32 KiB after the sub-header is still a chunk.
    const ok = await openPc();
    ok.send(bulkChunk(1, Buffer.alloc(CAPS.chunkBytes, 7)));
    await settle();
    expect(ok.closed).toEqual([]);
    expect(ok.bytes.map(([c, b]) => [c, b.length])).toEqual([[1, CAPS.chunkBytes]]);
  });

  it("reset the link on an unknown stream, or a kind its stream doesn't carry", async () => {
    for (const [stream, kind] of [[4, 1], [255, 2], [0, 7], [0, 2], [1, 2], [2, 1], [3, 2]]) {
      const p = await openPc();
      p.send(rawFrame(stream, kind, Buffer.from("{}")));
      await settle();
      expect(p.reader.resets().map(r => r.code), `${stream}/${kind}`).toEqual([RESET_CODE.unknown]);
      expect(p.closed).toHaveLength(1);
    }
  });

  it("reset the link on malformed control frames", async () => {
    const frames = [
      rawFrame(0, 3, Buffer.alloc(4)), // CREDIT of the wrong size
      credit(0, 100), // credit for ctl
      credit(2, 0), // credit of nothing
      rawFrame(0, 4, Buffer.alloc(7)), // PING of the wrong size
      rawFrame(0, 6, Buffer.alloc(1)), // RESET without its code
      rawFrame(1, 1, Buffer.alloc(5)), // an empty data chunk
      dataChunk(1, true, Buffer.from("{}")).fill(2, 10, 11), // last flag 2
      Buffer.from([0, 0, 0, 1, 0]), // a frame without its stream and kind
    ];
    for (const f of frames) {
      const p = await openPc();
      p.send(f);
      await settle();
      expect(p.reader.resets().map(r => r.code), f.toString("hex").slice(0, 40)).toEqual([RESET_CODE.protocol]);
    }
  });

  it("reset the link on a message that isn't JSON or fails its schema, and never deliver it", async () => {
    const bad: Buffer[] = [
      rawFrame(0, 1, Buffer.from("{nope")),
      rawFrame(0, 1, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])), // invalid UTF-8
      rawFrame(0, 1, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), jsonBytes({ t: "ev", ev: "notice", d: { state: "shown" } })])), // a BOM
      ctlJson({ t: "ev", ev: "notice", d: { state: "maybe" } }),
      ctlJson({ t: "ev", ev: "notice", d: { state: "shown", sneaky: 1 } }),
      ctlJson({ t: "ev", ev: "nope", d: {} }),
      ctlJson({ t: "ev", ev: "notice", d: { state: "shown" }, x: 1 }),
      ctlJson({ t: "ev", ev: "console.stop", d: { at: "x".repeat(65) } }),
      ctlJson([1, 2, 3]),
      rawFrame(3, 1, jsonBytes({ level: "loud", event: "x" })),
    ];
    for (const f of bad) {
      const p = await openPc();
      p.send(f);
      await settle();
      expect(p.reader.resets().map(r => r.code), f.subarray(6).toString("latin1")).toEqual([RESET_CODE.schema]);
      expect(p.msgs).toEqual([]);
    }
    const good = await openPc();
    good.send(ctlJson({ t: "ev", ev: "notice", d: { state: "shown" } }));
    await settle();
    expect(good.msgs).toEqual([{ t: "ev", ev: "notice", d: { state: "shown" } }]);
  });

  it("check an answer against the op its request named, and refuse an answer to no request", async () => {
    const p = await openPc();
    p.mux.send({ t: "req", id: 7, op: "stop", a: { epoch: 2 } });
    p.mux.send({ t: "req", id: 8, op: "stop", a: { epoch: 3 } });
    p.send(ctlJson({ t: "res", id: 7, ok: true, v: { ms: 12, late: [] } }));
    p.send(ctlJson({ t: "res", id: 8, ok: false, e: { code: "stopped", m: "already stopped" } }));
    await settle();
    expect(p.msgs).toEqual([
      { t: "res", id: 7, ok: true, v: { ms: 12, late: [] } },
      { t: "res", id: 8, ok: false, e: { code: "stopped", m: "already stopped" } },
    ]);
    // 7 was answered: a second answer to it is an answer to no request.
    p.send(ctlJson({ t: "res", id: 7, ok: true, v: { ms: 12, late: [] } }));
    await settle();
    expect(p.reader.resets().map(r => r.code)).toEqual([RESET_CODE.protocol]);
    const q = await openPc();
    q.mux.send({ t: "req", id: 1, op: "stop", a: { epoch: 2 } });
    q.send(ctlJson({ t: "res", id: 1, ok: true, v: { ms: -1, late: [] } }));
    await settle();
    expect(q.reader.resets().map(r => r.code)).toEqual([RESET_CODE.schema]);
    expect(q.closed[0]).toMatch(/stop's result fails its schema \(ms: too_small\)/);
    const r = await openPc();
    r.mux.send({ t: "req", id: 1, op: "hello", a: hello() });
    r.send(ctlJson({ t: "res", id: 1, ok: false, e: { code: "nonsense", m: "x" } }));
    await settle();
    expect(r.reader.resets().map(x => x.code)).toEqual([RESET_CODE.schema]);
  });

  it("refuse a request from the agent at the PC (critique remote: the agent never sends one)", async () => {
    const p = await openPc();
    p.send(ctlJson({ t: "req", id: 1, op: "cmd.facts", a: {} }));
    await settle();
    expect(p.reader.resets().map(r => r.code)).toEqual([RESET_CODE.direction]);
    expect(p.closed[0]).toMatch(/a cmd\.facts request from the remote agent, which never sends one/);
    expect(p.msgs).toEqual([]);
  });

  it("refuse answers, events and log lines from the PC at the agent", async () => {
    for (const f of [ctlJson({ t: "res", id: 1, ok: true, v: {} }), ctlJson({ t: "ev", ev: "notice", d: { state: "off" } }), rawFrame(3, 1, jsonBytes({ level: "info", event: "x" }))]) {
      const a = await openAgent();
      a.send(f);
      await settle();
      expect(a.reader.resets().map(r => r.code)).toEqual([RESET_CODE.direction]);
      expect(a.msgs).toEqual([]);
    }
  });

  it("refuse a request id reused before its answer, and check every request's arguments", async () => {
    const a = await openAgent();
    a.send(ctlJson({ t: "req", id: 1, op: "stop", a: { epoch: 1 } }));
    a.send(ctlJson({ t: "req", id: 1, op: "stop", a: { epoch: 2 } }));
    await settle();
    expect(a.msgs).toEqual([{ t: "req", id: 1, op: "stop", a: { epoch: 1 } }]);
    expect(a.reader.resets().map(r => r.code)).toEqual([RESET_CODE.protocol]);
    const b = await openAgent();
    b.send(ctlJson({ t: "req", id: 1, op: "cmd.run", a: { epoch: 1, spec: { shell: "fish" } } }));
    b.send(ctlJson({ t: "req", id: 2, op: "rm -rf", a: {} }));
    await settle();
    expect(b.reader.resets().map(r => r.code)).toEqual([RESET_CODE.schema]);
    expect(b.msgs).toEqual([]);
  });
});

function hello() {
  return {
    proto: 1 as const, partsId: PARTS, local: { name: "ana-laptop", os: "linux" as const }, pcId: "c".repeat(32),
    consent: { version: 1, at: "2026-10-22T12:00:00.000Z" }, neverLook: ["KeePassXC"], epoch: 1,
    localAdmin: {
      source: null, features: {}, neverLook: [], confirmEveryAction: false, allowGrants: true,
      commands: { local: "on" as const, wsl: "on" as const, ssh: "on" as const }, ssh: {}, models: {}, provider: false,
    },
  };
}

// ─────────────── Sending ───────────────

describe("sending", () => {
  it("refuses what the other end would refuse, and changes nothing when it does", async () => {
    const p = await openPc();
    expect(() => p.mux.send({ t: "req", id: 1, op: "stop", a: { epoch: -1 } })).toThrow(MuxError);
    expect(() => p.mux.send({ t: "req", id: 1.5, op: "stop", a: { epoch: 1 } })).toThrow(/whole number/);
    expect(() => p.mux.send({ t: "req", id: 1, op: "nope" as "stop", a: {} })).toThrow(/unknown op/);
    expect(() => p.mux.send({ t: "res", id: 1, ok: true, v: {} })).toThrow(/the PC never sends an answer/);
    expect(() => p.mux.send({ t: "ev", ev: "notice", d: { state: "off" } })).toThrow(/the PC never sends an event/);
    expect(() => p.mux.send({ t: "x" } as unknown as Msg)).toThrow(MuxError);
    p.mux.send({ t: "req", id: 1, op: "stop", a: { epoch: 1 } });
    expect(() => p.mux.send({ t: "req", id: 1, op: "stop", a: { epoch: 1 } })).toThrow(/still waiting/);
    await settle();
    expect(p.reader.json(0)).toEqual([{ t: "req", id: 1, op: "stop", a: { epoch: 1 } }]);
    expect(p.closed).toEqual([]);
  });

  it("never lets the agent send a request, and answers only requests it got", async () => {
    const a = await openAgent();
    expect(() => a.mux.send({ t: "req", id: 1, op: "stop", a: { epoch: 1 } })).toThrow(/the agent never sends a request/);
    expect(() => a.mux.send({ t: "res", id: 4, ok: true, v: { ms: 1, late: [] } })).toThrow(/no request 4/);
    a.send(ctlJson({ t: "req", id: 4, op: "stop", a: { epoch: 1 } }));
    await settle();
    // A result that fails its schema throws and leaves the request open, so it can still be answered with an error.
    expect(() => a.mux.send({ t: "res", id: 4, ok: true, v: { ms: 1 } })).toThrow(/stop's result fails its schema/);
    a.mux.send({ t: "res", id: 4, ok: false, e: { code: "internal", m: "é".repeat(600) } });
    expect(() => a.mux.send({ t: "res", id: 4, ok: false, e: { code: "internal", m: "again" } })).toThrow(/no request 4/);
    await settle();
    expect(a.reader.json(0)).toEqual([{ t: "res", id: 4, ok: false, e: { code: "internal", m: "é".repeat(500) } }]);
    expect(a.closed).toEqual([]);
  });

  it("refuses a message over 4 MiB, so the agent can answer with an error instead", async () => {
    const a = await openAgent();
    a.send(ctlJson({ t: "req", id: 9, op: "audit.recent", a: { limit: 200 } }));
    await settle();
    const tooBig = auditResult(CAPS.dataMessageBytes + 1);
    expect(() => a.mux.send({ t: "res", id: 9, ok: true, v: tooBig })).toThrow(expect.objectContaining({ code: "too_large" }));
    a.mux.send({ t: "res", id: 9, ok: false, e: { code: "too_large", m: "too many entries" } });
    await settle();
    expect(a.reader.json(0)).toEqual([{ t: "res", id: 9, ok: false, e: { code: "too_large", m: "too many entries" } }]);
  });

  it("refuses bulk bytes on a channel outside u32, and sends nothing for none", async () => {
    const p = await openPc();
    expect(() => p.mux.sendBytes(-1, Buffer.from("x"))).toThrow(MuxError);
    expect(() => p.mux.sendBytes(2 ** 32, Buffer.from("x"))).toThrow(MuxError);
    expect(() => p.mux.sendBytes(1, "x" as unknown as Uint8Array)).toThrow(MuxError);
    p.mux.sendBytes(1, new Uint8Array(0));
    await settle();
    expect(p.reader.of(2)).toEqual([]);
  });

  it("copies bulk bytes when they are sent, so the caller may reuse its buffer", async () => {
    const p = await openPc();
    const buf = Buffer.alloc(100 * KiB, 1);
    p.mux.sendBytes(3, buf);
    buf.fill(2);
    p.send(credit(2, 64 * KiB));
    await settle();
    const got = Buffer.concat(p.reader.of(2).map(f => f.payload.subarray(4)));
    expect(got.length).toBe(100 * KiB);
    expect(got.every(b => b === 1)).toBe(true);
  });
});

// ─────────────── Data messages ───────────────

describe("data messages", () => {
  it("chunk a 4 MiB answer into data frames of at most 32 KiB and reassemble it exactly", async () => {
    const { pc, agent, tapUp, closed } = pair({ chunks: { seed: 7, max: 9000 } });
    const result = auditResult(CAPS.dataMessageBytes);
    serve(agent, () => result);
    const got = answers(pc);
    pc.send({ t: "req", id: 1, op: "audit.recent", a: { limit: 200 } });
    await until(() => got.has(1), "the 4 MiB answer");
    expect(got.get(1)).toEqual({ t: "res", id: 1, ok: true, v: result });
    const chunks = tapUp.of(1);
    expect(chunks.length).toBeGreaterThanOrEqual(CAPS.dataMessageBytes / CAPS.chunkBytes);
    expect(Math.max(...chunks.map(f => f.payload.length))).toBe(CAPS.chunkBytes);
    expect(chunks.map(f => f.payload[4])).toEqual([...Array(chunks.length - 1).fill(0), 1]);
    expect(chunks.reduce((n, f) => n + f.payload.length - 5, 0)).toBe(CAPS.dataMessageBytes);
    expect(tapUp.of(0, 1)).toEqual([]);
    expect(closed).toEqual([]);
  });

  it("send a message of 60 KiB on ctl and a longer one on data", async () => {
    const { pc, agent, tapUp } = pair();
    const small = auditResult(60 * KiB);
    const large = auditResult(60 * KiB + 1);
    serve(agent, m => (m.id === 1 ? small : large));
    const got = answers(pc);
    pc.send({ t: "req", id: 1, op: "audit.recent", a: { limit: 1 } });
    pc.send({ t: "req", id: 2, op: "audit.recent", a: { limit: 1 } });
    await until(() => got.size === 2, "both answers");
    expect(tapUp.of(0, 1).map(f => f.payload.length)).toEqual([60 * KiB]);
    expect(tapUp.of(1).map(f => f.payload.length - 5)).toEqual([32 * KiB - 5, 60 * KiB + 1 - (32 * KiB - 5)]);
  });

  it("reset the link on a data message over 4 MiB", async () => {
    const p = await openPc();
    const chunk = Buffer.alloc(CAPS.chunkBytes - 5, 0x20);
    let bytes = 0;
    let payload = 0;
    while (bytes <= CAPS.dataMessageBytes && !p.closed.length) {
      const n = Math.min(chunk.length, CAPS.dataMessageBytes + 1 - bytes);
      // Never more than the PC granted (a correct writer, credit counting each chunk's payload), so only the
      // message's size is wrong.
      await until(() => WINDOW_START + p.reader.credited(1) - payload >= n + 5 || p.closed.length > 0, "credit");
      p.send(dataChunk(1, false, chunk.subarray(0, n)));
      bytes += n;
      payload += n + 5;
      await settle(1);
    }
    await settle();
    expect(p.reader.resets().map(r => r.code)).toEqual([RESET_CODE.tooLarge]);
    expect(p.closed[0]).toMatch(/a data message over 4194304 bytes/);
  });

  it("reset the link when a data message starts before the last one ended", async () => {
    const p = await openPc();
    p.send(dataChunk(1, false, Buffer.from("{\"t\":")));
    p.send(dataChunk(2, true, Buffer.from("{}")));
    await settle();
    expect(p.reader.resets().map(r => r.code)).toEqual([RESET_CODE.protocol]);
  });
});

// ─────────────── Credits ───────────────

describe("credits", () => {
  it("let a writer have at most 64 KiB in flight on each stream until credit comes back", async () => {
    const p = await openPc();
    p.mux.sendBytes(9, Buffer.alloc(MiB, 0xab));
    // A request over 60 KiB goes on data: 64 paths of 4000 characters.
    p.mux.send({ t: "req", id: 1, op: "cmd.inspect", a: { paths: Array.from({ length: 64 }, (_, i) => `/${String(i).padStart(3, "0")}${"a".repeat(3995)}`), cwd: "/" } });
    await settle(10);
    const payload = (s: number) => p.reader.of(s).reduce((n, f) => n + f.payload.length, 0);
    expect(payload(2)).toBe(WINDOW_START);
    expect(payload(1)).toBe(WINDOW_START);
    expect(Math.max(...p.reader.of(2).map(f => f.payload.length))).toBe(CAPS.chunkBytes);
    p.send(credit(2, 10_000));
    await settle(10);
    expect(payload(2)).toBe(WINDOW_START + 10_000);
    expect(payload(1)).toBe(WINDOW_START);
    // ctl is never held back by credit.
    p.mux.send({ t: "req", id: 2, op: "stop", a: { epoch: 1 } });
    await settle();
    expect(p.reader.json(0)).toContainEqual({ t: "req", id: 2, op: "stop", a: { epoch: 1 } });
    expect(payload(2)).toBe(WINDOW_START + 10_000);
  });

  it("reset a writer that sends more than it was granted", async () => {
    const p = await openPc();
    const full = bulkChunk(1, Buffer.alloc(CAPS.chunkBytes - 4));
    // Two full chunks use the 64 KiB grant; the third, in the same write, was never granted.
    p.send(Buffer.concat([full, full, full]));
    await settle();
    expect(p.bytes).toHaveLength(2);
    expect(p.reader.resets().map(r => r.code)).toEqual([RESET_CODE.credit]);
    expect(p.closed[0]).toMatch(/more bytes than this end granted/);
  });

  it("reset a reader that grants more than any window", async () => {
    const p = await openPc();
    p.send(credit(2, WINDOW_MAX));
    await settle();
    expect(p.reader.resets().map(r => r.code)).toEqual([RESET_CODE.credit]);
  });

  it("return credit as bytes arrive, so a long transfer never stalls", async () => {
    const { pc, agent, closed } = pair({ chunks: { seed: 3, max: 5000 } });
    const sent = allBytes(8 * 1024); // 2 MiB
    let got = 0;
    pc.onBytes((_c, b) => { got += b.length; });
    agent.sendBytes(5, sent);
    await until(() => got === sent.length, "2 MiB of bulk");
    expect(closed).toEqual([]);
  });

  /** Sends bulk to a PC mux as fast as its credit allows, `msPerRound` of clock per round; returns the most it allowed at once. */
  async function drive(msPerRound: number, rounds: number) {
    let t = 1000;
    const p = await openPc({ now: () => t });
    let sent = 0;
    let most = 0;
    for (let i = 0; i < rounds; i++) {
      const avail = WINDOW_START + p.reader.credited(2) - sent;
      most = Math.max(most, avail);
      const frames: Buffer[] = [];
      for (let left = avail; left > 4; left -= Math.min(left, CAPS.chunkBytes)) {
        frames.push(bulkChunk(1, Buffer.alloc(Math.min(left, CAPS.chunkBytes) - 4)));
      }
      sent += frames.reduce((n, f) => n + f.length - 6, 0);
      p.send(Buffer.concat(frames));
      await settle();
      t += msPerRound;
    }
    expect(p.closed).toEqual([]);
    return { p, most, setNow: (v: number) => { t = v; }, now: () => t };
  }

  it("grow a grant towards 256 KiB only while the measured throughput keeps it all within 250 ms", async () => {
    // 64 KiB or more every 5 ms (≥ 12 MB/s): every granted byte arrives well within 250 ms, so the grant grows.
    const fast = await drive(5, 150);
    expect(fast.most).toBe(WINDOW_MAX);
    const flight = fast.p.mux.inFlight();
    expect(flight.throughput).toBeGreaterThan(10 * MiB);
    // 64 KiB every 400 ms (160 KiB/s): 128 KiB granted would take 800 ms, so the grant never grows.
    const slow = await drive(400, 40);
    expect(slow.most).toBe(WINDOW_START);
    expect(slow.p.mux.inFlight().throughput).toBeGreaterThan(100 * KiB);
    expect(slow.p.mux.inFlight().throughput).toBeLessThan(200 * KiB);
  });

  it("report the grant of a busy stream as in flight, and nothing once it has been idle", async () => {
    const d = await drive(5, 150);
    const busy = d.p.mux.inFlight();
    // The writer here sends everything it is granted at once, so all of the grant is outstanding.
    expect(busy.bytes).toBe(WINDOW_MAX);
    d.setNow(d.now() + 1001);
    expect(d.p.mux.inFlight().bytes).toBe(0);
    // Sent from this end and not yet credited back counts too.
    d.p.mux.sendBytes(4, Buffer.alloc(10 * KiB));
    await settle();
    expect(d.p.mux.inFlight().bytes).toBe(10 * KiB + 4);
  });
});

describe("nextWindow (the 250 ms rule)", () => {
  it("doubles a grant only when both grants would arrive within 250 ms at the measured throughput", () => {
    expect(nextWindow(64 * KiB, 64 * KiB, 0)).toBe(64 * KiB);
    expect(nextWindow(64 * KiB, 64 * KiB, 768 * KiB)).toBe(128 * KiB);
    expect(nextWindow(64 * KiB, 64 * KiB, 768 * KiB - 1)).toBe(64 * KiB);
    expect(nextWindow(128 * KiB, 64 * KiB, 1280 * KiB)).toBe(256 * KiB);
    expect(nextWindow(256 * KiB, 256 * KiB, 100 * MiB)).toBe(WINDOW_MAX);
  });

  it("halves a grown grant once the throughput no longer carries it, never below 64 KiB", () => {
    expect(nextWindow(256 * KiB, 64 * KiB, 1280 * KiB)).toBe(256 * KiB);
    expect(nextWindow(256 * KiB, 64 * KiB, 1280 * KiB - 1)).toBe(128 * KiB);
    expect(nextWindow(128 * KiB, 64 * KiB, 0)).toBe(64 * KiB);
    expect(nextWindow(64 * KiB, 256 * KiB, 0)).toBe(64 * KiB);
  });
});

describe("RateMeter", () => {
  it("leaves out a sample's first read, counts all of its last, and measures at least 250 ms", () => {
    const m = new RateMeter();
    m.add(100 * KiB, 0);
    m.add(50 * KiB, 0);
    m.add(25 * KiB, 125);
    m.add(15 * KiB, 250);
    m.add(10 * KiB, 250);
    // The sample is long enough, but the read at 250 may have more frames: the next arrival closes it.
    expect(m.rate()).toBe(0);
    m.add(1, 260);
    expect(m.rate()).toBe(200 * KiB);
  });

  it("starts again after 500 ms of quiet, keeping its last estimate, and averages samples", () => {
    const m = new RateMeter();
    m.add(1, 0);
    m.add(100 * KiB, 250);
    m.add(0, 251);
    expect(m.rate()).toBe(400 * KiB);
    // 749 ms of quiet: this read opens a new sample and isn't counted.
    m.add(10 * MiB, 1000);
    m.add(50 * KiB, 1250);
    m.add(0, 1300);
    expect(m.rate()).toBe((400 * KiB + 200 * KiB) / 2);
  });
});

// ─────────────── Priority ───────────────

/** A writable that accepts nothing (write returns false, no drain) until released. */
class HeldWritable extends Writable {
  readonly chunks: Buffer[] = [];
  private held: (() => void)[] = [];
  private open = false;

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    if (this.open) cb();
    else this.held.push(() => cb());
  }

  release(): void {
    this.open = true;
    for (const cb of this.held.splice(0)) cb();
  }

  frames(): Reader {
    const r = new Reader();
    r.push(Buffer.concat(this.chunks));
    return r;
  }
}

describe("priority", () => {
  it("lets a Stop's answer overtake 4 MiB of bulk queued before it", async () => {
    const { pc, agent, closed } = pair({ chunks: { seed: 11, max: 4096 } });
    const bulk = allBytes(16 * 1024); // 4 MiB
    serve(agent, m => {
      if (m.op !== "stop") return undefined;
      agent.sendBytes(3, bulk);
      return { ms: 3, late: [] };
    });
    let bulkSeen = 0;
    let bulkBeforeAnswer = -1;
    const parts: Uint8Array[] = [];
    pc.onBytes((_c, b) => { bulkSeen += b.length; parts.push(b); });
    pc.onMessage(m => { if (m.t === "res") bulkBeforeAnswer = bulkSeen; });
    pc.send({ t: "req", id: 1, op: "stop", a: { epoch: 5 } });
    await until(() => bulkSeen === bulk.length, "4 MiB of bulk");
    expect(bulkBeforeAnswer).toBeGreaterThanOrEqual(0);
    expect(bulkBeforeAnswer).toBeLessThanOrEqual(WINDOW_START);
    expect(Buffer.concat(parts).equals(bulk)).toBe(true);
    expect(closed).toEqual([]);
  });

  it("writes ctl, then data, then bulk, then diag, and only while the stream accepts", async () => {
    const out = new HeldWritable();
    const a = rawPeer("agent", { write: out });
    a.send(PC_PREAMBLE);
    a.send(ctlJson({ t: "req", id: 1, op: "audit.recent", a: { limit: 1 } }));
    await settle();
    expect(a.msgs).toHaveLength(1);
    a.mux.send({ t: "ev", ev: "log", d: { level: "info", event: "remote.serve_started" } });
    a.mux.sendBytes(6, Buffer.alloc(40_000, 1));
    a.mux.send({ t: "res", id: 1, ok: true, v: auditResult(100_000) });
    a.mux.send({ t: "ev", ev: "notice", d: { state: "shown" } });
    await settle();
    // Only the preamble so far: the stream hasn't accepted more.
    expect(out.chunks).toHaveLength(1);
    out.release();
    await settle(30);
    const r = out.frames();
    // Data and bulk stop at their 64 KiB grant; diag comes last.
    expect(r.frames.map(f => f.stream)).toEqual([0, 1, 1, 2, 2, 3]);
    expect(r.json(0)).toEqual([{ t: "ev", ev: "notice", d: { state: "shown" } }]);
    expect(r.json(3)).toEqual([{ level: "info", event: "remote.serve_started" }]);
    expect(a.closed).toEqual([]);
  });
});

// ─────────────── Diag ───────────────

describe("the diag stream", () => {
  it("carries the agent's log lines as the log event", async () => {
    const { pc, agent, tapUp } = pair();
    const got: Msg[] = [];
    pc.onMessage(m => got.push(m));
    agent.send({ t: "ev", ev: "log", d: { level: "warn", event: "remote.desktop_lost" } });
    await until(() => got.length === 1, "the log line");
    expect(got).toEqual([{ t: "ev", ev: "log", d: { level: "warn", event: "remote.desktop_lost" } }]);
    expect(tapUp.json(3)).toEqual([{ level: "warn", event: "remote.desktop_lost" }]);
    expect(tapUp.of(0, 1)).toEqual([]);
  });

  it("drops log lines while more than 64 KiB of them is queued", async () => {
    const out = new HeldWritable();
    const a = rawPeer("agent", { write: out });
    a.send(PC_PREAMBLE);
    await settle();
    const line = { level: "debug" as const, event: `remote.${"x".repeat(150)}` };
    const frameBytes = 6 + jsonBytes(line).length;
    for (let i = 0; i < 2000; i++) a.mux.send({ t: "ev", ev: "log", d: line });
    a.mux.send({ t: "ev", ev: "notice", d: { state: "failed" } });
    out.release();
    await until(() => out.frames().of(3).length === Math.floor(DIAG_QUEUE_MAX / frameBytes), "the kept log lines", 5000);
    await settle(10);
    const r = out.frames();
    expect(r.of(3)).toHaveLength(Math.floor(DIAG_QUEUE_MAX / frameBytes));
    expect(r.frames[0].stream).toBe(0);
  });
});

// ─────────────── Liveness ───────────────

describe("liveness", () => {
  it("measures the round trip of a PING as the lowest of the last few, and the silence since the last frame", async () => {
    let t = 5000;
    const p = await openPc({ now: () => t });
    expect(p.mux.rttMs).toBe(0);
    /** Pings, lets `ms` pass, and answers the ping as the agent would. */
    const roundTrip = async (ms: number) => {
      p.mux.ping();
      await settle();
      const pings = p.reader.of(0, 4);
      t += ms;
      p.send(rawFrame(0, 5, pings[pings.length - 1].payload));
      await settle();
    };
    await roundTrip(40);
    expect(p.mux.rttMs).toBe(40);
    await roundTrip(25);
    expect(p.mux.rttMs).toBe(25);
    await roundTrip(90);
    expect(p.mux.rttMs).toBe(25);
    // Only the last 8 count: a slower path shows once the faster samples have aged out.
    for (let i = 0; i < 8; i++) await roundTrip(60);
    expect(p.mux.rttMs).toBe(60);
    expect(p.mux.silentMs()).toBe(0);
    t += 1234;
    expect(p.mux.silentMs()).toBe(1234);
    expect(p.closed).toEqual([]);
  });

  it("answers a PING with the same bytes, and ignores a PONG it didn't ask for", async () => {
    const p = await openPc();
    p.send(rawFrame(0, 4, u64(2 ** 40 + 3)));
    p.send(rawFrame(0, 5, u64(1)));
    await settle();
    expect(p.reader.of(0, 5).map(f => f.payload)).toEqual([u64(2 ** 40 + 3)]);
    expect(p.mux.rttMs).toBe(0);
    expect(p.closed).toEqual([]);
  });

  it("keeps at most a few PONGs queued for a peer that pings without reading", async () => {
    const out = new HeldWritable();
    const a = rawPeer("agent", { write: out });
    a.send(PC_PREAMBLE);
    for (let i = 0; i < 100; i++) a.send(rawFrame(0, 4, u64(i)));
    await settle();
    out.release();
    await settle(40);
    expect(out.frames().of(0, 5).length).toBe(8);
    expect(a.closed).toEqual([]);
  });
});

// ─────────────── Both roles, binary safety ───────────────

describe("both roles over streams cut at random places", () => {
  for (const seed of [1, 2, 3]) {
    it(`carry every byte value and every character both ways intact (seed ${seed})`, async () => {
      const { pc, agent, closed } = pair({ chunks: { seed, max: seed === 1 ? 1 : 37 * seed } });
      const toAgent = allBytes(seed === 1 ? 40 : 400);
      const toPc = allBytes(seed === 1 ? 60 : 600);
      const agentGot: Uint8Array[] = [];
      const pcGot: Uint8Array[] = [];
      agent.onBytes((c, b) => { expect(c).toBe(0xffff_ffff); agentGot.push(b); });
      pc.onBytes((c, b) => { expect(c).toBe(0); pcGot.push(b); });
      const reqs = serve(agent, m => {
        switch (m.op) {
          case "cmd.facts": return facts;
          case "perceive.openWindows": return { lines: [{ app: EVERY_CHAR.slice(0, 200), title: EVERY_CHAR, active: true }] };
          case "policy.sync": return {};
          default: return undefined;
        }
      });
      const got = answers(pc);
      const events: Msg[] = [];
      pc.onMessage(m => { if (m.t === "ev") events.push(m); });
      pc.send({ t: "req", id: 1, op: "cmd.facts", a: {} });
      pc.send({ t: "req", id: 2, op: "perceive.openWindows", a: {} });
      pc.send({ t: "req", id: 3, op: "policy.sync", a: { neverLook: [EVERY_CHAR.slice(0, 200), EVERY_CHAR.slice(200)], localAdmin: hello().localAdmin } });
      pc.sendBytes(0xffff_ffff, toAgent);
      agent.sendBytes(0, toPc);
      agent.send({ t: "ev", ev: "console.stop", d: { at: "2026-10-22T12:00:00.000Z" } });
      await until(() => got.size === 3 && Buffer.concat(agentGot).length === toAgent.length && Buffer.concat(pcGot).length === toPc.length && events.length === 1, "everything");
      expect(Buffer.concat(agentGot).equals(toAgent)).toBe(true);
      expect(Buffer.concat(pcGot).equals(toPc)).toBe(true);
      expect((reqs[2].a as { neverLook: string[] }).neverLook.join("")).toBe(EVERY_CHAR);
      expect(got.get(2)).toEqual({ t: "res", id: 2, ok: true, v: { lines: [{ app: EVERY_CHAR.slice(0, 200), title: EVERY_CHAR, active: true }] } });
      // A RegExp crosses as its list of names and is rebuilt from it.
      const names = ((got.get(1) as { v: RunnerFacts }).v.ember.names);
      expect(names).toBeInstanceOf(RegExp);
      expect(names.test("ember-remote")).toBe(true);
      expect(names.test("ember-remoteX")).toBe(false);
      expect(events).toEqual([{ t: "ev", ev: "console.stop", d: { at: "2026-10-22T12:00:00.000Z" } }]);
      expect(closed).toEqual([]);
    });
  }
});

// ─────────────── Closing ───────────────

describe("closing", () => {
  it("closes when the other end's stream ends, and never ends or destroys the streams itself", async () => {
    const p = await openPc();
    p.toMux.end();
    await settle();
    expect(p.closed).toEqual(["the other end closed the link"]);
    expect(p.fromMux.writableEnded).toBe(false);
    expect(p.fromMux.destroyed).toBe(false);
  });

  it("reports a RESET from the other end with its reason, made plain", async () => {
    const p = await openPc();
    p.send(resetFrame(7, "bye\nnow\u0000"));
    await settle();
    expect(p.closed).toEqual(["reset by the other end (7): bye now "]);
    expect(p.reader.resets()).toEqual([]);
  });

  it("reset() writes a RESET ahead of anything queued, closes once, and later sends do nothing", async () => {
    const p = await openPc();
    p.mux.sendBytes(1, Buffer.alloc(200 * KiB));
    await settle();
    const before = p.reader.frames.length;
    p.mux.reset(RESET_CODE.normal, "the user disconnected");
    p.mux.reset(RESET_CODE.normal, "again");
    p.mux.send({ t: "req", id: 1, op: "stop", a: { epoch: 1 } });
    p.mux.sendBytes(1, Buffer.alloc(10));
    p.mux.ping();
    p.send(credit(2, 64 * KiB));
    await settle();
    expect(p.reader.frames.slice(before).map(f => f.kind)).toEqual([6]);
    expect(p.reader.resets()).toEqual([{ code: 0, reason: "the user disconnected" }]);
    expect(p.closed).toEqual(["reset here (0): the user disconnected"]);
    const late: string[] = [];
    p.mux.onClose(w => late.push(w));
    await settle(1);
    expect(late).toEqual(["reset here (0): the user disconnected"]);
    // Closed: nothing more is checked or sent.
    expect(() => p.mux.reset(70_000, "x")).not.toThrow();
    const q = await openPc();
    expect(() => q.mux.reset(70_000, "x")).toThrow(MuxError);
    expect(q.closed).toEqual([]);
  });

  it("cuts a RESET's reason to 200 bytes", async () => {
    const p = await openPc();
    p.mux.reset(9, "é".repeat(300));
    await settle();
    expect(Buffer.byteLength(p.reader.resets()[0].reason)).toBe(200);
  });

  it("keeps delivering to other listeners when one throws, and stops delivering to one that unsubscribed", async () => {
    const p = await openPc();
    const seen: string[] = [];
    p.mux.onMessage(() => { throw new Error("listener bug"); });
    const off = p.mux.onMessage(m => seen.push(`b:${m.t}`));
    p.send(ctlJson({ t: "ev", ev: "notice", d: { state: "off" } }));
    await settle();
    off();
    p.send(ctlJson({ t: "ev", ev: "notice", d: { state: "off" } }));
    await settle();
    expect(seen).toEqual(["b:ev"]);
    expect(p.msgs).toHaveLength(2);
    expect(p.closed).toEqual([]);
  });

  it("closes when its output fails, without throwing", async () => {
    const out = new Writable({ write(_c, _e, cb) { cb(new Error("EPIPE")); } });
    const a = rawPeer("agent", { write: out });
    await settle();
    expect(a.closed[0]).toMatch(/the link's output failed: EPIPE/);
  });
});
