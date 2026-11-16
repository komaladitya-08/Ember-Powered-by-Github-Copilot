/** Portable proof ordering and failure quarantine. No collector, native binding or download is involved. */
import { describe, expect, it, vi } from "vitest";
import { completeChildAccessReadout, ChildAccessReadoutError, childAccessReadoutPhase, closeChildAccessOwnedStack, type ChildAccessReadout } from "../fixtures/windows-lpac-child-access-readout";
import type { WindowsLpacChildAccessAggregate } from "../fixtures/windows-lpac-child-access-parser";

const aggregate: WindowsLpacChildAccessAggregate = Object.freeze({ schema: 1, status: 1, coverage: 7, rows: Object.freeze([]) });
function setup(fault?: string) {
  const events: string[] = [], retained: unknown[] = [], bytes = Buffer.from("private trace path and details");
  const event = (name: string) => { events.push(name); if (name === fault) throw new Error("private path and cause", { cause: "secret" }); };
  const pin = (name: string) => ({ size: bytes.length, unchanged: () => event(`${name}:unchanged`), close: () => event(`${name}:close`),
    read: () => { event(`${name}:read`); return bytes; } });
  const pml = pin("pml"), csv = pin("csv");
  const input: ChildAccessReadout = {
    requireRootStopped: () => event("root:stopped"), requireCollectorStopped: () => event("collector:stopped"),
    pinPml: () => { event("pml:pin"); return pml; }, exportPml: value => { expect(value).toBe(pml); event("export:stopped"); },
    pinCsv: () => { event("csv:pin"); return csv; }, stopWatchdog: async () => { event("watchdog:stopped"); },
    decode: value => { expect(value).toBe(bytes); event("decode"); return aggregate; },
    closeOwners: async () => { event("owners:close"); }, removeKnownScratch: () => event("scratch:remove"),
    retain: owners => { retained.push(owners); },
  };
  return { input, events, retained, bytes };
}
describe("stopped fixed child witness publication", () => {
  it("retains the failed and unattempted ownership references when reverse closure becomes uncertain", () => {
    const owners = [1n, 2n, 3n], calls: bigint[] = [];
    expect(() => closeChildAccessOwnedStack(owners, owner => { calls.push(owner); if (owner === 2n) throw new Error("private close"); })).toThrow();
    expect(calls).toEqual([3n, 2n]); expect(owners).toEqual([1n, 2n]);
  });
  it("waits for every native writer and watchdog before decoding, then closes all owners before returning counts", async () => {
    const f = setup(); expect(await completeChildAccessReadout(f.input)).toBe(aggregate);
    expect(f.events).toEqual(["root:stopped", "collector:stopped", "pml:pin", "pml:unchanged", "export:stopped", "pml:unchanged", "csv:pin", "csv:unchanged",
      "watchdog:stopped", "root:stopped", "collector:stopped", "pml:unchanged", "csv:unchanged", "csv:read", "decode", "pml:unchanged", "csv:unchanged",
      "csv:close", "pml:close", "owners:close", "scratch:remove"]);
    expect(f.bytes.every(value => value === 0)).toBe(true); expect(f.retained).toEqual([]);
  });
  it.each([
    ["root:stopped", 1], ["collector:stopped", 2], ["pml:pin", 3], ["export:stopped", 4], ["csv:pin", 5], ["watchdog:stopped", 6],
    ["csv:read", 7], ["decode", 8], ["csv:close", 9], ["owners:close", 10], ["scratch:remove", 11],
  ] as const)("retains ownership and publishes only a fixed phase after %s refuses", async (fault, phase) => {
    const f = setup(fault); let error: unknown;
    try { await completeChildAccessReadout(f.input); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(ChildAccessReadoutError); expect(childAccessReadoutPhase(error)).toBe(phase);
    expect(String(error)).not.toMatch(/private|path|secret|cause/); expect((error as Error).cause).toBeUndefined();
    expect(f.retained).toHaveLength(1);
    if (phase < 8) expect(f.events).not.toContain("decode");
    if (phase < 9) expect(f.events).not.toContain("csv:close");
    if (phase < 11) expect(f.events).not.toContain("scratch:remove");
    if (phase >= 8) expect(f.bytes.every(value => value === 0)).toBe(true);
  });
  it("blocks readout while watchdog completion is pending and blocks return while owner closure is pending", async () => {
    const f = setup(); let watcherDone!: () => void, ownersDone!: () => void;
    f.input.stopWatchdog = () => new Promise(resolve => { watcherDone = resolve; });
    f.input.closeOwners = () => new Promise(resolve => { ownersDone = resolve; });
    const returned = vi.fn(), promise = completeChildAccessReadout(f.input).then(value => { returned(value); return value; });
    await Promise.resolve(); expect(f.events).not.toContain("decode"); expect(returned).not.toHaveBeenCalled();
    watcherDone(); await Promise.resolve(); await Promise.resolve();
    expect(f.events).toContain("decode"); expect(returned).not.toHaveBeenCalled(); expect(f.events).not.toContain("scratch:remove");
    ownersDone(); expect(await promise).toBe(aggregate); expect(returned).toHaveBeenCalledOnce();
  });
  it("does not treat a forged or text-bearing error as a numeric transaction receipt", () => {
    expect(childAccessReadoutPhase(new Error("private", { cause: 7 }))).toBe(0);
    expect(childAccessReadoutPhase({ phase: 8 })).toBe(0); expect(childAccessReadoutPhase(null)).toBe(0);
  });
});
