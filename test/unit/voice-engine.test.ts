import { describe, expect, it } from "vitest";
import { Ring, VoiceEngine, isStop, stripWake, type VoiceBackend, type VoiceEvent } from "../../app/voice/engine";

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

function run(b: VoiceBackend, script: (e: VoiceEngine, clock: { t: number }) => void, opts: { rejectWindowMs?: number } = { rejectWindowMs: 300 }) {
  const events: VoiceEvent[] = [];
  const clock = { t: 0 };
  const e = new VoiceEngine(b, ev => { if (ev.type !== "level") events.push(ev); }, { now: () => clock.t, verifyWake: false, ...opts });
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
    expect(stripWake("Hey Emmer. Turn on night light.")).toBe("Turn on night light.");
  });

  it("right after a wake, drops what was said just before it (the pre-roll), as transcribed for real", () => {
    // Recognizer output when "Hey Ember, turn on night light" followed other speech with no pause.
    expect(stripWake("Lunch, hey Ember, turn on night light.", true)).toBe("Turn on night light.");
    expect(stripWake("6. Hey Ember, turn on night light.", true)).toBe("Turn on night light.");
    expect(stripWake("Ace, pay ember, turn on night light.", true)).toBe("Turn on night light.");
    expect(stripWake("I say, amber, turn on nightlight.", true)).toBe("Turn on nightlight.");
    expect(stripWake("Ligger, hey Emmer, turn on night light.", true)).toBe("Turn on night light.");
    expect(stripWake("Hey Ember, call Amber.", true)).toBe("Call Amber.");
    // Only near the start, and only whole words: a request that merely mentions "Amber" later is kept.
    expect(stripWake("Remember the milk", true)).toBe("Remember the milk");
    expect(stripWake("Please send the minutes of the meeting to Amber.", true)).toBe("Please send the minutes of the meeting to Amber.");
    // Later segments (no pre-roll) only lose a wake phrase at the very start.
    expect(stripWake("Lunch, hey Ember, turn on night light.")).toBe("Lunch, hey Ember, turn on night light.");
  });
});

