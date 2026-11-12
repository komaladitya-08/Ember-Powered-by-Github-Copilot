import { describe, expect, it } from "vitest";
import { CONVERSATION_IDLE_MS, VoiceEngine, endsConversation, nameOnItsOwn, spokenByEmber, type VoiceBackend, type VoiceEvent } from "../../app/voice/engine";
import { VoiceGate, type Printer } from "../../app/voice/match";

/**
 * A conversation (engine.ts CONVERSATION_IDLE_MS; owner report of 2026-11-05): the microphone stays open after a request,
 * Ember can be talked over, and Voice Match no longer decides who is heard. A scripted backend: frame tag 1 is the wake
 * word, and a frame's level is its speech (see say()).
 */
function fake(transcripts: string[]) {
  let speaking = false;
  let segment: number[] = [];
  const b: VoiceBackend = {
    spot: f => (f[0] === 1 ? ["hey_ember"] : []),
    vad(f) {
      if (f[1] > 0) { speaking = true; segment.push(...f); return []; }
      if (speaking) { speaking = false; const s = Float32Array.from(segment); segment = []; return [s]; }
      return [];
    },
    speaking: () => speaking,
    speechSoFar: () => (speaking ? Float32Array.from(segment) : null),
    flushVad: () => [],
    resetVad: () => { speaking = false; segment = []; },
    transcribe: () => transcripts.shift() ?? "",
  };
  return b;
}

const frame = (level: number, tag = 0) => { const f = new Float32Array(512).fill(level); f[0] = tag; return f; };

function setup(transcripts: string[], o: { conversation?: boolean } = { conversation: true }) {
  const events: VoiceEvent[] = [];
  const clock = { t: 1000 };
  const e = new VoiceEngine(fake(transcripts), ev => events.push(ev), { now: () => clock.t, verifyWake: false, rejectWindowMs: 0, ...o });
  const feed = (f: Float32Array) => { clock.t += 32; e.feed(f); };
  const say = (frames: number, level = 0.2) => { for (let i = 0; i < frames; i++) feed(frame(level)); };
  const quiet = (frames: number) => { for (let i = 0; i < frames; i++) feed(frame(0)); };
  const wake = () => { feed(frame(0, 1)); quiet(2); };
  const utterances = () => events.filter((v): v is Extract<VoiceEvent, { type: "utterance" }> => v.type === "utterance");
  return { e, events, clock, feed, say, quiet, wake, utterances };
}

