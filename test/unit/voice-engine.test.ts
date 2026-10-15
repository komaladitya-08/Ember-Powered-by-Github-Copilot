import { describe, expect, it } from "vitest";
import { Ring, VoiceEngine, stripWake, type VoiceBackend, type VoiceEvent } from "../../app/voice/engine";

/** A scripted backend: frames are tagged by their first sample. */
const KW = { 1: "hey_ember", 2: "ember_stop" } as Record<number, string>;
function fake(transcripts: string[]) {
  let speaking = false;
  let segment: number[] = [];
  const b: VoiceBackend & { monitor: string[] } = {
    monitor: [],
    spot: f => (KW[f[0]] ? [KW[f[0]]] : []),
    vad(f) {
      // 0.5 = speech, 0 = silence; a segment ends at the first silence after speech.
      if (f[1] === 0.5) { speaking = true; segment.push(...f); return []; }
      if (speaking) { speaking = false; const s = Float32Array.from(segment); segment = []; return [s]; }
      return [];
    },
    speaking: () => speaking,
    flushVad: () => [],
    resetVad: () => { speaking = false; segment = []; },
    transcribe: () => transcripts.shift() ?? "",
  };
  return b;
}
const frame = (tag: number, speech = false) => { const f = new Float32Array(512); f[0] = tag; f[1] = speech ? 0.5 : 0; return f; };

function run(b: VoiceBackend, script: (e: VoiceEngine, clock: { t: number }) => void) {
  const events: VoiceEvent[] = [];
  const clock = { t: 0 };
  const e = new VoiceEngine(b, ev => { if (ev.type !== "level") events.push(ev); }, { now: () => clock.t, rejectWindowMs: 300, verifyWake: false });
  script(e, clock);
  return events;
}

describe("stripWake", () => {
  it("removes the wake phrase and tidies the rest", () => {
    expect(stripWake("Hey Ember, turn on night light.")).toBe("Turn on night light.");
    expect(stripWake("hey amber what's the time")).toBe("What's the time");
    expect(stripWake("OK Ember: open files")).toBe("Open files");
    expect(stripWake("Ember.")).toBe("");
    expect(stripWake("Remember the milk")).toBe("Remember the milk");
  });
});

describe("Ring", () => {
  it("keeps the most recent samples in order", () => {
    const r = new Ring(4 / 16000);
    r.push(Float32Array.from([1, 2, 3]));
    expect([...r.read()]).toEqual([1, 2, 3]);
    r.push(Float32Array.from([4, 5, 6]));
    expect([...r.read()]).toEqual([3, 4, 5, 6]);
  });
});

describe("VoiceEngine", () => {
  it("wakes, hears the request, and goes back to sleep", () => {
    const events = run(fake(["Hey Ember, turn on night light."]), (e, c) => {
      e.feed(frame(1));
      c.t += 32; e.feed(frame(0, true));
      c.t += 32; e.feed(frame(0, true));
      c.t += 32; e.feed(frame(0));
    });
    expect(events).toEqual([
      { type: "wake", keyword: "hey_ember" },
      { type: "listening", on: true, reason: "wake" },
      { type: "speech", on: true },
      { type: "speech", on: false },
      { type: "utterance", text: "Turn on night light.", ms: 0 },
      { type: "listening", on: false, reason: "done" },
    ]);
  });

  it("keeps listening after a bare 'Hey Ember' and times out if nothing follows", () => {
    const events = run(fake(["Hey Ember."]), (e, c) => {
      e.feed(frame(1));
      e.feed(frame(0, true)); e.feed(frame(0));
      for (let i = 0; i < 400; i++) { c.t += 32; e.feed(frame(0)); }
    });
    expect(events.map(e => e.type)).toEqual(["wake", "listening", "speech", "speech", "listening"]);
    expect(events.at(-1)).toEqual({ type: "listening", on: false, reason: "timeout" });
  });

  it("stops at once on 'Ember stop', even mid-request", () => {
    const events = run(fake([]), e => {
      e.feed(frame(1));
      e.feed(frame(0, true));
      e.feed(frame(2));
    });
    expect(events.slice(-2)).toEqual([{ type: "stop" }, { type: "listening", on: false, reason: "stop" }]);
  });

  it("ignores its own voice", () => {
    const events = run(fake([]), (e, c) => {
      e.selfSpeaking(true);
      e.feed(frame(1));
      e.selfSpeaking(false, 400);
      c.t += 200; e.feed(frame(1));
      c.t += 300; e.feed(frame(1));
    });
    expect(events.filter(e => e.type === "rejected")).toEqual([
      { type: "rejected", keyword: "hey_ember", reason: "self" },
      { type: "rejected", keyword: "hey_ember", reason: "self" },
    ]);
    expect(events.some(e => e.type === "wake")).toBe(true); // after the tail
  });

  it("rejects a wake word that came out of the speakers", () => {
    const b = fake([]);
    b.spotMonitor = f => (f[0] === 1 ? ["hey_ember"] : []);
    const events = run(b, (e, c) => {
      e.feedMonitor(frame(1));
      c.t += 120; e.feed(frame(1));
      c.t += 400; e.feed(frame(0));
    });
    expect(events).toEqual([{ type: "rejected", keyword: "hey_ember", reason: "speakers" }]);
  });

  it("accepts a wake at once when the speakers are quiet", () => {
    const b = fake([]);
    b.spotMonitor = () => [];
    const events = run(b, e => { e.feed(frame(1)); });
    expect(events[0]).toEqual({ type: "wake", keyword: "hey_ember" });
  });

  it("waits out the speakers check while something is playing, then accepts a real wake", () => {
    const b = fake([]);
    b.spotMonitor = () => [];
    let early = -1;
    const playing = new Float32Array(512).fill(0.05);
    const events = run(b, (e, c) => {
      e.feedMonitor(playing);
      e.feed(frame(1));
      early = e.listening ? 1 : 0; // still checking the speakers
      c.t += 320; e.feedMonitor(playing); e.feed(frame(0));
    });
    expect(early).toBe(0);
    expect(events[0]).toEqual({ type: "wake", keyword: "hey_ember" });
  });

  it("listens for a follow-up without the wake word", () => {
    const events = run(fake(["And turn on do not disturb too."]), (e, c) => {
      e.followUp(8000);
      c.t += 1000; e.feed(frame(0, true));
      c.t += 32; e.feed(frame(0));
    });
    expect(events).toContainEqual({ type: "listening", on: true, reason: "follow-up" });
    expect(events).toContainEqual({ type: "utterance", text: "And turn on do not disturb too.", ms: 0 });
  });
});

