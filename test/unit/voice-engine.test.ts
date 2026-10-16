import { describe, expect, it } from "vitest";
import { Ring, VoiceEngine, heardOtherStop, isCloser, isFiller, isStop, saidWakeStop, stopSaidAlone, stripWake, type VoiceBackend, type VoiceEvent } from "../../app/voice/engine";

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
  const e = new VoiceEngine(b, ev => events.push(ev), { now: () => clock.t, verifyWake: false, ...opts });
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

  // What the recognizer wrote for real wakes (review round 2): the wake phrase never goes to the model.
  it.each([
    ["Hey Emma, close this window.", "Close this window."],
    ["Hey, Emma, open the terminal.", "Open the terminal."],
    ["Hey, ever, turn on Nightlight", "Turn on Nightlight"],
    ["Hey, I'm Return on Nightlight.", "Return on Nightlight."],
    ["Hey, I'm going to close this", "Going to close this"],
    ["Hey, Emberton on Nightlight.", "Ton on Nightlight."],
    ["Peyamber, mute.", "Mute."],
    ["A member mute.", "Mute."],
    ["A. M. B. Make the text bigger.", "Make the text bigger."],
    ["A-M-R turn on night light", "Turn on night light"],
    ["Hey, EmberStop.", "Stop."],
    ["Hey Emma Stop.", "Stop."],
    ["Hey, Emberstop", "Stop"],
    ["Hey Ember, Ember stop.", "Stop."],
    ["Hey Ember. Amber, stop!", "Stop!"],
    ["Amber", ""],
    ["Hey, Em", ""],
    ["P. M. B. Make the text bigger.", "Make the text bigger."],
    ["Hey Ember, okay stop.", "Okay stop."],
    ["Turn on night light.", "Turn on night light."],
    ["Okay, open the terminal and make the text bigger.", "Okay, open the terminal and make the text bigger."],
  ])("after a wake: %j → %j", (heard, sent) => {
    expect(stripWake(heard, true)).toBe(sent);
  });

  it("only takes a greeting and the word after it as the wake phrase right after a wake", () => {
    expect(stripWake("Hey, ever, turn on Nightlight")).toBe("Hey, ever, turn on Nightlight");
    expect(stripWake("Okay, great.")).toBe("Okay, great.");
    expect(stripWake("8 a.m. Remind me to call.", true)).toBe("8 a.m. Remind me to call.");
  });
});

describe("isStop", () => {
  it("is a request that is only 'stop' in other words", () => {
    for (const t of ["Stop.", "stop!", "Stop it.", "Stop, stop.", "Cancel that.", "Never mind.", "Nevermind", "Be quiet.", "Please stop.", "Stop talking."]) expect(isStop(t), t).toBe(true);
    for (const t of ["Stop the music.", "Don't stop.", "Cancel my meeting at three.", "Stop sharing my screen."]) expect(isStop(t), t).toBe(false);
  });

  it.each([
    "Okay stop.", "OK, stop.", "No, stop.", "Oh, stop it.", "Ember Stop.", "Stop everything.", "Stop!", "Shut up.", "That's enough.", "Thats enough", "Enough.",
    "Forget it.", "Forget that.", "Never mind.", "Cancel.", "Abort.", "Quiet.", "Be quiet, please.", "No, no, stop.", "Stop talking, Ember.",
    "Stuff.", "Step.", "St", "The stop.", "Quite.", "Stopped.",
  ])("%j stops", t => expect(isStop(t)).toBe(true));

  it.each([
    "Stop the music.", "Don't stop.", "Cancel my meeting at three.", "Stop sharing my screen.", "No.", "Okay.", "That's enough coffee for today.",
    "Forget my password.", "Abort the build on the server.", "Quiet hours start at ten.", "Stop by the store on the way home.", "Step two.", "Stuff to do today.", "So",
  ])("%j is a request", t => expect(isStop(t)).toBe(false));
});

describe("the stop phrase's transcript check", () => {
  it.each(["September stopped being fun.", "December stop sign.", "Remember to stop by.", "I remember, stop worrying.", "One member stopped by.", "November, stop."])(
    "%j isn't 'Ember, stop'", t => expect(heardOtherStop(t)).toBe(true));
  it.each(["Ember, stop!", "Ember stop.", "Ember stopped.", "Amber, stop.", "Emma, stop it.", "Amber, stop it now.", "Emmer, stop the task.", "Amber stop talking.", "Amber, stop, stop it!", "Amber, stock.", "Hey Ember, stop.", "I remember. Ember, stop!", "Ember, stop that right now!", "Stop.", "Hey, I'm stop.", ""])(
    "%j stops (a garbled one too)", t => expect(heardOtherStop(t)).toBe(false));
  it.each(["Amber, stop that right now!", "Emma, stop pulling your sister's hair.", "Amber stopped by the office.", "Ken. Amber, stock that rose from 1", "Hey Amber, what time is it?"])(
    "%j is someone talking to an Amber (but stops while Ember speaks: its own words may follow)", t => {
      expect(heardOtherStop(t)).toBe(true);
      expect(heardOtherStop(t, true)).toBe(false);
    });
});

describe("'Amber, stop…' heard again at the speaker's pause", () => {
  it.each(["Amber, stop it.", "Amber, stop!", "Ember, stop, stop!", "Emma stop now please.", "Stop.", ""])("%j stops", t => expect(stopSaidAlone(t)).toBe(true));
  // Whichever way the sentence went on, a transcript that says "Ember, stop" stops (as in the first look).
  it.each(["Ember stopped the task.", "Ember stopped that right now.", "Embers, please stop what you're doing.", "Emmer, stop the task."])("%j stops (it says Ember)", t => expect(stopSaidAlone(t)).toBe(true));
  it.each(["Amber, stop that right now!", "Amber stopped that right now.", "Right, ever stop that right now.", "Amber, stop pulling your sister's hair."])(
    "%j is a sentence", t => expect(stopSaidAlone(t)).toBe(false));
});

