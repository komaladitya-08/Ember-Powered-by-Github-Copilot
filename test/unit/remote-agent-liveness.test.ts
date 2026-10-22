import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEADMAN_MS, FRESH_MS, startLiveness } from "../../app/remote/liveness";

/** A link whose last frame from the PC came at `last` (ms on the fake clock). */
function link() {
  const l = { last: 0, pings: 0, silentMs: () => Date.now() - l.last, ping: () => { l.pings++; } };
  return l;
}

describe("the agent's liveness (§5.1.11)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it("pings every 500 ms and calls the link fresh only under 1.5 s of silence", () => {
    const l = link();
    const live = startLiveness({ ...l, graceMs: () => 20_000, onDeadman: () => {}, onAlive: () => {}, onGrace: () => {} });
    vi.advanceTimersByTime(2000);
    expect(l.pings).toBe(4);
    vi.setSystemTime(FRESH_MS - 1);
    expect(live.fresh()).toBe(true);
    vi.setSystemTime(FRESH_MS);
    expect(live.fresh()).toBe(false);
    live.stop();
  });

  it("stops desktop work after 3 s of silence but lets commands run until the grace (critique remote-7)", () => {
    const l = link();
    const events: [string, number][] = [];
    const live = startLiveness({
      ...l, graceMs: () => 20_000,
      onDeadman: () => events.push(["deadman", Date.now()]),
      onAlive: () => events.push(["alive", Date.now()]),
      onGrace: () => events.push(["grace", Date.now()]),
    });
    vi.advanceTimersByTime(19_500);
    expect(events).toEqual([["deadman", DEADMAN_MS]]);
    expect(live.dead).toBe(true);
    vi.advanceTimersByTime(500);
    expect(events).toEqual([["deadman", DEADMAN_MS], ["grace", 20_000]]);
    vi.advanceTimersByTime(5000);
    expect(events.filter(e => e[0] === "grace")).toHaveLength(1);
    live.stop();
  });

  it("lets a blip shorter than the grace pass: desktop work resumes and no command stops", () => {
    const l = link();
    const events: string[] = [];
    const live = startLiveness({ ...l, graceMs: () => 20_000, onDeadman: () => events.push("deadman"), onAlive: () => events.push("alive"), onGrace: () => events.push("grace") });
    vi.advanceTimersByTime(10_000);
    l.last = Date.now();
    vi.advanceTimersByTime(500);
    expect(events).toEqual(["deadman", "alive"]);
    expect(live.dead).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(events).toEqual(["deadman", "alive"]);
    live.stop();
  });

  it("follows a grace lowered by the PC's policy (3 s at the least)", () => {
    const l = link();
    let grace = 20_000;
    const events: string[] = [];
    const live = startLiveness({ ...l, graceMs: () => grace, onDeadman: () => events.push("deadman"), onAlive: () => {}, onGrace: () => events.push("grace") });
    grace = 3000;
    vi.advanceTimersByTime(3000);
    expect(events).toEqual(["deadman", "grace"]);
    live.stop();
  });

  it("does nothing after stop", () => {
    const l = link();
    const events: string[] = [];
    const live = startLiveness({ ...l, graceMs: () => 20_000, onDeadman: () => events.push("deadman"), onAlive: () => {}, onGrace: () => events.push("grace") });
    live.stop();
    vi.advanceTimersByTime(60_000);
    expect(events).toEqual([]);
    expect(l.pings).toBe(0);
  });
});