describe("a conversation", () => {
  it("stays open after a wake's request: what is said next needs no name and no new window", () => {
    const c = setup(["Open the calculator.", "And make it bigger."]);
    c.wake();
    c.say(20); c.quiet(2);
    expect(c.utterances().map(u => u.window)).toEqual(["wake"]);
    expect(c.events).toContainEqual({ type: "listening", on: true, reason: "conversation", window: "conversation" });
    c.say(20); c.quiet(2);
    expect(c.utterances().map(u => [u.text, u.window])).toEqual([["Open the calculator.", "wake"], ["And make it bigger.", "conversation"]]);
    expect(c.e.listening).toBe(true);
  });

  it("has no limit on turns (three follow-ups used to need “Hey Ember” again, owner report of 2026-11-05)", () => {
    const c = setup(["One.", "Two please.", "Three please.", "Four please.", "Five please.", "Six please."]);
    c.wake();
    for (let i = 0; i < 6; i++) { c.say(20); c.quiet(2); }
    expect(c.utterances()).toHaveLength(6);
    expect(c.e.listening).toBe(true);
  });

  it("hears a voice much softer than the one that woke it (speech dropped for loudness, log of 2026-11-04 20:26:16)", () => {
    const c = setup(["Open the calculator.", "Thanks for that but use the other one."]);
    c.wake();
    c.say(20, 0.3); c.quiet(2);
    c.say(20, 0.02); c.quiet(2);
    expect(c.utterances().map(u => u.text)).toContain("Thanks for that but use the other one.");
  });

  it("doesn't open when conversations are off: the follow-up window stays as it was", () => {
    const c = setup(["Open the calculator."], { conversation: false });
    c.wake();
    c.say(20); c.quiet(2);
    expect(c.e.listening).toBe(false);
    expect(c.events.some(v => v.type === "listening" && v.window === "conversation")).toBe(false);
    expect(c.events.at(-1)).toEqual({ type: "listening", on: false, reason: "done", window: "wake" });
  });

  it("says as the wake's window ends that the conversation opens next, so main never shows Ember stopped listening in between (voice-listening-c3-1)", () => {
    // Settings' voice line and Listen once's line said "Listening for “Ember”" and back in the same millisecond, and a
    // screen reader saying them was heard as the next request ("Is already listening.").
    const c = setup(["Open the calculator."]);
    c.wake();
    c.say(20); c.quiet(2);
    const ends = c.events.findIndex(v => v.type === "listening" && !v.on);
    expect(c.events.slice(ends)).toEqual([
      { type: "listening", on: false, reason: "done", window: "wake", next: "conversation" },
      { type: "listening", on: true, reason: "conversation", window: "conversation" },
    ]);
  });

  it("ends a conversation when it is turned off, and says so", () => {
    const c = setup(["Open the calculator."]);
    c.wake();
    c.say(20); c.quiet(2);
    c.e.conversation(false);
    expect(c.events.at(-1)).toEqual({ type: "listening", on: false, reason: "timeout", window: "conversation" });
  });

  it("goes quiet after its idle time, and not while a reply or a task is at work", () => {
    const c = setup(["Open the calculator."]);
    c.wake();
    c.say(20); c.quiet(2);
    c.e.conversationBusy(true);
    c.clock.t += CONVERSATION_IDLE_MS * 3;
    c.quiet(2);
    expect(c.e.listening).toBe(true);
    c.e.conversationBusy(false);
    c.clock.t += CONVERSATION_IDLE_MS - 1000;
    c.quiet(2);
    expect(c.e.listening).toBe(true);
    c.clock.t += 2000;
    c.quiet(2);
    expect(c.e.listening).toBe(false);
    expect(c.events.at(-1)).toEqual({ type: "listening", on: false, reason: "timeout", window: "conversation" });
  });

  it("ends on “That's all”, and sends nothing of it", () => {
    const c = setup(["Open the calculator.", "That's all, thanks."]);
    c.wake();
    c.say(20); c.quiet(2);
    c.say(20); c.quiet(2);
    expect(c.utterances()).toHaveLength(1);
    expect(c.e.listening).toBe(false);
  });

  it("drops a “Thanks.” (nothing to answer) and goes on listening for more", () => {
    const c = setup(["Open the calculator.", "Thanks.", "Now close it please."]);
    c.wake();
    c.say(20); c.quiet(2);
    c.say(20); c.quiet(2);
    c.say(20); c.quiet(2);
    expect(c.utterances().map(u => u.text)).toEqual(["Open the calculator.", "Now close it please."]);
    expect(c.e.listening).toBe(true);
  });

  it("sends an “Okay.” or “That's fine.” while one of Ember's questions is up, so it answers it (owner's report of 2026-11-12)", () => {
    const c = setup(["Open the calculator.", "Okay.", "That's fine.", "Thanks."]);
    c.wake();
    c.say(20); c.quiet(2);
    c.e.questionUp(true);
    for (let i = 0; i < 3; i++) { c.say(20); c.quiet(2); }
    expect(c.utterances().map(u => u.text)).toEqual(["Open the calculator.", "Okay.", "That's fine."]);
    expect(c.e.listening).toBe(true);
  });

  it("keeps a short command said after the name (review of #180)", () => {
    const c = setup(["Open the calculator.", "Ember, close it.", "Ember, allow."]);
    c.wake();
    c.say(20); c.quiet(2);
    for (let i = 0; i < 2; i++) { c.feed(frame(0.2, 1)); c.say(20); c.quiet(2); }
    expect(c.utterances().map(u => u.text)).toEqual(["Open the calculator.", "Close it.", "Allow."]);
  });

  it("sends nothing of the name said alone, however the recognizer wrote it", () => {
    const c = setup(["Open the calculator.", "Number.", "Andber.", "Day number."]);
    c.wake();
    c.say(20); c.quiet(2);
    for (let i = 0; i < 3; i++) { c.feed(frame(0.2, 1)); c.say(20); c.quiet(2); }
    expect(c.utterances()).toHaveLength(1);
    expect(c.e.listening).toBe(true);
  });

  it("takes the name off a request that still says it", () => {
    const c = setup(["Open the calculator.", "Hey Ember, close it please."]);
    c.wake();
    c.say(20); c.quiet(2);
    c.say(20); c.quiet(2);
    expect(c.utterances()[1].text).toBe("Close it please.");
  });

  it("sends a stop as a stop", () => {
    const c = setup(["Open the calculator.", "Stop."]);
    c.wake();
    c.say(20); c.quiet(2);
    c.say(20); c.quiet(2);
    expect(c.events).toContainEqual({ type: "stop" });
    expect(c.e.listening).toBe(false);
  });
});

