/**
 * Ember's own voice: how a reply is cut into pieces to speak (the first one short, so it starts soon), how a streamed
 * answer becomes sentences as they complete (never inside code or a table, never twice), the page's player (gapless,
 * says when it speaks and when it's done, a hush stops it), and the system voice chosen when Ember's isn't there.
 */

import { describe, expect, it, vi } from "vitest";
import { SpeechStream, speechChunks } from "../../app/voice/tts";
import { Player, type PlayerAudio, type PlayerSource } from "../../app/renderer/mic/player";
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
    p.chunk(1, new Float32Array(22_050), 22_050);
    p.chunk(1, new Float32Array(11_025), 22_050);
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
    p.chunk(1, new Float32Array(100), 22_050);
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

  it("keeps to the language, and lets the system choose when it has none for it", () => {
    expect(bestVoice([v("Thomas (Enhanced)", "fr-FR"), v("Alex", "en-GB")], "en-US")?.name).toBe("Alex");
    expect(bestVoice([v("Thomas", "fr-FR")], "en-US")).toBeNull();
  });
});
