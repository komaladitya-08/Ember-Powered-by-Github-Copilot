/**
 * How often the main process moves Ember (rp-7): 60 times a second while Ember or the pointer moves, and about 10 once
 * both have been still for 2 s, so an Ember at rest stops waking the processor 60 times a second.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  const display = { id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  return {
    BrowserWindow: class {},
    screen: { getAllDisplays: () => [display], getCursorScreenPoint: () => ({ x: 900, y: 600 }), getDisplayNearestPoint: () => display, getDisplayMatching: () => display, on() {}, off() {} },
  };
});

import type { Logger } from "../../app/main/logger";
import type { Settings } from "../../app/main/settings";
import { FAST_TICK_MS, SLOW_TICK_MS, tickGap } from "../../app/main/overlay";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const shaper = { setInputRegion: () => false, release() {}, forward: false, floating: () => ({ options: {}, allWorkspaces: null }) };

afterEach(() => { vi.useRealTimers(); });

describe("tickGap", () => {
  it("is 60 Hz within 2 s of the last movement, and about 10 Hz after (rp-7)", () => {
    expect(FAST_TICK_MS).toBe(16);
    expect(SLOW_TICK_MS).toBe(100);
    expect(tickGap(0)).toBe(FAST_TICK_MS);
    expect(tickGap(1999)).toBe(FAST_TICK_MS);
    expect(tickGap(2000)).toBe(SLOW_TICK_MS);
    expect(tickGap(600_000)).toBe(SLOW_TICK_MS);
  });
});

describe("the main process's frame loop", () => {
  async function manager() {
    vi.useFakeTimers();
    const { OverlayManager } = await import("../../app/main/overlay");
    let pointer = { x: 900, y: 600 };
    const m = new OverlayManager(() => ({ size: 60, reduceMotion: false }) as Settings, quiet, () => pointer, shaper);
    const inner = m as unknown as { tick(): void; running: boolean; loop(): void };
    let ticks = 0;
    const tick = inner.tick.bind(m);
    inner.tick = () => { ticks++; tick(); };
    // start() without windows: only the loop.
    inner.running = true;
    inner.loop();
    const over = async (ms: number) => { const before = ticks; await vi.advanceTimersByTimeAsync(ms); return ticks - before; };
    return { m, over, move: (x: number, y: number) => { pointer = { x, y }; }, stop: () => m.stop() };
  }

  it("ticks about 10 times a second once Ember and the pointer have been still for 2 s, not 60 (rp-7)", async () => {
    const { over, stop } = await manager();
    // Ember settles beside the pointer, then everything is still.
    await over(15_000);
    expect(await over(1000)).toBeLessThanOrEqual(11);
    stop();
  });

  it("is back at 60 a second within 100 ms of the pointer moving (rp-7)", async () => {
    const { over, move, stop } = await manager();
    await over(15_000);
    move(400, 300);
    await over(100);
    expect(await over(1000)).toBeGreaterThanOrEqual(55);
    stop();
  });

  it("goes back to 60 a second at once when the state changes, so a question's Ember stops where it is (rp-7)", async () => {
    const { m, over, stop } = await manager();
    await over(15_000);
    m.setState({ status: "Working in Files" });
    expect(await over(500)).toBeGreaterThanOrEqual(25);
    stop();
  });
});