describe("'Hey Ember, stop' over Ember's own voice", () => {
  it.each(["is on. Hey Ember, stop. It makes the", "Hey Ember stop", "warmer in the evening. Hey, Amber, stop! Which is", "Hey Ember, please stop.", "Hey Ember, be quiet.", "Hey Ember, shut up."])(
    "%j stops", t => expect(saidWakeStop(t)).toBe(true));
  it.each(["Night Light is on. Hey Ember, what's the time?", "Remember, stop at the red light.", "The ember stopped glowing.", "Stop the music.", "It makes the screen warmer.", "",
    "Hey Ember stopped the music.", "Hey Ember, stuff to do today.", "Hey Ember, steps to follow."])(
    "%j doesn't", t => expect(saidWakeStop(t)).toBe(false));
  it.each(["A. Ember stopped.", "A. Ember Stuff.", "\"pay ember\" stopped talking.", "Hey Ember stopped. Which is", "Hey Ember, step!", "is on. Hey, Amber, stopped it. It makes", "P. M. B. Stop.", "A. Ember, the quiet."])(
    "%j stops (a lone 'stop' as the recognizer writes it)", t => expect(saidWakeStop(t)).toBe(true));
});

describe("follow-up closers and fillers", () => {
  it.each(["Thanks.", "Thank you.", "Okay, great.", "No, that's all.", "No, that's all", "That's it.", "Nope.", "No thanks.", "Great, thank you very much.", "Perfect.", "All good.", "I'm good, thanks.", "Cool, bye.",
    "Okay.", "OK.", "All right.", "Alright, thanks.", "Sounds good.", "Thanks a lot.", "Thank you so much.", "That works.", "Fine.", "That's fine.", "Okay, sounds good, thanks!", "Much appreciated."])(
    "%j ends the conversation", t => expect(isCloser(t)).toBe(true));
  it.each(["Yes.", "Sure.", "Thanks, now open the terminal.", "No, open the other one.", "Great, make it bigger.", "That's not right.", "Okay, open the terminal.", "Fine, do it.", "That works, now close it."])(
    "%j is a follow-up", t => expect(isCloser(t)).toBe(false));
  // After Ember asked something ("Should I close that one too?"), these are how people say yes: they're sent.
  it.each(["Okay.", "OK.", "Alright.", "All right.", "Fine.", "That works.", "Sounds good.", "Perfect.", "Great, thanks.", "Okay, thanks.", "Thanks.", "That's fine.", "Yeah, cool."])(
    "%j answers Ember's question", t => {
      expect(isCloser(t)).toBe(true);
      expect(isCloser(t, true)).toBe(false);
    });
  it.each(["No.", "Nope.", "No, thanks.", "No thanks.", "No, that's all.", "Not now.", "Nothing else.", "I'm good, thanks.", "That's all.", "That's it, thanks.", "Okay, no.", "Okay, bye.", "Bye."])(
    "%j still ends the conversation after a question", t => expect(isCloser(t, true)).toBe(true));
  it.each(["Um.", "Hmm.", "Uh...", "Mm-hmm", "Ah.", "Erm,"])("%j is a filler", t => expect(isFiller(t)).toBe(true));
  it.each(["Um, open the terminal.", "Mute.", "Ahead."])("%j isn't a filler", t => expect(isFiller(t)).toBe(false));
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
      { type: "utterance", text: "Turn on night light.", ms: 0, window: "wake" },
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
    const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t, verifyWake: false });
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
    expect(events).toContainEqual({ type: "utterance", text: "And turn on do not disturb too.", ms: 0, window: "follow-up" });
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
    expect(events.filter(e => e.type === "utterance")).toEqual([{ type: "utterance", text: "And turn on do not disturb too.", ms: 0, window: "follow-up" }]);
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
    expect(events).toContainEqual({ type: "utterance", text: "Turn on night light.", ms: 0, window: "wake" });
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

  it("drops a wake when the recognizer heard 'Amber' (Ember lights up, then goes back)", () => {
    for (const checkAfterMs of [0, 256]) {
      const b = fake(["Hey Amber, what time is it?"]);
      let heard = 0;
      const transcribe = b.transcribe;
      b.transcribe = s => { heard = s.length; return transcribe(s); };
      const events: VoiceEvent[] = [];
      const c = { t: 0 };
      const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t, checkAfterMs });
      e.feed(frame(0));
      c.t += 32; e.feed(frame(1));
      for (let i = 0; i < 8; i++) { c.t += 32; e.feed(frame(0)); }
      expect(events).toEqual([
        { type: "wake", keyword: "hey_ember" },
        { type: "listening", on: true, reason: "wake", window: "wake" },
        { type: "rejected", keyword: "hey_ember", reason: "check", heard: "Hey Amber, what time is it?" },
        { type: "listening", on: false, reason: "rejected", window: "wake" },
      ]);
      // What it checked: the pre-roll up to the moment the spotter fired (the word had ended), or a while after.
      expect(heard).toBe((checkAfterMs ? 10 : 2) * 512);
      expect(e.listening).toBe(false);
    }
  });
});

/**
 * A backend whose VAD hears any sound as speech (as Silero hears other people's talk), with frames of a steady
 * level: the speaker at 0.1 (U), other people at 0.02 with a dip every 5th frame (14 dB down: b), the room's
 * noise at 0.001 (silence to the VAD). `hangover`: the VAD goes on "hearing speech" for that many silent frames
 * (Silero waits 0.6 s: 19); `onset`: it says it hears speech only once the segment is that many frames long (Silero:
 * about 0.2 s in), though the segment it gives starts with the sound. The transcript counts the frames of each.
 */
