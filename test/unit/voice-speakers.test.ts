/** The speakers' stream (parec) kept running, and the watchdog for microphone frames that stop. */

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeakerMonitor } from "../../app/voice/speakers";
import { FrameWatchdog } from "../../app/voice/watchdog";

function setup() {
  const children: (EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> })[] = [];
  const states: [boolean, string?][] = [];
  const frames: Float32Array[] = [];
  const spawn = () => {
    const p = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
    children.push(p);
    return p as unknown as ChildProcess;
  };
  const monitor = new SpeakerMonitor(f => frames.push(f), (on, reason) => states.push(reason ? [on, reason] : [on]), spawn);
  return { monitor, children, states, frames };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("speakers' stream", () => {
  it("counts as on only once parec has started, and passes on 512-sample frames", () => {
    const s = setup();
    s.monitor.start();
    expect(s.states).toEqual([]);
    s.children[0].emit("spawn");
    expect(s.states).toEqual([[true]]);
    const audio = Float32Array.from({ length: 1100 }, (_, i) => i / 1100);
    const bytes = Buffer.from(audio.buffer);
    s.children[0].stdout.emit("data", bytes.subarray(0, 3000));
    s.children[0].stdout.emit("data", bytes.subarray(3000));
    expect(s.frames.map(f => f.length)).toEqual([512, 512]);
    expect(s.frames[1][0]).toBeCloseTo(512 / 1100);
  });

  it("starts parec again when it stops: after 1 s, 5 s, then every 30 s", () => {
    const s = setup();
    s.monitor.start();
    s.children[0].emit("spawn");
    s.children[0].emit("exit", 1, null);
    expect(s.states.at(-1)).toEqual([false, "parec stopped (exit 1)"]);
    vi.advanceTimersByTime(999);
    expect(s.children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(s.children).toHaveLength(2);
    s.children[1].emit("exit", 1, null); // PulseAudio isn't back yet
    vi.advanceTimersByTime(5000);
    expect(s.children).toHaveLength(3);
    s.children[2].emit("exit", 1, null);
    vi.advanceTimersByTime(29_999);
    expect(s.children).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(s.children).toHaveLength(4);
    s.children[3].emit("spawn");
    expect(s.states.at(-1)).toEqual([true]);
  });

  it("stays off without parec installed", () => {
    const s = setup();
    s.monitor.start();
    s.children[0].emit("error", Object.assign(new Error("spawn parec ENOENT"), { code: "ENOENT" }));
    vi.advanceTimersByTime(120_000);
    expect(s.children).toHaveLength(1);
    expect(s.states).toEqual([[false, "parec isn't installed (pulseaudio-utils)"]]);
  });

  it("stop() ends it for good", () => {
    const s = setup();
    s.monitor.start();
    s.children[0].emit("spawn");
    s.monitor.stop();
    expect(s.children[0].kill).toHaveBeenCalled();
    s.children[0].emit("exit", null, "SIGTERM");
    vi.advanceTimersByTime(60_000);
    expect(s.children).toHaveLength(1);
    expect(s.states).toEqual([[true]]);
  });
});

describe("frame watchdog", () => {
  it("speaks up once when frames stop for 3 s (10 s before the first one)", () => {
    let t = 0;
    const stalls: number[] = [];
    const w = new FrameWatchdog(ms => stalls.push(ms), () => t);
    t = 9000; w.check();
    expect(stalls).toEqual([]);
    t = 10_500; w.check(); w.check();
    expect(stalls).toEqual([10_500]);
    w.frame();
    for (let i = 0; i < 90; i++) { t += 32; w.frame(); w.check(); } // audio flows
    expect(stalls).toHaveLength(1);
    t += 2900; w.check();
    expect(stalls).toHaveLength(1);
    t += 200; w.check(); w.check();
    expect(stalls).toEqual([10_500, 3100]);
  });
});
