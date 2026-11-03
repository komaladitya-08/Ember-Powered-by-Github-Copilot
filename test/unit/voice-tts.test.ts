/**
 * Ember's own voice: how a reply is cut into pieces to speak (the first one short, so it starts soon), how a streamed
 * answer becomes sentences as they complete (never inside code or a table, never twice), the page's player (gapless,
 * says when it speaks and when it's done, a hush stops it), and the system voice chosen when Ember's isn't there.
 */

import { describe, expect, it, vi } from "vitest";
import { NATURAL_RECHECK_MS, REST_IN_BUBBLE, SPOKEN_MAX, SpeechStream, rememberedSlow, slowVerdict, speechChunks } from "../../app/voice/tts";
import { Player, type PlayerAudio, type PlayerSource, playerAudio } from "../../app/renderer/mic/player";

describe("the natural voice's too-slow verdict", () => {
  it("holds for a week, then lets Kokoro be timed again", () => {
    const at = 1_800_000_000_000;
    const verdict = slowVerdict(0.598, at);
    expect(rememberedSlow(verdict, at)).toBe(0.598);
    expect(rememberedSlow(verdict, at + NATURAL_RECHECK_MS - 1)).toBe(0.598);
    expect(rememberedSlow(verdict, at + NATURAL_RECHECK_MS)).toBeNull();
  });

  it("ignores missing, damaged, fast and future-dated verdicts", () => {
    for (const value of [undefined, "cpu", "slow:abc:1", "slow:Infinity:1", `slow:${"9".repeat(400)}:1`, "slow:0.5:1", slowVerdict(0.7, 5000)]) {
      expect(rememberedSlow(value, 1000), value).toBeNull();
    }
  });
});

describe("SpeechStream with a long answer", () => {
  const sentence = (i: number) => `This is sentence number ${i} of a long answer that goes on.`;
  it("says no more than SPOKEN_MAX of it, ending at a sentence, then that the rest is in the bubble, once", () => {
    const s = new SpeechStream();
    const said = Array.from({ length: 30 }, (_, i) => s.push(`${sentence(i)} `)).flat();
    const rest = s.finish(Array.from({ length: 30 }, (_, i) => sentence(i)).join(" "));
    const all = [...said, ...rest];
    expect(all.at(-1)!.endsWith(REST_IN_BUBBLE)).toBe(true);
    expect(all.filter(x => x.includes(REST_IN_BUBBLE))).toHaveLength(1);
    expect(all.join(" ").length).toBeLessThanOrEqual(SPOKEN_MAX + REST_IN_BUBBLE.length + 2);
    expect(all.join(" ")).toContain(sentence(0));
  });

  it("cuts an answer given whole at its last sentence that fits", () => {
    const text = Array.from({ length: 30 }, (_, i) => sentence(i)).join(" ");
    const [said] = new SpeechStream().finish(text);
    expect(said).toMatch(/goes on\. The rest is in the bubble\.$/);
    expect(said.length).toBeLessThanOrEqual(SPOKEN_MAX + REST_IN_BUBBLE.length + 1);
  });

  it("still says the answer's closing question past the cap, as the follow-up window waits for its reply (review of #143)", () => {
    const body = Array.from({ length: 30 }, (_, i) => sentence(i)).join(" ");
    const s = new SpeechStream();
    const said = [...s.push(`${body} `), ...s.push("Which of them shall I open? ")];
    const all = [...said, ...s.finish(`${body} Which of them shall I open?`)];
    expect(all.at(-1)).toBe("Which of them shall I open?");
    expect(all.filter(x => x.includes(REST_IN_BUBBLE))).toHaveLength(1);
    // Given whole, too; and an answer that ends without a question says only the note at the end.
    expect(new SpeechStream().finish(`${body} Shall I go on?`).at(-1)).toBe("Shall I go on?");
    expect(new SpeechStream().finish(`${body} Is that it? That's all.`).at(-1)).toMatch(/The rest is in the bubble\.$/);
  });

  it("says a short answer whole, and starts afresh for the next answer", () => {
    const s = new SpeechStream(60);
    expect(s.finish("Night Light is on.")).toEqual(["Night Light is on."]);
    expect(s.finish("x ".repeat(20) + "and that is a very long first sentence without an end")).toEqual([expect.stringMatching(/…\s+The rest is in the bubble\.$/)]);
    expect(s.finish("Done.")).toEqual(["Done."]);
  });
});
import { bestVoice } from "../../app/renderer/mic/voices";

