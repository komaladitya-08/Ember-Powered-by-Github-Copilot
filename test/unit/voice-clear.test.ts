/**
 * Hear me more clearly: the clearer recognizer stays optional, pinned and off, and Home says how it stands.
 */
import { describe, expect, it } from "vitest";
import { CLEAR_SPEECH, LISTENING_MODELS, VOICE_MODELS } from "../../app/voice/models";
import { CLEAR_HINT, clearHearingLine } from "../../app/renderer/home/copy";

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
});