function talking(opts: { wake?: number; hangover?: number; onset?: number } = {}) {
  let seg: Float32Array[] = [], silent = 0;
  const cat = (x: Float32Array[]) => { const o = new Float32Array(x.length * 512); x.forEach((f, i) => o.set(f, i * 512)); return o; };
  const heard: number[] = [];
  const b: VoiceBackend & { heard: number[] } = {
    heard,
    spot: f => (f[0] === opts.wake ? ["hey_ember"] : []),
    vad(f) {
      if (f[5] > 0.005) { seg.push(f); silent = 0; return []; }
      if (!seg.length) return [];
      if (++silent <= (opts.hangover ?? 0)) { seg.push(f); return []; }
      const s = cat(seg);
      seg = [];
      silent = 0;
      return [s];
    },
    speaking: () => seg.length > 0 && seg.length >= (opts.onset ?? 0),
    flushVad() { const s = seg.length ? [cat(seg)] : []; seg = []; silent = 0; return s; },
    resetVad() { seg = []; silent = 0; },
    transcribe(s) {
      heard.push(s.length / 512);
      let u = 0, bg = 0;
      for (let i = 0; i + 512 <= s.length; i += 512) { if (s[i + 5] > 0.05) u++; else if (s[i + 5] > 0.005) bg++; }
      return u === 6 && bg <= 10 ? "Hey Ember." : `U${u} b${bg}`; // the wake phrase alone (and a moment of talk)
    },
  };
  return b;
}
const level = (a: number, tag = 0) => { const f = new Float32Array(512).fill(a); f[0] = tag; return f; };
let said = 0;
const others = () => level(++said % 5 ? 0.02 : 0.006);
const room = () => level(0.001);