describe("talking over Ember in a conversation", () => {
  const talking = (transcripts: string[], said = "The weather in Delhi is sunny with a high of thirty degrees.") => {
    const c = setup(["Open the calculator.", ...transcripts]);
    c.wake();
    c.say(20); c.quiet(2);
    c.e.selfWords(said);
    c.e.selfSpeaking(true);
    return c;
  };

  it("hushes Ember as soon as the words aren't its own, before the user has finished, and sends the whole of it", () => {
    const c = talking(["Wait, I meant", "Wait, I meant Mumbai instead."]);
    c.say(14);
    expect(c.events.filter(v => v.type === "cut-in")).toHaveLength(1);
    expect(c.utterances()).toHaveLength(1);
    c.say(20); c.quiet(2);
    expect(c.utterances()[1]).toMatchObject({ text: "Wait, I meant Mumbai instead.", window: "conversation", overEmber: true });
    expect(c.events.filter(v => v.type === "cut-in")).toHaveLength(1);
  });

  it("doesn't take its own voice for the user: nothing stops, and nothing is sent", () => {
    const c = talking(["The weather in Delhi is", "The weather in Delhi is sunny with a high", "The weather in Delhi is sunny with a high of thirty degrees."]);
    c.say(40); c.quiet(2);
    expect(c.events.some(v => v.type === "cut-in")).toBe(false);
    expect(c.utterances()).toHaveLength(1);
  });

  it("takes a recognizer's slip in its own words for its own voice", () => {
    const c = talking(["The wether in Dehli is sunny"]);
    c.say(14); c.quiet(2);
    expect(c.events.some(v => v.type === "cut-in")).toBe(false);
    expect(c.utterances()).toHaveLength(1);
  });

  it("wants speech louder than the echo it has found on this computer", () => {
    const c = talking(["The weather in Delhi is sunny", "Something else entirely please"]);
    c.say(14, 0.2); c.quiet(2);
    c.say(14, 0.2); c.quiet(2);
    expect(c.events.some(v => v.type === "cut-in")).toBe(false);
    c.say(14, 0.5);
  });

  it("goes on speaking over a “yeah” or an “mm-hmm”", () => {
    const c = talking(["Mm-hmm.", "Yeah."]);
    c.say(5); c.quiet(2);
    c.say(5); c.quiet(2);
    expect(c.events.some(v => v.type === "cut-in")).toBe(false);
    expect(c.utterances()).toHaveLength(1);
  });

  it("stops for a “Yes.” or an “Okay.” said over it while one of its questions is up, and sends it as said over its voice, which never answers (owner's report of 2026-11-12)", () => {
    for (const said of ["Yes.", "Okay.", "Sure.", "Yeah."]) {
      const c = talking([said]);
      c.e.questionUp(true);
      c.say(5); c.quiet(2);
      expect(c.events.filter(v => v.type === "cut-in"), said).toHaveLength(1);
      expect(c.utterances()[1], said).toMatchObject({ text: said, window: "conversation", overEmber: true });
    }
    // “Mm-hmm.” is no answer: Ember goes on speaking over it, question or not.
    const mm = talking(["Mm-hmm."]);
    mm.e.questionUp(true);
    mm.say(5); mm.quiet(2);
    expect(mm.events.some(v => v.type === "cut-in")).toBe(false);
    expect(mm.utterances()).toHaveLength(1);
  });

  it("drops Ember's voice the moment anything is heard over it, and brings it back when that was nothing", () => {
    const c = talking(["Mm-hmm."]);
    c.say(5);
    expect(c.events).toContainEqual({ type: "duck", on: true });
    c.quiet(2);
    expect(c.events.at(-1)).toEqual({ type: "duck", on: false });
  });

  it("is stopped by a short word that ended before the first check", () => {
    const c = talking(["Wait."]);
    c.say(5); c.quiet(2);
    expect(c.events.filter(v => v.type === "cut-in")).toHaveLength(1);
    expect(c.utterances()[1]).toMatchObject({ text: "Wait.", overEmber: true });
  });

  it("hears on after Ember has stopped, with nothing heard then marked as over its voice", () => {
    const c = talking([]);
    c.e.selfSpeaking(false);
    c.clock.t += 1000;
    const heard: string[] = [];
    (c.e as unknown as { backend: VoiceBackend }).backend.transcribe = () => { heard.push("x"); return "Open my mail please."; };
    c.say(20); c.quiet(2);
    expect(heard.length).toBeGreaterThan(0);
    expect(c.utterances()[1].overEmber).toBeUndefined();
  });
});