describe("speechChunks", () => {
  it("says a reply sentence by sentence", () => {
    expect(speechChunks("Night Light is on. I also turned on Do Not Disturb! Anything else?")).toEqual(["Night Light is on.", "I also turned on Do Not Disturb!", "Anything else?"]);
  });

  it("starts a long first sentence with its first clause, so the sound comes sooner", () => {
    const [first, ...rest] = speechChunks("I opened the terminal in your project folder, ran the tests and the linter, and everything passed on the first try.");
    expect(first).toBe("I opened the terminal in your project folder,");
    expect(rest.join(" ")).toBe("ran the tests and the linter, and everything passed on the first try.");
  });

  it("cuts a first sentence of more than 48 characters at its first clause of 18 or more, where the voice takes about 18 ms a character (scripts/perf/latency.mjs)", () => {
    expect(speechChunks("I can't do that one, because it would delete files from your home folder without a way back.")[0]).toBe("I can't do that one,");
    expect(speechChunks("It's 3:40 in the afternoon, and your next meeting is at 4.")).toEqual(["It's 3:40 in the afternoon,", "and your next meeting is at 4."]);
    // Short enough to say whole, and a clause too short to say alone: as before.
    expect(speechChunks("Night Light is on now, until sunrise.")).toEqual(["Night Light is on now, until sunrise."]);
    expect(speechChunks("Sure, I've made the text bigger in Settings for you.")).toEqual(["Sure, I've made the text bigger in Settings for you."]);
  });

  it("doesn't end a sentence at an abbreviation, a decimal or a list's number", () => {
    expect(speechChunks("Use a short name, e.g. notes. Version 3.5 is out.")).toEqual(["Use a short name, e.g. notes.", "Version 3.5 is out."]);
  });

  it("joins a very short piece to the one before it", () => {
    expect(speechChunks("The build finished in twelve seconds. OK. Next?")).toEqual(["The build finished in twelve seconds.", "OK. Next?"]);
  });

  it("says nothing for nothing", () => {
    expect(speechChunks("  \n ")).toEqual([]);
  });
});

describe("SpeechStream", () => {
  const stream = (deltas: string[], full?: string) => {
    const s = new SpeechStream();
    const said = deltas.flatMap(d => s.push(d));
    return { said, rest: s.finish(full ?? deltas.join("")) };
  };

  it("speaks each sentence as soon as it's complete, and the rest at the end", () => {
    const { said, rest } = stream(["Night Li", "ght is on", ". I also", " turned on Do Not Disturb.", " Anything", " else?"]);
    expect(said).toEqual(["Night Light is on.", "I also turned on Do Not Disturb."]);
    expect(rest).toEqual(["Anything else?"]);
  });

  it("never speaks inside a code block: it is said as shown in the bubble once it's closed", () => {
    const { said, rest } = stream(["Run this:\n\n```bash\nnpm test. And", " more.\n```\n", "Then check the output."]);
    expect(said.join(" ")).not.toMatch(/npm|more/);
    expect([...said, ...rest].join(" ")).toMatch(/^Run this:\s*\(code shown in the bubble\)\s*Then check the output\.$/);
  });

  it("says Markdown as words (no stars or link addresses)", () => {
    const { said } = stream(["**Done.** See [the guide](https://example.com/guide). ", "More soon"]);
    expect(said.join(" ")).toBe("Done. See the guide.");
  });

  it("starts speaking at the first clause of a long first sentence, before Copilot has written the rest", () => {
    const s = new SpeechStream();
    expect(s.push("I opened the quarterly report")).toEqual([]);
    expect(s.push(", checked the totals and")).toEqual(["I opened the quarterly report,"]);
    expect(s.push(" fixed two cells. Anything else?")).toEqual(["checked the totals and fixed two cells."]);
    expect(s.finish()).toEqual(["Anything else?"]);
  });

  it("starts at a first clause of 18 characters and four words, not only at 25 (“I can't do that one,”)", () => {
    expect(new SpeechStream().push("I can't do that one, because")).toEqual(["I can't do that one,"]);
    expect(new SpeechStream().push("Here's what I found: the project")).toEqual(["Here's what I found:"]);
  });

  it("waits for the sentence when the first clause is too short to say alone", () => {
    expect(new SpeechStream().push("Sure, I can open that for you")).toEqual([]);
  });

  it("never cuts the first clause inside a code span, a link or a list", () => {
    expect(new SpeechStream().push("Run `npm test --watch, then check the output, and")).toEqual([]);
    expect(new SpeechStream().push("Open [the guide to builds, tests and more](https://exa")).toEqual([]);
    expect(new SpeechStream().push("- Open the settings window first, then")).toEqual([]);
  });

  it("speaks only from the sentences once the first part is said", () => {
    const s = new SpeechStream();
    s.push("I opened the quarterly report, checked it");
    expect(s.push(" and more, then again")).toEqual([]);
  });

  it("says a whole answer that wasn't streamed", () => {
    expect(new SpeechStream().finish("Hello there.")).toEqual(["Hello there."]);
  });

  it("doesn't say again what it said, even when the final message differs from the stream", () => {
    const s = new SpeechStream();
    expect(s.push("First. Second")).toEqual(["First."]);
    expect(s.finish("Something else entirely.")).toEqual([]);
  });
});