describe("VoiceEngine with other people talking", () => {
  function listen(b: VoiceBackend, frames: Float32Array[], o: { followUp?: boolean } = {}) {
    const events: (VoiceEvent & { at: number })[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(b, ev => events.push({ ...ev, at: c.t }), { now: () => c.t, verifyWake: false });
    if (o.followUp) e.followUp(8000);
    for (const f of frames) { e.feed(f); c.t += 32; }
    return { events, e, c };
  }
  const n = (count: number, f: () => Float32Array) => Array.from({ length: count }, f);
  const utterances = (events: VoiceEvent[]) => events.flatMap(e => (e.type === "utterance" ? [e.text] : []));

  it("ends the request when the speaker's voice does, though the others talk on (and sends only the speaker's words)", () => {
    const b = talking({ wake: 9 });
    // "Hey Ember, …" for 1.5 s, then 30 s of the others' talk.
    const { events } = listen(b, [...n(20, room), level(0, 9), ...n(47, () => level(0.1)), ...n(940, others)]);
    const u = events.find(e => e.type === "utterance")!;
    expect(u).toMatchObject({ text: expect.stringMatching(/^U47 b1[01]$/) }); // and 10 frames after it (or 11: a dip in their talk is no sound)
    // 1.5 s of the request ended at frame 68: sent about 0.64 s later, not when the talk pauses.
    expect(u.at / 32 - 68).toBeGreaterThan(15);
    expect(u.at / 32 - 68).toBeLessThan(26);
    expect(events.at(-1)).toMatchObject({ type: "listening", on: false, reason: "done" });
  });

  it("ends the request though the others pause between their sentences (their pauses don't start the count over)", () => {
    const b = talking({ wake: 9, hangover: 19 });
    // "Hey Ember, …" (1.5 s), then the others' sentences for 30 s: a soft start, 0.3 s louder (8 dB under the request,
    // as loud as the speaker's own softer words), a soft end, and 0.25 s of silence.
    const talk = Array.from({ length: 940 }, (_, i) => { const k = i % 24; return k < 3 || (k >= 13 && k < 16) ? level(0.02) : k < 13 ? level(0.04) : room(); });
    const { events } = listen(b, [...n(20, room), level(0, 9), ...n(47, () => level(0.1)), ...talk]);
    const u = events.find(e => e.type === "utterance")!;
    expect(u).toMatchObject({ text: expect.stringMatching(/^U47 /) });
    expect(u.at / 32 - 68).toBeLessThan(3 * 24); // within their third sentence, not at the 10 s cap
  });

  it("ends the request over a radio whose sound the room's noise estimate has followed (it isn't a pause)", () => {
    const b = talking({ wake: 9, hangover: 19 });
    // The radio plays on before and after "Hey Ember, …", steady enough that it counts as the room's noise.
    const radio = () => level(0.006);
    const { events } = listen(b, [...n(150, radio), level(0.006, 9), ...n(47, () => level(0.1)), ...n(600, radio)]);
    const u = events.find(e => e.type === "utterance")!;
    expect(u).toMatchObject({ text: expect.stringMatching(/^U47 /) });
    expect(u.at / 32 - 198).toBeLessThan(50); // about 1.3 s after the voice, not at the 10 s cap
  });

  it("doesn't send the others' talk after a bare 'Hey Ember', and stops listening when the window's time is up", () => {
    const b = talking({ wake: 9 });
    // "Hey Ember." (6 frames), the others' talk at once, for 30 s.
    const { events } = listen(b, [...n(20, room), level(0, 9), ...n(6, () => level(0.1)), ...n(940, others)]);
    expect(events.filter(e => e.type === "utterance")).toEqual([]);
    const off = events.find(e => e.type === "listening" && !e.on)!;
    expect(off).toMatchObject({ reason: "timeout" });
    // The wait for speech (6 s) and the extra 4 s after a bare wake phrase: not as long as the talk goes on.
    expect(off.at).toBeLessThan(11_000);
    expect(b.heard.every(frames => frames <= 6 + 10)).toBe(true); // the others' talk was never transcribed
  });

  it("hears a request that starts after the others had been talking, without the talk before it", () => {
    const b = talking({ wake: 9 });
    const { events } = listen(b, [...n(20, room), level(0, 9), ...n(6, () => level(0.1)), ...n(60, others), ...n(40, () => level(0.1)), ...n(200, others)]);
    expect(utterances(events)[0]).toMatch(/^U40 b(\d|1\d|20)$/); // ≤ 10 frames either side
  });

  it("doesn't end a request at a pause in a quiet room: the VAD hears through it, and its own silence ends the request", () => {
    for (const pause of [8, 12, 16]) {
      const b = talking({ wake: 9, hangover: 19 });
      // "Hey Ember, set a timer for…" (0.25–0.5 s, the room's noise) "…ten minutes."
      const { events } = listen(b, [...n(20, room), level(0, 9), ...n(47, () => level(0.1)), ...n(pause, room), ...n(30, () => level(0.1)), ...n(60, room)]);
      expect(utterances(events), `pause of ${pause} frames`).toEqual(["U77 b0"]);
    }
  });

  it("doesn't end a request at a pause after words that trail off, as the voice comes back", () => {
    const b = talking({ wake: 9, hangover: 19 });
    // (After 3 s of the room: its noise is learned.) "…in the afternoons" (trailing off, 16 dB down for half a second), a
    // pause (0.25 s), "and ask…" (soft at first).
    const { events } = listen(b, [...n(100, room), level(0, 9), ...n(47, () => level(0.1)), ...n(16, () => level(0.015)), ...n(8, room),
      ...n(3, () => level(0.03)), ...n(30, () => level(0.1)), ...n(60, room)]);
    expect(utterances(events)).toEqual([expect.stringMatching(/^U77 b19$/)]);
  });

  it("doesn't end a request at a short pause while the others talk either (the count starts over once the voice is back)", () => {
    for (const pause of [12, 16]) {
      const b = talking({ wake: 9, hangover: 19 });
      const { events } = listen(b, [...n(20, room), level(0, 9), ...n(47, () => level(0.1)), ...n(pause, others), ...n(30, () => level(0.1)), ...n(100, others)]);
      expect(utterances(events)[0], `pause of ${pause} frames`).toMatch(/^U77 b(1\d|2\d)$/); // the pause, and ≤ 10 frames after
    }
  });

  it("ends a request after 10 s once only talk too faint to tell apart from the room goes on (it wasn't cut)", () => {
    const b = talking({ wake: 9 });
    // A fan (0.003, not speech to the VAD), the request (3 s), then talk barely over the fan that the VAD still hears.
    const fan = () => level(0.003), faint = () => level(0.006);
    const { events } = listen(b, [...n(200, fan), level(0.003, 9), ...n(94, () => level(0.1)), ...n(600, faint)]);
    const u = events.find(e => e.type === "utterance")!;
    expect(u).toMatchObject({ window: "wake" });
    expect(u).not.toHaveProperty("cut");
    expect(u.at - 201 * 32).toBeLessThan(10_100);
  });

  /** A speaker talking on in phrases (1.3 s), with short pauses (0.2 s) that are silent, or filled by others' talk. */
  const phrases = (count: number, gap: () => Float32Array) => Array.from({ length: count }, (_, i) => (i % 46 < 40 ? level(0.1) : gap()));

  it("lets a quiet room's request run to 20 s while the speaker goes on (it says it was cut), and transcribes 12 s at a time", () => {
    const b = talking({ hangover: 19 });
    const { events } = listen(b, phrases(700, room), { followUp: true });
    const u = events.find(e => e.type === "utterance")!;
    expect(u).toMatchObject({ text: expect.stringMatching(/^U\d+ b0 U\d+ b0 U\d+ b0$/), cut: true }); // in 3 pieces
    expect(u.type === "utterance" && [...u.text.matchAll(/U(\d+)/g)].reduce((a, m) => a + Number(m[1]), 0)).toBeGreaterThan(540);
    expect(u.at).toBeLessThan(20_100);
    expect(Math.max(...b.heard)).toBeLessThanOrEqual(12 * 16000 / 512);
  });

  it("lets a request run on past 10 s when the speaker pauses only briefly, every 4 s (a breath, a comma)", () => {
    const b = talking({ hangover: 19 });
    // 4 s of speech, then a tenth of a second of the room's noise, over and over (the VAD hears through it).
    const { events } = listen(b, Array.from({ length: 700 }, (_, i) => (i % 129 < 125 ? level(0.1) : room())), { followUp: true });
    const u = events.find(e => e.type === "utterance")!;
    expect(u).toMatchObject({ cut: true });
    expect(u.at).toBeGreaterThan(19_500);
    expect(u.at).toBeLessThan(20_100);
  });

  it("cuts at 10 s when others' talk fills the speaker's pauses", () => {
    const b = talking({ hangover: 19 });
    const { events } = listen(b, phrases(700, others), { followUp: true });
    const u = events.find(e => e.type === "utterance")!;
    expect(u).toMatchObject({ cut: true });
    expect(u.at).toBeLessThan(10_100);
  });

  it("doesn't say a request was cut when the speaker had finished", () => {
    const b = talking({ wake: 9 });
    const { events } = listen(b, [...n(20, room), level(0, 9), ...n(47, () => level(0.1)), ...n(100, others)]);
    expect(events.find(e => e.type === "utterance")).not.toHaveProperty("cut");
  });

  it("leaves a quiet room's requests as the VAD ends them", () => {
    const b = talking({ wake: 9 });
    const { events } = listen(b, [...n(20, room), level(0, 9), ...n(47, () => level(0.1)), ...n(10, room), ...n(30, () => level(0.1)), ...n(60, room)]);
    // This VAD (no hangover) ended it at the pause.
    expect(events.find(e => e.type === "utterance")).toMatchObject({ text: "U47 b0" });
  });

  describe("a follow-up", () => {
    /** "Hey Ember, …" (sent), then a follow-up window that hears `then`. */
    function followUp(then: Float32Array[]) {
      const b = talking({ wake: 9 });
      const { events, e, c } = listen(b, [...n(20, room), level(0, 9), ...n(47, () => level(0.1)), ...n(40, room)]);
      e.followUp(8000);
      for (const f of then) { e.feed(f); c.t += 32; }
      return { events, e, b };
    }

    it("hears the voice that woke Ember", () => {
      const { events } = followUp([...n(30, room), ...n(30, () => level(0.08)), ...n(40, room)]);
      expect(events.filter(e => e.type === "utterance")).toMatchObject([{ text: "U47 b0", window: "wake" }, { text: "U30 b0", window: "follow-up" }]);
    });

    it("doesn't send the room's talk (10 dB quieter than the request) to the model", () => {
      const { events, b } = followUp(n(400, () => level(++said % 5 ? 0.03 : 0.006)));
      expect(utterances(events)).toEqual(["U47 b0"]);
      expect(events.at(-1)).toMatchObject({ type: "listening", on: false, reason: "timeout", window: "follow-up" });
      expect(b.heard.length).toBe(1); // nor transcribes it
    });

    it("hears a one-word reply, though the VAD said it heard speech only 0.2 s into it", () => {
      const b = talking({ wake: 9, hangover: 19, onset: 7 });
      const { events, e, c } = listen(b, [...n(20, room), level(0, 9), ...n(47, () => level(0.1)), ...n(40, room)]);
      e.followUp(8000);
      // "Yep." (0.25 s, as loud as the request).
      for (const f of [...n(30, room), ...n(8, () => level(0.1)), ...n(40, room)]) { e.feed(f); c.t += 32; }
      expect(utterances(events)).toEqual(["U47 b0", "U8 b0"]);
    });

    it("tries a short segment again, with a moment of what came before it, when the recognizer heard nothing in it", () => {
      const b = talking({ wake: 9, hangover: 19 });
      const lead = new Float32Array(1600).fill(0.001);
      const tries: number[] = [];
      const transcribe = b.transcribe;
      b.before = () => lead;
      b.transcribe = s => { tries.push(s.length); return tries.length === 2 ? "" : transcribe(s); }; // the request, then the reply
      const { events, e, c } = listen(b, [...n(20, room), level(0, 9), ...n(47, () => level(0.1)), ...n(40, room)]);
      e.followUp(8000);
      for (const f of [...n(30, room), ...n(8, () => level(0.1)), ...n(40, room)]) { e.feed(f); c.t += 32; }
      expect(utterances(events)).toEqual(["U47 b0", "U8 b0"]);
      expect(tries.slice(-2)).toEqual([(8 + 19) * 512, (8 + 19) * 512 + 1600]);
    });

    it("opens only after a wake's request: an answer to a follow-up gets none", () => {
      const { events, e } = followUp([...n(30, () => level(0.1)), ...n(40, room)]);
      const before = events.length;
      e.followUp(8000);
      expect(events.length).toBe(before);
      expect(e.listening).toBe(false);
    });
  });
});

describe("'Ember, stop' is checked", () => {
  it("doesn't stop on 'September stopped…', and stops on 'Ember, stop'", () => {
    for (const [heard, stops] of [["September stopped being fun.", false], ["December stop sign.", false], ["Ember, stop!", true], ["Hey, Amber stop.", true]] as const) {
      const checked: number[] = [];
      const b = fake([heard, heard]);
      const transcribe = b.transcribe;
      b.transcribe = s => { checked.push(s.length); return transcribe(s); };
      const events: VoiceEvent[] = [];
      const c = { t: 0 };
      const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t });
      for (let i = 0; i < 80; i++) { c.t += 32; e.feed(frame(0)); }
      e.feed(frame(2));
      for (let i = 0; i < 8; i++) { c.t += 32; e.feed(frame(0)); }
      expect(events, heard).toEqual(stops ? [{ type: "stop" }] : [{ type: "rejected", keyword: "ember_stop", reason: "check", heard }]);
      expect(checked[0]).toBe(11 * 512); // the last 2 s from 10 frames before the phrase's sound (the recognizer returns nothing after a silence)
    }
  });

  it("decides on 'Amber, stop…' said mid-sentence at the speaker's pause: a stop said on its own stops, a sentence doesn't", () => {
    for (const [first, then, stops] of [["Amber, stop", "Amber, stop it.", true], ["Amber, stop that", "Amber, stop that right now!", false]] as const) {
      const b = fake([first, then]);
      const events: VoiceEvent[] = [];
      const c = { t: 0 };
      const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t });
      const talk = new Float32Array(512).fill(0.05);
      for (let i = 0; i < 80; i++) { c.t += 32; e.feed(frame(0)); }
      e.feed(frame(2)); // spotted while the speaker goes on
      for (let i = 0; i < 6; i++) { c.t += 32; e.feed(talk); }
      expect(events).toEqual([]);
      for (let i = 0; i < 8; i++) { c.t += 32; e.feed(frame(0)); }
      expect(events, then).toEqual(stops ? [{ type: "stop" }] : [{ type: "rejected", keyword: "ember_stop", reason: "check", heard: then }]);
    }
  });

  it("rejects 'Ember, stop' that comes out of the speakers (a video, Ember's own hint)", () => {
    const b = fake([]);
    b.spotMonitor = f => (f[0] === 2 ? ["ember_stop"] : []);
    const playing = new Float32Array(512).fill(0.05);
    const said = new Float32Array(512).fill(0.05); said[0] = 2;
    const events = run(b, (e, c) => {
      e.feedMonitor(said); // the speakers say it…
      for (let i = 0; i < 3; i++) { c.t += 32; e.feedMonitor(playing); }
      e.feed(frame(2)); // …and the microphone hears it a moment later
      for (let i = 0; i < 15; i++) { c.t += 32; e.feedMonitor(playing); e.feed(frame(0)); }
    });
    expect(events).toEqual([{ type: "rejected", keyword: "ember_stop", reason: "speakers" }]);
  });

  it("still stops while the speakers play something else (Ember's own answer, which the transcript has too)", () => {
    const b = fake(["is at two in the afternoon. Amber, stop that"]);
    b.spotMonitor = () => [];
    const playing = new Float32Array(512).fill(0.05);
    const events = run(b, (e, c) => {
      e.selfSpeaking(true);
      e.feedMonitor(playing);
      e.feed(frame(2));
      for (let i = 0; i < 15; i++) { c.t += 32; e.feedMonitor(playing); e.feed(frame(0)); }
    });
    expect(events).toEqual([{ type: "stop" }]);
  });

  it("looks again at the pause when the first look makes nothing out; words decide, and nothing still made out stops (VO9-1)", () => {
    // A quiet "Ember stop" can come out empty both times: the kill switch errs on the safe side.
    for (const [first, then, stops] of [["", "", true], ["", "Ember, stop what you're doing.", true], [" . ", "Amber, stop hitting your brother.", false]] as const) {
      const b = fake([first, then]);
      const events: VoiceEvent[] = [];
      const c = { t: 0 };
      const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t });
      const talk = new Float32Array(512).fill(0.05);
      for (let i = 0; i < 80; i++) { c.t += 32; e.feed(frame(0)); }
      e.feed(frame(2)); // spotted mid-phrase: the recognizer makes nothing of a phrase cut mid-word
      for (let i = 0; i < 6; i++) { c.t += 32; e.feed(talk); }
      expect(events).toEqual([]);
      for (let i = 0; i < 8; i++) { c.t += 32; e.feed(frame(0)); }
      expect(events, then).toEqual(stops ? [{ type: "stop" }] : [{ type: "rejected", keyword: "ember_stop", reason: "check", heard: then }]);
    }
  });

  it("stops when the second look at 'Amber, stop…' hears 'Ember, stop' (the rule of the first look)", () => {
    const b = fake(["Amber stopped the", "Ember stopped the task."]);
    const events: VoiceEvent[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t });
    for (let i = 0; i < 80; i++) { c.t += 32; e.feed(frame(0)); }
    e.feed(frame(2));
    for (let i = 0; i < 6; i++) { c.t += 32; e.feed(new Float32Array(512).fill(0.05)); }
    for (let i = 0; i < 8; i++) { c.t += 32; e.feed(frame(0)); }
    expect(events).toEqual([{ type: "stop" }]);
  });
});

