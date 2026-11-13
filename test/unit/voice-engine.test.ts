import { describe, expect, it } from "vitest";
import { MANUAL_MAX_MS, Ring, TRAIL_HOLD_MS, VoiceEngine, heardOtherStop, trailsOff, heardStopWord, holdsWake, isCloser, isFiller, isStop, saidWakeStop, stopSaidAlone, stripWake, withoutAnnounced, type VoiceBackend, type VoiceEvent } from "../../app/voice/engine";
import { withoutRepeats } from "../../app/voice/sherpa";
import { stopRequest } from "../../app/main/agent/status";

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

describe("holdsWake (what Voice Match may count as “what follows the wake phrase”; security review of #143)", () => {
  const holds = (heard: string, first: boolean) => holdsWake(heard, stripWake(heard, first), first);

  it("is true when the wake phrase is in the clip: at its start, or in its first words on the first pass", () => {
    expect(holds("Hey Ember, allow.", true)).toBe(true);
    expect(holds("Um, Ember, allow.", true)).toBe(true);
    expect(holds("Ember, allow.", false)).toBe(true);
  });

  it("is true on a later pass too when the name is said in its first words, though stripWake leaves it in the text", () => {
    // The wake phrase was heard alone and this clip is the request after it: “Um, Ember, allow” still has the name in it.
    expect(stripWake("Um, Ember, allow.", false)).toBe("Um, Ember, allow.");
    expect(holds("Um, Ember, allow.", false)).toBe(true);
  });

  it("is false for a request that holds no wake phrase", () => {
    expect(holds("Allow.", true)).toBe(false);
    expect(holds("Go ahead and allow it.", false)).toBe(false);
    expect(holds("Open the calendar.", false)).toBe(false);
  });
});

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

