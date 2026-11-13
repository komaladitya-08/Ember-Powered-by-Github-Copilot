/**
 * The bare name as a wake ("Ember, open the terminal"): the check that the name started what was said, and the
 * recognizer's guards (its repeat loop on short clips, and long requests cut into pieces it can take).
 */

import { describe, expect, it } from "vitest";
import { calledByName, saidWakeItself, stripWake } from "../../app/voice/engine";
import { recognizerPieces, withoutRepeats } from "../../app/voice/sherpa";

describe("calledByName", () => {
  it.each([
    "Ember, turn on night light.",
    "Ember turn on night light",
    "Ember?",
    "Ember.",
    "Um, Ember, what time is it?",
    "Okay. Ember, open the terminal.",
    "Lunch was great. Ember, set a timer.",
    "Emmer, stop.",
    "Pay Ember, open the terminal.",
    "Peyember.",
    "Umber, open the terminal.",
  ])("takes %j for Ember called by name", t => expect(calledByName(t)).toBe(true));

  it.each([
    "The embers in the fireplace were still glowing.",
    "I remember the September weather was nice.",
    "Tell Ember's team about it.",
    "Hey Amber, what time is it?",
    "We sat by the ember all night.",
    "Number, the September weather was nice.",
    "Number to call Amber.",
    "",
    // Others' names, and words near the name, as Moonshine wrote them for 33 synthesized voices' near misses.
    "Amber, dinner is ready.",
    "Amber dinner is ready.",
    "Emma, dinner is ready.",
    "No member, I think.",
    "Members only, please.",
    "Member, remember to call mum.",
    "Number.",
    // Sentences that start with "Member" (review of PR #144).
    "Member of staff, please call me back.",
    "Member services, how can I help?",
    "Member since 2019.",
    "Member states agreed on Tuesday.",
    "Member login is down.",
    "Member what time is it?",
  ])("doesn't take %j", t => expect(calledByName(t)).toBe(false));

  // How Moonshine wrote a lone "Ember." or "Ember?", and "Ember, what time is it?", for voices it didn't write the name for
  // (the bare name didn't wake Ember on Windows).
  it.each(["Member.", "Member?", "Embra.", "Embro.", "Member, open Notepad.", "Member, what time is it?"])("takes %j, a spelling of the name that isn't a name, said first", t => {
    expect(calledByName(t)).toBe(true);
  });

  // "Number" for the name after a greeting (a real laptop's microphone, 2026-11-05), only where the words go on as to
  // Ember: the wake phrase's own end, or a request's first word. "A number of people…" is the room's talk (CI's voice
  // step on RHEL 8 took it for a wake, voice-roomtalk-1).
  it.each(["Hey, number.", "A number.", "A number. What time is it?", "Hey number, what time is it?", "Hey a number, open the calculator.", "Number open the calculator"])("takes %j, the name written as a word, by how the words go on", t => {
    expect(calledByName(t)).toBe(true);
  });
  it.each(["A number of people called today.", "Hey, number five is ready.", "A number, of course, called.", "A number of us can open the door.", "Hi, number crunching is my job."])("doesn't take %j: “number” goes on as a word (voice-roomtalk-1)", t => {
    expect(calledByName(t)).toBe(false);
    // …and nothing is taken out of it where a wake's first words are stripped (a conversation sent "Of people called
    // today."). ("Hey" and the word after it still go, as the wake phrase misheard: "Hey, ever, turn on…".)
    if (t.startsWith("A ")) expect(stripWake(t, true)).toBe(t);
  });

  it("leaves the request once the name is stripped", () => {
    expect(stripWake("Ember, turn on night light.", true)).toBe("Turn on night light.");
    expect(stripWake("Okay. Ember, open the terminal.", true)).toBe("Open the terminal.");
    expect(stripWake("Member, what time is it?", true)).toBe("What time is it?");
    // Ember's own possessive isn't the name said: "Ember's own…" never becomes "'s own…".
    expect(stripWake("Ember's own next sentence.", true)).toBe("Ember's own next sentence.");
    expect(stripWake("Embra.", true)).toBe("");
  });
});

