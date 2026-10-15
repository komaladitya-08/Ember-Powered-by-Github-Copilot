/** The mic page's capture (renderer/mic/capture.ts) with stand-in devices: it gets the microphone back. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Capture, type CaptureDeps } from "../../app/renderer/mic/capture";
import type { MicStatus } from "../../app/shared/voice";

type FakeTrack = { label: string; muted: boolean; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null; onmute: (() => void) | null; onunmute: (() => void) | null };
type FakeCtx = { state: string; sampleRate: number; onstatechange: (() => void) | null; resume: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

function setup() {
  const tracks: FakeTrack[] = [];
  const contexts: FakeCtx[] = [];
  const statuses: MicStatus["state"][] = [];
  const failures: Error[] = []; // getUserMedia fails with these first
  let devices = [{ kind: "audioinput", deviceId: "default", groupId: "laptop", label: "Default - Built-in Audio" }];
  let deviceChange = () => undefined as void;
  const deps: CaptureDeps = {
    getUserMedia: vi.fn(async () => {
      const err = failures.shift();
      if (err) throw err;
      const track: FakeTrack = { label: devices[0].label, muted: false, stop: vi.fn(), onended: null, onmute: null, onunmute: null };
      tracks.push(track);
      return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    }),
    enumerateDevices: async () => devices as MediaDeviceInfo[],
    onDeviceChange: fn => { deviceChange = fn; },
    graph: async () => {
      const ctx: FakeCtx = { state: "running", sampleRate: 16000, onstatechange: null, resume: vi.fn(async () => { ctx.state = "running"; }), close: vi.fn(async () => { ctx.state = "closed"; }) };
      contexts.push(ctx);
      return ctx as unknown as AudioContext;
    },
    status: s => statuses.push(s.state),
  };
  const capture = new Capture(deps);
  return {
    capture, deps, tracks, contexts, statuses, failures,
    setDevices: (d: typeof devices) => { devices = d; },
    devicesChanged: () => deviceChange(),
  };
}

const notFound = () => Object.assign(new Error("Requested device not found"), { name: "NotFoundError" });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("microphone capture", () => {
  it("starts again when the microphone is unplugged", async () => {
    const c = setup();
    await c.capture.start();
    expect(c.statuses).toEqual(["capturing"]);
    c.tracks[0].onended!();
    expect(c.statuses).toEqual(["capturing", "lost"]);
    expect(c.tracks[0].stop).toHaveBeenCalled();
    expect(c.contexts[0].close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.statuses).toEqual(["capturing", "lost", "capturing"]);
    expect(c.deps.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("keeps trying after 1 s, 5 s, then every 30 s, and at once when a device appears", async () => {
    const c = setup();
    await c.capture.start();
    c.failures.push(notFound(), notFound(), notFound());
    c.tracks[0].onended!();
    await vi.advanceTimersByTimeAsync(1000); // fails
    expect(c.deps.getUserMedia).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4900);
    expect(c.deps.getUserMedia).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100); // 5 s: fails
    expect(c.deps.getUserMedia).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(29_900);
    expect(c.deps.getUserMedia).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(100); // 30 s: fails
    expect(c.deps.getUserMedia).toHaveBeenCalledTimes(4);
    expect(c.statuses).toEqual(["capturing", "lost", "lost", "lost", "lost"]);
    c.devicesChanged(); // a microphone is plugged in
    await vi.advanceTimersByTimeAsync(600);
    expect(c.deps.getUserMedia).toHaveBeenCalledTimes(5);
    expect(c.statuses.at(-1)).toBe("capturing");
  });

  it("follows a new default device, and isn't interrupted by other device changes", async () => {
    const c = setup();
    await c.capture.start();
    c.devicesChanged(); // e.g. a webcam's microphone appears; the default is the same
    await vi.advanceTimersByTimeAsync(600);
    expect(c.deps.getUserMedia).toHaveBeenCalledTimes(1);
    c.setDevices([{ kind: "audioinput", deviceId: "default", groupId: "headset", label: "Default - USB Headset" }]);
    c.devicesChanged();
    await vi.advanceTimersByTimeAsync(600);
    expect(c.deps.getUserMedia).toHaveBeenCalledTimes(2);
    expect(c.tracks[0].stop).toHaveBeenCalled();
    expect(c.statuses).toEqual(["capturing", "capturing"]); // no "lost": just a moment's gap
  });

  it("waits out a short mute, and starts again after a long one", async () => {
    const c = setup();
    await c.capture.start();
    const t = c.tracks[0];
    t.muted = true; t.onmute!();
    await vi.advanceTimersByTimeAsync(1500);
    t.muted = false; t.onunmute!();
    await vi.advanceTimersByTimeAsync(3000);
    expect(c.statuses).toEqual(["capturing"]);
    t.muted = true; t.onmute!();
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.statuses).toEqual(["capturing", "lost"]);
  });

  it("resumes a suspended audio context, and starts again if it closes", async () => {
    const c = setup();
    await c.capture.start();
    const ctx = c.contexts[0];
    ctx.state = "suspended"; ctx.onstatechange!();
    expect(ctx.resume).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500);
    expect(c.statuses).toEqual(["capturing"]);
    ctx.state = "closed"; ctx.onstatechange!();
    expect(c.statuses).toEqual(["capturing", "lost"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.statuses.at(-1)).toBe("capturing");
  });

  it("leaves a microphone that never opened to main (an error, not retried)", async () => {
    const c = setup();
    c.failures.push(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    await c.capture.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.statuses).toEqual(["error"]);
    expect(c.deps.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("stop() releases the microphone and tries nothing more", async () => {
    const c = setup();
    await c.capture.start();
    c.tracks[0].onended!();
    c.capture.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.deps.getUserMedia).toHaveBeenCalledTimes(1);
  });
});
