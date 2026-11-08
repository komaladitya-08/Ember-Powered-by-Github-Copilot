/**
 * Hear me more clearly: the clearer recognizer stays optional, pinned and off, and Home says how it stands.
 */
import { describe, expect, it } from "vitest";
import { CLEAR_SPEECH, LISTENING_MODELS, VOICE_MODELS } from "../../app/voice/models";
import { CLEAR_HINT, clearHearingLine } from "../../app/renderer/home/copy";
import { calledByName } from "../../app/voice/engine";

describe("the clearer recognizer", () => {
  it("is pinned, and not part of the standard download or of what listening needs", () => {
    expect(CLEAR_SPEECH.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(CLEAR_SPEECH.url).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\//);
    expect(VOICE_MODELS.map(m => m.id)).not.toContain("clear");
    expect(LISTENING_MODELS).not.toContain("clear");
  });

  it("says its size where it is offered, from the pinned download", () => {
    expect(CLEAR_HINT).toContain(`${Math.round(CLEAR_SPEECH.bytes / 1e6)} MB`);
  });

  it("says how it stands under its switch, and nothing while off", () => {
    expect(clearHearingLine(undefined)).toBe("");
    expect(clearHearingLine({ state: "off" })).toBe("");
    expect(clearHearingLine({ state: "downloading", percent: 40 })).toBe("Downloading… 40%");
    expect(clearHearingLine({ state: "starting" })).toBe("Starting…");
    expect(clearHearingLine({ state: "failed", detail: "The network dropped." })).toBe("The network dropped. Turn this off and on to try again.");
    expect(clearHearingLine({ state: "wont-load" })).toMatch(/usual speech model/);
  });

  it("never names Ember in a way a screen reader saying the line into the wake word's microphone wakes it (voice-listening-c4-1)", () => {
    // "On. Ember writes what you say with the clearer model.", read into an idle wake microphone in the test-only Ryan
    // voice, woke Ember and sent "Writes what you say with the clearer model." as a request in 5 of 20 placements.
    expect(clearHearingLine({ state: "on" })).toBe("On. The clearer model writes what you say.");
    expect(clearHearingLine({ state: "needs-native" })).toBe("This computer can't run it, so the usual speech model writes what you say.");
    expect(clearHearingLine({ state: "wont-load" })).toBe("It wouldn't start on this computer, so the usual speech model writes what you say.");
    for (const s of [{ state: "on" }, { state: "needs-native" }, { state: "wont-load" }, { state: "starting" }, { state: "downloading", percent: 40 }, { state: "failed", detail: "The network dropped." }] as const) {
      const words = clearHearingLine(s).split(/\s+/);
      for (let i = 0; i < words.length; i++) expect(calledByName(words.slice(i).join(" ")), `${s.state} from “${words[i]}”`).toBe(false);
    }
  });
});