describe("Player", () => {
  function fakeAudio() {
    const sources: (PlayerSource & { at: number; stopped: boolean })[] = [];
    const ctx: PlayerAudio & { currentTime: number } = {
      currentTime: 10, state: "running", destination: {},
      resume: () => Promise.resolve(),
      createBuffer: (_c, length, rate) => ({ copyToChannel: () => undefined, duration: length / rate }),
      createBufferSource: () => {
        const s = { buffer: null as unknown, onended: null as (() => void) | null, at: -1, stopped: false, connect: () => undefined, start(when: number) { s.at = when; }, stop() { s.stopped = true; } };
        sources.push(s);
        return s;
      },
    };
    return { ctx, sources };
  }

  it("plays a reply's chunks back to back, and says it speaks until the last has played", () => {
    const { ctx, sources } = fakeAudio();
    const speaking = vi.fn();
    const p = new Player(() => ctx, speaking);
    expect(p.chunk(1, new Float32Array(22_050), 22_050)).toBe(1);
    expect(p.chunk(1, new Float32Array(11_025), 22_050)).toBe(0.5);
    expect(sources.map(s => s.at)).toEqual([10.03, 11.03]);
    expect(speaking.mock.calls).toEqual([[true]]);
    sources[0].onended?.();
    sources[1].onended?.();
    expect(p.active).toBe(true); // more may come: the reply isn't done
    p.done(1);
    expect(speaking.mock.calls).toEqual([[true], [false]]);
  });

  it("stops at once on a hush, and drops what is still on its way for that reply", () => {
    const { ctx, sources } = fakeAudio();
    const speaking = vi.fn();
    const p = new Player(() => ctx, speaking);
    p.chunk(1, new Float32Array(100), 22_050);
    p.stop();
    expect(sources[0].stopped).toBe(true);
    expect(speaking.mock.calls).toEqual([[true], [false]]);
    expect(p.chunk(1, new Float32Array(100), 22_050)).toBe(0); // dropped
    expect(sources).toHaveLength(1);
    p.chunk(2, new Float32Array(100), 22_050);
    expect(sources).toHaveLength(2);
  });
});

describe("bestVoice", () => {
  const v = (name: string, lang = "en-US", localService = true, def = false) => ({ name, lang, localService, default: def });

  it("prefers a natural voice that runs on this computer", () => {
    const voices = [v("Microsoft David", "en-US", true, true), v("Microsoft Aria Online (Natural)", "en-US", false), v("Microsoft Jenny (Natural)"), v("Samantha (Enhanced)")];
    expect(bestVoice(voices, "en-US")?.name).toBe("Microsoft Jenny (Natural)");
  });

  it("takes macOS's Premium over Enhanced, and anything over espeak", () => {
    expect(bestVoice([v("Ava (Enhanced)"), v("Zoe (Premium)")], "en-US")?.name).toBe("Zoe (Premium)");
    expect(bestVoice([v("English (America) espeak-ng", "en-US", true, true), v("Mary")], "en-US")?.name).toBe("Mary");
  });

  it("keeps to the language, and returns no voice when none local matches", () => {
    expect(bestVoice([v("Thomas (Enhanced)", "fr-FR"), v("Alex", "en-GB")], "en-US")?.name).toBe("Alex");
    expect(bestVoice([v("Thomas", "fr-FR")], "en-US")).toBeNull();
  });
});

describe("playerAudio (how Ember's voice reaches the speakers)", () => {
  const ctx = () => {
    const dest = { stream: { id: "s" } };
    const c = {
      currentTime: 1.5, state: "running", resumed: 0,
      resume: async () => { c.resumed++; },
      createBuffer: () => ({ copyToChannel() {}, duration: 1 }),
      createBufferSource: () => ({ buffer: null, onended: null, connect() {}, start() {}, stop() {} }),
      destination: { speakers: true },
      createMediaStreamDestination: () => dest,
    };
    return { c, dest };
  };

  it("plays through the context's own output by default", () => {
    const { c } = ctx();
    expect(playerAudio(c, false)).toBe(c);
  });

  it("plays through an <audio> element fed by a media stream when asked (echo cancellation covers media elements)", async () => {
    const { c, dest } = ctx();
    const el = { srcObject: null as unknown, plays: 0, play: async () => { el.plays++; } };
    const a = playerAudio(c, true, () => el);
    expect(a.destination).toBe(dest);
    expect(el.srcObject).toBe(dest.stream);
    expect(a.currentTime).toBe(1.5);
    await a.resume();
    expect(c.resumed).toBe(1);
    expect(el.plays).toBe(2);
  });

  it("tries a refused <audio> element again with the next chunk while the context runs (it never resumes then; voice audit)", async () => {
    const { c } = ctx();
    let refuse = true;
    const el = { srcObject: null as unknown, plays: 0, play: async () => { el.plays++; if (refuse) throw new Error("NotAllowedError"); } };
    const a = playerAudio(c, true, () => el);
    await Promise.resolve(); await Promise.resolve();
    expect(el.plays).toBe(1);
    refuse = false;
    a.createBufferSource();
    await Promise.resolve(); await Promise.resolve();
    expect(el.plays).toBe(2);
    a.createBufferSource(); // playing now: not asked again
    expect(el.plays).toBe(2);
  });
});
