/** The eval must measure the selected speech backend and keep slow frames in the wake's latency. */
import { describe, expect, it } from "vitest";
import { VoiceFrameClock, voiceRuntime } from "../../eval/src/voice-timing";

describe("the voice eval runtime", () => {
  it("uses the same explicitly selected native speech directory as Ember and the latency benchmark", () => {
    expect(voiceRuntime({ EMBER_SHERPA_CAPI: "/voice/native" })).toEqual({ capiDir: "/voice/native" });
    expect(voiceRuntime({})).toEqual({});
    expect(voiceRuntime({ EMBER_SHERPA_CAPI: "" })).toEqual({});
  });
});

describe("the voice eval frame clock", () => {
  it("counts the complete frame and the compute before an event, but not compute after that event", () => {
    let now = 1000;
    const clock = new VoiceFrameClock(() => now);
    clock.start(32);
    now += 4;
    expect(clock.eventAt()).toBe(36);
    now += 6;
    expect(clock.finish()).toBe(10);
  });
  it("carries a slow frame's backlog into the next wake instead of reporting only that frame's compute", () => {
    let now = 0;
    const clock = new VoiceFrameClock(() => now);
    clock.start(32);
    now += 100;
    expect(clock.finish()).toBe(100);
    clock.start(64);
    now += 5;
    expect(clock.eventAt()).toBe(137); // not 64 + 5: the previous frame finished at 132
    expect(clock.finish()).toBe(5);
    clock.start(96);
    now += 5;
    expect(clock.eventAt()).toBe(142);
    clock.finish();
  });
  it("lets real-time audio catch up and excludes time spent setting up between frames", () => {
    let now = 0;
    const clock = new VoiceFrameClock(() => now);
    clock.start(32);
    now += 50;
    clock.finish();
    now += 1000;
    clock.start(96);
    now += 3;
    expect(clock.eventAt()).toBe(99);
    expect(clock.finish()).toBe(3);
  });
});