describe("withoutAnnounced (what a screen reader said as Listen once opened; voice-listening-c2-1)", () => {
  // What Ember's windows announce then (main sends them only while a screen reader runs).
  const said = ["Checking the microphone…", "Starting to listen…", "Listening for one request…", "Cancel listening", "Starting…", "Listening…"];

  it("takes the announcement off the start of a request, as the recognizer wrote it on the real models", () => {
    expect(withoutAnnounced("Listening for one request and turn on do not disturb to.", said)).toBe("And turn on do not disturb to.");
    expect(withoutAnnounced("Listening for one request. And make the text a bit bigger, and turn on Do Not Disturb 2.", said)).toBe("And make the text a bit bigger, and turn on Do Not Disturb 2.");
    expect(withoutAnnounced("Listen for one request and make the text a bit bigger", said)).toBe("And make the text a bit bigger");
    expect(withoutAnnounced("Cancel listening, push button. Starting to listen. Listening for one request. Open the calendar.", said)).toBe("Open the calendar.");
    expect(withoutAnnounced("Starting. Listening. Turn on night light.", said)).toBe("Turn on night light.");
    expect(withoutAnnounced("Checking the microphone. Listening for one request. What's on my calendar today?", said)).toBe("What's on my calendar today?");
  });

  it("leaves nothing of an announcement heard alone", () => {
    for (const t of ["Listening for one request.", "Listing for one request.", "Cancel listening button.", "Listening.", "Starting to listen. Listening for one request…"]) expect(withoutAnnounced(t, said), t).toBe("");
  });

  it("never takes the user's own words, and nothing at all with no screen reader running", () => {
    for (const t of ["Starting tomorrow, remind me to call Sam.", "Listen to my voicemail.", "Listening to music is fine, turn it down a bit.", "Cancel my three o'clock.", "Open the calendar and listen for one request."]) expect(withoutAnnounced(t, said), t).toBe(t);
    expect(withoutAnnounced("Listening for one request and turn on do not disturb to.", [])).toBe("Listening for one request and turn on do not disturb to.");
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
    "Hey Ember, stuff to do today.", "Hey Ember, steps to follow.", "A member stopped by the office.", "Ember stopped the music."])(
    "%j doesn't", t => expect(saidWakeStop(t)).toBe(false));
  // Ember never says "Hey Ember" itself, and its own words go on after the user's "stop" until it has been hushed (VO9-2).
  it.each(["Literally. Hey, Ember stopped Thursday at 2.", "Hey Ember stopped the music.", "They, Amber, stopping at the third floor"])(
    "%j stops (with the greeting, whatever follows the stop)", t => expect(saidWakeStop(t)).toBe(true));
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
  it.each(["No, that's all.", "Nothing else.", "I'm good, thanks.", "That's all.", "That's it, thanks.", "Okay, bye.", "Bye."])(
    "%j still ends the conversation after a question", t => expect(isCloser(t, true)).toBe(true));
  it.each(["No.", "Nope.", "No, thanks.", "No thanks.", "Not now.", "Okay, no."])(
    "%j answers an ordinary clarification (review conversation repair)", t => expect(isCloser(t, true)).toBe(false));
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
  it("Listen once starts on fresh capture and submits one request without a wake word", () => {
    const b = fake(["Do not disturb.", "Unexpected second request."]);
    const events = run(b, (e, c) => {
      c.t = 1000;
      e.cancel();
      e.listenOnce(c.t, 8000);
      e.feed(frame(0, true), 999); // queued audio captured before the click
      expect(b.speaking()).toBe(false);
      c.t += 32; e.feed(frame(0, true), c.t);
      e.followUp(); // an old answer cannot extend or change the manual window
      c.t += 32; e.feed(frame(0), c.t);
      c.t += 32; e.feed(frame(0, true), c.t);
      c.t += 32; e.feed(frame(0), c.t);
      expect(e.listening).toBe(false);
    });
    expect(events.filter(e => e.type === "utterance")).toEqual([{ type: "utterance", text: "Do not disturb.", window: "manual", ms: 0 }]);
    expect(events.filter(e => e.type === "listening").map(e => e.reason)).toEqual(["manual", "done"]);
  });

  it("Listen once times out at its deadline when no speech has started, an old answer's follow-up notwithstanding", () => {
    const events = run(fake(["A late request."]), (e, c) => {
      c.t = 1000;
      e.listenOnce(c.t, 8000);
      c.t = 5000; e.feed(frame(0), c.t);
      e.followUp();
      c.t = 9000; e.feed(frame(0), c.t);
    });
    expect(events.filter(e => e.type === "utterance")).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "listening", on: false, reason: "timeout", window: "manual" });
  });

  it("Listen once hears a request still being spoken at its deadline to the end, whole (voice-listening-1)", () => {
    const events = run(fake(["Open the calendar and show me next Tuesday."]), (e, c) => {
      c.t = 1000;
      e.listenOnce(c.t, 8000);
      // A quiet room, then speech from 7.9 s to 10 s after the press.
      for (c.t = 1032; c.t < 8900; c.t += 32) e.feed(frame(0), c.t);
      for (; c.t < 11_000; c.t += 32) e.feed(frame(0, true), c.t);
      e.feed(frame(0), c.t);
    });
    expect(events.filter(e => e.type === "utterance")).toEqual([{ type: "utterance", text: "Open the calendar and show me next Tuesday.", window: "manual", ms: 0 }]);
    expect(events.at(-1)).toEqual({ type: "listening", on: false, reason: "done", window: "manual" });
  });

  it("Listen once still caps a request that runs on: at 10 s of breathless speech, or 20 s from the press, sent cut (voice-listening-1)", () => {
    expect(MANUAL_MAX_MS).toBe(20_000);
    /** A scripted VAD that hears speech wherever f[2] > 0, and hands its segment over when flushed. */
    const held = (): VoiceBackend => {
      let segment: number[] = [];
      return {
        spot: () => [], speaking: () => segment.length > 0, transcribe: () => "And then there was the time when",
        vad: f => { if (f[2] > 0) segment.push(...f); return []; },
        flushVad: () => { const s = Float32Array.from(segment); segment = []; return s.length ? [s] : []; },
        resetVad: () => { segment = []; },
      };
    };
    const voiced = () => { const f = frame(0, true); f[2] = 1; return f; };
    // A breath: the VAD still hears speech, the room's noise is all the microphone has.
    const breath = () => { const f = new Float32Array(512); f[2] = 0.0001; return f; };
    // A quiet room until 7.5 s after the press, then speech.
    const quietUntil = (e: VoiceEngine, c: { t: number }) => { for (c.t = 1032; c.t < 8500; c.t += 32) e.feed(new Float32Array(512), c.t); };
    // Breathless from 7.5 s: the engine's own 10 s cap sends it at 17.5 s.
    const capped = run(held(), (e, c) => {
      c.t = 1000; e.listenOnce(c.t, 8000);
      quietUntil(e, c);
      for (c.t = 8500; c.t <= 30_000 && e.listening; c.t += 32) e.feed(voiced(), c.t);
    });
    expect(capped.filter(e => e.type === "utterance")).toEqual([{ type: "utterance", text: "And then there was the time when", window: "manual", ms: 0, cut: true }]);
    // Breathing every 2 s (it would go on to 20 s of speech): sent at 20 s from the press.
    let endedAt = 0;
    const long = run(held(), (e, c) => {
      c.t = 1000; e.listenOnce(c.t, 8000);
      quietUntil(e, c);
      for (let i = 0, t = 8500; t <= 40_000 && e.listening; t += 32, i++) { c.t = t; e.feed(i % 62 < 4 ? breath() : voiced(), c.t); endedAt = t; }
    });
    // (Over 12 s, it goes to the recognizer in two pieces: this one writes the same words for each.)
    expect(long.filter(e => e.type === "utterance")).toEqual([{ type: "utterance", text: expect.stringMatching(/^And then there was the time when/), window: "manual", ms: 0, cut: true }]);
    expect(endedAt).toBeGreaterThanOrEqual(1000 + MANUAL_MAX_MS);
    expect(endedAt).toBeLessThan(1000 + MANUAL_MAX_MS + 100);
  });

  describe("Listen once in a room where others talk (voice-listening-c1-1)", () => {
    /**
     * A scripted VAD that hears speech wherever f[2] > 0, from `lag` frames into it (Silero's own lag: about 0.25 s),
     * and hands its segment over at the first frame without it, or when flushed.
     */
    const vadOf = (lag = 0): VoiceBackend => {
      let segment: number[] = [], run = 0;
      return {
        spot: () => [], speaking: () => run > lag, transcribe: () => "Turn on do not disturb and set a timer for ten minutes.",
        vad: f => {
          if (f[2] > 0) { run++; if (run > lag) segment.push(...f); return []; }
          run = 0;
          const s = Float32Array.from(segment); segment = [];
          return s.length ? [s] : [];
        },
        flushVad: () => { const s = Float32Array.from(segment); segment = []; run = 0; return s.length ? [s] : []; },
        resetVad: () => { segment = []; run = 0; },
      };
    };
    /** A frame of speech at `level` (RMS): talk across the room, or the user up close. */
    const talk = (level: number) => { const f = new Float32Array(512).fill(level); f[2] = level; return f; };
    const room = (from: number, to: number, e: VoiceEngine, c: { t: number }, level = 0.01) => { for (c.t = from; c.t < to && e.listening; c.t += 32) e.feed(talk(level), c.t); };
    const sent = (events: VoiceEvent[]) => events.filter(e => e.type === "utterance");

    it("ends at its deadline, as no request heard, when the only speech is talk that was going on as it opened (a TV, a colleague)", () => {
      let endedAt = 0;
      const events = run(vadOf(), (e, c) => {
        c.t = 1000; e.listenOnce(c.t, 8000);
        room(1032, 30_000, e, c);
        endedAt = c.t;
      });
      expect(sent(events)).toEqual([]);
      expect(events.at(-1)).toEqual({ type: "listening", on: false, reason: "timeout", window: "manual" });
      expect(endedAt).toBeLessThan(1000 + 8000 + 100);
    });

    it("still hears the user's own request said over that talk, up close, to its end past the deadline", () => {
      const events = run(vadOf(), (e, c) => {
        c.t = 1000; e.listenOnce(c.t, 8000);
        room(1032, 8500, e, c);
        // The user, 20 dB over the room's talk, from 7.5 s to 11 s; then the talk goes on.
        for (; c.t < 12_000; c.t += 32) e.feed(talk(0.1), c.t);
        room(c.t, 20_000, e, c);
      });
      expect(sent(events)).toEqual([{ type: "utterance", text: "Turn on do not disturb and set a timer for ten minutes.", window: "manual", ms: 0 }]);
    });

    it("waits out the VAD's lag for speech that began just before the deadline, in a quiet room (voice-listening-1)", () => {
      let endedAt = 0;
      const events = run(vadOf(8), (e, c) => {
        c.t = 1000; e.listenOnce(c.t, 8000);
        for (c.t = 1032; c.t < 8900; c.t += 32) e.feed(new Float32Array(512), c.t);
        // Said from 7.9 s to 10 s; the VAD hears it from 8.16 s.
        for (; c.t < 11_000; c.t += 32) e.feed(talk(0.05), c.t);
        for (let i = 0; i < 10 && e.listening; i++, c.t += 32) e.feed(new Float32Array(512), c.t);
        endedAt = c.t;
      });
      expect(sent(events)).toHaveLength(1);
      expect(endedAt).toBeGreaterThan(11_000);
      // A click or a cough at the deadline costs at most 0.4 s more of "Listening…".
      let quietEnd = 0;
      const cough = run(vadOf(8), (e, c) => {
        c.t = 1000; e.listenOnce(c.t, 8000);
        for (c.t = 1032; c.t < 8940; c.t += 32) e.feed(new Float32Array(512), c.t);
        for (let i = 0; i < 3; i++, c.t += 32) e.feed(talk(0.05), c.t);
        for (; c.t < 12_000 && e.listening; c.t += 32) e.feed(new Float32Array(512), c.t);
        quietEnd = c.t;
      });
      expect(sent(cough)).toEqual([]);
      expect(cough.at(-1)).toEqual({ type: "listening", on: false, reason: "timeout", window: "manual" });
      expect(quietEnd).toBeLessThanOrEqual(1000 + 8000 + 450);
    });

    describe("a request begun at once (voice-listening-r2-1)", () => {
      /** The room's own noise: the VAD hears no speech in it. */
      const hush = () => { const f = new Float32Array(512).fill(0.0005); f[2] = 0; return f; };
      /** The user's voice up close, its syllables dipping to the room's noise (the VAD hears speech through them): frame `i` of it. */
      const say = (i: number) => (i % 6 === 5 ? talk(0.0005) : talk(0.05));
      /**
       * Silero as a scripted VAD: it hears speech `lag` frames into it, hands its segment over `hang` frames of silence
       * after it (0.6 s), and writes `transcripts` in turn.
       */
      const silero = (transcripts: string[], lag = 8, hang = 19): VoiceBackend => {
        let segment: number[] = [], run = 0, quiet = 0;
        return {
          spot: () => [], speaking: () => run > lag, transcribe: () => transcripts.shift() ?? "",
          vad: f => {
            if (f[2] > 0) { run++; quiet = 0; if (run > lag) segment.push(...f); return []; }
            if (run <= lag) { run = 0; return []; }
            segment.push(...f);
            if (++quiet < hang) return [];
            run = 0; quiet = 0;
            const s = Float32Array.from(segment); segment = [];
            return [s];
          },
          flushVad: () => { const s = Float32Array.from(segment); segment = []; run = 0; quiet = 0; return s.length ? [s] : []; },
          resetVad: () => { segment = []; run = 0; quiet = 0; },
        };
      };

      it("hears a request begun 0.3 s after the press and still being said at 8 s to its end, whole, not “No request heard” (voice-listening-r2-1)", () => {
        let endedAt = 0;
        const events = run(silero(["Open the calendar, find a free hour on Thursday afternoon and invite Sam and Priya to it."]), (e, c) => {
          c.t = 1000; e.listenOnce(c.t, 8000);
          for (c.t = 1032; c.t < 1300; c.t += 32) e.feed(hush(), c.t);
          // Said from 0.3 s to 9.7 s after the press, with no pause the VAD ends it at.
          for (let i = 0; c.t < 10_700; i++, c.t += 32) e.feed(say(i), c.t);
          for (let i = 0; i < 30 && e.listening; i++, c.t += 32) e.feed(hush(), c.t);
          endedAt = c.t;
        });
        expect(sent(events)).toEqual([{ type: "utterance", text: "Open the calendar, find a free hour on Thursday afternoon and invite Sam and Priya to it.", window: "manual", ms: 0 }]);
        expect(events.at(-1)).toEqual({ type: "listening", on: false, reason: "done", window: "manual" });
        expect(endedAt).toBeGreaterThan(10_700);
      });

      it("still ends at 8 s with nothing sent when the talk was going on as it opened, though the VAD hears it only 0.3 s in (voice-listening-c1-1)", () => {
        let endedAt = 0;
        const events = run(silero(["Let's meet at the station after lunch."]), (e, c) => {
          c.t = 1000; e.listenOnce(c.t, 8000);
          room(1032, 30_000, e, c);
          endedAt = c.t;
        });
        expect(sent(events)).toEqual([]);
        expect(events.at(-1)).toEqual({ type: "listening", on: false, reason: "timeout", window: "manual" });
        expect(endedAt).toBeLessThan(1000 + 8000 + 100);
      });

      it("gives talk that began just after the press, which can't be told from the room's after a pause, 12 s at most, and sends none of it (voice-listening-c1-1)", () => {
        let endedAt = 0;
        const events = run(silero(["Let's meet at the station after lunch."]), (e, c) => {
          c.t = 1000; e.listenOnce(c.t, 8000);
          for (c.t = 1032; c.t < 1300; c.t += 32) e.feed(hush(), c.t);
          // A TV between two lines at the press, then talking on without a pause; breathing now and then as people do.
          for (let i = 0; c.t < 30_000 && e.listening; i++, c.t += 32) e.feed(i % 62 < 4 ? hush() : talk(0.01), c.t);
          endedAt = c.t;
        });
        expect(sent(events)).toEqual([]);
        // (Said so: someone spoke, so main doesn't say that no request was heard: voice-listening-r2-1.)
        expect(events.at(-1)).toEqual({ type: "listening", on: false, reason: "timeout", window: "manual", doubt: true });
        expect(endedAt).toBeLessThanOrEqual(1000 + 12_000 + 100);
      });

      it("says a request begun at once and still being said 12 s after the press was talk it couldn't tell from the room's, not that nothing was heard (voice-listening-r2-1, voice-listening-1)", () => {
        // The documented trade-off (MANUAL_DOUBT_MS): such a request isn't sent, and "No request heard. Try again." was untrue.
        const events = run(silero(["Open the calendar, find a free hour on Thursday afternoon, invite Sam and Priya, and tell them it's about the budget."]), (e, c) => {
          c.t = 1000; e.listenOnce(c.t, 8000);
          for (c.t = 1032; c.t < 1300; c.t += 32) e.feed(hush(), c.t);
          for (let i = 0; c.t < 13_400 && e.listening; i++, c.t += 32) e.feed(say(i), c.t);
          for (let i = 0; i < 30 && e.listening; i++, c.t += 32) e.feed(hush(), c.t);
        });
        expect(sent(events)).toEqual([]);
        expect(events.at(-1)).toEqual({ type: "listening", on: false, reason: "timeout", window: "manual", doubt: true });
      });

      it("hears a request begun at once that pauses after a trailing word near the deadline as one request, its rest joined (voice-listening-3)", () => {
        const events = run(silero(["Turn on do not disturb, and make the text a.", "Bit bigger."]), (e, c) => {
          c.t = 1000; e.listenOnce(c.t, 8000);
          for (c.t = 1032; c.t < 1300; c.t += 32) e.feed(hush(), c.t);
          for (let i = 0; c.t < 7700; i++, c.t += 32) e.feed(say(i), c.t);
          // A 0.8 s pause (the VAD ends the first part 0.6 s into it), then the rest, said across the deadline.
          for (; c.t < 8500; c.t += 32) e.feed(hush(), c.t);
          for (let i = 0; c.t < 9100; i++, c.t += 32) e.feed(say(i), c.t);
          for (let i = 0; i < 40 && e.listening; i++, c.t += 32) e.feed(hush(), c.t);
        });
        expect(sent(events).map(u => (u as { text: string }).text)).toEqual(["Turn on do not disturb, and make the text a bit bigger."]);
      });

      it("hears the request after a screen reader's announcement of the window, never the announcement, and waits for it after one heard alone (voice-listening-c2-1)", () => {
        let endedAt = 0;
        const events = run(silero(["Listening for one request.", "Turn on do not disturb."]), (e, c) => {
          c.t = 1000; e.listenOnce(c.t, 8000, ["Listening for one request…", "Cancel listening"]);
          for (c.t = 1032; c.t < 1250; c.t += 32) e.feed(hush(), c.t);
          // The announcement through the speakers, softer than the user, from 0.25 s to 1.5 s; then the user, at 8.6 s.
          for (let i = 0; c.t < 2500; i++, c.t += 32) e.feed(i % 6 === 5 ? talk(0.0005) : talk(0.005), c.t);
          for (; c.t < 9600; c.t += 32) e.feed(hush(), c.t);
          for (let i = 0; c.t < 11_000; i++, c.t += 32) e.feed(say(i), c.t);
          for (let i = 0; i < 40 && e.listening; i++, c.t += 32) e.feed(hush(), c.t);
          endedAt = c.t;
        });
        // The announcement went as the request, and the window closed on it: what the user said was never heard.
        expect(sent(events).map(u => (u as { text: string }).text)).toEqual(["Turn on do not disturb."]);
        expect(endedAt).toBeGreaterThan(11_000);
      });

      it("sends a request that trailed off as it was, not nothing, when only talk that was going on as it opened follows it past the deadline (voice-listening-3)", () => {
        const events = run(silero(["Turn on do not disturb, and make the text a."], 0), (e, c) => {
          c.t = 1000; e.listenOnce(c.t, 8000);
          room(1032, 6500, e, c);
          // The user up close from 5.5 s to 7.5 s, ending on "…a", over the TV; then the TV talks on.
          for (; c.t < 8500; c.t += 32) e.feed(talk(0.1), c.t);
          room(c.t, 30_000, e, c);
        });
        expect(sent(events).map(u => (u as { text: string }).text)).toEqual(["Turn on do not disturb, and make the text a."]);
        expect(events.at(-1)).toEqual({ type: "listening", on: false, reason: "done", window: "manual" });
      });
    });
  });

  describe("a request that trails off (voice-listening-3)", () => {
    /** "Hey Ember", then `first` said, a pause of `pauseMs`, then `rest` (each segment is one frame of speech). */
    const pausedRequest = (pauseMs: number, transcripts: string[], window: "wake" | "manual" = "wake") => run(fake(transcripts), (e, c) => {
      const second = transcripts.length > 1;
      if (window === "manual") { c.t = 1000; e.listenOnce(c.t, 8000); }
      else { e.feed(frame(1)); }
      c.t += 32; e.feed(frame(0, true), c.t);
      c.t += 32; e.feed(frame(0), c.t); // the VAD ends the first part here
      for (const end = c.t + pauseMs; c.t < end;) { c.t += 32; e.feed(frame(0), c.t); }
      if (second) { c.t += 32; e.feed(frame(0, true), c.t); c.t += 32; e.feed(frame(0), c.t); }
      for (let i = 0; i < 40 && e.listening; i++) { c.t += 32; e.feed(frame(0), c.t); }
    });
    const said = (events: VoiceEvent[]) => events.filter(e => e.type === "utterance").map(e => (e as { text: string }).text);

    it("waits for the rest of “And make the text a.” after a 0.7 s pause, and sends it as one request", () => {
      expect(TRAIL_HOLD_MS).toBe(900);
      expect(said(pausedRequest(700, ["Hey Ember, and make the text a.", "Bit bigger."]))).toEqual(["And make the text a bit bigger."]);
      expect(said(pausedRequest(700, ["Open the.", "Calculator."], "manual"))).toEqual(["Open the calculator."]);
    });

    it("sends it as it was when nothing more is said, and never holds a request that ends as one does", () => {
      expect(said(pausedRequest(1500, ["Hey Ember, and make the text a."]))).toEqual(["And make the text a."]);
      const events = run(fake(["Hey Ember, turn on night light."]), (e, c) => {
        e.feed(frame(1));
        c.t += 32; e.feed(frame(0, true), c.t);
        c.t += 32; e.feed(frame(0), c.t);
      });
      // At once, as before: no wait after a request that ends as one does.
      expect(said(events)).toEqual(["Turn on night light."]);
      for (const t of ["Turn it on.", "Log in.", "What is it for?", "Send it to Sam.", "Open the calculator."]) expect(trailsOff(t), t).toBe(false);
      for (const t of ["And make the text a.", "Open the", "Send it to my, um.", "Set a timer for", "Call Sam and"]) expect(trailsOff(t), t).toBe(true);
    });

    it("still stops on a stop said after the pause, and drops the half request", () => {
      const events = pausedRequest(500, ["Hey Ember, and make the text a.", "Stop."]);
      expect(said(events)).toEqual([]);
      expect(events.filter(e => e.type === "stop")).toHaveLength(1);
    });

    it("sends the half request as it was when what follows is others' talk, well under the voice that paused (voice-listening-c1-2)", () => {
      // The user up close ("And make the text a"), a pause, then a TV or colleague 8 dB under: their words aren't the user's.
      const close = () => { const f = frame(0, true); f.fill(0.05, 2); return f; };
      for (const window of ["wake", "follow-up", "manual", "conversation"] as const) {
        const events = run(fake([...(window === "conversation" ? ["Turn on night light."] : []), "And make the text a.", "Let's meet at the station."]), (e, c) => {
          if (window === "manual") { c.t = 1000; e.listenOnce(c.t, 8000); }
          else if (window === "follow-up") e.followUp(8000);
          else { e.conversation(window === "conversation"); e.feed(frame(1)); }
          if (window === "conversation") {
            // A first request opens the conversation.
            for (let i = 0; i < 10; i++) { c.t += 32; e.feed(close(), c.t); }
            for (let i = 0; i < 30; i++) { c.t += 32; e.feed(frame(0), c.t); }
          }
          for (let i = 0; i < 10; i++) { c.t += 32; e.feed(close(), c.t); }
          c.t += 32; e.feed(frame(0), c.t); // the VAD ends the first part here
          for (let i = 0; i < 10; i++) { c.t += 32; e.feed(frame(0), c.t); }
          for (let i = 0; i < 10; i++) { c.t += 32; e.feed(frame(0, true), c.t); }
          for (let i = 0; i < 40 && e.listening; i++) { c.t += 32; e.feed(frame(0), c.t); }
        });
        // (A conversation hears on: there the talk is what was said next, as it was before the hold.)
        expect(said(events), window).toEqual(window === "conversation" ? ["Turn on night light.", "And make the text a.", "Let's meet at the station."] : ["And make the text a."]);
      }
    });

    it("never sends the half request after a cancel (the kill switch)", () => {
      const events = run(fake(["Hey Ember, open the."]), (e, c) => {
        e.feed(frame(1));
        c.t += 32; e.feed(frame(0, true), c.t);
        c.t += 32; e.feed(frame(0), c.t);
        expect(e.listening).toBe(true); // held, not sent
        e.cancel();
        for (let i = 0; i < 60; i++) { c.t += 32; e.feed(frame(0), c.t); }
      });
      expect(said(events)).toEqual([]);
    });
  });

  it("does not transcribe queued audio captured in the playback tail", () => {
    const b = fake([]);
    const events = run(b, (e, c) => {
      c.t = 1000; e.selfSpeaking(true);
      c.t = 1100; e.selfSpeaking(false); e.listenOnce(c.t, 8000);
      c.t = 1600; e.feed(frame(0, true), 1200); // playback tail, processed after the speakers went quiet
      expect(b.speaking()).toBe(false);
      e.feed(frame(0), c.t);
    });
    expect(events).toEqual([{ type: "listening", on: true, reason: "manual", window: "manual" }]);
  });

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
  function listen(b: VoiceBackend, frames: Float32Array[], o: { followUp?: boolean; question?: boolean } = {}) {
    const events: (VoiceEvent & { at: number })[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(b, ev => events.push({ ...ev, at: c.t }), { now: () => c.t, verifyWake: false });
    if (o.question) e.questionUp(true);
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

  describe("after a bare 'Hey Ember' (VO9-3)", () => {
    /** Others talking 10 dB under the speaker (their louder words): as loud as a speaker's softer ones, but never as the wake phrase. */
    const near = () => level(++said % 5 ? 0.03 : 0.006);
    /** The wake phrase as long as it is said (0.4 s), and a recognizer that makes nothing of a moment of talk around it. */
    const wake = () => n(12, () => level(0.1));
    const lenient = (b: ReturnType<typeof talking>) => { const t = b.transcribe; b.transcribe = s => { const r = t(s); return /^U12 b(1\d|2[0-2]|\d)$/.test(r) ? "Hey Ember." : r; }; return b; };

    it("doesn't send the others' talk heard right after it, in the same breath of sound", () => {
      const b = lenient(talking({ wake: 9 }));
      const { events } = listen(b, [...n(100, near), level(0.03, 9), ...wake(), ...n(400, near)]);
      expect(utterances(events)).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: "listening", on: false, reason: "timeout" });
    });

    it("takes no answer from the others' everyday word in the same breath, with a question up (voice-product-x9-1)", () => {
      // The recognizer writes "Hey Ember, okay." for the whole and "Hey Ember." for the user's own stretch: the "okay"
      // is a colleague's or a TV's, and riding on the user's name it was sent as a yes by name.
      for (const word of ["okay", "yes", "sure"]) {
        const b = lenient(talking({ wake: 9 }));
        const own = b.transcribe;
        b.transcribe = s => (own(s) === "Hey Ember." ? "Hey Ember." : `Hey Ember, ${word}.`);
        const { events } = listen(b, [...n(100, near), level(0.03, 9), ...wake(), ...n(60, near), ...n(200, room)], { question: true });
        expect(utterances(events), word).toEqual([]);
      }
    });

    it("doesn't send the others' talk heard after it ended (not as loud as the wake phrase), in a room where they talk", () => {
      // They talked until 1.9 s before "Hey Ember".
      const b = lenient(talking({ wake: 9 }));
      const { events } = listen(b, [...n(100, near), ...n(58, room), level(0, 9), ...wake(), ...n(30, room), ...n(60, near), ...n(200, room)]);
      expect(utterances(events)).toEqual([]);
      // In a quiet room, a request that follows it is sent however softly it's said.
      const quiet = lenient(talking({ wake: 9 }));
      expect(utterances(listen(quiet, [...n(160, room), level(0, 9), ...wake(), ...n(30, room), ...n(60, near), ...n(200, room)]).events)).toEqual([expect.stringMatching(/^U0 b60$/)]);
    });

    it("sends the request the speaker says after it, as loud as they said it (with the others talking on)", () => {
      const b = lenient(talking({ wake: 9 }));
      const { events } = listen(b, [...n(100, near), level(0.03, 9), ...wake(), ...n(20, near), ...n(30, () => level(0.08)), ...n(300, near)]);
      expect(utterances(events)).toEqual([expect.stringMatching(/^U42 /)]); // the wake phrase and the request (the talk this close goes with it, as before)
    });

    it("still sends a one-breath request said softer than the wake phrase, in a quiet room", () => {
      const b = lenient(talking({ wake: 9 }));
      const { events } = listen(b, [...n(100, room), level(0, 9), ...wake(), ...n(30, () => level(0.03)), ...n(60, room)]);
      expect(utterances(events)).toEqual(["U12 b30"]);
    });
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

  it("doesn't end a request at the speaker's own softer words, with gaps between their syllables (early end)", () => {
    const b = talking({ wake: 9, hangover: 19 });
    // As measured in a -45 dBFS room: "…and make the text a bit…" 13 dB under the speaker's loudest for 0.6 s (the
    // count reached 16 frames), its syllables 2 frames apart at the room's own noise, then "…bigger." as loud as before.
    const soft = Array.from({ length: 4 }, () => [...n(3, () => level(0.022)), ...n(2, room)]).flat();
    const { events } = listen(b, [...n(100, room), level(0, 9), ...n(47, () => level(0.1)), ...soft, ...n(30, () => level(0.1)), ...n(60, room)]);
    expect(utterances(events)).toEqual(["U77 b12"]);
    expect(events.find(e => e.type === "utterance")).not.toHaveProperty("cut");
  });

  it("still sends a request that never goes quiet at the cap, saying it was cut (early end)", () => {
    const b = talking({ wake: 9, hangover: 19 });
    // The speaker goes on for 30 s, the softer words between their louder ones as above, in a room quiet at each gap.
    const talk = Array.from({ length: 60 }, () => [...n(8, () => level(0.1)), ...n(3, () => level(0.022)), ...n(2, room), ...n(3, () => level(0.022))]).flat();
    const { events } = listen(b, [...n(100, room), level(0, 9), ...n(47, () => level(0.1)), ...talk]);
    const u = events.find(e => e.type === "utterance")!;
    expect(u).toMatchObject({ type: "utterance", cut: true });
    expect(u.at / 32 - 101).toBeGreaterThan(300); // at the cap (10 s of speech, with the wake phrase), not at a softer word
    expect(events.at(-1)).toMatchObject({ type: "listening", on: false, reason: "done" });
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

    it("keeps a softer follow-up's last words, without admitting quieter room talk on the next turn (PR #149)", () => {
      const b = talking({ wake: 9, hangover: 19 });
      const { events, e, c } = listen(b, [...n(100, room), level(0, 9), ...n(47, () => level(0.1)), ...n(40, room)]);
      const feed = (frames: Float32Array[]) => { for (const f of frames) { e.feed(f); c.t += 32; } };
      e.selfSpeaking(true);
      feed(n(20, room));
      e.selfSpeaking(false);
      e.followUp(8000);
      // The follow-up starts within 6 dB of the wake. Its softer words after a breath are still its own, but measured
      // against the louder wake they looked like someone else's talk and were sent before the request ended.
      feed([...n(30, room), ...n(20, () => level(0.055)), ...n(8, room), ...n(40, () => level(0.02)), ...n(60, room)]);
      expect(utterances(events)).toEqual(["U47 b0", "U20 b40"]);
      e.followUp(8000);
      feed([...n(30, room), ...n(60, () => level(0.03)), ...n(300, room)]);
      expect(utterances(events)).toEqual(["U47 b0", "U20 b40"]);
      expect(events.at(-1)).toMatchObject({ type: "listening", reason: "timeout", window: "follow-up" });
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

    it("opens after a follow-up's answer too, three in a row at most: then the next request needs \"Hey Ember\" (a third request went unheard)", () => {
      const { events, e, b } = followUp([...n(30, () => level(0.1)), ...n(40, room)]);
      const reply = () => { e.followUp(8000); for (const f of [...n(30, room), ...n(30, () => level(0.1)), ...n(40, room)]) e.feed(f); };
      reply();
      reply();
      expect(events.filter(ev => ev.type === "utterance").map(ev => ev.type === "utterance" && ev.window)).toEqual(["wake", "follow-up", "follow-up", "follow-up"]);
      const before = events.length;
      e.followUp(8000);
      expect(events.length).toBe(before);
      expect(e.listening).toBe(false);
      // A wake starts the count again.
      for (const f of [...n(30, room), level(0, 9), ...n(47, () => level(0.1)), ...n(40, room)]) e.feed(f);
      e.followUp(8000);
      expect(e.listening).toBe(true);
      expect(b.heard.length).toBe(5);
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
    for (const [first, then, stops] of [["Amber, stop", "Amber, stop it.", true], ["Amber, stop that", "Amber, stop that right now!", false],
      ["Amber, stop", "Um, Amber stop it Amber stop it", true]] as const) {
      const b = fake([first, then]);
      const transcribe = b.transcribe;
      b.transcribe = (samples, purpose) => withoutRepeats(transcribe(samples), purpose);
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

describe("while Voice Match is taught, only the kill phrase is heard (stopsOnly)", () => {
  /**
   * The engine as the voice process runs it then (stopsOnly, the VAD the enrolment's): the spotter takes `keyword` 0.5 s
   * into a phrase, as the real one takes the bare name in "Ember, stop" and "Hey Ember" in "Hey Ember, stop", and the
   * recognizer hears `heard`. `speaking`: Ember is speaking meanwhile.
   */
  const teach = (keyword: string, heard: string, o: { speaking?: boolean } = {}) => {
    const b = fake([heard, heard]);
    b.spot = f => (f[0] === 3 ? [keyword] : []);
    const events: VoiceEvent[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t });
    e.cancel();
    e.stopsOnly(true);
    if (o.speaking) e.selfSpeaking(true);
    const voice = new Float32Array(512).fill(0.05), spotted = voice.slice();
    spotted[0] = 3;
    for (let i = 0; i < 80; i++) { c.t += 32; e.feed(frame(0)); }
    for (let i = 0; i < 16; i++) { c.t += 32; e.feed(voice); }
    c.t += 32; e.feed(spotted);
    for (let i = 0; i < 10; i++) { c.t += 32; e.feed(voice); }
    for (let i = 0; i < 50; i++) { c.t += 32; e.feed(frame(0)); }
    return events;
  };

  it("stops on “Ember, stop”, though the real spotter takes the bare name first (voice-listening-r1)", () => {
    for (const heard of ["Ember, stop.", "Ember stopped.", "Hey, Amber stop."]) expect(teach("ember", heard), heard).toEqual([{ type: "stop" }]);
  });

  it("stops on “Hey Ember, stop”, which the spotter hears as “Hey Ember”, also while Ember speaks (voice-listening-r1)", () => {
    expect(teach("hey_ember", "Hey Ember, stop.")).toEqual([{ type: "stop" }]);
    expect(teach("hey_ember", "Hey Ember, stop.", { speaking: true })).toEqual([{ type: "stop" }]);
    expect(teach("ember", "Ember, stop!", { speaking: true })).toEqual([{ type: "stop" }]);
  });

  it("takes the teaching's phrases, and the name inside other words, as nothing: no stop, wake or request (voice-listening-r1)", () => {
    for (const [keyword, heard] of [["hey_ember", "Hey Ember, open my calendar."], ["hey_ember", "Hey Ember, what's on my schedule today?"], ["ember", "I remember the September weather."], ["hey_ember", "Hey Ember, turn on night light."]] as const) {
      expect(teach(keyword, heard), heard).toEqual([]);
      expect(teach(keyword, heard, { speaking: true }), `${heard} (while Ember speaks)`).toEqual([]);
    }
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
  /** `name`: the spotter takes the bare name (without the speakers' stream "Hey Ember" cuts in: see "cutting in on Ember"). */
  function heardWhileSpeaking(heard: string, o: { speakersSaidIt?: boolean; name?: boolean } = {}) {
    const b = fake([heard, heard]); // (the cut-in check may hear it first: see bargeIn)
    if (o.name) b.spot = f => (f[0] === 1 ? ["ember"] : []);
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
    const { events, checked } = heardWhileSpeaking("the screen warmer. Hey Ember, stop. Which is", { name: true });
    expect(events).toEqual([{ type: "stop" }]);
    expect(checked).toBe((10 + 5) * 32); // at the pause after it
    // With the speakers' stream (which didn't say it), the check runs as soon as they can't have said it.
    const cutIn = heardWhileSpeaking("Hey Ember, stop.", { speakersSaidIt: false });
    expect(cutIn.events).toEqual([{ type: "stop" }]);
    expect(cutIn.checked).toBe(13 * 32);
  });

  it("hears the phrase from just before its first sound (the recognizer returns nothing for a phrase after near-silence)", () => {
    // 1.5 s before the spotter fired were silent but for the last frame: what's transcribed starts 10 frames before it.
    expect(heardWhileSpeaking("Hey Ember, stop.", { name: true }).length).toBe((10 + 1 + 10 + 5) * 512);
  });

  it.each(["A. Ember stopped.", "A. Ember Stuff.", "\"pay ember\" stopped talking.", "Hey Ember, step.", "Hey, Emma, stopped it now."])(
    "stops on %j (how the recognizer writes a lone 'stop')", heard => expect(heardWhileSpeaking(heard, { name: true }).events).toEqual([{ type: "stop" }]));

  it("takes anything else as Ember's own voice (no wake while it speaks)", () => {
    expect(heardWhileSpeaking("It makes the screen warmer in the evening.").events).toEqual([{ type: "rejected", keyword: "hey_ember", reason: "self", heard: "It makes the screen warmer in the evening." }]);
    // The bare name never cuts in without the speakers' stream (Ember's own words have it).
    expect(heardWhileSpeaking("Hey Ember, what time is it?", { name: true }).events).toEqual([{ type: "rejected", keyword: "ember", reason: "self", heard: "Hey Ember, what time is it?" }]);
  });

  it("doesn't stop when the speakers said it", () => {
    expect(heardWhileSpeaking("Hey Ember, stop.", { speakersSaidIt: true }).events).toEqual([{ type: "rejected", keyword: "hey_ember", reason: "speakers" }]);
  });
});

describe("cutting in on Ember (VO9-2)", () => {
  /**
   * Ember speaks (its speakers' stream on, saying something else); the user says "Hey Ember, …" (0.35 s after the spotter
   * fired, and `on` frames more), then pauses; `again`: then says something more (0.6 s), and pauses. Main hushes Ember on
   * a wake or a stop: its speakers go quiet. `transcripts`: the wake's check, then what the window heard.
   */
  function cutIn(transcripts: string[], o: { speakers?: boolean; on?: number; again?: boolean } = {}) {
    const b = fake(transcripts);
    if (o.speakers !== false) b.spotMonitor = () => [];
    const events: (VoiceEvent & { at: number })[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(b, ev => events.push({ ...ev, at: c.t }), { now: () => c.t });
    const hushed = () => events.some(ev => ev.type === "wake" || ev.type === "stop");
    const step = (f: Float32Array) => { c.t += 32; if (o.speakers !== false) e.feedMonitor(new Float32Array(512).fill(hushed() ? 0 : 0.05)); e.feed(f); };
    e.selfSpeaking(true);
    for (let i = 0; i < 30; i++) step(frame(0));
    const spottedAt = c.t + 32;
    step(frame(1, true));
    for (let i = 0; i < 10 + (o.on ?? 0); i++) step(frame(0, true));
    for (let i = 0; i < 80; i++) step(frame(0));
    if (o.again) { for (let i = 0; i < 20; i++) step(frame(0, true)); for (let i = 0; i < 80; i++) step(frame(0)); }
    return { events, spottedAt };
  }
  const plain = (events: (VoiceEvent & { at: number })[]) => events.filter(ev => ev.type !== "speech").map(({ at: _at, ...ev }) => ev);

  it("hushes Ember (a wake: main hushes it) as soon as the speakers can't have said it, and sends the request it heard", () => {
    // The request goes on once Ember is quiet.
    const { events, spottedAt } = cutIn(["Literally. Hey Ember, what's the weather tomorrow? Thursday", "Hey Ember, what's the weather tomorrow?"], { on: 10 });
    expect(plain(events)).toEqual([
      { type: "wake", keyword: "hey_ember" }, { type: "listening", on: true, reason: "wake", window: "wake" },
      { type: "utterance", text: "What's the weather tomorrow?", ms: 0, window: "wake" }, { type: "listening", on: false, reason: "done", window: "wake" }]);
    expect(events[0].at - spottedAt).toBe(416); // the speakers' window (400 ms), to the frame
  });

  it("doesn't send what it heard over Ember's voice (Ember's words mixed in): hushed, Ember listens for the request again", () => {
    // "Hey Ember, stop." said (and over) before Ember went quiet, as the recognizer heard it.
    expect(plain(cutIn(["Literally. Hey Ember, Stiles", "Hey Ember, Stiles 1440."]).events)).toEqual([
      { type: "wake", keyword: "hey_ember" }, { type: "listening", on: true, reason: "wake", window: "wake" }]);
    // Ember's speakers went quiet as the request ended: still over Ember's voice.
    expect(plain(cutIn(["Literally. Hey Ember, what", "Hey Ember, what time is it?"], { on: 3 }).events).filter(ev => ev.type === "utterance")).toEqual([]);
    // Said again (once Ember is quiet), it's sent.
    expect(plain(cutIn(["Literally. Hey Ember, what", "Hey Ember, what time is it", "What time is it?"], { again: true }).events)).toEqual([
      { type: "wake", keyword: "hey_ember" }, { type: "listening", on: true, reason: "wake", window: "wake" },
      { type: "utterance", text: "What time is it?", ms: 0, window: "wake" }, { type: "listening", on: false, reason: "done", window: "wake" }]);
  });

  it("holds what it heard over Ember's voice once, then sends the next request, with the speakers' stream (Linux: as on main)", () => {
    // Ember's speakers go on sounding (the hush hasn't taken yet): the first request after cutting in is held, the next is sent.
    const b = fake(["Literally. Hey Ember, what", "Hey Ember, what time is it", "What time is it?"]);
    b.spotMonitor = () => [];
    const events: VoiceEvent[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t });
    const step = (f: Float32Array) => { c.t += 32; e.feedMonitor(new Float32Array(512).fill(0.05)); e.feed(f); };
    e.selfSpeaking(true);
    for (let i = 0; i < 30; i++) step(frame(0));
    step(frame(1, true));
    for (let i = 0; i < 10; i++) step(frame(0, true));
    for (let i = 0; i < 80; i++) step(frame(0));
    expect(events.filter(ev => ev.type === "utterance")).toEqual([]);
    for (let i = 0; i < 20; i++) step(frame(0, true));
    for (let i = 0; i < 80; i++) step(frame(0));
    expect(events.filter(ev => ev.type === "utterance")).toMatchObject([{ text: "What time is it?", window: "wake" }]);
  });

  it("still stops on a stop said over Ember's voice", () => {
    for (const heard of ["Hey Ember, stop.", "Stop.", "Be quiet.", "Ever be quiet."]) {
      expect(plain(cutIn(["Literally. Hey Ember.", heard]).events).filter(ev => ev.type !== "listening"), heard).toEqual([{ type: "wake", keyword: "hey_ember" }, { type: "stop" }]);
    }
  });

  it("stops on 'Hey Ember, stop' with Ember's own words after it, before hushing it as a wake", () => {
    expect(plain(cutIn(["Literally. Hey, Ember stopped Thursday at 2."]).events)).toEqual([{ type: "stop" }]);
  });

  it("takes the wake back when what it heard after cutting in was someone talking to an Amber", () => {
    expect(plain(cutIn(["He, he, he.", "Hey, Amber, what time is the meeting?"]).events)).toEqual([
      { type: "wake", keyword: "hey_ember" }, { type: "listening", on: true, reason: "wake", window: "wake" },
      { type: "rejected", keyword: "hey_ember", reason: "check", heard: "Hey, Amber, what time is the meeting?" }, { type: "listening", on: false, reason: "rejected", window: "wake" }]);
    // "Ember" heard as "Amber" in a stop: it stops.
    expect(plain(cutIn(["He, he, he.", "Hey, Amber, be quiet."]).events).filter(ev => ev.type !== "listening")).toEqual([{ type: "wake", keyword: "hey_ember" }, { type: "stop" }]);
  });

  it("stops on a few garbled words with a stop in them, heard after cutting in", () => {
    for (const heard of ["But not quite.", "Ever be quiet."]) {
      const { events } = cutIn(["Bitterly play. Hey Ember. " + heard, heard]);
      expect(plain(events).filter(ev => ev.type !== "listening"), heard).toEqual([{ type: "wake", keyword: "hey_ember" }, { type: "stop" }]);
    }
  });

  describe("without the speakers' stream (Windows, macOS: Ember never says its wake phrase there)", () => {
    /** As cutIn, and main hushes Ember on a wake: the page says it stopped speaking `hushAfter` frames later (default 1). */
    function cutInPlain(transcripts: string[], o: { keyword?: string; again?: boolean; hushAfter?: number } = {}) {
      const b = fake(transcripts);
      if (o.keyword) b.spot = f => (f[0] === 1 ? [o.keyword!] : []);
      const events: VoiceEvent[] = [];
      const c = { t: 0 };
      const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t });
      let since = -1;
      const step = (f: Float32Array) => {
        c.t += 32;
        if (since < 0 && events.some(ev => ev.type === "wake")) since = 0;
        if (since >= 0 && since++ === (o.hushAfter ?? 1) - 1) e.selfSpeaking(false);
        e.feed(f);
      };
      e.selfSpeaking(true);
      for (let i = 0; i < 30; i++) step(frame(0));
      step(frame(1, true));
      for (let i = 0; i < 10; i++) step(frame(0, true));
      for (let i = 0; i < 80; i++) step(frame(0));
      if (o.again) { for (let i = 0; i < 20; i++) step(frame(0, true)); for (let i = 0; i < 80; i++) step(frame(0)); }
      return events.filter(ev => ev.type !== "speech");
    }

    it("cuts in on Ember's answer on \"Hey Ember\" (the request was thrown away while Ember read its answer out), and takes the request said once Ember is quiet", () => {
      expect(cutInPlain(["…in the evening. Hey Ember", "Hey Ember, what's the weather tomorrow?"])).toEqual([
        { type: "wake", keyword: "hey_ember" }, { type: "listening", on: true, reason: "wake", window: "wake" },
        { type: "utterance", text: "What's the weather tomorrow?", ms: 0, window: "wake" }, { type: "listening", on: false, reason: "done", window: "wake" }]);
    });

    it("doesn't send what was said over Ember's voice, before it went quiet (its own words may be in it), and hears it said again", () => {
      // Ember went quiet only as the request ended (SELF_LAG_MS after it said so).
      expect(cutInPlain(["…in the evening. Hey Ember", "Hey Ember, what's the weather tomorrow?"], { hushAfter: 10 }).filter(ev => ev.type === "utterance")).toEqual([]);
      expect(cutInPlain(["…in the evening. Hey Ember", "Hey Ember, what's the", "What's the weather tomorrow?"], { hushAfter: 10, again: true }).filter(ev => ev.type === "utterance"))
        .toMatchObject([{ text: "What's the weather tomorrow?", window: "wake" }]);
    });

    it("never sends what it heard while waiting for Ember to stop speaking, however long the page takes to say so (review of PR #144: B1)", () => {
      // The page never says Ember stopped: Ember's next sentence was sent as the request ("'s own next sentence.").
      expect(cutInPlain(["…in the evening. Hey Ember", "Hey Ember, what's the", "Ember's own next sentence."], { hushAfter: 100000, again: true }).filter(ev => ev.type === "utterance")).toEqual([]);
    });

    /** Ember speaks, the page says it stopped; "Hey Ember" `after` frames into the tail, a request, and the request again. */
    function cutInTail(after: number) {
      const b = fake(["…in the evening. Hey Ember", "Hey Ember, what's the weather tomorrow?", "What's the weather tomorrow?"]);
      const events: VoiceEvent[] = [];
      const c = { t: 0 };
      const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t });
      const step = (f: Float32Array) => { c.t += 32; e.feed(f); };
      e.selfSpeaking(true);
      for (let i = 0; i < 30; i++) step(frame(0));
      e.selfSpeaking(false);
      for (let i = 0; i < after; i++) step(frame(0));
      step(frame(1, true));
      for (let i = 0; i < 10; i++) step(frame(0, true));
      for (let i = 0; i < 80; i++) step(frame(0));
      for (let i = 0; i < 20; i++) step(frame(0, true));
      for (let i = 0; i < 80; i++) step(frame(0));
      return { events, e, step };
    }

    it.each([1, 5, 11])("sends a request after a cut-in %i frames into the tail, once the page has said Ember stopped (no word comes after it: every request was held)", after => {
      const { events } = cutInTail(after);
      expect(events.filter(ev => ev.type === "wake")).toHaveLength(1);
      expect(events.filter(ev => ev.type === "utterance")).toMatchObject([{ text: "What's the weather tomorrow?", window: "wake" }]);
    });

    it("doesn't carry a cut-in's wait for the page into the next window", () => {
      // The page said Ember speaks and never that it stopped: the cut-in's window holds what it hears, and runs out.
      const b = fake(["…in the evening. Hey Ember", "Hey Ember, what's the", "Hey Ember", "Hey Ember, what time is it?"]);
      const events: VoiceEvent[] = [];
      const c = { t: 0 };
      const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t });
      const step = (f: Float32Array) => { c.t += 32; e.feed(f); };
      e.selfSpeaking(true);
      for (let i = 0; i < 30; i++) step(frame(0));
      step(frame(1, true));
      for (let i = 0; i < 10; i++) step(frame(0, true));
      for (let i = 0; i < 400; i++) step(frame(0));
      expect(e.listening).toBe(false);
      expect(events.filter(ev => ev.type === "utterance")).toEqual([]);
      // The next "Hey Ember, what time is it?" is an ordinary wake, and its request is sent.
      for (let i = 0; i < 30; i++) step(frame(0));
      step(frame(1, true));
      for (let i = 0; i < 10; i++) step(frame(0, true));
      for (let i = 0; i < 80; i++) step(frame(0));
      expect(events.filter(ev => ev.type === "utterance")).toMatchObject([{ text: "What time is it?", window: "wake" }]);
    });

    it("gives a later wake its pre-roll when the page never says Ember stopped after a cut-in (Voice Match's first look)", () => {
      const b = fake(["…in the evening. Hey Ember", "Hey Ember, what's the", "Hey Ember", "Hey Ember, what time is it?"]);
      const events: VoiceEvent[] = [];
      const c = { t: 0 };
      const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t });
      const step = (f: Float32Array) => { c.t += 32; e.feed(f); };
      e.selfSpeaking(true);
      for (let i = 0; i < 30; i++) step(frame(0));
      step(frame(1, true));
      for (let i = 0; i < 10; i++) step(frame(0, true));
      // The window runs out (6 s, and 4 s more once held); then "Hey Ember" again.
      for (let i = 0; i < 400; i++) step(frame(0));
      expect(e.listening).toBe(false);
      for (let i = 0; i < 60; i++) step(frame(0, true));
      step(frame(1, true));
      expect(e.wakeAudio?.length).toBeGreaterThan(40 * 512);
    });

    it("doesn't cut in where the check didn't hear \"Hey Ember\" (the spotter fired on Ember's own words), nor on the bare name", () => {
      expect(cutInPlain(["It makes the screen warmer in the evening.", "It makes the screen warmer in the evening."])).toEqual([
        { type: "rejected", keyword: "hey_ember", reason: "self", heard: "It makes the screen warmer in the evening." }]);
      expect(cutInPlain(["I remember. Hey Ember", "I remember. Hey Ember"], { keyword: "ember" }).filter(ev => ev.type === "wake")).toEqual([]);
    });

    it("still stops on \"Hey Ember, stop\" said over Ember's voice", () => {
      expect(cutInPlain(["the screen warmer. Hey Ember, stop. Which is"]).filter(ev => ev.type !== "listening")).toEqual([{ type: "stop" }]);
    });
  });

  it("doesn't cut in when the check heard someone else's name (Ember goes on speaking), and still stops on 'Hey Amber, stop'", () => {
    expect(plain(cutIn(["Hey Amber, what time is the meeting?", "Hey Amber, what time is the meeting?"]).events)).toEqual([
      { type: "rejected", keyword: "hey_ember", reason: "self", heard: "Hey Amber, what time is the meeting?" }]);
    expect(plain(cutIn(["Hey Amber, stop by my desk.", "Hey Amber, stop by my desk."]).events)).toEqual([{ type: "stop" }]);
  });

  it("sends 'That's not quite right.' said after cutting in (not a stop)", () => {
    expect(plain(cutIn(["Literally. Hey Ember, that's", "Hey Ember, that's not quite right."], { on: 10 }).events).filter(ev => ev.type !== "listening")).toEqual([
      { type: "wake", keyword: "hey_ember" }, { type: "utterance", text: "That's not quite right.", ms: 0, window: "wake" }]);
  });

  it.each(["But not quite.", "Ever be quiet.", "Be quite!", "Stop.", "Enough!", "No, that's enough."])("%j is a garbled stop", t => expect(heardStopWord(t)).toBe(true));
  it.each(["What's the weather tomorrow?", "Know the other file.", "Is there enough disk space?", "Turn the volume up a little, it's not quite loud enough for me.", "That's not quite right.", "Not quite what I asked."])("%j isn't", t => expect(heardStopWord(t)).toBe(false));
});

describe("cutting in while a listening window is open (review #253)", () => {
  it("doesn't ask the recognizer about no audio (the window already heard its pre-roll), and still hears 'Hey Ember, stop'", () => {
    // The real recognizer throws a bare number (out of WebAssembly) on less than about 0.1 s of audio.
    const b = fake([]);
    b.spotMonitor = () => [];
    const lengths: number[] = [];
    const said = ["", "Hey Ember, stop."];
    b.transcribe = s => { lengths.push(s.length); if (s.length < 1600) throw 92691224; return said.shift() ?? ""; };
    const events: VoiceEvent[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t });
    const step = (f: Float32Array) => { c.t += 32; e.feedMonitor(new Float32Array(512).fill(0.05)); e.feed(f); };
    for (let i = 0; i < 30; i++) step(frame(0));
    step(frame(1)); // "Hey Ember": the window opens once its check has heard the pre-roll
    for (let i = 0; i < 20; i++) step(frame(0));
    expect(e.listening).toBe(true);
    e.selfSpeaking(true); // a finished task is announced while the window waits
    for (let i = 0; i < 5; i++) step(frame(0));
    step(frame(1)); // "Hey Ember, stop" over it, which the speakers didn't say
    for (let i = 0; i < 60; i++) step(frame(0));
    expect(events.filter(ev => ev.type !== "speech")).toEqual([
      { type: "wake", keyword: "hey_ember" }, { type: "listening", on: true, reason: "wake", window: "wake" },
      { type: "wake", keyword: "hey_ember" }, { type: "listening", on: true, reason: "wake", window: "wake" },
      { type: "stop" }, { type: "listening", on: false, reason: "stop", window: "wake" }]);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(1600);
  });
});