describe("saidWakeItself (what “Hey Ember” spotted in a question's answer window must be written as; voice-roomtalk-1)", () => {
  it.each(["Hey, Ember, what time is it?", "Hey ember, what time is it?", "Ok ember turn on night light", "K ember turn on night light", "Lunch. Hey Ember, open my mail.", "Ember, open my mail.", "Hey ember", "K-embler.", "K-emer", "He ember"])("takes %j", t => {
    expect(saidWakeItself(t)).toBe(true);
  });
  it.each(["Number, can you pass the salt?", "A number. What time is it?", "Hey Amber, what time is it?", "Hey, number.", "Member, open Notepad.", "Hey, remember.", "Umber, open the terminal.", "What time is it?", "And then we can book the flights to Lisbon.", "He remembers.", "Okay, embers.", ""])("doesn't take %j: the room's talk, or a near word", t => {
    expect(saidWakeItself(t)).toBe(false);
  });
});

describe("withoutRepeats", () => {
  it("takes out the recognizer's repeat loop, with its cut-off end", () => {
    expect(withoutRepeats("pay embers pay embers pay embers pay em")).toBe("pay embers");
    expect(withoutRepeats("Stop stop stop stop stop")).toBe("Stop");
    expect(withoutRepeats("Open settings. Open settings.")).toBe("Open settings.");
  });

  it("keeps what people say twice, and ordinary sentences", () => {
    expect(withoutRepeats("very, very good")).toBe("very, very good");
    expect(withoutRepeats("Turn on Night Light and turn on Do Not Disturb too.")).toBe("Turn on Night Light and turn on Do Not Disturb too.");
  });

  it.each(["Find the New York, New York office.", "Find the New York New York office.", "Write go team go team in the note."])(
    "keeps an intentional phrase repeated inside a request: %s", text => expect(withoutRepeats(text)).toBe(text),
  );

  it.each([
    "Write ha ha ha in the note.", "Right go team go team go team in the note.", "Say no no no.",
    "Type five five five.", "The code is five five five.", "The extension is 2 2 2.",
    "Search for twenty-five twenty-five twenty-five.", "Find the second second second entry.",
    "Open the folder called hey hey hey.",
  ])("preserves dictated repeats and quantities: %s", text => expect(withoutRepeats(text)).toBe(text));

  it("still removes loops during keyword verification, including words used in dictation", () => {
    expect(withoutRepeats("Ember stop. Ember stop. Ember stop.", "keyword")).toBe("Ember stop.");
    expect(withoutRepeats("say say say say", "keyword")).toBe("say");
  });

  it("still removes a whole sentence loop when it happens to contain a quantity", () => {
    expect(withoutRepeats("Set a timer for 15 minutes. Set a timer for 15 minutes. Set a timer for 1")).toBe("Set a timer for 15 minutes.");
    expect(withoutRepeats("Set up a call with Kofi set up a call with Kofi set up")).toBe("Set up a call with Kofi");
  });
});

describe("recognizerPieces", () => {
  it("keeps a request of up to 7 s whole", () => {
    const s = new Float32Array(7 * 16000);
    expect(recognizerPieces(s)).toHaveLength(1);
  });

  it("cuts a long one at its quietest moment between 4 and 7 s in, and loses nothing", () => {
    const s = new Float32Array(15 * 16000).map((_, i) => Math.sin(i / 3) * 0.3);
    s.fill(0, Math.round(5.5 * 16000), Math.round(5.7 * 16000)); // a pause at 5.5 s
    const pieces = recognizerPieces(s);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every(p => p.length <= 7 * 16000)).toBe(true);
    expect(pieces[0].length / 16000).toBeGreaterThan(5.5);
    expect(pieces[0].length / 16000).toBeLessThan(5.7);
    expect(pieces.reduce((n, p) => n + p.length, 0)).toBe(s.length);
  });
});