describe("isStop", () => {
  it("is a request that is only 'stop' in other words", () => {
    for (const t of ["Stop.", "stop!", "Stop it.", "Stop, stop.", "Cancel that.", "Never mind.", "Nevermind", "Be quiet.", "Please stop.", "Stop talking."]) expect(isStop(t), t).toBe(true);
    for (const t of ["Stop the music.", "Don't stop.", "Cancel my meeting at three.", "Stop sharing my screen."]) expect(isStop(t), t).toBe(false);
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
      { type: "listening", on: true, reason: "wake", window: "wake" },
      { type: "speech", on: true },
      { type: "speech", on: false },
      { type: "utterance", text: "Turn on night light.", ms: 0 },
      { type: "listening", on: false, reason: "done", window: "wake" },
    ]);
  });

  it("keeps listening after a bare 'Hey Ember' and times out if nothing follows", () => {
    const events = run(fake(["Hey Ember."]), (e, c) => {
      e.feed(frame(1));
      e.feed(frame(0, true)); e.feed(frame(0));
      for (let i = 0; i < 400; i++) { c.t += 32; e.feed(frame(0)); }
    });
    expect(events.map(e => e.type)).toEqual(["wake", "listening", "speech", "speech", "listening"]);
    expect(events.at(-1)).toEqual({ type: "listening", on: false, reason: "timeout", window: "wake" });
  });

  it("stops at once on 'Ember stop', even mid-request", () => {
    const events = run(fake([]), e => {
      e.feed(frame(1));
      e.feed(frame(0, true));
      e.feed(frame(2));
    });
    expect(events.slice(-2)).toEqual([{ type: "stop" }, { type: "listening", on: false, reason: "stop", window: "wake" }]);
  });

  it("stops on 'Hey Ember, stop' (and 'never mind') without sending anything", () => {
    for (const said of ["Hey Ember, stop.", "Hey Ember. Never mind."]) {
      const events = run(fake([said]), (e, c) => {
        e.feed(frame(1));
        c.t += 32; e.feed(frame(0, true));
        c.t += 32; e.feed(frame(0));
      });
      expect(events.filter(e => e.type === "utterance"), said).toEqual([]);
      expect(events.slice(-2), said).toEqual([{ type: "stop" }, { type: "listening", on: false, reason: "stop", window: "wake" }]);
    }
  });

  it("doesn't send words said just before the wake phrase", () => {
    const events = run(fake(["Lunch, hey Ember, turn on night light.", "Call Amber about lunch."]), (e, c) => {
      e.feed(frame(1));
      c.t += 32; e.feed(frame(0, true));
      c.t += 32; e.feed(frame(0));
      e.followUp(8000); // the next segment has no pre-roll: only a leading wake phrase would go
      c.t += 32; e.feed(frame(0, true));
      c.t += 32; e.feed(frame(0));
    });
    expect(events.filter(e => e.type === "utterance").map(e => e.type === "utterance" && e.text)).toEqual(["Turn on night light.", "Call Amber about lunch."]);
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

  it("waits long enough for the speakers' spotter (a video's wake reported 300 ms apart is still rejected)", () => {
    const b = fake([]);
    b.spotMonitor = f => (f[0] === 1 ? ["hey_ember"] : []);
    const playing = new Float32Array(512).fill(0.05);
    const events = run(b, (e, c) => {
      e.feedMonitor(playing);
      e.feed(frame(1)); // the mic's spotter first
      for (let i = 0; i < 9; i++) { c.t += 32; e.feedMonitor(playing); e.feed(frame(0)); }
      const hit = new Float32Array(512); hit[0] = 1;
      e.feedMonitor(hit); // ~300 ms later from the speakers' stream
      c.t += 32; e.feed(frame(0));
      for (let i = 0; i < 10; i++) { c.t += 32; e.feed(frame(0)); }
    }, {});
    expect(events).toEqual([{ type: "rejected", keyword: "hey_ember", reason: "speakers" }]);
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

  it("rejects a video's wake word that the speakers' spotter reports late, after the video paused", () => {
    const b = fake([]);
    b.spotMonitor = f => (f[0] === 1 ? ["hey_ember"] : []);
    const playing = new Float32Array(512).fill(0.05);
    const silent = new Float32Array(512);
    const events: VoiceEvent[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(b, ev => { if (ev.type !== "level") events.push(ev); }, { now: () => c.t, verifyWake: false });
    e.feedMonitor(playing); // the video says "Hey Ember." and stops
    for (let i = 0; i < 12; i++) { c.t += 32; e.feedMonitor(silent); }
    e.feed(frame(1)); // both spotters report it ~400 ms later
    const hit = new Float32Array(512); hit[0] = 1;
    c.t += 20; e.feedMonitor(hit);
    c.t += 20; e.feed(frame(0));
    expect(events).toEqual([{ type: "rejected", keyword: "hey_ember", reason: "speakers" }]);
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
    expect(events).toContainEqual({ type: "listening", on: true, reason: "follow-up", window: "follow-up" });
    expect(events).toContainEqual({ type: "utterance", text: "And turn on do not disturb too.", ms: 0 });
  });

  it("says a timeout ended a follow-up window, not a wake (the answer stays up)", () => {
    const events = run(fake([]), (e, c) => {
      e.followUp(8000);
      for (let i = 0; i < 300; i++) { c.t += 32; e.feed(frame(0)); }
    });
    expect(events.at(-1)).toEqual({ type: "listening", on: false, reason: "timeout", window: "follow-up" });
  });

  it("doesn't take Ember's own voice as a follow-up, and opens the window once it has finished", () => {
    const b = fake(["And turn on do not disturb too."]);
    let heardWhileSpeaking = 0;
    const transcribe = b.transcribe;
    b.transcribe = s => { if (speaking) heardWhileSpeaking++; return transcribe(s); };
    let speaking = true;
    const events = run(b, (e, c) => {
      e.selfSpeaking(true);
      e.followUp(8000);
      // Ember reads out a long answer (12 s), which the mic hears.
      for (let i = 0; i < 375; i++) { c.t += 32; e.feed(frame(0, i % 50 < 40)); }
      e.selfSpeaking(false, 400);
      speaking = false;
      // The window counts from the end of the answer: 7 s later the user still has time.
      for (let i = 0; i < 220; i++) { c.t += 32; e.feed(frame(0)); }
      expect(e.listening).toBe(true);
      c.t += 32; e.feed(frame(0, true));
      c.t += 32; e.feed(frame(0));
    });
    expect(heardWhileSpeaking).toBe(0);
    expect(events.filter(e => e.type === "utterance")).toEqual([{ type: "utterance", text: "And turn on do not disturb too.", ms: 0 }]);
    expect(events.some(e => e.type === "listening" && !e.on && e.reason === "timeout")).toBe(false);
  });

  it("forgets speech the window heard when Ember starts speaking over it", () => {
    const events = run(fake(["Here is what I found."]), (e, c) => {
      e.followUp(8000);
      c.t += 32; e.feed(frame(0, true)); // the speakers' first word…
      e.selfSpeaking(true); // …and Ember says it's speaking
      for (let i = 0; i < 20; i++) { c.t += 32; e.feed(frame(0, true)); }
      c.t += 32; e.feed(frame(0));
    });
    expect(events.filter(e => e.type === "speech")).toEqual([{ type: "speech", on: true }, { type: "speech", on: false }]);
    expect(events.some(e => e.type === "utterance")).toBe(false);
  });

  it("doesn't stay deaf if it never hears that Ember stopped speaking", () => {
    const events = run(fake([]), (e, c) => {
      e.selfSpeaking(true);
      c.t += 61_000; e.feed(frame(1));
    });
    expect(events[0]).toEqual({ type: "wake", keyword: "hey_ember" });
  });

  it("a 'stopped speaking' while silent (hush on a wake) doesn't cut the request", () => {
    const events = run(fake(["Hey Ember, turn on night light."]), (e, c) => {
      e.feed(frame(1));
      e.selfSpeaking(false, 400);
      c.t += 32; e.feed(frame(0, true));
      c.t += 32; e.feed(frame(0));
    });
    expect(events).toContainEqual({ type: "utterance", text: "Turn on night light.", ms: 0 });
  });

  it("cancel (the kill switch) ends listening and drops a wake still being checked", () => {
    const b = fake(["Turn on night light."]);
    b.spotMonitor = () => [];
    const playing = new Float32Array(512).fill(0.05);
    const pending = run(b, (e, c) => {
      e.feedMonitor(playing);
      e.feed(frame(1)); // waiting out the speakers check
      e.cancel();
      for (let i = 0; i < 20; i++) { c.t += 32; e.feedMonitor(playing); e.feed(frame(0, true)); }
      c.t += 32; e.feed(frame(0));
    });
    expect(pending).toEqual([]);
    const listening = run(fake(["Turn on night light."]), (e, c) => {
      e.feed(frame(1));
      c.t += 32; e.feed(frame(0, true));
      e.cancel();
      c.t += 32; e.feed(frame(0));
    });
    expect(listening.slice(-1)).toEqual([{ type: "listening", on: false, reason: "stop", window: "wake" }]);
    expect(listening.some(e => e.type === "utterance")).toBe(false);
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

describe("VoiceEngine idle CPU with a voice check", () => {
  /** Noise at a steady level, and the voice check's verdicts (tagged on the frame's last sample). */
  let seed = 5;
  const noise = (rms: number, speech = false) => {
    const f = Float32Array.from({ length: 512 }, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff - 0.5) * rms / 0.2887; });
    f[511] = speech ? 0.25 : 0;
    return f;
  };
  function counted(withCheck = true) {
    const b = fake([]);
    const n = { spot: 0, check: 0, resets: 0 };
    const spot = b.spot;
    b.spot = f => { n.spot++; return spot(f); };
    if (withCheck) {
      b.hearsSpeech = f => { n.check++; return f[511] === 0.25; };
      b.resetHearsSpeech = () => { n.resets++; };
    }
    return { e: new VoiceEngine(b, () => undefined, { now: () => 0 }), n };
  }

  it("never runs the voice check in true silence", () => {
    const { e, n } = counted();
    for (let i = 0; i < 200; i++) e.feed(new Float32Array(512));
    expect(n.check).toBe(0);
    expect(n.spot).toBe(16);
  });

  it("learns a noisy room in seconds, then rests both the spotter and the voice check", () => {
    for (const withCheck of [true, false]) {
      const { e, n } = counted(withCheck);
      for (let i = 0; i < 200; i++) e.feed(noise(0.02)); // 6 s of a fan, from the start
      const was = { ...n };
      for (let i = 0; i < 300; i++) e.feed(noise(0.02));
      expect(n.spot - was.spot, `spotter, check ${withCheck}`).toBe(0);
      expect(n.check - was.check, `check ${withCheck}`).toBe(0);
    }
  });

  it("hears speech under a fan that loudness alone misses", () => {
    for (const withCheck of [true, false]) {
      const { e, n } = counted(withCheck);
      for (let i = 0; i < 300; i++) e.feed(noise(0.02));
      const was = n.spot;
      // Speech at about 4 dB SNR: louder than the fan, but not 2.5 times.
      for (let i = 0; i < 20; i++) e.feed(noise(0.032, true));
      expect(n.spot - was > 0, `check ${withCheck}`).toBe(withCheck);
    }
  });

  it("replays from 12 frames before the sound started, once the voice check confirms it", () => {
    const { e, n } = counted();
    for (let i = 0; i < 100; i++) e.feed(new Float32Array(512));
    const was = n.spot;
    const loud = (speech: boolean) => { const f = new Float32Array(512).fill(0.1); f[511] = speech ? 0.25 : 0.1; return f; };
    for (let i = 0; i < 3; i++) e.feed(loud(false)); // the check needs a few frames to be sure
    expect(n.spot).toBe(was);
    expect(n.resets).toBe(1); // started afresh (with context) at the first sound
    e.feed(loud(true));
    expect(n.spot - was).toBe(12 + 3 + 1);
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
      { type: "listening", on: true, reason: "wake", window: "wake" },
      { type: "rejected", keyword: "hey_ember", reason: "check", heard: "Hey Amber, what time is it?" },
      { type: "listening", on: false, reason: "rejected", window: "wake" },
    ]);
    expect(e.listening).toBe(false);
  });
});