describe("the speakers' stream", () => {
  it("is only spotted while a wake or stop is checked: their last 3 s, then as they play, until it's decided", () => {
    const b = fake([]);
    let spotted = 0, resets = 0;
    b.spotMonitor = () => { spotted++; return []; };
    b.resetMonitor = () => { resets++; };
    const playing = new Float32Array(512).fill(0.05);
    const events = run(b, (e, c) => {
      for (let i = 0; i < 600; i++) { c.t += 32; e.feedMonitor(playing); e.feed(frame(0)); } // 20 s of music, nobody talks to Ember
      expect(spotted).toBe(0);
      e.feed(frame(1)); // "Hey Ember"
      expect(spotted).toBe(94);
      for (let i = 0; i < 30; i++) { c.t += 32; e.feedMonitor(playing); e.feed(frame(0)); }
    });
    expect(events[0]).toEqual({ type: "wake", keyword: "hey_ember" });
    expect(spotted).toBe(94 + 10); // the speakers check's 300 ms
    expect(resets).toBe(2); // a fresh stream for the check, freed after it
  });
});

describe("the speakers' check after a pause", () => {
  it("lets the speakers' spotter decide on what they played up to now, as the microphone's did", () => {
    const b = fake([]);
    b.spotMonitor = () => [];
    b.padMonitor = () => ["hey_ember"]; // the video's "Hey Ember." was in the speakers' last words
    const playing = new Float32Array(512).fill(0.05);
    const events = run(b, (e, c) => {
      for (let i = 0; i < 30; i++) { c.t += 32; e.feedMonitor(playing); e.feed(frame(0)); }
      e.feed(frame(1));
      for (let i = 0; i < 15; i++) { c.t += 32; e.feedMonitor(playing); e.feed(frame(0)); }
    });
    expect(events).toEqual([{ type: "rejected", keyword: "hey_ember", reason: "speakers" }]);
  });
});