describe("follow-up windows", () => {
  it("sends affirmative and negative answers to ordinary clarifications (review conversation repair)", () => {
    const okay = run(fake(["Okay."]), (e, c) => { e.followUp(8000, { afterQuestion: true }); c.t += 32; e.feed(frame(0, true)); c.t += 32; e.feed(frame(0)); });
    expect(okay.filter(e => e.type === "utterance")).toEqual([{ type: "utterance", text: "Okay.", ms: 0, window: "follow-up" }]);
    const no = run(fake(["No, thanks."]), (e, c) => { e.followUp(8000, { afterQuestion: true }); c.t += 32; e.feed(frame(0, true)); c.t += 32; e.feed(frame(0)); });
    expect(no.filter(e => e.type === "utterance")).toEqual([{ type: "utterance", text: "No, thanks.", ms: 0, window: "follow-up" }]);
    // Without a question, "Okay." ends it.
    const closed = run(fake(["Okay."]), (e, c) => { e.followUp(8000); c.t += 32; e.feed(frame(0, true)); c.t += 32; e.feed(frame(0)); });
    expect(closed.filter(e => e.type === "utterance")).toEqual([]);
  });

  it("send 'No.' or 'Not now.' while one of Ember's questions is up, so it answers it, and still end on 'Thanks.' (review of #127)", () => {
    for (const said of ["No.", "Not now.", "Nope."]) {
      const up = run(fake([said]), (e, c) => { e.questionUp(true); e.followUp(8000); c.t += 32; e.feed(frame(0, true)); c.t += 32; e.feed(frame(0)); });
      expect(up.filter(e => e.type === "utterance"), said).toEqual([{ type: "utterance", text: said, ms: 0, window: "follow-up" }]);
      const none = run(fake([said]), (e, c) => { e.followUp(8000); c.t += 32; e.feed(frame(0, true)); c.t += 32; e.feed(frame(0)); });
      expect(none.filter(e => e.type === "utterance"), said).toEqual([]);
    }
    const thanks = run(fake(["Thanks."]), (e, c) => { e.questionUp(true); e.followUp(8000); c.t += 32; e.feed(frame(0, true)); c.t += 32; e.feed(frame(0)); });
    expect(thanks.filter(e => e.type === "utterance")).toEqual([]);
  });

  it("sends “Okay.”, “That's fine.” or “Sounds good.” while one of Ember's questions is up, so it answers it, and ends on them otherwise (owner's report of 2026-11-12)", () => {
    for (const said of ["Okay.", "OK.", "That's fine.", "Sounds good.", "Fine.", "Alright.", "Okay, that's fine."]) {
      const up = run(fake([said]), (e, c) => { e.questionUp(true); e.followUp(8000); c.t += 32; e.feed(frame(0, true)); c.t += 32; e.feed(frame(0)); });
      expect(up.filter(e => e.type === "utterance"), said).toEqual([{ type: "utterance", text: said, ms: 0, window: "follow-up" }]);
      const none = run(fake([said]), (e, c) => { e.followUp(8000); c.t += 32; e.feed(frame(0, true)); c.t += 32; e.feed(frame(0)); });
      expect(none.filter(e => e.type === "utterance"), said).toEqual([]);
    }
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

describe("the bare name before it shows", () => {
  /** The spotter hears the bare name ("ember") in frame 3, then `speech` frames of speech, then silence. */
  const byName = (heard: string[], speech = 3, after = 400) => {
    const b = fake(heard);
    const spot = b.spot;
    b.spot = f => (f[0] === 3 ? ["ember"] : spot(f));
    const events: VoiceEvent[] = [];
    const c = { t: 0 };
    // The transcript check on (the default): the bare name shows only once what was said starts with it.
    const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t });
    e.feed(frame(0));
    c.t += 32; e.feed(frame(3));
    for (let i = 0; i < speech; i++) { c.t += 32; e.feed(frame(0, true)); }
    for (let i = 0; i < after; i++) { c.t += 32; e.feed(frame(0)); }
    return { events, e };
  };
  /** Main shows "Listening…" on every "speech on", and clears it only on a window's "listening off". */
  const listeningLeftUp = (events: VoiceEvent[]) => {
    let shown = false, open = false;
    for (const ev of events) {
      if (ev.type === "listening") { open = ev.on; if (!ev.on) shown = false; }
      if (ev.type === "speech" && ev.on) shown = true;
      if (ev.type === "wake") shown = true;
    }
    return shown && !open;
  };

  it("shows nothing for 'I remember…' that the check takes back, so \"Listening…\" never stays up (stuck listening)", () => {
    const { events, e } = byName(["I remember the milk."]);
    expect(events).toEqual([{ type: "rejected", keyword: "ember", reason: "check", heard: "I remember the milk." }]);
    expect(listeningLeftUp(events)).toBe(false);
    expect(e.listening).toBe(false);
  });

  it("shows nothing for a bare name that nobody followed with words, and goes back to idle (stuck listening)", () => {
    const { events, e } = byName([], 0);
    expect(events).toEqual([]);
    expect(e.listening).toBe(false);
  });

  it("shows the wake, the request and the end once what was said starts with the name (stuck listening)", () => {
    const { events, e } = byName(["Ember, turn on night light."]);
    expect(events).toEqual([
      { type: "wake", keyword: "ember" },
      { type: "listening", on: true, reason: "wake", window: "wake" },
      { type: "utterance", text: "Turn on night light.", ms: 0, window: "wake" },
      { type: "listening", on: false, reason: "done", window: "wake" },
    ]);
    expect(listeningLeftUp(events)).toBe(false);
    expect(e.listening).toBe(false);
  });

  it("says no end of speech it never said began, when Ember starts speaking over a bare name not shown yet (voice audit)", () => {
    const { events, e } = byName([], 2, 0);
    e.selfSpeaking(true);
    expect(events.filter(ev => ev.type === "speech")).toEqual([]);
  });

  it("becomes the follow-up window when one opens over a bare name not shown yet, so a reply without the name counts (voice audit)", () => {
    const b = fake(["Turn on night light."]);
    const spot = b.spot;
    b.spot = f => (f[0] === 3 ? ["ember"] : spot(f));
    const events: VoiceEvent[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t });
    e.feed(frame(0));
    c.t += 32; e.feed(frame(3));
    e.followUp(8000);
    expect(events).toEqual([{ type: "listening", on: true, reason: "follow-up", window: "follow-up" }]);
    for (let i = 0; i < 3; i++) { c.t += 32; e.feed(frame(0, true)); }
    for (let i = 0; i < 40; i++) { c.t += 32; e.feed(frame(0)); }
    expect(events).toContainEqual(expect.objectContaining({ type: "utterance", text: "Turn on night light.", window: "follow-up" }));
  });

  it("after the name alone, listens for the request and times out back to idle (stuck listening)", () => {
    const { events, e } = byName(["Ember."]);
    expect(events.map(ev => ev.type)).toEqual(["wake", "listening", "listening"]);
    expect(events.at(-1)).toEqual({ type: "listening", on: false, reason: "timeout", window: "wake" });
    expect(listeningLeftUp(events)).toBe(false);
    expect(e.listening).toBe(false);
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

describe("a request transcribed ahead of the VAD, at its pause (SPECULATE_FRAMES, docs/ASSISTANT.md phase 1.5)", () => {
  /**
   * The energy fake with a VAD that waits 19 quiet frames (0.6 s), speechSoFar, and transcripts that say how long the
   * audio was (after the wake phrase, unless `wake` is false: the recognizer didn't hear it).
   */
  function ahead(wake = true, o: { noise?: number } = {}) {
    const b = talking({ wake: 9, hangover: 19 });
    let seg: Float32Array[] = [];
    const vad = b.vad.bind(b), reset = b.resetVad.bind(b), flush = b.flushVad.bind(b);
    const calls: number[] = [];
    // `noise`: the room's noise, which raises what the VAD takes for speech (its own test, not the engine's loudness).
    let fed = 0, spoke = 0;
    const ends = new WeakMap<Float32Array, number>();
    b.vad = f => {
      const g = f.slice();
      g[5] -= o.noise ?? 0;
      fed += 512;
      if (g[5] > 0.005) spoke = fed;
      const out = vad(g);
      for (const x of out) ends.set(x, spoke);
      seg = out.length ? [] : b.speaking() ? [...seg, f] : [];
      return out;
    };
    b.fed = () => fed;
    b.speechEnd = x => ends.get(x) ?? null;
    b.resetVad = () => { seg = []; fed = 0; reset(); };
    b.flushVad = () => { seg = []; return flush(); };
    b.speechSoFar = () => {
      if (!seg.length) return null;
      const o = new Float32Array(seg.length * 512);
      seg.forEach((f, i) => o.set(f, i * 512));
      return o;
    };
    b.transcribe = s => { calls.push(s.length / 512); return `${wake ? "Hey Ember, h" : "H"}eard ${s.length / 512} frames.`; };
    return { b, calls };
  }
  const n = (count: number, f: () => Float32Array) => Array.from({ length: count }, f);
  const loud = () => level(0.1), quiet = () => level(0);
  function hear(b: VoiceBackend, frames: Float32Array[], o: { transcribeAhead?: boolean } = {}) {
    const events: (VoiceEvent & { at: number })[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(b, ev => events.push({ ...ev, at: c.t }), { now: () => c.t, verifyWake: false, ...o });
    for (const f of [...n(20, quiet), level(0, 9), ...frames]) { e.feed(f); c.t += 32; }
    return events.filter(x => x.type === "utterance");
  }

  it("sends the request when the VAD ends it, as before, with the transcript made at the pause (Moonshine isn't waited for again)", () => {
    const { b, calls } = ahead();
    const sent = hear(b, [...n(47, loud), ...n(60, quiet)]);
    expect(sent).toHaveLength(1);
    // Made at the pause, of the speech and 11 quiet frames; the VAD's own segment (with its 19) is never transcribed.
    expect(calls).toHaveLength(1);
    expect(sent[0].text).toBe(`Heard ${calls[0]} frames.`);
  });

  it("ends the request no sooner than without it (when a request ends is the VAD's, as before)", () => {
    const on = hear(ahead().b, [...n(47, loud), ...n(60, quiet)]);
    const off = hear(ahead().b, [...n(47, loud), ...n(60, quiet)], { transcribeAhead: false });
    expect(on[0].at).toBe(off[0].at);
  });

  it("throws that transcript away when the speaker goes on after the pause, and sends what they said in full", () => {
    const { b, calls } = ahead();
    const sent = hear(b, [...n(30, loud), ...n(14, quiet), ...n(20, loud), ...n(60, quiet)]);
    expect(sent).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBeGreaterThan(calls[0] + 20);
    expect(sent[0].text).toBe(`Heard ${calls[1]} frames.`);
  });

  it("doesn't take a transcript made ahead right after a wake that doesn't show the wake phrase (\"A. emperor.\" for \"Hey Ember.\")", () => {
    const { b, calls } = ahead(false);
    hear(b, [...n(47, loud), ...n(60, quiet)]);
    expect(calls).toHaveLength(2);
  });

  it("never loses soft words the VAD heard after the pause: its segment is transcribed, not the request so far (review of PR #137)", () => {
    // In a room's noise (0.015), "Turn on night light" (0.1), 14 quiet frames, "in the bedroom" softly (0.032: under the
    // engine's silence test, speech to the VAD, within 12 dB of the request), then quiet.
    const frames = [...n(60, () => level(0.015)), level(0.003, 9), ...n(47, () => level(0.1)), ...n(14, () => level(0.015)), ...n(25, () => level(0.032)), ...n(80, () => level(0.015))];
    const sent = (on: boolean) => {
      const { b } = ahead(true, { noise: 0.015 });
      const events: VoiceEvent[] = [];
      const c = { t: 0 };
      const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t, verifyWake: false, transcribeAhead: on });
      for (const f of frames) { e.feed(f); c.t += 32; }
      return events.flatMap(x => (x.type === "utterance" ? [x.text] : []));
    };
    expect(sent(false)).toEqual([expect.stringMatching(/^Heard \d+ frames\.$/)]);
    expect(sent(true)).toEqual(sent(false));
  });

  it("transcribes a long request only at its end: a 15 s request with three pauses costs at most one extra transcription", () => {
    // 3 s of speech, a 0.45 s pause, three times over, then 4.5 s more and the end (15 s in all). Transcribing the whole
    // takes two calls (the recognizer gets at most 12 s at a time); the first pause's 3.4 s is the one extra.
    const part = [...n(94, loud), ...n(14, quiet)];
    const frames = [...part, ...part, ...part, ...n(140, loud), ...n(60, quiet)];
    const on = ahead(), off = ahead();
    const [said] = hear(on.b, frames), [whole] = hear(off.b, frames, { transcribeAhead: false });
    expect(on.calls.length - off.calls.length).toBe(1);
    expect(on.calls[0]).toBeLessThan(6 * 16_000 / 512);
    expect(said.text).toBe(whole.text);
  });

  /**
   * A backend whose transcripts say what was in the audio (frames of loud and of soft speech, whatever the quiet
   * around them), with a VAD that takes the room's `noise` off before its own speech test, as Silero's rises with it.
   */
  function said(noise: number) {
    const b = talking({ wake: 9, hangover: 19 });
    let seg: Float32Array[] = [], fed = 0, spoke = 0;
    const vad = b.vad.bind(b), reset = b.resetVad.bind(b), flush = b.flushVad.bind(b);
    const ends = new WeakMap<Float32Array, number>();
    let calls = 0;
    b.vad = f => {
      const g = f.slice();
      g[5] -= noise;
      fed += 512;
      if (g[5] > 0.005) spoke = fed;
      const out = vad(g);
      for (const x of out) ends.set(x, spoke);
      seg = out.length ? [] : b.speaking() ? [...seg, g] : [];
      return out;
    };
    b.fed = () => fed;
    b.speechEnd = x => ends.get(x) ?? null;
    b.resetVad = () => { seg = []; fed = 0; reset(); };
    b.flushVad = () => { seg = []; return flush(); };
    b.speechSoFar = () => {
      if (!seg.length) return null;
      const o = new Float32Array(seg.length * 512);
      seg.forEach((f, i) => o.set(f, i * 512));
      return o;
    };
    b.transcribe = x => {
      calls++;
      let loudN = 0, softN = 0;
      for (let i = 0; i + 512 <= x.length; i += 512) { if (x[i + 5] > 0.05) loudN++; else if (x[i + 5] > 0.005) softN++; }
      return `Hey Ember, loud ${loudN} soft ${softN}.`;
    };
    return { b, calls: () => calls };
  }
  function both(noise: number, body: Float32Array[]) {
    const run = (on: boolean) => {
      const { b, calls } = said(noise);
      const events: (VoiceEvent & { at: number })[] = [];
      const c = { t: 0 };
      const e = new VoiceEngine(b, ev => events.push({ ...ev, at: c.t }), { now: () => c.t, verifyWake: false, transcribeAhead: on });
      for (const f of [...n(60, () => level(noise)), level(noise || 0.003, 9), ...body, ...n(90, () => level(noise))]) { e.feed(f); c.t += 32; }
      return { sent: events.flatMap(x => (x.type === "utterance" ? [[x.text, x.at]] : [])), calls: calls() };
    };
    return { on: run(true), off: run(false) };
  }

  it("hears a soft frame the VAD takes for speech right after the transcript made ahead (the last 's' of a word: re-review of PR #137)", () => {
    // 47 loud frames, the 11 quiet ones the transcript is made at, then one soft frame the VAD counts as speech.
    const { on, off } = both(0.015, [...n(47, loud), ...n(11, () => level(0.015)), level(0.032)]);
    expect(off.sent).toEqual([["Loud 47 soft 1.", expect.any(Number)]]);
    expect(on.sent).toEqual(off.sent);
  });

  it("sends what the VAD's own segment holds, ahead or not, over rooms, pauses and soft words after them", () => {
    let early = 0, cases = 0;
    for (const noise of [0, 0.005, 0.015, 0.03]) {
      const q = () => level(noise), soft = () => level(noise ? Math.min(noise * 2.4, 0.09) : 0.0062);
      const bodies = [
        [...n(47, loud), ...n(14, q)],
        [...n(47, loud), ...n(14, q), ...n(25, soft)],
        [...n(30, loud), ...n(14, q), ...n(30, loud), ...n(14, q), ...n(10, soft)],
        ...[9, 11, 12, 16].flatMap(k => [1, 2, 4].map(len => [...n(47, loud), ...n(k, q), ...n(len, soft)])),
        [...n(47, loud), ...n(11, q), ...n(5, loud)],
      ];
      for (const body of bodies) {
        const { on, off } = both(noise, body);
        expect(on.sent).toEqual(off.sent);
        cases++;
        if (on.calls === off.calls) early++;
      }
    }
    // (The transcript made ahead is still what's sent where nothing came after it.)
    expect(early).toBeGreaterThanOrEqual(cases / 8);
  });

  it("transcribes the VAD's segment itself when turned off, or with a backend that can't give the speech so far", () => {
    const off = ahead();
    const a = hear(off.b, [...n(47, loud), ...n(60, quiet)], { transcribeAhead: false });
    expect(off.calls).toHaveLength(1);
    expect(a[0].text).toBe(`Heard ${off.calls[0]} frames.`);
    const without = ahead();
    delete without.b.speechSoFar;
    hear(without.b, [...n(47, loud), ...n(60, quiet)]);
    expect(without.calls).toEqual(off.calls);
  });
});

describe("a conversation without the speakers' stream (Windows, macOS: Ember's own voice can't be told apart)", () => {
  const n = (count: number, f: () => Float32Array) => Array.from({ length: count }, f);
  /** The recognizer makes "Hey Ember." of the wake phrase with a moment of sound around it (as in VO9-3's tests). */
  const lenient = (b: ReturnType<typeof talking>) => { const t = b.transcribe; b.transcribe = s => { const r = t(s); return /^U12 b(1\d|2[0-2]|\d)$/.test(r) ? "Hey Ember." : r; }; return b; };
  /** "Hey Ember." (0.4 s, said up close), a pause, then the request 10 dB softer (0.03), as people say it. */
  const wakeThenRequest = (pause: number) => [level(0, 9), ...n(12, () => level(0.1)), ...n(pause, room), ...n(60, () => level(0.03)), ...n(300, room)];
  function converse(script: (feed: (frames: Float32Array[]) => void, e: VoiceEngine) => void, b: VoiceBackend = lenient(talking({ wake: 9 }))) {
    const events: VoiceEvent[] = [];
    const c = { t: 0 };
    const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t, verifyWake: false });
    script(fs => { for (const f of fs) { e.feed(f); c.t += 32; } }, e);
    return { events, e, utterances: events.flatMap(ev => (ev.type === "utterance" ? [ev.text] : [])) };
  }
  /** Ember answers for 3 s, which the microphone hears at `echo` (the echo canceller doesn't take out Web Audio's playback). */
  const emberSays = (feed: (frames: Float32Array[]) => void, e: VoiceEngine, echo: number) => { e.selfSpeaking(true); feed(n(94, () => level(echo))); e.selfSpeaking(false); };

  it("hears a request said softer than \"Hey Ember\" after a pause, when \"Hey Ember\" comes right after Ember's answer (Windows: said again and again)", () => {
    for (const echo of [0.004, 0.02]) {
      // Ember's voice 28 dB (and 14 dB) under the user's: the room before the wake phrase wasn't busy with others' talk.
      const { utterances, events } = converse((feed, e) => { feed(n(100, room)); emberSays(feed, e, echo); feed(n(30, room)); feed(wakeThenRequest(40)); });
      expect(utterances, `echo ${echo}`).toEqual(["U0 b60"]);
      expect(events.at(-1), `echo ${echo}`).toMatchObject({ type: "listening", on: false, reason: "done" });
    }
  });

  it("doesn't end a request said softer than \"Hey Ember\", after a pause, at its softer words (a quiet room: the request was cut short)", () => {
    // "Hey Ember." … "And make the text" (10 dB softer), a breath, "a bit bigger" (14 dB softer): its own loudness, not the
    // wake phrase's, says when it's over.
    const { utterances } = converse(feed => feed([...n(100, room), level(0, 9), ...n(12, () => level(0.1)), ...n(40, room), ...n(20, () => level(0.03)), ...n(8, room), ...n(40, () => level(0.02)), ...n(300, room)]), lenient(talking({ wake: 9, hangover: 19 })));
    expect(utterances).toEqual(["U0 b60"]);
  });

  it("doesn't send Ember's own last words, heard just before \"Hey Ember\", as the request (nor give them to Voice Match)", () => {
    // Ember's voice loud enough for the VAD (14 dB under the user), ending 1 s before the wake: the 1.6 s pre-roll heard it.
    const { utterances, e } = converse((feed, eng) => {
      feed(n(100, room));
      emberSays(feed, eng, 0.02);
      feed(n(30, room));
      feed([level(0, 9)]);
      // The pre-roll from 96 ms after Ember said it stopped (SELF_LAG_MS).
      expect(eng.wakeAudio?.length).toBe(27 * 512);
      feed(wakeThenRequest(40).slice(1));
    });
    expect(utterances).toEqual(["U0 b60"]);
    expect(e.listening).toBe(false);
  });

  it("measures a follow-up against the wake phrase, not a softer request after it (three follow-ups can't creep down to the room's talk)", () => {
    // "Hey Ember." (0.1), a pause, the request at 0.03 (sent); then, in the follow-up window, talk at that same 0.03.
    const { utterances } = converse((feed, e) => {
      feed([...n(100, room), ...wakeThenRequest(40)]);
      e.followUp(8000);
      feed([...n(30, room), ...n(60, () => level(0.03)), ...n(300, room)]);
    });
    expect(utterances).toEqual(["U0 b60"]);
  });

  describe("with the speakers' stream (Linux with parec): as before this change", () => {
    // What main's engine did on each (pinned against it: the self-voice handling is for Windows and macOS only).
    const PRE_ROLL_LINUX = 50 * 512, BUSY_LINUX: string[] = [], OVER_LINUX: string[] = [];
    /** As converse, with the speakers' stream fed: Ember's voice in it while Ember speaks, silence otherwise. */
    function converseLinux(script: (feed: (frames: Float32Array[]) => void, e: VoiceEngine, speaking: (on: boolean) => void) => void) {
      const b = lenient(talking({ wake: 9 }));
      b.spotMonitor = () => [];
      const events: VoiceEvent[] = [];
      const c = { t: 0 };
      const e = new VoiceEngine(b, ev => events.push(ev), { now: () => c.t, verifyWake: false });
      let on = false;
      script(fs => { for (const f of fs) { e.feedMonitor(on ? f : new Float32Array(512)); e.feed(f); c.t += 32; } }, e, v => { on = v; e.selfSpeaking(v); });
      return { events, e, utterances: events.flatMap(ev => (ev.type === "utterance" ? [ev.text] : [])) };
    }

    it("keeps the whole pre-roll before a wake that follows Ember's answer", () => {
      converseLinux((feed, e, speaking) => {
        feed(n(100, room));
        speaking(true); feed(n(94, () => level(0.02))); speaking(false);
        feed(n(30, room));
        feed([level(0, 9), ...n(14, () => level(0.1))]); // (the wake shows once the speakers can't have said it)
        expect(e.wakeAudio?.length).toBe(PRE_ROLL_LINUX);
      });
    });

    it("counts Ember's answer just before \"Hey Ember\" as the room's sound (VO9-3's busyRoom), as before", () => {
      const { utterances } = converseLinux((feed, _e, speaking) => { feed(n(100, room)); speaking(true); feed(n(94, () => level(0.02))); speaking(false); feed(n(10, room)); feed(wakeThenRequest(40)); });
      expect(utterances).toEqual(BUSY_LINUX);
    });

    it("forgets a request under way when Ember starts speaking over it, as before", () => {
      const { utterances } = converseLinux((feed, _e, speaking) => {
        feed([...n(100, room), level(0, 9), ...n(12, () => level(0.1)), ...n(40, room), ...n(20, () => level(0.03))]);
        speaking(true); feed(n(94, () => level(0.004))); speaking(false);
        feed(n(300, room));
      });
      expect(utterances).toEqual(OVER_LINUX);
    });
  });

  it("still finds the room busy when people talked between Ember's answer and \"Hey Ember\" (VO9-3)", () => {
    const near = () => level(++said % 5 ? 0.03 : 0.006);
    const { utterances } = converse((feed, e) => { feed(n(100, room)); emberSays(feed, e, 0.004); feed(n(100, near)); feed([level(0.03, 9), ...n(12, () => level(0.1)), ...n(400, near)]); });
    expect(utterances).toEqual([]);
  });

  it("takes \"Hey Ember\" said in a follow-up window as a wake: a request said softer than the first one is heard", () => {
    for (const oneBreath of [false, true]) {
      const { events } = converse((feed, e) => {
        feed([...n(100, room), level(0, 9), ...n(47, () => level(0.1)), ...n(40, room)]);
        emberSays(feed, e, 0.004);
        e.followUp(8000);
        feed(n(30, room));
        feed(oneBreath ? [...n(12, () => level(0.1)), level(0.03, 9), ...n(40, () => level(0.03)), ...n(300, room)] : [...n(12, () => level(0.1)), level(0.001, 9), ...n(40, room), ...n(60, () => level(0.03)), ...n(300, room)]);
      });
      const second = events.slice(events.findIndex(ev => ev.type === "listening" && ev.reason === "follow-up"));
      expect(second.filter(ev => ev.type !== "speech"), `one breath: ${oneBreath}`).toEqual([
        { type: "listening", on: true, reason: "follow-up", window: "follow-up" },
        { type: "wake", keyword: "hey_ember" },
        { type: "listening", on: true, reason: "wake", window: "wake" },
        // A wake's request: its answer gets a follow-up window of its own.
        { type: "utterance", text: oneBreath ? "U12 b41" : "U0 b60", ms: 0, window: "wake" },
        { type: "listening", on: false, reason: "done", window: "wake" },
      ]);
    }
  });

  it("takes back a wake spotted in a follow-up window where the recognizer heard another word, unless the follow-up would have taken it", () => {
    const amber = (loud: number) => {
      const b = talking({ wake: 9 });
      const t = b.transcribe;
      b.transcribe = s => (t(s).startsWith("U47") ? "U47" : "Hey Amber, dinner is ready.");
      return converse((feed, e) => {
        feed([...n(100, room), level(0, 9), ...n(47, () => level(0.1)), ...n(40, room)]);
        e.followUp(8000);
        feed([...n(30, room), ...n(12, () => level(loud)), level(loud, 9), ...n(30, () => level(loud)), ...n(300, room)]);
      }, b);
    };
    // Someone else, softer than the voice that woke Ember: nothing is sent (the follow-up wouldn't have taken it either).
    const soft = amber(0.03);
    expect(soft.utterances).toEqual(["U47"]);
    expect(soft.events.at(-1)).toMatchObject({ type: "listening", on: false, reason: "rejected" });
    // As loud as the user: sent as the follow-up it was (it gets no follow-up of its own).
    const loud = amber(0.1);
    expect(loud.events.filter(ev => ev.type === "utterance")).toMatchObject([{ window: "wake" }, { text: "Dinner is ready.", window: "follow-up" }]);
  });

  it("keeps a request under way when Ember starts speaking over it (a reminder, an answer's next sentence), and hears it once Ember is done", () => {
    const { utterances } = converse((feed, e) => {
      feed([...n(100, room), level(0, 9), ...n(12, () => level(0.1)), ...n(40, room), ...n(20, () => level(0.03))]);
      emberSays(feed, e, 0.004);
      feed(n(300, room));
    });
    expect(utterances).toEqual(["U0 b20"]);
  });

  it("doesn't take the bare name in a follow-up window for a wake (a follow-up needs no name, and \"remember\" has it)", () => {
    const b = lenient(talking({ wake: 9 }));
    b.spot = f => (f[0] === 9 ? ["hey_ember"] : f[0] === 8 ? ["ember"] : []);
    const { events } = converse((feed, e) => {
      feed([...n(100, room), level(0, 9), ...n(47, () => level(0.1)), ...n(40, room)]);
      e.followUp(8000);
      feed([...n(30, room), level(0.1, 8), ...n(20, () => level(0.1)), ...n(60, room)]);
    }, b);
    expect(events.filter(ev => ev.type === "wake")).toHaveLength(1);
    expect(events.filter(ev => ev.type === "utterance").map(ev => ev.type === "utterance" && ev.window)).toEqual(["wake", "follow-up"]);
  });
});

describe("the answer window after one of Ember's questions (owner's report of 2026-11-12: a bare “allow” was never heard)", () => {
  /** The scripted backend, whose transcript is the words tagged in a segment's first frame (tags 5–7; 1 and 2 are keywords). */
  const saying = (words: Record<number, string>) => { const b = fake([]); b.transcribe = s => words[s[0]] ?? ""; return b; };
  const say = (e: VoiceEngine, c: { t: number }, tag: number, frames = 1) => { for (let i = 0; i < frames; i++) { c.t += 32; e.feed(frame(tag, true)); } c.t += 32; e.feed(frame(0)); };
  const asking = { rejectWindowMs: 300, conversation: true };
  const utterances = (events: VoiceEvent[]) => events.filter(v => v.type === "utterance");
  /** As `saying`, the microphone's spotter hearing the bare name in what is said (tag 5): said by name (V2-S2). */
  const byName = (words: Record<number, string>) => { const b = saying(words); b.spot = f => (f[0] === 5 ? ["ember"] : []); return b; };

  it("hears a bare “allow” or “not now” said once the question is asked, without the name, and opens no conversation after it", () => {
    for (const words of ["Allow.", "Not now.", "Okay, go with it."]) {
      const events = run(saying({ 5: words }), (e, c) => { e.questionUp(true); e.answerWindow(8000); say(e, c, 5); }, asking);
      expect(events, words).toEqual([
        { type: "listening", on: true, reason: "answer", window: "answer" },
        { type: "speech", on: true }, { type: "speech", on: false },
        { type: "utterance", text: words, ms: 0, window: "answer" },
        { type: "listening", on: false, reason: "done", window: "answer" },
      ]);
    }
  });

  it("sends nothing else heard in it, never the room's talk without the name, and hears an answer after it until the window's time is up", () => {
    const events = run(saying({ 5: "I'll be there in five minutes.", 6: "Yes." }), (e, c) => {
      e.questionUp(true);
      e.answerWindow(8000);
      say(e, c, 5);
      expect(e.listening).toBe(true);
      say(e, c, 6);
    }, asking);
    expect(utterances(events)).toEqual([{ type: "utterance", text: "Yes.", ms: 0, window: "answer" }]);
    const idle = run(saying({ 5: "Thanks." }), (e, c) => { e.questionUp(true); e.answerWindow(8000); say(e, c, 5); c.t += 9000; e.feed(frame(0)); }, asking);
    expect(utterances(idle)).toEqual([]);
    expect(idle.at(-1)).toEqual({ type: "listening", on: false, reason: "timeout", window: "answer" });
  });

  it("says when a word or two heard in it was no answer, most likely one misheard, never the words, and nothing for longer talk (owner's report of 2026-11-12)", () => {
    // In one voice the recognizer writes a lone "Allow." as "Hello": it went nowhere, and nothing showed.
    const misheard = run(saying({ 5: "Hello." }), (e, c) => { e.questionUp(true); e.answerWindow(8000); say(e, c, 5); }, asking);
    expect(misheard.filter(v => v.type === "unclear")).toEqual([{ type: "unclear" }]);
    expect(utterances(misheard)).toEqual([]);
    const talk = run(saying({ 5: "I'll be there in five minutes." }), (e, c) => { e.questionUp(true); e.answerWindow(8000); say(e, c, 5); }, asking);
    expect(talk.filter(v => v.type === "unclear")).toEqual([]);
  });

  it("takes a request said by name in it as a wake's, so “Ember, …” still works while it is open", () => {
    const events = run(byName({ 5: "Ember, open my mail." }), (e, c) => { e.questionUp(true); e.answerWindow(8000); say(e, c, 5); }, asking);
    expect(events).toContainEqual({ type: "wake", keyword: "ember" });
    expect(utterances(events)).toEqual([{ type: "utterance", text: "Open my mail.", ms: 0, window: "wake" }]);
  });

  it("hears “Hey Ember, …” said in it as a wake from idle, checked as one, never as a follow-up", () => {
    const words = "Hey Ember, open my mail.";
    const events = run(saying({ 1: words, 5: words }), (e, c) => {
      e.questionUp(true);
      e.answerWindow(8000);
      c.t += 32; e.feed(frame(1, true));
      for (let i = 0; i < 12; i++) { c.t += 32; e.feed(frame(5, true)); }
      c.t += 32; e.feed(frame(0));
    }, asking);
    const ended = events.findIndex(v => v.type === "listening" && !v.on && v.window === "answer");
    expect(ended).toBeGreaterThan(0);
    expect(events.slice(ended + 1)).toContainEqual({ type: "wake", keyword: "hey_ember" });
    expect(utterances(events)).toEqual([{ type: "utterance", text: "Open my mail.", ms: 0, window: "wake" }]);
  });

  it("goes with the question, opens only while one is up, and never over a window already listening", () => {
    const gone = run(saying({}), e => { e.questionUp(true); e.answerWindow(8000); e.questionUp(false); }, asking);
    expect(gone).toEqual([
      { type: "listening", on: true, reason: "answer", window: "answer" },
      { type: "listening", on: false, reason: "timeout", window: "answer" },
    ]);
    expect(run(saying({}), e => e.answerWindow(8000), asking)).toEqual([]);
    const followUp = run(saying({}), e => { e.questionUp(true); e.followUp(8000); e.answerWindow(8000); }, asking);
    expect(followUp).toEqual([{ type: "listening", on: true, reason: "follow-up", window: "follow-up" }]);
  });

  it("is widened to a follow-up window when Ember's answer opens one, and is no follow-up itself (MAX_FOLLOW_UPS)", () => {
    const events = run(saying({ 5: "Open my mail." }), (e, c) => { e.questionUp(true); e.answerWindow(8000); e.followUp(8000); say(e, c, 5); }, asking);
    expect(utterances(events)).toEqual([{ type: "utterance", text: "Open my mail.", ms: 0, window: "follow-up" }]);
  });

  /**
   * Ember reads the question out (its voice, tag 8, in the microphone as it is on Windows and macOS), the page says it
   * stopped and main opens the window (VoiceService does both at once), and then `after` is what the microphone hears.
   */
  const asked = (words: Record<number, string>, after: (e: VoiceEngine, c: { t: number }) => void, window: "answer" | "follow-up" = "answer") =>
    run(saying({ 8: "To allow, press Control Alt Y; for not now, press Control Alt N.", ...words }), (e, c) => {
      e.questionUp(true);
      e.selfSpeaking(true);
      for (let i = 0; i < 40; i++) { c.t += 32; e.feed(frame(8, true)); }
      e.selfSpeaking(false);
      if (window === "answer") e.answerWindow(8000); else e.followUp(8000);
      after(e, c);
      for (let i = 0; i < 40; i++) { c.t += 32; e.feed(frame(0)); }
    }, asking);
  const overs = (events: VoiceEvent[]) => events.filter(v => v.type === "answer-over");

  it("never takes an answer begun before Ember had stopped speaking: “Don't do it.” heard only as “Do it.” is asked for again, never allowed (owner's report of 2026-11-12)", () => {
    // The user's "Don't" (tag 7) runs on from Ember's voice, unheard in the 400 ms tail; only "Do it." (tag 6) is heard after it.
    for (const window of ["answer", "follow-up"] as const) {
      const events = asked({ 7: "Don't do it.", 6: "Do it." }, (e, c) => {
        for (let i = 0; i < 12; i++) { c.t += 32; e.feed(frame(7, true)); }
        for (let i = 0; i < 12; i++) { c.t += 32; e.feed(frame(6, true)); }
      }, window);
      expect(utterances(events), window).toEqual([]);
      expect(overs(events), window).toEqual([{ type: "answer-over", answer: "allow" }]);
    }
  });

  it("hears an answer begun just after Ember's voice ended whole, also a short one over before the tail is (owner's report of 2026-11-12: it was lost)", () => {
    // 160 ms of quiet after Ember's voice (TURN_GAP_FRAMES), then "Okay." (tag 5), all of it in the 400 ms tail.
    const events = asked({ 5: "Okay." }, (e, c) => {
      for (let i = 0; i < 5; i++) { c.t += 32; e.feed(frame(0)); }
      for (let i = 0; i < 6; i++) { c.t += 32; e.feed(frame(5, true)); }
    });
    expect(utterances(events)).toEqual([{ type: "utterance", text: "Okay.", ms: 0, window: "answer" }]);
    expect(overs(events)).toEqual([]);
    // "Don't do it." begun a moment after Ember's voice ended, with its own pause in the tail: heard from its start.
    const refusal = asked({ 7: "Don't do it.", 6: "Do it." }, (e, c) => {
      for (let i = 0; i < 6; i++) { c.t += 32; e.feed(frame(0)); }
      for (let i = 0; i < 3; i++) { c.t += 32; e.feed(frame(7, true)); }
      for (let i = 0; i < 3; i++) { c.t += 32; e.feed(frame(0)); }
      for (let i = 0; i < 8; i++) { c.t += 32; e.feed(frame(6, true)); }
    });
    expect(utterances(refusal)).toEqual([{ type: "utterance", text: "Don't do it.", ms: 0, window: "answer" }]);
  });

  it("never takes an answer begun under Ember's voice where the speakers' own stream says when it ended either (Linux with parec; owner's report of 2026-11-12)", () => {
    // The tail ends with the speakers' last sound, and what the microphone heard from it on is heard: here "Do it." (tag 6),
    // the end of a "Don't do it." whose "Don't" (tag 7) was said under Ember's last words (tag 8).
    const b = saying({ 8: "To allow, press Control Alt Y; for not now, press Control Alt N.", 7: "Don't do it.", 6: "Do it." });
    b.spotMonitor = () => [];
    const playing = new Float32Array(512).fill(0.05), silent = new Float32Array(512);
    const events = run(b, (e, c) => {
      e.questionUp(true);
      e.selfSpeaking(true);
      const both = (tag: number, n: number, speakers: Float32Array) => { for (let i = 0; i < n; i++) { c.t += 32; e.feedMonitor(speakers); e.feed(frame(tag, true)); } };
      both(8, 30, playing);
      both(7, 4, playing);
      both(6, 2, playing);
      e.selfSpeaking(false);
      e.answerWindow(8000);
      both(6, 8, silent);
      for (let i = 0; i < 40; i++) { c.t += 32; e.feedMonitor(silent); e.feed(frame(0)); }
    }, asking);
    expect(utterances(events)).toEqual([]);
    expect(overs(events)).toEqual([{ type: "answer-over", answer: "allow" }]);
  });

  it("never hears Ember's own last words, whether they end in the tail or go on past it after an early “stopped” (owner's report of 2026-11-12)", () => {
    // Its voice runs into the tail and stops there: nothing, and no note.
    const inTail = asked({}, (e, c) => { for (let i = 0; i < 4; i++) { c.t += 32; e.feed(frame(8, true)); } });
    expect(inTail.filter(v => v.type !== "listening")).toEqual([]);
    // The page said it stopped 0.6 s early: "…press Control Alt N." (tag 9) goes on past the tail. Never an answer.
    const past = asked({ 9: "Press Control Alt N." }, (e, c) => { for (let i = 0; i < 19; i++) { c.t += 32; e.feed(frame(9, true)); } });
    expect(utterances(past)).toEqual([]);
    expect(overs(past)).toEqual([]);
  });

  it("takes a video's or a call's “Okay.” for no one's yes where nothing can tell whether other sound plays (macOS, Linux without parec, Windows before its output watch has looked; owner's report of 2026-11-12)", () => {
    // In production nothing is known until the platform says (process.ts: otherSound null).
    const unknown = { ...asking, otherSound: null };
    const marked = { overSound: true, soundUnknown: true };
    const answer = run(saying({ 5: "Okay." }), (e, c) => { e.questionUp(true); e.answerWindow(8000); say(e, c, 5); }, unknown);
    expect(utterances(answer)).toEqual([{ type: "utterance", text: "Okay.", ms: 0, window: "answer", ...marked }]);
    const followUp = run(saying({ 5: "Okay." }), (e, c) => { e.questionUp(true); e.followUp(8000); say(e, c, 5); }, unknown);
    expect(utterances(followUp)).toEqual([{ type: "utterance", text: "Okay.", ms: 0, window: "follow-up", ...marked }]);
    // A no is anyone's; a yes said with the name is the user's.
    const no = run(saying({ 5: "Not now." }), (e, c) => { e.questionUp(true); e.answerWindow(8000); say(e, c, 5); }, unknown);
    expect(utterances(no)).toEqual([{ type: "utterance", text: "Not now.", ms: 0, window: "answer" }]);
    const named = run(byName({ 5: "Ember, allow." }), (e, c) => { e.questionUp(true); e.answerWindow(8000); say(e, c, 5); }, unknown);
    expect(utterances(named)).toEqual([{ type: "utterance", text: "Allow.", ms: 0, window: "answer" }]);
    // Once Windows' output watch has said nothing else plays, a yes goes as before; once it stops, nothing is known again.
    const watched = run(saying({ 5: "Okay.", 6: "Sure." }), (e, c) => {
      e.questionUp(true);
      e.otherSound(false);
      e.answerWindow(8000);
      say(e, c, 5);
      e.otherSound(null);
      e.answerWindow(8000);
      say(e, c, 6);
    }, unknown);
    expect(utterances(watched)).toEqual([{ type: "utterance", text: "Okay.", ms: 0, window: "answer" }, { type: "utterance", text: "Sure.", ms: 0, window: "answer", ...marked }]);
  });

  it("marks what it hears over other sound, which the voice gate drops without a voiceprint, unless said by name", () => {
    const over = run(saying({ 5: "Allow." }), (e, c) => { e.questionUp(true); e.otherSound(true); e.answerWindow(8000); say(e, c, 5); }, asking);
    expect(utterances(over)).toEqual([{ type: "utterance", text: "Allow.", ms: 0, window: "answer", overSound: true }]);
    const named = run(byName({ 5: "Ember, allow." }), (e, c) => { e.questionUp(true); e.otherSound(true); e.answerWindow(8000); say(e, c, 5); }, asking);
    expect(utterances(named)).toEqual([{ type: "utterance", text: "Allow.", ms: 0, window: "answer" }]);
  });

  it("takes a video's “Okay.” for no one's yes in a follow-up window too, when other sound is known to play (Codex review of #211)", () => {
    // A question that comes up while a follow-up window is open keeps that window (answerWindow leaves it), so the same
    // "Okay." that the answer window marks went out unmarked and, with Voice Match off, could allow the question.
    const okay = run(saying({ 5: "Okay." }), (e, c) => { e.questionUp(true); e.otherSound(true); e.followUp(8000); say(e, c, 5); }, asking);
    expect(utterances(okay)).toEqual([{ type: "utterance", text: "Okay.", ms: 0, window: "follow-up", overSound: true }]);
    const opened = run(saying({ 5: "Okay." }), (e, c) => { e.otherSound(true); e.followUp(8000); e.questionUp(true); e.answerWindow(8000); say(e, c, 5); }, asking);
    expect(utterances(opened)).toEqual([{ type: "utterance", text: "Okay.", ms: 0, window: "follow-up", overSound: true }]);
    // A no is anyone's, a yes said with the name is the user's, and a follow-up with no question up is as before.
    const no = run(saying({ 5: "Not now." }), (e, c) => { e.questionUp(true); e.otherSound(true); e.followUp(8000); say(e, c, 5); }, asking);
    expect(utterances(no)).toEqual([{ type: "utterance", text: "Not now.", ms: 0, window: "follow-up" }]);
    const named = run(byName({ 5: "Ember, allow." }), (e, c) => { e.questionUp(true); e.otherSound(true); e.followUp(8000); say(e, c, 5); }, asking);
    expect(utterances(named)).toEqual([{ type: "utterance", text: "Allow.", ms: 0, window: "follow-up" }]);
    const request = run(saying({ 5: "Open the downloads folder." }), (e, c) => { e.otherSound(true); e.followUp(8000); say(e, c, 5); }, asking);
    expect(utterances(request)).toEqual([{ type: "utterance", text: "Open the downloads folder.", ms: 0, window: "follow-up" }]);
  });
});

describe("whose a spoken answer is (second review of the voice lane, 2026-11-12)", () => {
  /**
   * A scripted backend whose VAD ends a segment after 0.6 s of quiet, as Silero does, so a segment is judged when the real
   * one is. A microphone frame says which words it holds ([0], in thousandths, so its level stays its own) and which name
   * the spotter hears in it ([1]: 1 "ember", 2 "hey_ember"); a frame of the speakers' stream says which name its own
   * spotter hears ([1]).
   */
  const NAMES = ["", "ember", "hey_ember"];
  const HANG = 19;
  const code = (x: number) => Math.round(x * 1000);
  function hears(words: Record<number, string>, speakers: boolean): VoiceBackend {
    let speaking = false, quiet = 0, seg: Float32Array[] = [];
    const whole = () => { const s = new Float32Array(seg.length * 512); seg.forEach((f, i) => s.set(f, i * 512)); return s; };
    const end = () => { const s = whole(); seg = []; speaking = false; quiet = 0; return s; };
    const spot = (f: Float32Array) => (NAMES[code(f[1])] ? [NAMES[code(f[1])]] : []);
    const b: VoiceBackend = {
      spot,
      vad(f) {
        if (code(f[0]) > 0) { speaking = true; quiet = 0; seg.push(f); return []; }
        if (!speaking) return [];
        seg.push(f);
        return ++quiet >= HANG ? [end()] : [];
      },
      speaking: () => speaking,
      speechSoFar: () => (speaking ? whole() : null),
      flushVad: () => (speaking ? [end()] : []),
      resetVad: () => { speaking = false; quiet = 0; seg = []; },
      transcribe: s => { for (let i = 0; i < s.length; i += 512) if (words[code(s[i])]) return words[code(s[i])]; return ""; },
    };
    if (speakers) { b.spotMonitor = spot; b.padMonitor = () => []; b.resetMonitor = () => undefined; }
    return b;
  }
  /** A microphone frame: the words `tag` at `level` (0: no speech, only sound at that level), the spotter hearing `name` in it. */
  const mic = (tag: number, level = 0.05, name = 0) => { const f = new Float32Array(512).fill(level); f[0] = tag / 1000; f[1] = name / 1000; return f; };
  /** A frame of the speakers' own stream at `level`, its spotter hearing `name` in it; `tag`: the words the recognizer reads in it. */
  const out = (level: number, name = 0, tag = 0) => { const f = new Float32Array(512).fill(level); f[0] = tag / 1000; f[1] = name / 1000; return f; };
  const frames = (ms: number) => Math.round(ms / 32);
  type Scene = { e: VoiceEngine; events: VoiceEvent[]; run: (n: number, m?: () => Float32Array, s?: () => Float32Array) => void; emberSays: (ms: number, mic?: number, also?: number) => void; heard: () => unknown[] };
  /** `speakers`: their own stream arrives (Linux with parec); `otherSound`: what the platform says of other sound (null: nothing). */
  function scene(words: Record<number, string>, o: { speakers?: boolean; otherSound?: boolean | null; conversation?: boolean } = {}): Scene {
    const events: VoiceEvent[] = [], c = { t: 1_000_000 };
    const e = new VoiceEngine(hears(words, !!o.speakers), ev => events.push(ev), { now: () => c.t, conversation: !!o.conversation, otherSound: o.otherSound === undefined ? null : o.otherSound });
    const run: Scene["run"] = (n, m = () => mic(0, 0), s = () => out(0)) => { for (let i = 0; i < n; i++) { c.t += 32; if (o.speakers) e.feedMonitor(s()); e.feed(m()); } };
    /** Ember says something for `ms`: the page says so, its speakers' stream carries it (over `also`), the microphone hears `level` of it. */
    const emberSays: Scene["emberSays"] = (ms, level = 0.02, also = 0) => { e.selfSpeaking(true); run(frames(ms), () => mic(0, level), () => out(0.06 + also)); e.selfSpeaking(false); };
    /** What left the engine, as main and the voice gate get it: each utterance's words, window and marks, and each other verdict. */
    const heard = () => events.flatMap(v => (v.type === "utterance" ? [[v.text, v.window, ...(v.overSound ? ["over other sound"] : []), ...(v.soundUnknown ? ["sound unknown"] : []), ...(v.overEmber ? ["over Ember"] : [])].join(" | ")]
      : v.type === "answer-over" || v.type === "unclear" || v.type === "stop" || v.type === "wake" ? [v.type] : v.type === "rejected" ? [`rejected (${v.reason})`] : []));
    return { e, events, run, emberSays, heard };
  }
  /**
   * A question comes up, Ember reads it out (the microphone hears `echo` of it; a bed of sound `bed` goes on in the room
   * and the stream meanwhile), and main opens its answer window as Ember stops (VoiceService does both at once).
   */
  const asks = (s: Scene, o: { echo?: number; bed?: number } = {}) => {
    const bed = o.bed ?? 0;
    s.e.questionUp(true);
    s.run(frames(700), () => mic(0, bed / 2), () => out(bed));
    s.emberSays(2000, o.echo ?? 0.02, bed);
    s.e.answerWindow(8000);
  };

  describe("right after Ember reads a question out (V2-S1, voice-listening-r9-1)", () => {
    /** A video, quiet between its sentences, says "Okay." (0.4 s) `gap` ms after Ember's voice: in the speakers' stream and the microphone alike. */
    const videoSays = (gap: number, o: { bed?: boolean; mine?: boolean; conversation?: boolean } = {}) => {
      const s = scene({ 5: "Okay.", 6: "What time is it?" }, { speakers: true, conversation: o.conversation });
      const bedMic = () => mic(0, o.bed ? 0.002 : 0), bedOut = () => out(o.bed ? 0.004 : 0);
      s.run(100, bedMic, bedOut);
      if (o.conversation) {
        // The user's own "Hey Ember, what time is it?" first, and Ember's answer: the conversation is open.
        for (let i = 0; i < 30; i++) s.run(1, () => mic(6, 0.05, i === 10 ? 2 : 0));
        s.run(40);
        s.emberSays(1200);
        s.run(frames(600));
      }
      // The video talks for 3 s before the question, then pauses.
      s.run(frames(3000), () => mic(0, 0.03), () => out(0.05));
      s.run(frames(400), bedMic, bedOut);
      s.events.length = 0;
      asks(s, { echo: o.conversation ? 0 : 0.02, bed: o.bed ? 0.004 : 0 });
      s.run(frames(gap), bedMic, bedOut);
      s.run(frames(400), () => mic(5, 0.03), () => out(o.mine ? (o.bed ? 0.004 : 0) : 0.05));
      s.run(frames(2500), bedMic, bedOut);
      return s.heard();
    };

    it("takes a video's or a call's “Okay.” begun a moment after Ember's voice for no one's yes, where the speakers' own stream says it played (Linux with parec)", () => {
      // The stream went quiet as Ember's voice ended: what sounds in it a turn's gap later is other sound at once. Before, nothing
      // counted as other sound for 1.5 s after Ember's voice, and the "Okay." went to main unmarked: anyone's yes.
      for (const gap of [160, 256, 352, 448, 640, 1300]) expect(videoSays(gap), `${gap} ms`).toEqual(["Okay. | answer | over other sound"]);
      // With a bed of sound under the video the stream never goes quiet: Ember's voice counts as over 400 ms after it says so.
      for (const gap of [544, 800, 1300]) expect(videoSays(gap, { bed: true }), `bed, ${gap} ms`).toEqual(["Okay. | answer | over other sound"]);
      // (Begun under the tail of Ember's voice it was never an answer, as before.)
      for (const gap of [160, 352]) expect(videoSays(gap, { bed: true }), `bed, ${gap} ms`).toEqual(["answer-over"]);
    });

    it("so in a conversation, the default after a spoken request", () => {
      for (const gap of [350, 450, 700, 1200]) expect(videoSays(gap, { conversation: true }), `${gap} ms`).toEqual(["Okay. | conversation | over other sound"]);
    });

    it("still takes the user's own “Okay.” said then, while the speakers' stream is silent or only its bed goes on under Ember's voice", () => {
      for (const gap of [160, 352, 640]) expect(videoSays(gap, { mine: true }), `${gap} ms`).toEqual(["Okay. | answer"]);
      for (const gap of [350, 700]) expect(videoSays(gap, { mine: true, conversation: true }), `${gap} ms`).toEqual(["Okay. | conversation"]);
    });

    it("doesn't take Ember's own voice, hushed when the user cuts in, for other sound: what they go on to say is heard", () => {
      // A conversation over nothing else: the user talks over Ember, main hushes it, and its last sound leaves the stream
      // a moment after the cut-in. Dated from the cut-in, that sound was "other sound" for the 1.5 s after it.
      const s = scene({ 5: "Open my mail please.", 6: "What time is it?" }, { speakers: true, conversation: true });
      s.run(100);
      for (let i = 0; i < 30; i++) s.run(1, () => mic(6, 0.05, i === 10 ? 2 : 0));
      s.run(40);
      s.events.length = 0;
      s.e.selfWords("It is ten past four in the afternoon.");
      s.e.selfSpeaking(true);
      s.run(30, () => mic(0, 0), () => out(0.06));
      let hushed = false;
      for (let i = 0; i < 24; i++) {
        s.run(1, () => mic(5, 0.05), () => out(hushed ? 0 : 0.06));
        // Main hushes Ember on the cut-in: the page says it stopped, and its sound leaves the stream three frames later.
        if (!hushed && s.events.some(v => v.type === "cut-in")) { hushed = true; s.e.selfSpeaking(false); s.run(3, () => mic(5, 0.05), () => out(0.06)); }
      }
      s.run(40);
      expect(hushed).toBe(true);
      expect(s.heard()).toEqual(["Open my mail please. | conversation | over Ember"]);
    });
  });
  /** Where a question is answered without the name: its own answer window, a follow-up window, a conversation. */
  type Where = "answer" | "follow-up" | "conversation";
  const WHERE: Where[] = ["answer", "follow-up", "conversation"];
  /**
   * A question is up and read out, in `where`; for a follow-up or a conversation the user's own "Hey Ember, what time is
   * it?" (tag 9, the microphone's spotter only) and Ember's answer came first. What happened till then is forgotten.
   * `conversations`: they are on (the default), so a wake's request would open one.
   */
  const waiting = (words: Record<number, string>, where: Where, o: { speakers?: boolean; otherSound?: boolean | null; conversations?: boolean } = { speakers: true }) => {
    const s = scene({ 9: "What time is it?", ...words }, { ...o, conversation: where === "conversation" || !!o.conversations });
    s.run(100);
    if (where !== "answer") {
      for (let i = 0; i < 30; i++) s.run(1, () => mic(9, 0.05, i === 10 ? 2 : 0));
      s.run(40);
      s.emberSays(1500);
      if (where === "follow-up") s.e.followUp(8000);
      s.run(frames(300));
    }
    asks(s);
    s.run(frames(600));
    s.events.length = 0;
    return s;
  };
  /** A video known to play (2.5 s of its talk, in the speakers' stream and the microphone), then a breath. */
  const videoOn = (s: Scene) => { s.run(frames(2500), () => mic(0, 0.03), () => out(0.05)); s.run(frames(300)); };
  /**
   * `tag`'s words (0.9 s): out of the speakers (in their stream, which reads as those words, and the microphone, both
   * spotters hearing `name` in them; `theirs`: what the speakers' own spotter hears instead, `reads`: the words the
   * recognizer reads in their stream instead) or said by the user (the microphone and its spotter only, the video's
   * talk going on in the stream); then quiet.
   */
  const says = (s: Scene, tag: number, name: number, by: "video" | "user", theirs = by === "video" ? name : 0, reads = by === "video" ? tag : 0) => {
    for (let i = 0; i < frames(900); i++) s.run(1, () => mic(tag, by === "video" ? 0.03 : 0.05, i === 8 ? name : 0), () => out(0.05, i === 8 ? theirs : 0, reads));
    s.run(frames(1500));
  };

  describe("a name the speakers said (V2-S2, voice-listening-r9-2)", () => {
    it("never takes “Ember, allow” out of the speakers as said by name: a video's, a call's or a page's own yes answers nothing, in any window (Linux with parec)", () => {
      // At idle a wake word the speakers' own stream said is rejected; in a window that needs no name nothing asked that
      // stream, and the transcript's "Ember, …" exempted the yes from every other-sound mark.
      for (const words of ["Ember, allow.", "Ember, yes please."]) for (const where of WHERE) {
        const s = waiting({ 5: words }, where);
        videoOn(s);
        says(s, 5, 1, "video");
        expect(s.heard(), `${words} in ${where}`).toEqual([`${words.replace("Ember, ", "").replace(/^./, c => c.toUpperCase())} | ${where} | over other sound`]);
      }
    });

    it("so for “Hey Ember, allow” out of the speakers: rejected as theirs, and the yes that came with it is theirs too", () => {
      // A follow-up logged that the speakers said "Hey Ember" and then took the "Allow." after it; a conversation never asked.
      const followUp = waiting({ 5: "Hey Ember, allow." }, "follow-up");
      videoOn(followUp);
      says(followUp, 5, 2, "video");
      expect(followUp.heard()).toEqual(["rejected (speakers)", "Allow. | follow-up | over other sound"]);
      const conversation = waiting({ 5: "Hey Ember, allow." }, "conversation");
      videoOn(conversation);
      says(conversation, 5, 2, "video");
      expect(conversation.heard()).toEqual(["Allow. | conversation | over other sound"]);
      // (In the answer window "Hey Ember" ends the window and is checked as a wake from idle, as before.)
      const answer = waiting({ 5: "Hey Ember, allow." }, "answer");
      videoOn(answer);
      says(answer, 5, 2, "video");
      expect(answer.heard()).toEqual(["rejected (speakers)"]);
    });

    it("takes it for theirs by the recognizer's reading of their own stream too, where their spotter missed the name the microphone's heard", () => {
      // Measured on the real models: with the two spotters alone a video's own "Ember, okay." was still the user's 3 times in 80.
      for (const where of WHERE) {
        const s = waiting({ 5: "Ember, okay." }, where);
        videoOn(s);
        says(s, 5, 1, "video", 0);
        expect(s.heard(), where).toEqual([`Okay. | ${where} | over other sound`]);
        // The recognizer drops a first "Ember" out of the stream's digital silence now and then: the words heard with
        // the name are the speakers' own all the same.
        const dropped = waiting({ 5: "Ember, yes please.", 7: "Yes, please." }, where);
        videoOn(dropped);
        says(dropped, 5, 1, "video", 0, 7);
        expect(dropped.heard(), where).toEqual([`Yes please. | ${where} | over other sound`]);
        // The user's own words over a video that says others are the user's (the microphone's spotter heard the name).
        const mine = waiting({ 5: "Ember, yes please.", 7: "And then we can book the flights to Lisbon." }, where);
        videoOn(mine);
        says(mine, 5, 1, "user", 0, 7);
        expect(mine.heard(), where).toEqual([`Yes please. | ${where}`]);
      }
      // So for a request in a conversation, which a name the spotter heard a moment ago lets through however it was written.
      const request = waiting({ 5: "I remember the September weather was nice." }, "conversation");
      request.e.questionUp(false);
      videoOn(request);
      says(request, 5, 1, "video", 0);
      expect(request.heard()).toEqual(["I remember the September weather was nice. | conversation | over other sound"]);
    });

    it("reads their stream from where its sound began, and again from its pause: a name the speech was dated a moment into, or one said right after the video's other words, is theirs all the same", () => {
      for (const where of WHERE) {
        // The VAD hears a speech begin a moment late, so the stretch of their stream read for it began inside the name,
        // and of a name cut at its start the recognizer writes nothing (here: its words are in its first 0.1 s). Measured
        // on the real models: a video's "Ember, go ahead." so read was the user's yes by name.
        const late = waiting({ 5: "Ember, okay." }, where);
        videoOn(late);
        for (let i = 0; i < frames(900); i++) late.run(1, () => mic(i < 14 ? 0 : 5, 0.03, i === 20 ? 1 : 0), () => out(0.05, 0, i < 3 ? 5 : 0));
        late.run(frames(1500));
        expect(late.heard(), `dated late, ${where}`).toEqual([`Okay. | ${where} | over other sound`]);
        // The end of what the video said before, a pause, then its "Ember, okay.": read together the recognizer makes
        // nothing of the second (here: it reads the first words it finds), so the stream is read again from the pause.
        const after = waiting({ 5: "Ember, okay.", 7: "The flights to Lisbon." }, where);
        videoOn(after);
        after.run(6, () => mic(0, 0.03), () => out(0.05, 0, 7));
        after.run(8);
        says(after, 5, 1, "video", 0);
        expect(after.heard(), `after other words, ${where}`).toEqual([`Okay. | ${where} | over other sound`]);
      }
    });

    it("still takes the user's own “Ember, allow” over a playing video, which only the microphone's spotter heard", () => {
      for (const where of WHERE) {
        const s = waiting({ 5: "Ember, allow." }, where);
        videoOn(s);
        says(s, 5, 1, "user");
        expect(s.heard(), where).toEqual([`Allow. | ${where}`]);
      }
    });

    describe("by the microphone's loudness too, where both readers of the stream made nothing of it (voice-safety-x9-2)", () => {
      // Tones on whole periods of a frame (31.25 Hz), so each frame's first two samples, which carry the words' and the
      // names' tags, hardly break a wave.
      /** Frame `i` of a voice at `level`: a `hz` tone whose loudness rises and falls as syllables do (`rate`). */
      const voice = (i: number, level: number, rate: number, hz = 1000) => (k: number) => level * (0.15 + 0.85 * Math.abs(Math.sin(i * rate))) * Math.sin((2 * Math.PI * hz * k) / 16_000);
      const hum = (hz: number) => (k: number) => 0.9 * Math.sin((2 * Math.PI * hz * k) / 16_000);
      /** A microphone frame of the words `tag` with the name `name` for its spotter, and `sound` in the rest of it. */
      const heardAs = (tag: number, name: number, sound: (k: number) => number) => { const f = new Float32Array(512); for (let k = 2; k < 512; k++) f[k] = sound(k); f[0] = tag / 1000; f[1] = name / 1000; return f; };
      /**
       * A frame of the speakers' stream holding `sound`, its spotter hearing nothing and the recognizer reading nothing in it
       * (`whole`: in its first two samples too, which a hum's own values keep from reading as either tag).
       */
      const played = (sound: (k: number) => number, whole = false) => { const f = new Float32Array(512); for (let k = whole ? 0 : 2; k < 512; k++) f[k] = sound(k); return f; };

      it("takes a page's own “Ember, allow.” for theirs when a loud hum in its stream, which no speaker plays, blinds their spotter and the recognizer: no one's yes", () => {
        // Measured on the real models: a 50 to 300 Hz hum at 0.9 of full scale, the words 32 dB under it, made the stream's
        // spotter and the recognizer's reading of it miss, and the yes by name was the user's in 5 to 7 of 48 runs. (A
        // follow-up hears only a voice about as loud as the wake's: the words are as loud here.)
        for (const where of WHERE) for (const hz of [62.5, 187.5, 312.5]) {
          const s = waiting({ 5: "Ember, allow." }, where);
          videoOn(s);
          for (let i = 0; i < frames(900); i++) {
            const words = voice(i, 0.12, 0.7), late = voice(i - 2, 0.06, 0.7);
            // The room hears the words alone, half as loud and two frames late; the stream holds them under the hum.
            s.run(1, () => heardAs(5, i === 8 ? 1 : 0, i >= 2 ? late : () => 0), () => played(k => hum(hz)(k) + words(k), true));
          }
          s.run(frames(1500), () => mic(0, 0), () => played(hum(hz), true));
          expect(s.heard(), `${hz} Hz, ${where}`).toEqual([`Allow. | ${where} | over other sound`]);
        }
      });

      it("still takes the user's own “Ember, allow.” over music whose loudness their words don't follow", () => {
        for (const where of WHERE) {
          const s = waiting({ 5: "Ember, allow." }, where);
          videoOn(s);
          const music = (i: number) => voice(i, 0.02, 0.2, 625);
          for (let i = 0; i < frames(900); i++) {
            const mine = voice(i, 0.05, 1.3), late = music(i - 2);
            s.run(1, () => heardAs(5, i === 8 ? 1 : 0, k => mine(k) + late(k) / 2), () => played(music(i)));
          }
          for (let i = frames(900); i < frames(2400); i++) { const late = music(i - 2); s.run(1, () => heardAs(0, 0, k => late(k) / 2), () => played(music(i))); }
          expect(s.heard(), where).toEqual([`Allow. | ${where}`]);
        }
      });
    });

    it("takes the recognizer's “Ember, allow” for said by name without the spotter only where the speakers can't have said it, and a near word (“Member, yes.”) never without it", () => {
      for (const where of WHERE) {
        // The speakers' stream holds sound through the words (the video goes on): only the two spotters can tell whose
        // "Ember, allow" it is, and the microphone's heard no name.
        const over = waiting({ 5: "Ember, allow." }, where);
        videoOn(over);
        says(over, 5, 0, "user");
        expect(over.heard(), where).toEqual([`Allow. | ${where} | over other sound`]);
        // No such stream (macOS, Windows, Linux without parec): the spotter's hit says no more of who spoke than the
        // recognizer's "Ember" does, and it misses the name in a window that is already listening. As before.
        const unknown = waiting({ 5: "Ember, allow." }, where, { otherSound: null });
        says(unknown, 5, 0, "user");
        expect(unknown.heard(), where).toEqual([`Allow. | ${where}`]);
        const playing = waiting({ 5: "Ember, allow." }, where, { otherSound: true });
        says(playing, 5, 0, "user");
        expect(playing.heard(), where).toEqual([`Allow. | ${where}`]);
        // The transcript check was written as the second stage after the spotter, and is lenient: its near words are the
        // name only where the spotter heard it (V2-S3).
        const near = waiting({ 5: "Member, yes." }, where, { otherSound: null });
        says(near, 5, 0, "user");
        expect(near.heard(), where).toEqual([`Yes. | ${where} | over other sound | sound unknown`]);
        const nearOver = waiting({ 5: "Member, yes." }, where, { otherSound: true });
        says(nearOver, 5, 0, "user");
        expect(nearOver.heard(), where).toEqual([`Yes. | ${where} | over other sound`]);
        const spotted = waiting({ 5: "Member, yes." }, where, { otherSound: null });
        says(spotted, 5, 1, "user");
        expect(spotted.heard(), where).toEqual([`Yes. | ${where}`]);
      }
    });

    it("says when what it marked began with the name the recognizer wrote, which couldn't be told from the speakers, so the question doesn't ask for the name just said (voice-safety-x9-4)", () => {
      const doubted = (s: Scene) => s.events.flatMap(v => (v.type === "utterance" ? [v.nameDoubted === true] : []));
      for (const where of WHERE) {
        // Over a video that goes on, with no hit of the microphone's spotter: marked, its name doubted.
        const named = waiting({ 5: "Ember, allow." }, where);
        videoOn(named);
        says(named, 5, 0, "user");
        expect(named.heard(), where).toEqual([`Allow. | ${where} | over other sound`]);
        expect(doubted(named), where).toEqual([true]);
        // A nameless yes over it is marked as before, and no name is doubted.
        const nameless = waiting({ 5: "Okay." }, where);
        videoOn(nameless);
        says(nameless, 5, 0, "video", 0, 0);
        expect(nameless.heard(), where).toEqual([`Okay. | ${where} | over other sound`]);
        expect(doubted(nameless), where).toEqual([false]);
      }
    });

    it("takes a request the speakers said by name in a follow-up window or a conversation for theirs, never the user's own words", () => {
      // "Ember, delete the folder." out of a video, known to play: it went to Copilot, and on Linux with parec as the user's own words for commands.
      for (const where of ["follow-up", "conversation"] as const) {
        const s = waiting({ 5: "Ember, delete the folder." }, where);
        s.e.questionUp(false);
        videoOn(s);
        says(s, 5, 1, "video");
        expect(s.heard(), where).toEqual([`Delete the folder. | ${where} | over other sound`]);
        const mine = waiting({ 5: "Ember, delete the folder." }, where);
        mine.e.questionUp(false);
        videoOn(mine);
        says(mine, 5, 1, "user");
        expect(mine.heard(), where).toEqual([`Delete the folder. | ${where}`]);
      }
    });
  });

  describe("room talk in a question's answer window (V2-S3, voice-listening-r9-3)", () => {
    /** What the room says next (tag 6): sent too, once a conversation had opened. */
    const NEXT = "And then we can book the flights to Lisbon.";

    it("sends nothing of talk that never says the name, though the recognizer's words alone read as called by name: no wake, no request, no conversation", () => {
      // "(nothing else it hears then is sent)", the consent says of this window. The transcript check is the second stage
      // after the spotter, and lenient: without the spotter's own hit each of these left the window as a wake's request,
      // went to Copilot, and opened a conversation that sent the next sentence too.
      for (const words of ["A number of people called today.", "Number, can you believe it?", "Hey, number five is ready.", "Member, I told you.", "Amber, open the window please.", "Umber is a nice colour."]) {
        for (const otherSound of [null, false]) {
          const s = waiting({ 5: words, 6: NEXT }, "answer", { otherSound, conversations: true });
          says(s, 5, 0, "user");
          says(s, 6, 0, "user");
          expect(s.heard(), words).toEqual([]);
          expect(s.events.filter(v => v.type === "listening"), words).toEqual([]);
        }
      }
    });

    it("so for the name as the recognizer writes it, where the microphone's spotter heard none: a request leaves the window only as a wake would have it, by both stages", () => {
      const s = waiting({ 5: "Ember, open my mail.", 6: NEXT }, "answer", { otherSound: null, conversations: true });
      says(s, 5, 0, "user");
      says(s, 6, 0, "user");
      expect(s.heard()).toEqual([]);
      expect(s.events.filter(v => v.type === "listening")).toEqual([]);
    });

    it("still takes a request said by name in it as a wake's, where the spotter heard the name: “Ember, open my mail.”", () => {
      const s = waiting({ 5: "Ember, open my mail." }, "answer", { otherSound: null, conversations: true });
      says(s, 5, 1, "user");
      expect(s.heard()).toEqual(["wake", "Open my mail. | wake"]);
      // (A conversation opens after a wake's request, as ever.)
      expect(s.events.at(-1)).toEqual({ type: "listening", on: true, reason: "conversation", window: "conversation" });
    });

    it("never takes a request the speakers' own stream said by name in it (Linux with parec)", () => {
      const s = waiting({ 5: "Ember, open my mail." }, "answer", { speakers: true, conversations: true });
      videoOn(s);
      says(s, 5, 1, "video");
      expect(s.heard()).toEqual([]);
      expect(s.events.filter(v => v.type === "listening")).toEqual([]);
    });
  });

  describe("a nameless yes after a name was spotted (V2-S4)", () => {
    /**
     * A conversation over a video, a question up. The video says a sentence in which the spotter hears the name late
     * ("…September…", 1.44 s in), and `gap` ms after it a lone "Okay.".
     */
    const videoSays = (gap: number, o: { speakers?: boolean; otherSound?: boolean | null }) => {
      const s = waiting({ 5: "I remember the September weather was nice.", 6: "Okay." }, "conversation", o);
      videoOn(s);
      for (let i = 0; i < frames(1800); i++) s.run(1, () => mic(5, 0.03, i === 45 ? 1 : 0), () => out(0.05, i === 45 ? 1 : 0, 5));
      s.run(frames(gap));
      s.run(frames(400), () => mic(6, 0.03), () => out(0.05, 0, 6));
      s.run(frames(2000));
      return s.heard();
    };

    it("takes a video's “Okay.” for no one's yes in a conversation, whatever the spotter heard in the video's sentence before it (Windows: the output's level says other sound plays)", () => {
      // A name the spotter heard in the last 3 s lets what is said next through as said by name, and the "Okay." after the
      // video's "…September…" went out unmarked: anyone's yes. A yes is judged on its own speech now.
      for (const gap of [700, 900, 1200]) expect(videoSays(gap, { otherSound: true }).at(-1), `${gap} ms`).toBe("Okay. | conversation | over other sound");
    });

    it("so where the speakers' own stream says the video said that name: it never counts as the user's (Linux with parec)", () => {
      for (const gap of [700, 1200]) expect(videoSays(gap, { speakers: true }), `${gap} ms`).toEqual(["I remember the September weather was nice. | conversation | over other sound", "Okay. | conversation | over other sound"]);
    });
  });

  describe("a yes after “Hey Ember” and a pause (V2-S6, voice-listening-r9-4)", () => {
    /** A question is up and has been read out. The user says "Hey Ember." (the microphone only), and after a second `then` goes on. */
    const called = (o: { speakers?: boolean; otherSound?: boolean | null }, then: (s: Scene) => void, words: Record<number, string> = {}) => {
      const s = scene({ 9: "Hey Ember.", 5: "Okay.", 7: "Allow.", ...words }, o);
      s.run(100);
      asks(s);
      s.run(frames(600));
      s.events.length = 0;
      for (let i = 0; i < frames(600); i++) s.run(1, () => mic(9, 0.05, i === 8 ? 2 : 0));
      s.run(frames(1000));
      then(s);
      s.run(frames(2000));
      return s.heard();
    };
    /** A video's lone "Okay." (0.4 s): out of the speakers, in their stream where it arrives and in the microphone. */
    const videoOkay = (s: Scene) => s.run(frames(400), () => mic(5, 0.03), () => out(0.05, 0, 5));

    it("takes a video's “Okay.” then for no one's yes where other sound is known to play: the name was the user's, the yes wasn't said with it", () => {
      // The wake's own window marked nothing: with the video quiet before the wake, its "Okay." a second later allowed.
      expect(called({ speakers: true }, videoOkay), "Linux with parec").toEqual(["wake", "Okay. | wake | over other sound"]);
      expect(called({ otherSound: true }, videoOkay), "Windows").toEqual(["wake", "Okay. | wake | over other sound"]);
    });

    it("still takes “Hey Ember, allow” said in one breath over a playing video, and the two-breath answer where nothing can tell (macOS: it is how one answers there)", () => {
      // (Two words after the name: in a room with other talk before the wake, one alone is taken for the wake phrase misheard.)
      const oneBreath = (o: { speakers?: boolean; otherSound?: boolean | null }) => {
        const s = scene({ 6: "Hey Ember, allow it." }, o);
        s.run(100);
        asks(s);
        s.run(frames(600));
        videoOn(s);
        s.events.length = 0;
        for (let i = 0; i < frames(900); i++) s.run(1, () => mic(6, 0.05, i === 8 ? 2 : 0), () => out(0.05));
        s.run(frames(2000));
        return s.heard();
      };
      expect(oneBreath({ speakers: true }), "Linux with parec").toEqual(["wake", "Allow it. | wake"]);
      expect(oneBreath({ otherSound: true }), "Windows").toEqual(["wake", "Allow it. | wake"]);
      // "Hey Ember" … "allow", the user's own, where nothing can tell whether other sound plays: as before.
      expect(called({ otherSound: null }, s => s.run(frames(400), () => mic(7, 0.05))), "macOS").toEqual(["wake", "Allow. | wake"]);
      // And where sound is known not to play, from anyone.
      expect(called({ otherSound: false }, s => s.run(frames(400), () => mic(7, 0.05))), "quiet").toEqual(["wake", "Allow. | wake"]);
    });

    it("takes what the speakers say by name then for no one's yes either: a video's “Ember, okay.” after the user's “Hey Ember” and a pause (Linux with parec; V2-S2 and voice-listening-r9-2 in a wake's own window)", () => {
      // A wake's own window asked the speakers' stream nothing once it was open: the name in the video's "Ember, okay."
      // made it a yes said by name, where the same words in the answer window, a follow-up or a conversation are theirs.
      // Measured on the real models: taken 28 times in 40.
      const NAMED = { 8: "Ember, okay.", 6: "And then we can book the flights to Lisbon." };
      expect(called({ speakers: true }, s => says(s, 8, 1, "video"), NAMED), "both spotters heard the name").toEqual(["wake", "Okay. | wake | over other sound"]);
      // Their spotter missed it, and the recognizer reads the words in what their stream played.
      expect(called({ speakers: true }, s => says(s, 8, 1, "video", 0), NAMED), "their stream reads so").toEqual(["wake", "Okay. | wake | over other sound"]);
      // Neither spotter heard a name while their stream held sound: the recognizer's "Ember, …" alone is no name there.
      expect(called({ speakers: true }, s => says(s, 8, 0, "video", 0, 6), NAMED), "no spotter heard it").toEqual(["wake", "Okay. | wake | over other sound"]);
      // A no is anyone's, theirs too: declining is the safe side.
      expect(called({ speakers: true }, s => says(s, 8, 1, "video"), { 8: "Ember, not now." })).toEqual(["wake", "Not now. | wake"]);
    });

    it("still takes the user's own “Ember, okay.” then: over a video that says other words where the microphone's spotter heard the name, and as the recognizer wrote it where the speakers can't have said it", () => {
      const NAMED = { 8: "Ember, okay.", 6: "And then we can book the flights to Lisbon." };
      expect(called({ speakers: true }, s => says(s, 8, 1, "user", 0, 6), NAMED), "over a video's other words").toEqual(["wake", "Okay. | wake"]);
      // The speakers' stream silent through it (Linux with parec), or none (Windows with other sound playing, macOS).
      const mine = (s: Scene) => s.run(frames(900), () => mic(8, 0.05));
      expect(called({ speakers: true }, mine, NAMED), "a silent stream").toEqual(["wake", "Okay. | wake"]);
      expect(called({ otherSound: true }, mine, NAMED), "Windows").toEqual(["wake", "Okay. | wake"]);
      expect(called({ otherSound: null }, mine, NAMED), "macOS").toEqual(["wake", "Okay. | wake"]);
    });

    it("takes a video's own “Hey Ember, allow it.” from idle for no one's yes where its spotter missed the wake and the recognizer reads it in the speakers' stream (Linux with parec; V2-S2)", () => {
      // A wake is checked against the speakers' stream by the two spotters alone, and theirs misses a name now and then:
      // measured on the real models, a video's "Ember, go ahead." from idle was a wake and a yes by name twice in 96.
      const fromIdle = (by: "video" | "user") => {
        const s = scene({ 6: "Hey Ember, allow it.", 7: "And then we can book the flights to Lisbon." }, { speakers: true });
        s.run(100);
        asks(s);
        s.run(frames(9000));
        videoOn(s);
        s.events.length = 0;
        for (let i = 0; i < frames(900); i++) s.run(1, () => mic(6, by === "video" ? 0.03 : 0.05, i === 8 ? 2 : 0), () => out(0.05, 0, by === "video" ? 6 : 7));
        s.run(frames(2000));
        return s.heard();
      };
      expect(fromIdle("video")).toEqual(["wake", "Allow it. | wake | over other sound"]);
      // The user's own, over a video that says other words: taken, as before.
      expect(fromIdle("user")).toEqual(["wake", "Allow it. | wake"]);
    });
  });

  describe("a no said over other sound (V2-S7, voice-listening-r9-5)", () => {
    it("takes “No.”, “Not now.” and “Don't do it.” from anyone while other sound is known to play, in each window: a no is anyone's", () => {
      // The answer window and a conversation marked everything nameless over other sound, a no included, and the voice
      // gate dropped it; a follow-up took it. The question stayed up, open to the next yes.
      for (const where of WHERE) for (const words of ["No.", "Not now.", "Don't do it."]) {
        // Windows: the output's level says other sound plays.
        const windows = waiting({ 5: words }, where, { otherSound: true });
        says(windows, 5, 0, "user");
        expect(windows.heard(), `${words} in ${where}, Windows`).toEqual([`${words} | ${where}`]);
        // Linux with parec, a video known to play: the user's own no, and the video's (declining is the safe side).
        for (const by of ["user", "video"] as const) {
          const s = waiting({ 5: words }, where);
          videoOn(s);
          says(s, 5, 0, by);
          expect(s.heard(), `${words} in ${where}, the ${by}'s`).toEqual([`${words} | ${where}`]);
        }
      }
    });

    it("so for a no the speakers said by name, and a yes over other sound is still no one's", () => {
      for (const where of WHERE) {
        const named = waiting({ 5: "Ember, not now." }, where);
        videoOn(named);
        says(named, 5, 1, "video");
        expect(named.heard(), where).toEqual([`Not now. | ${where}`]);
        const yes = waiting({ 5: "Okay." }, where, { otherSound: true });
        says(yes, 5, 0, "user");
        expect(yes.heard(), where).toEqual([`Okay. | ${where} | over other sound`]);
      }
    });
  });

  describe("stop words in a question's answer window (V2-S8)", () => {
    it("stops on “Stop.” said there without the name, as the recognizer writes it too, and on nothing else the room says: “Never mind.” and “That's enough.” pulled the kill switch", () => {
      for (const words of ["Stop.", "Stop it.", "Stop everything.", "No, stop.", "Please stop.", "Step.", "Stuff."]) {
        const s = waiting({ 5: words }, "answer", { otherSound: false });
        says(s, 5, 0, "user");
        expect(s.heard(), words).toEqual(["stop"]);
      }
      // Other ways to say it are for Ember while it speaks or was just asked something; in this window Ember is silent
      // and listens to the room. A word or two that read as no answer make the question say how to answer, as ever.
      for (const words of ["Never mind.", "Cancel.", "Enough.", "That's enough.", "Quiet.", "Forget it.", "Shut up.", "Quite.", "Hush."]) {
        const s = waiting({ 5: words }, "answer", { otherSound: false });
        says(s, 5, 0, "user");
        expect(s.heard(), words).toEqual(["unclear"]);
        expect(s.e.listening, words).toBe(true);
      }
    });

    it("still stops on any of them said by name there, and without it in a follow-up window, as before", () => {
      for (const words of ["Ember, never mind.", "Ember, that's enough.", "Ember, cancel."]) {
        const s = waiting({ 5: words }, "answer", { otherSound: false });
        says(s, 5, 1, "user");
        expect(s.heard(), words).toEqual(["stop"]);
      }
      const followUp = waiting({ 5: "Never mind." }, "follow-up", { otherSound: false });
      says(followUp, 5, 0, "user");
      expect(followUp.heard()).toEqual(["stop"]);
    });
  });

  describe("a near-miss answer while a question waits (V2-F5, V2-F7; voice-listening-r9-9, voice-listening-r9-11)", () => {
    it("says once it didn't catch a few words that start like an answer, and sends nothing, in every window: they went to Copilot or vanished", () => {
      for (const words of ["Yes, but wait.", "No, hang on.", "Okay, hold on.", "Sure, why?", "Don't, wait.", "Not that one.", "Absolutely, sure, why not?"]) for (const where of WHERE) {
        const s = waiting({ 5: words }, where, { otherSound: false });
        says(s, 5, 0, "user");
        expect(s.heard(), `${words} in ${where}`).toEqual(["unclear"]);
      }
    });

    it("still sends a real short request said while a question waits, and longer talk, as before", () => {
      for (const words of ["Why?", "Which file?", "What email?"]) for (const where of ["follow-up", "conversation"] as const) {
        const s = waiting({ 5: words }, where, { otherSound: false });
        says(s, 5, 0, "user");
        expect(s.heard(), `${words} in ${where}`).toEqual([`${words} | ${where}`]);
      }
      const long = waiting({ 5: "No, open the other file instead please." }, "conversation", { otherSound: false });
      says(long, 5, 0, "user");
      expect(long.heard()).toEqual(["No, open the other file instead please. | conversation"]);
    });

    it("never takes a stop for a near-miss answer: “No, stop the task.” said while a question waits still reaches the stop, as before (voice-product-y9-1)", () => {
      // Main stops everything on these (stopRequest) while a task is at work; as near-misses they stopped nothing.
      for (const words of ["No, stop the task.", "No, stop typing.", "No, halt.", "Okay, stop working.", "No, cancel my task.", "No, stop all tasks.", "Okay, stop clicking."]) {
        expect(stopRequest(words), words).toBe(true);
        for (const where of ["follow-up", "conversation"] as const) {
          const s = waiting({ 5: words }, where, { otherSound: false });
          says(s, 5, 0, "user");
          expect(s.heard(), `${words} in ${where}`).toEqual([`${words} | ${where}`]);
        }
      }
      for (const words of ["No, stop it.", "No, stop.", "No, abort."]) for (const where of ["follow-up", "conversation"] as const) {
        const s = waiting({ 5: words }, where, { otherSound: false });
        says(s, 5, 0, "user");
        expect(s.heard(), `${words} in ${where}`).toEqual(["stop"]);
      }
    });

    it("still ends a conversation or a follow-up on “Okay, that's all.” said while a question waits, sending nothing (voice-product-x9-3)", () => {
      // The near-miss check ran before the closers: the window stayed open and the question got "I didn't catch that…".
      for (const words of ["Okay, that's all.", "No, that's all."]) for (const where of ["follow-up", "conversation"] as const) {
        const s = waiting({ 5: words }, where, { otherSound: false });
        says(s, 5, 0, "user");
        expect(s.heard(), `${words} in ${where}`).toEqual([]);
      }
    });

    it("never sends a yes asked as a question said by name as a request, nor at a wake (V2-F7)", () => {
      for (const where of WHERE) {
        const s = waiting({ 5: "Ember, okay?" }, where, { otherSound: false });
        says(s, 5, 1, "user");
        expect(s.heard().filter(h => h !== "wake"), where).toEqual(["unclear"]);
      }
    });

    it("takes “Okay, Ember.” said in the answer window as the yes it is, by name, rather than a wake that answers nothing (V2-F7)", () => {
      // The spotter hears "Okay, Ember" as its "Hey Ember" (2): a wake, which heard nothing after the name.
      const s = waiting({ 5: "Okay, Ember." }, "answer", { otherSound: false });
      says(s, 5, 2, "user");
      expect(s.heard().filter(h => h !== "wake")).toEqual(["Okay, Ember. | wake"]);
    });
  });
});
