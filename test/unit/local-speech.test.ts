/** Recovery stays in order, drains real playback, and never uses an unrestricted browser default. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSpeech } from "../../app/renderer/mic/local-speech";
import { Player, type PlayerAudio, type PlayerSource } from "../../app/renderer/mic/player";

const local = { name: "Local", lang: "en-US", localService: true, default: false };
function setup() {
  vi.useFakeTimers();
  const d = {
    voices: vi.fn(() => [local]), busy: vi.fn(() => false), speak: vi.fn(), unavailable: vi.fn(),
    setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimer: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
  return { d, q: new LocalSpeech(d, "en-US") };
}
afterEach(() => vi.useRealTimers());

describe("local system speech recovery", () => {
  it("waits for voiceschanged and explicitly selects the local voice", () => {
    const { d, q } = setup();
    d.voices.mockReturnValue([]);
    q.enqueue("First."); q.enqueue("Second.");
    expect(d.speak).not.toHaveBeenCalled();
    d.voices.mockReturnValue([{ ...local, localService: false, default: true }, local]);
    q.drain();
    expect(d.speak.mock.calls).toEqual([["First.", local, undefined], ["Second.", local, undefined]]);
    vi.advanceTimersByTime(3000);
    expect(d.unavailable).not.toHaveBeenCalled();
  });

  it.each([{ voices: [] }, { voices: [{ ...local, localService: false, default: true }] }, { voices: [{ ...local, lang: "fr-FR" }] }])("fails closed without a local voice for the language", ({ voices }) => {
    const { d, q } = setup();
    d.voices.mockReturnValue(voices);
    q.enqueue("Private reply.");
    vi.advanceTimersByTime(3000);
    expect(d.speak).not.toHaveBeenCalled();
    expect(d.unavailable).toHaveBeenCalledOnce();
    d.voices.mockReturnValue([local]); q.drain();
    expect(d.speak).not.toHaveBeenCalled();
  });

  it("says a reply in another language with a local voice for it, or not at all, never reporting speech as broken (voice-speaking-11)", () => {
    const { d, q } = setup();
    const french = { name: "Amélie", lang: "fr-FR", localService: true, default: false };
    q.enqueue("J'ai ouvert les paramètres.", "fr");
    q.enqueue("Opened.");
    expect(d.speak.mock.calls).toEqual([["Opened.", local, undefined]]);
    vi.advanceTimersByTime(3000);
    expect(d.unavailable).not.toHaveBeenCalled();
    d.voices.mockReturnValue([local, french]);
    q.enqueue("J'ai ouvert les paramètres.", "fr");
    expect(d.speak.mock.calls.at(-1)).toEqual(["J'ai ouvert les paramètres.", french, "fr"]);
  });

  it("doesn't say Ember couldn't speak when a computer with no voices at all drops only words in another language (voice-speaking-r1)", () => {
    const { d, q } = setup();
    d.voices.mockReturnValue([]);
    q.enqueue("J'ai ouvert les paramètres.", "fr");
    q.enqueue("Et la fenêtre est fermée.", "fr");
    vi.advanceTimersByTime(3000);
    expect(d.speak).not.toHaveBeenCalled();
    expect(d.unavailable).not.toHaveBeenCalled();
    // English words that no voice could say are still speech failing.
    q.enqueue("Je regarde.", "fr");
    q.enqueue("Opened.");
    vi.advanceTimersByTime(3000);
    expect(d.unavailable).toHaveBeenCalledOnce();
  });

  it("does not revive cancelled words or their failure timer when voices load", () => {
    const { d, q } = setup(); d.voices.mockReturnValue([]);
    q.enqueue("Old reply."); q.cancel();
    d.voices.mockReturnValue([local]); q.enqueue("New reply."); q.drain();
    vi.advanceTimersByTime(3000);
    expect(d.speak.mock.calls).toEqual([["New reply.", local, undefined]]);
    expect(d.unavailable).not.toHaveBeenCalled();
  });

  it("waits past audioDone until all scheduled PCM ends, then speaks the suffix once", () => {
    const { d, q } = setup();
    const sources: PlayerSource[] = [];
    const ctx: PlayerAudio = {
      currentTime: 0, state: "running", destination: {}, resume: async () => {},
      createBuffer: () => ({ duration: 1, copyToChannel: () => {} }),
      createBufferSource: () => {
        const s: PlayerSource = { buffer: null, onended: null, connect() {}, start() {}, stop() {} };
        sources.push(s); return s;
      },
    };
    const p = new Player(() => ctx, on => { if (!on) q.drain(); });
    d.busy.mockImplementation(() => p.active);
    p.chunk(1, new Float32Array(10), 10);
    p.chunk(1, new Float32Array(10), 10);
    p.done(1);
    q.enqueue("Unmade suffix."); q.enqueue("Next reply.");
    sources[0].onended?.();
    expect(d.speak).not.toHaveBeenCalled();
    sources[1].onended?.(); q.drain();
    expect(d.speak.mock.calls).toEqual([["Unmade suffix.", local, undefined], ["Next reply.", local, undefined]]);
  });
});