describe("VoiceEngine idle CPU", () => {
  it("pauses keyword spotting in silence and replays the quiet tail when sound returns", () => {
    let spotCalls = 0;
    const b = fake([]);
    const spot = b.spot;
    b.spot = f => { spotCalls++; return spot(f); };
    const e = new VoiceEngine(b, () => undefined, { now: () => 0 });
    const quiet = new Float32Array(512);
    for (let i = 0; i < 100; i++) e.feed(quiet);
    expect(spotCalls).toBe(16); // half a second, then the spotter rests
    const loud = new Float32Array(512).fill(0.1);
    e.feed(loud);
    expect(spotCalls).toBe(16 + 12 + 1); // the last 12 quiet frames, then the new one
    e.feed(loud);
    expect(spotCalls).toBe(30);
  });

  it("rests in a steady noisy room too (a fan), and wakes up for speech", () => {
    let spotCalls = 0;
    const b = fake([]);
    const spot = b.spot;
    b.spot = f => { spotCalls++; return spot(f); };
    const e = new VoiceEngine(b, () => undefined, { now: () => 0 });
    let seed = 3;
    const hum = () => Float32Array.from({ length: 512 }, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff - 0.5) * 0.02; }); // RMS ≈ 0.006
    for (let i = 0; i < 1000; i++) e.feed(hum()); // half a minute of fan noise
    const resting = spotCalls;
    for (let i = 0; i < 100; i++) e.feed(hum());
    expect(spotCalls - resting).toBe(0);
    e.feed(new Float32Array(512).fill(0.1)); // someone speaks
    expect(spotCalls - resting).toBe(12 + 1);
  });
});

describe("second-stage wake check", () => {
  it("rejects clear near-misses only", async () => {
    const { heardOtherWord } = await import("../../app/voice/engine");
    expect(heardOtherWord("Hey Amber, what time is it?")).toBe(true);
    expect(heardOtherWord("I remember that")).toBe(true);
    expect(heardOtherWord("Hey Ember, turn on night light")).toBe(false);
    expect(heardOtherWord("hey and her")).toBe(false); // mumbled: let it through
    expect(heardOtherWord("")).toBe(false);
  });

  it("drops a wake when the recognizer heard 'Amber'", () => {
    const b = fake(["Hey Amber, what time is it?"]);
    const events: VoiceEvent[] = [];
    const e = new VoiceEngine(b, ev => { if (ev.type !== "level") events.push(ev); }, { now: () => 0 });
    e.feed(frame(1));
    // Ember lit up at once, then took it back when the recognizer heard "Amber".
    expect(events).toEqual([
      { type: "wake", keyword: "hey_ember" },
      { type: "listening", on: true, reason: "wake" },
      { type: "rejected", keyword: "hey_ember", reason: "check", heard: "Hey Amber, what time is it?" },
      { type: "listening", on: false, reason: "rejected" },
    ]);
    expect(e.listening).toBe(false);
  });
});
