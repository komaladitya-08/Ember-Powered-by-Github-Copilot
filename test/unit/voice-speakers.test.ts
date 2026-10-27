/** The speakers' stream (parec) kept running, and the watchdog for microphone frames that stop. */

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeakerMonitor } from "../../app/voice/speakers";
import { FrameWatchdog } from "../../app/voice/watchdog";

/** `children`: parec's runs; `watchers`: pactl's (what it is asked is in `watched`). */
function setup() {
  type Child = EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> };
  const children: Child[] = [], watchers: Child[] = [];
  const watched: string[][] = [];
  const states: [boolean, string?][] = [];
  const frames: Float32Array[] = [];
  const spawn = (cmd: string, args: string[]) => {
    const p = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
    if (cmd === "pactl") { watchers.push(p); watched.push(args); } else children.push(p);
    return p as unknown as ChildProcess;
  };
  const monitor = new SpeakerMonitor(f => frames.push(f), (on, reason) => states.push(reason ? [on, reason] : [on]), spawn);
  return { monitor, children, watchers, watched, states, frames };
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

  it("starts parec again on the new default output when it changes (headphones, a Bluetooth speaker) (review #260)", () => {
    const s = setup();
    s.monitor.start();
    s.children[0].emit("spawn");
    expect(s.watched).toEqual([["subscribe"]]);
    s.watchers[0].stdout.emit("data", Buffer.from("Event 'new' on sink-input #12\nEvent 'change' on sink #1\n"));
    vi.advanceTimersByTime(1000);
    expect(s.children).toHaveLength(1); // something played: the default output is the same
    s.watchers[0].stdout.emit("data", Buffer.from("Event 'change' on ser"));
    s.watchers[0].stdout.emit("data", Buffer.from("ver #4294967295\n"));
    vi.advanceTimersByTime(499);
    expect(s.children[0].kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(s.children[0].kill).toHaveBeenCalled();
    expect(s.children).toHaveLength(2); // at once, on the new default's monitor
    s.children[0].emit("exit", null, "SIGTERM");
    s.children[1].emit("spawn");
    expect(s.states).toEqual([[true], [true]]); // never reported off meanwhile
    vi.advanceTimersByTime(60_000);
    expect(s.children).toHaveLength(2); // nor started again after the old one's end
    expect(s.watchers).toHaveLength(1);
  });

  it("stop() ends it for good", () => {
    const s = setup();
    s.monitor.start();
    s.children[0].emit("spawn");
    s.monitor.stop();
    expect(s.children[0].kill).toHaveBeenCalled();
    expect(s.watchers[0].kill).toHaveBeenCalled();
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
    const seconds = (n: number) => { for (let i = 0; i < n; i++) { t += 1000; w.check(); } }; // checked every second
    seconds(10);
    expect(stalls).toEqual([]);
    seconds(1);
    expect(stalls).toEqual([11_000]);
    w.frame();
    for (let i = 0; i < 90; i++) { t += 32; w.frame(); w.check(); } // audio flows
    expect(stalls).toHaveLength(1);
    seconds(3);
    expect(stalls).toHaveLength(1);
    seconds(2);
    expect(stalls).toEqual([11_000, 4000]);
  });

  it("says nothing after the computer slept (its own checks came late), unless frames still don't come", () => {
    let t = 0;
    const stalls: number[] = [];
    const w = new FrameWatchdog(ms => stalls.push(ms), () => t);
    w.frame();
    for (let i = 0; i < 5; i++) { t += 1000; w.frame(); w.check(); }
    t += 3_600_000; w.check(); // an hour asleep: the first check after waking
    expect(stalls).toEqual([]);
    t += 500; w.frame(); t += 500; w.check(); // the microphone is back
    for (let i = 0; i < 5; i++) { t += 1000; w.frame(); w.check(); }
    expect(stalls).toEqual([]);
    t += 3_600_000; w.check(); // asleep again, and this time no frames follow
    for (let i = 0; i < 4; i++) { t += 1000; w.check(); }
    expect(stalls).toEqual([4000]);
  });
});
