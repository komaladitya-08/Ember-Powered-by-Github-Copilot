import { describe, expect, it } from "vitest";
import { acquireLock, lockText, parseLock, processStart, type LockIo } from "../../app/remote/lock";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const PC = "a".repeat(32);
const OTHER_PC = "b".repeat(32);
const FILE = "/run/user/1000/ember-remote/lock";

/** An in-memory lock folder and process table with a clock that moves only when the agent sleeps. */
function machine(o: { procs?: Record<number, string>; lock?: string; onSleep?: (now: number, m: ReturnType<typeof machine>) => void } = {}) {
  const files = new Map<string, string>();
  if (o.lock !== undefined) files.set(FILE, o.lock);
  const procs = new Map(Object.entries(o.procs ?? {}).map(([k, v]) => [Number(k), v]));
  const signals: { pid: number; signal: string; at: number }[] = [];
  let now = 0;
  const m = {
    files, procs, signals,
    get now() { return now; },
    io: {
      create(file: string, text: string) {
        if (files.has(file)) return false;
        files.set(file, text);
        return true;
      },
      read: (file: string) => files.get(file) ?? null,
      remove: (file: string) => { files.delete(file); },
      startOf: (pid: number) => procs.get(pid) ?? null,
      kill(pid: number, signal: NodeJS.Signals) { signals.push({ pid, signal, at: now }); if (signal === "SIGKILL") procs.delete(pid); },
      async sleep(ms: number) { now += ms; o.onSleep?.(now, m); },
      now: () => now,
    } satisfies LockIo,
  };
  return m;
}

const me = { pid: 500, start: "9000", pcId: PC };

describe("the agent's lock", () => {
  it("is taken when nobody holds it, with the pid, start time and PC id", async () => {
    const m = machine({ procs: { 500: "9000" } });
    const r = await acquireLock({ file: FILE, me, graceMs: 20_000, io: m.io, log: quiet });
    expect(r.ok).toBe(true);
    expect(m.files.get(FILE)).toBe(`500 9000 ${PC}\n`);
    if (r.ok) r.release();
    expect(m.files.has(FILE)).toBe(false);
  });

  it("replaces a stale lock: no such process, another process under that pid, or no lock at all in the file", async () => {
    for (const lock of [`77 1234 ${OTHER_PC}\n`, `78 1234 ${OTHER_PC}\n`, "garbage"]) {
      const m = machine({ procs: { 500: "9000", 78: "5555" }, lock });
      const r = await acquireLock({ file: FILE, me, graceMs: 20_000, io: m.io, log: quiet });
      expect(r.ok).toBe(true);
      expect(parseLock(m.files.get(FILE)!)).toEqual(me);
      expect(m.signals).toEqual([]);
    }
  });

  it("refuses when a live agent of another PC holds it (\"busy\")", async () => {
    const m = machine({ procs: { 500: "9000", 77: "1234" }, lock: `77 1234 ${OTHER_PC}\n` });
    const r = await acquireLock({ file: FILE, me, graceMs: 20_000, io: m.io, log: quiet });
    expect(r).toEqual({ ok: false, holder: { pid: 77, start: "1234", pcId: OTHER_PC } });
    expect(m.signals).toEqual([]);
    expect(m.now).toBe(0);
  });

  it("waits for this PC's own previous agent to finish stopping, without a signal when it does (critique remote-5)", async () => {
    const m = machine({
      procs: { 500: "9000", 77: "1234" },
      lock: `77 1234 ${PC}\n`,
      onSleep: (now, mm) => { if (now >= 4000) { mm.procs.delete(77); mm.files.delete(FILE); } },
    });
    const r = await acquireLock({ file: FILE, me, graceMs: 20_000, io: m.io, log: quiet });
    expect(r.ok && r.tookOver).toBe(null);
    expect(m.signals).toEqual([]);
    expect(m.now).toBe(4000);
    expect(parseLock(m.files.get(FILE)!)?.pid).toBe(500);
  });

  it("takes the lock over from this PC's previous agent only after the grace + 3 s, with SIGTERM", async () => {
    const m = machine({
      procs: { 500: "9000", 77: "1234" },
      lock: `77 1234 ${PC}\n`,
      onSleep: (_now, mm) => { if (mm.signals.some(s => s.pid === 77 && s.signal === "SIGTERM")) mm.procs.delete(77); },
    });
    const r = await acquireLock({ file: FILE, me, graceMs: 20_000, io: m.io, log: quiet });
    expect(r.ok && r.tookOver).toBe(77);
    expect(m.signals).toEqual([{ pid: 77, signal: "SIGTERM", at: 23_000 }]);
    expect(parseLock(m.files.get(FILE)!)?.pid).toBe(500);
  });

  it("kills a previous agent that ignores SIGTERM", async () => {
    const m = machine({ procs: { 500: "9000", 77: "1234" }, lock: `77 1234 ${PC}\n` });
    const r = await acquireLock({ file: FILE, me, graceMs: 3000, io: m.io, log: quiet });
    expect(r.ok && r.tookOver).toBe(77);
    expect(m.signals.map(s => [s.signal, s.at])).toEqual([["SIGTERM", 6000], ["SIGKILL", 8000]]);
  });

  it("releases only its own lock (a later agent may have taken it over)", async () => {
    const m = machine({ procs: { 500: "9000" } });
    const r = await acquireLock({ file: FILE, me, graceMs: 20_000, io: m.io, log: quiet });
    m.files.set(FILE, lockText({ pid: 600, start: "1", pcId: PC }));
    if (r.ok) r.release();
    expect(m.files.get(FILE)).toBe(`600 1 ${PC}\n`);
  });
});

describe("parseLock", () => {
  it("reads only the lock's own form", () => {
    expect(parseLock(`12 345 ${PC}`)).toEqual({ pid: 12, start: "345", pcId: PC });
    expect(parseLock(`0 345 ${PC}\n`)).toBeNull();
    expect(parseLock(`12 3 4 ${PC}\n`)).toBeNull();
    expect(parseLock(`12 345 ${PC.toUpperCase()}\n`)).toBeNull();
    expect(parseLock(null)).toBeNull();
  });
});

describe("processStart", () => {
  it("reads Linux's starttime even when the command's name holds spaces and parentheses", () => {
    const stat = "4242 (a (weird) name) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 200";
    expect(processStart("linux", 4242, { stat: () => stat, ps: () => null })).toBe("987654");
    expect(processStart("linux", 4242, { stat: () => null, ps: () => null })).toBeNull();
  });

  it("reads macOS's start date as one token", () => {
    expect(processStart("darwin", 7, { stat: () => null, ps: () => "Thu Oct 22 16:40:00 2026\n" })).toBe("Thu-Oct-22-16:40:00-2026");
    expect(processStart("darwin", 7, { stat: () => null, ps: () => "" })).toBeNull();
    expect(processStart("darwin", -1, { stat: () => null, ps: () => "x" })).toBeNull();
  });
});
