/**
 * The bare name as a wake ("Ember, open the terminal"): the check that the name started what was said, and the
 * recognizer's guards (its repeat loop on short clips, and long requests cut into pieces it can take).
 */

import { describe, expect, it } from "vitest";
import { calledByName, stripWake } from "../../app/voice/engine";
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
  ])("doesn't take %j", t => expect(calledByName(t)).toBe(false));

  it("leaves the request once the name is stripped", () => {
    expect(stripWake("Ember, turn on night light.", true)).toBe("Turn on night light.");
    expect(stripWake("Okay. Ember, open the terminal.", true)).toBe("Open the terminal.");
  });
});

describe("withoutRepeats", () => {
  it("takes out the recognizer's repeat loop, with its cut-off end", () => {
    expect(withoutRepeats("pay embers pay embers pay embers pay em")).toBe("pay embers");
    expect(withoutRepeats("Stop stop stop stop stop")).toBe("Stop");
  });

  it("keeps what people say twice, and ordinary sentences", () => {
    expect(withoutRepeats("very, very good")).toBe("very, very good");
    expect(withoutRepeats("Turn on Night Light and turn on Do Not Disturb too.")).toBe("Turn on Night Light and turn on Do Not Disturb too.");
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