describe("after Ember speaks", () => {
  const tone = (a: number) => { const f = new Float32Array(512).fill(a); f[1] = a > 0.01 ? 0.5 : 0; return f; };
  function answer(b: VoiceBackend, after: Float32Array[], monitor?: (i: number) => Float32Array | null) {
    return run(b, (e, c) => {
      e.selfSpeaking(true);
      for (let i = 0; i < 60; i++) { c.t += 32; e.feed(tone(0)); }
      e.selfSpeaking(false, 400); // the answer is over
      e.followUp(8000);
      after.forEach((f, i) => { c.t += 32; const m = monitor?.(i); if (m) e.feedMonitor(m); e.feed(f); });
    });
  }
  const counted = () => { const b = fake(["And make the text bigger."]); let frames = 0; const vad = b.vad; b.vad = f => { if (f[1] === 0.5) frames++; return vad(f); }; return { b, frames: () => frames }; };

  it("hears a reply that starts during the tail", () => {
    const { b, frames } = counted();
    const events = answer(b, [...Array.from({ length: 4 }, () => tone(0)), ...Array.from({ length: 30 }, () => tone(0.1)), ...Array.from({ length: 30 }, () => tone(0))]);
    expect(events).toContainEqual({ type: "utterance", text: "And make the text bigger.", ms: 0, window: "follow-up" });
    expect(frames()).toBe(30); // all of it, the 9 frames said during the tail too
  });

  it("doesn't hear the end of its own voice that ran on through the tail", () => {
    const { b, frames } = counted();
    answer(b, [...Array.from({ length: 14 }, () => tone(0.1)), ...Array.from({ length: 30 }, () => tone(0))]);
    expect(frames()).toBe(0); // the 2 frames past the tail stopped short of a reply: Ember's voice, not heard
  });

  it("ends the tail as soon as the speakers' own stream has gone quiet", () => {
    const { b, frames } = counted();
    const quiet = new Float32Array(512);
    const events = answer(b, [...Array.from({ length: 6 }, () => tone(0)), ...Array.from({ length: 30 }, () => tone(0.1)), ...Array.from({ length: 30 }, () => tone(0))], () => quiet);
    expect(events).toContainEqual({ type: "utterance", text: "And make the text bigger.", ms: 0, window: "follow-up" });
    expect(frames()).toBe(30);
  });

  /**
   * Ember says a 3 s answer (syllables on the speakers' stream); the microphone hears it `lag` frames later at a
   * third of its level (or not at all: a headset), and the user replies (0.1) the moment that echo ends. "Stopped
   * speaking" comes `late` frames after the audio ends. Returns the reply's frames and the echo's that the VAD heard.
   */
  function reply(o: { lag: number; late: number; echo?: boolean }) {
    let echo = 0, said = 0, seg: Float32Array[] = [];
    const b: VoiceBackend = {
      spot: () => [],
      vad(f) {
        if (f[0] > 0.05) said++; else if (f[0] > 0.005) echo++;
        if (f[0] > 0.005) { seg.push(f.slice()); return []; }
        const out = seg.length ? [Float32Array.from(seg.flatMap(x => [...x]))] : [];
        seg = [];
        return out;
      },
      speaking: () => seg.length > 0,
      flushVad: () => { seg = []; return []; },
      resetVad: () => { seg = []; },
      transcribe: () => "Yes.",
    };
    const events: VoiceEvent[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t, verifyWake: false });
    // Syllables, and the faint end of the last one (a fade, as speech synthesis ends).
    const syllable = (i: number) => (i === 92 || i === 93 ? 0.002 : i >= 0 && i < 92 && (i * 7) % 11 > 2 ? 0.04 + 0.03 * Math.sin(i * 0.9) * Math.sin(i * 0.37) : 0);
    const end = 94 + o.lag; // the echo's end, where the reply starts
    e.selfSpeaking(true);
    for (let i = 0; i < end + 60; i++) {
      if (i === 94 + o.late) { e.selfSpeaking(false, 400); e.followUp(8000); }
      e.feedMonitor(new Float32Array(512).fill(syllable(i)));
      e.feed(new Float32Array(512).fill(i >= end && i < end + 30 ? 0.1 : o.echo === false ? 0.001 : Math.max(0.001, syllable(i - o.lag) * 0.3)));
      c.t += 32;
    }
    return { said, echo, sent: events.filter(e => e.type === "utterance").length };
  }

  it("keeps a reply that starts as Ember's voice ends: it measures how much later the microphone hears the speakers", () => {
    for (const lag of [0, 2, 5]) {
      for (const late of [0, 5]) expect(reply({ lag, late }), `lag ${lag} frames, "stopped speaking" ${late} frames late`).toEqual({ said: 30, echo: 0, sent: 1 });
    }
  });

  it("keeps all of a reply when the microphone doesn't hear the speakers (a headset)", () => {
    expect(reply({ lag: 0, late: 3, echo: false })).toEqual({ said: 30, echo: 0, sent: 1 });
  });
});