describe("a conversation with other sound playing (a song Ember was asked to play)", () => {
  it("takes nothing the speakers' words say for the user", () => {
    const c = setup(["Open the calculator.", "I've been dancing in the moonlight all night."]);
    c.wake();
    c.say(20); c.quiet(2);
    c.e.otherSound(true);
    c.say(20); c.quiet(2);
    // The voice gate decides it (match.ts): a song is not the owner, and with no voiceprint nothing marked so is heard.
    expect(c.utterances().at(-1)).toMatchObject({ overSound: true });
    expect(c.e.listening).toBe(true);
  });

  it("hears a request said to it by name", () => {
    const c = setup(["Open the calculator.", "Ember, turn the volume down please."]);
    c.wake();
    c.say(20); c.quiet(2);
    c.e.otherSound(true);
    c.say(20); c.quiet(2);
    expect(c.utterances()[1].text).toBe("Turn the volume down please.");
  });

  it("isn't interrupted by them while it speaks", () => {
    const c = setup(["Open the calculator.", "Dancing in the moonlight tonight", "Dancing in the moonlight tonight"]);
    c.wake();
    c.say(20); c.quiet(2);
    c.e.otherSound(true);
    c.e.selfWords("The weather is sunny.");
    c.e.selfSpeaking(true);
    c.say(30); c.quiet(2);
    expect(c.events.some(v => v.type === "cut-in" || v.type === "duck")).toBe(false);
  });

  it("hears everyone again once the sound stops", () => {
    const c = setup(["Open the calculator.", "Now close it please."]);
    c.wake();
    c.say(20); c.quiet(2);
    c.e.otherSound(true);
    c.e.otherSound(false);
    c.say(20); c.quiet(2);
    expect(c.utterances()).toHaveLength(2);
  });
});

describe("spokenByEmber", () => {
  const said = "I opened the quarterly report in Writer".toLowerCase().split(" ");
  it("is its own voice when most of what was heard is what it says", () => {
    expect(spokenByEmber("opened the quarterly report", said)).toBe(true);
    expect(spokenByEmber("I opend the quarterly", said)).toBe(true);
  });
  it("isn't when the user says other things, even with common words among them", () => {
    expect(spokenByEmber("no the other report", said)).toBe(false);
    expect(spokenByEmber("wait stop that", said)).toBe(false);
  });
  it("is nobody's when nothing was heard, or Ember said nothing", () => {
    expect(spokenByEmber("", said)).toBe(false);
    expect(spokenByEmber("the report", [])).toBe(false);
  });
});

describe("endsConversation", () => {
  it.each(["That's all.", "That's all for now.", "Okay, thanks, that's all.", "Bye.", "Goodbye.", "Stop listening.", "I'm done.", "Thanks, bye."])("ends on “%s”", t => {
    expect(endsConversation(t)).toBe(true);
  });
  it.each(["That's all I need from the report, now print it.", "Say goodbye to the team in my email.", "Open the calculator.", "Thanks."])("goes on after “%s”", t => {
    expect(endsConversation(t)).toBe(false);
  });
});