describe("'Hey Ember' while Ember speaks", () => {
  function heardWhileSpeaking(heard: string, o: { speakersSaidIt?: boolean } = {}) {
    const b = fake([heard]);
    let checkedAt = -1, length = 0;
    const transcribe = b.transcribe;
    b.transcribe = s => { checkedAt = c.t; length = s.length; return transcribe(s); };
    if (o.speakersSaidIt !== undefined) b.spotMonitor = f => (o.speakersSaidIt && f[0] === 1 ? ["hey_ember"] : []);
    const events: VoiceEvent[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t });
    const playing = (tag = 0) => { const f = new Float32Array(512).fill(0.05); f[0] = tag; return f; };
    e.selfSpeaking(true);
    for (let i = 0; i < 30; i++) { c.t += 32; if (o.speakersSaidIt !== undefined) e.feedMonitor(playing(i === 28 ? 1 : 0)); e.feed(frame(0)); }
    const spottedAt = c.t;
    e.feed(frame(1));
    // "…stop." (0.3 s), then a pause.
    for (let i = 0; i < 30; i++) { c.t += 32; if (o.speakersSaidIt !== undefined) e.feedMonitor(playing()); e.feed(i < 10 ? new Float32Array(512).fill(0.1) : frame(0)); }
    return { events, checked: checkedAt < 0 ? null : checkedAt - spottedAt, length };
  }

  it("stops on 'Hey Ember, stop' (the spotter takes the name, so 'Ember, stop' isn't spotted after it), checked once 'stop' has been said", () => {
    const { events, checked } = heardWhileSpeaking("the screen warmer. Hey Ember, stop. Which is");
    expect(events).toEqual([{ type: "stop" }]);
    expect(checked).toBe((10 + 5) * 32); // at the pause after it
    expect(heardWhileSpeaking("Hey Ember, stop.", { speakersSaidIt: false }).events).toEqual([{ type: "stop" }]);
  });

  it("hears the phrase from just before its first sound (the recognizer returns nothing for a phrase after near-silence)", () => {
    // 1.5 s before the spotter fired were silent but for the last frame: what's transcribed starts 10 frames before it.
    expect(heardWhileSpeaking("Hey Ember, stop.").length).toBe((10 + 1 + 10 + 5) * 512);
  });

  it.each(["A. Ember stopped.", "A. Ember Stuff.", "\"pay ember\" stopped talking.", "Hey Ember, step.", "Hey, Emma, stopped it now."])(
    "stops on %j (how the recognizer writes a lone 'stop')", heard => expect(heardWhileSpeaking(heard).events).toEqual([{ type: "stop" }]));

  it("takes anything else as Ember's own voice (no wake while it speaks)", () => {
    expect(heardWhileSpeaking("It makes the screen warmer in the evening.").events).toEqual([{ type: "rejected", keyword: "hey_ember", reason: "self", heard: "It makes the screen warmer in the evening." }]);
  });

  it("doesn't stop when the speakers said it", () => {
    expect(heardWhileSpeaking("Hey Ember, stop.", { speakersSaidIt: true }).events).toEqual([{ type: "rejected", keyword: "hey_ember", reason: "speakers" }]);
  });
});