describe("which recognizer writes what (Hear me more clearly)", () => {
  it("has the request itself written by the one for requests, and the quick checks by the other", () => {
    const asked: (string | undefined)[] = [];
    const b = fake(["Open the calculator."]);
    const inner = b.transcribe.bind(b);
    b.transcribe = (s, purpose) => { asked.push(purpose); return inner(s, purpose); };
    const clock = { t: 1000 };
    const e = new VoiceEngine(b, () => undefined, { now: () => clock.t, verifyWake: false, rejectWindowMs: 0 });
    const feed = (f: Float32Array) => { clock.t += 32; e.feed(f); };
    feed(frame(0, 1));
    for (let i = 0; i < 20; i++) feed(frame(0.2));
    for (let i = 0; i < 2; i++) feed(frame(0));
    expect(asked).toContain("request");
  });
});

describe("“Hey Ember” written as “Hey Amber” (Moonshine base)", () => {
  /** A wake checked by what the recognizer makes of it: first the check's few words, then the whole. */
  const hear = (check: string, whole: string) => {
    const said = [check, whole];
    const events: VoiceEvent[] = [];
    const clock = { t: 1000 };
    const e = new VoiceEngine(fake(said), ev => events.push(ev), { now: () => clock.t, rejectWindowMs: 0, checkAfterMs: 0 });
    const feed = (f: Float32Array) => { clock.t += 32; e.feed(f); };
    feed(frame(0, 1));
    for (let i = 0; i < 2; i++) feed(frame(0));
    for (let i = 0; i < 20; i++) feed(frame(0.2));
    for (let i = 0; i < 2; i++) feed(frame(0));
    return events;
  };

  it("doesn't take a real wake back on the first words alone", () => {
    const events = hear("Pay amber to", "Pay amber, turn on night light.");
    expect(events.some(v => v.type === "rejected")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "utterance", text: "Turn on night light." }));
  });

  it("still takes back someone talking to an Amber, on all they said", () => {
    const events = hear("Hey amber din", "Hey Amber, dinner's ready.");
    expect(events.some(v => v.type === "rejected" && v.reason === "check")).toBe(true);
    expect(events.some(v => v.type === "utterance")).toBe(false);
  });
});

describe("the bare name said on its own (9 real “Ember”s taken back in one evening's log)", () => {
  it("is the name in a short segment of up to two words, or none the recognizer made out", () => {
    for (const heard of ["", "Emperor.", "I'm there.", "Amber."]) expect(nameOnItsOwn(heard, 16_000)).toBe(true);
  });
  it("isn't a longer phrase, or a long segment", () => {
    expect(nameOnItsOwn("I remember when we went", 16_000)).toBe(false);
    expect(nameOnItsOwn("Emperor.", 40_000)).toBe(false);
  });
});

describe("Voice Match never decides who is heard (owner decision of 2026-11-05)", () => {
  const unit = (v: number[]) => { const n = Math.hypot(...v); return Float32Array.from(v.map(x => x / n)); };
  const owner = unit([1, 0]);
  const printer: Printer = { print: async s => unit([s[0], s[1]]) };
  const said: VoiceEvent = { type: "utterance", text: "Open the calculator.", ms: 10, window: "wake" };
  const flush = () => new Promise(r => setTimeout(r, 0));

  it("hears a voice unlike the owner's, vouched for by nobody, after saying so", async () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => printer, e => sent.push(e), () => undefined);
    g.setOwner(owner);
    g.event(said, Float32Array.from([0, 1]));
    await flush();
    expect(sent).toEqual([{ type: "rejected", keyword: "", reason: "voice", score: 0 }, said]);
  });

  it("never ends a window or holds a wake", () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => printer, e => sent.push(e), () => undefined);
    g.setOwner(owner);
    g.event({ type: "wake", keyword: "hey_ember" }, null);
    expect(sent).toEqual([{ type: "wake", keyword: "hey_ember" }]);
  });

  it("vouches for nothing said over Ember's voice, however close it sounds", async () => {
    const sent: VoiceEvent[] = [];
    const g = new VoiceGate(() => printer, e => sent.push(e), () => undefined);
    g.setOwner(owner);
    const over: VoiceEvent = { ...said, window: "conversation", overEmber: true } as VoiceEvent;
    g.event(over, new Float32Array(32_000).fill(0.2));
    await flush();
    expect(sent).toEqual([over]);
  });
});