describe("follow-up windows", () => {
  it("send 'Okay.' when Ember's answer asked something, and still end on 'No, thanks.'", () => {
    const okay = run(fake(["Okay."]), (e, c) => { e.followUp(8000, { afterQuestion: true }); c.t += 32; e.feed(frame(0, true)); c.t += 32; e.feed(frame(0)); });
    expect(okay.filter(e => e.type === "utterance")).toEqual([{ type: "utterance", text: "Okay.", ms: 0, window: "follow-up" }]);
    const no = run(fake(["No, thanks."]), (e, c) => { e.followUp(8000, { afterQuestion: true }); c.t += 32; e.feed(frame(0, true)); c.t += 32; e.feed(frame(0)); });
    expect(no.filter(e => e.type === "utterance")).toEqual([]);
    expect(no.at(-1)).toEqual({ type: "listening", on: false, reason: "timeout", window: "follow-up" });
    // Without a question, "Okay." ends it.
    const closed = run(fake(["Okay."]), (e, c) => { e.followUp(8000); c.t += 32; e.feed(frame(0, true)); c.t += 32; e.feed(frame(0)); });
    expect(closed.filter(e => e.type === "utterance")).toEqual([]);
  });

  it("end on 'Thanks.' without sending it, and keep listening after 'Um.'", () => {
    const thanks = run(fake(["Thanks."]), (e, c) => { e.followUp(8000); c.t += 32; e.feed(frame(0, true)); c.t += 32; e.feed(frame(0)); });
    expect(thanks).toEqual([
      { type: "listening", on: true, reason: "follow-up", window: "follow-up" },
      { type: "speech", on: true }, { type: "speech", on: false },
      { type: "listening", on: false, reason: "timeout", window: "follow-up" },
    ]);
    const um = run(fake(["Um.", "And turn on do not disturb."]), (e, c) => {
      e.followUp(8000);
      c.t += 32; e.feed(frame(0, true)); c.t += 32; e.feed(frame(0));
      c.t += 7000; e.feed(frame(0, true)); c.t += 32; e.feed(frame(0));
    });
    expect(um.filter(e => e.type === "utterance")).toEqual([{ type: "utterance", text: "And turn on do not disturb.", ms: 0, window: "follow-up" }]);
  });
});

describe("events", () => {
  it("sends no loudness levels (nothing uses them)", () => {
    const events = run(fake([]), e => { for (let i = 0; i < 100; i++) e.feed(new Float32Array(512).fill(0.1)); });
    expect(events).toEqual([]);
  });
});

describe("the wake check", () => {
  it("stops (rather than taking the wake back) when what it heard is 'Hey Amber, stop'", () => {
    const events: VoiceEvent[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(fake(["Hey, amber, stop."]), ev => events.push(ev), { now: () => c.t });
    e.feed(frame(0));
    c.t += 32; e.feed(frame(1));
    expect(events.slice(2)).toEqual([{ type: "stop" }, { type: "listening", on: false, reason: "stop", window: "wake" }]);
  });
});

describe("a pause after speech", () => {
  it("lets the spotter decide at once (the cue comes 0.1 s after 'Hey Ember.', not 0.45 s), and checks the word a moment later", () => {
    const b = fake(["Hey Ember."]);
    let pads = 0, checked = -1;
    b.padSpot = () => { pads++; return ["hey_ember"]; };
    const transcribe = b.transcribe;
    b.transcribe = s => { checked = s.length / 512; return transcribe(s); };
    const events: (VoiceEvent & { at: number })[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(b, ev => events.push({ ...ev, at: c.t }), { now: () => c.t });
    const loud = new Float32Array(512).fill(0.1);
    for (let i = 0; i < 20; i++) { c.t += 32; e.feed(new Float32Array(512)); }
    for (let i = 0; i < 12; i++) { c.t += 32; e.feed(loud); } // "Hey Ember."
    for (let i = 0; i < 2; i++) { c.t += 32; e.feed(new Float32Array(512)); }
    expect(pads).toBe(0);
    c.t += 32; e.feed(new Float32Array(512)); // the third quiet frame: a pause
    expect(pads).toBe(1);
    expect(events[0]).toMatchObject({ type: "wake", at: c.t });
    expect(checked).toBe(-1); // what followed the word is waited for (the recognizer drops a word cut at its end)…
    for (let i = 0; i < 8; i++) { c.t += 32; e.feed(new Float32Array(512)); }
    expect(checked).toBeGreaterThan(0); // …then checked
    for (let i = 0; i < 40; i++) { c.t += 32; e.feed(new Float32Array(512)); }
    expect(pads).toBe(1); // once per pause
  });

  it("doesn't pad in the middle of words, or after a click", () => {
    const b = fake([]);
    let pads = 0;
    b.padSpot = () => { pads++; return []; };
    const e = new VoiceEngine(b, () => undefined, { now: () => 0 });
    const loud = new Float32Array(512).fill(0.1);
    for (let i = 0; i < 20; i++) e.feed(new Float32Array(512));
    for (let k = 0; k < 5; k++) { for (let i = 0; i < 6; i++) e.feed(loud); for (let i = 0; i < 2; i++) e.feed(new Float32Array(512)); } // words, short gaps
    expect(pads).toBe(0);
    for (let i = 0; i < 30; i++) e.feed(new Float32Array(512));
    expect(pads).toBe(1);
    for (let i = 0; i < 3; i++) e.feed(loud); // a click
    for (let i = 0; i < 30; i++) e.feed(new Float32Array(512));
    expect(pads).toBe(1);
  });
});
