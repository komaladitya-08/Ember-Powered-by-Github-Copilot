/** A required default-voice gate cannot pass on cached Kokoro, a different neural voice or audio emitted in WASM. */
import { describe, expect, it } from "vitest";
import { defaultSpeechBackend } from "../smoke/voice-backend-checks.mjs";

const native = { voice: { voice: "kitten", backend: "native" }, readyCount: 1, audioChunks: 3, audioSeconds: 4, rtf: 0.3 };
const unsupported = { unavailable: "native", readyCount: 0, audioChunks: 0, audioSeconds: 0 };
describe("default speech backend smoke", () => {
  it("requires the exact native Kitten voice and usable generated audio", () => {
    expect(() => defaultSpeechBackend(native, true)).not.toThrow();
    for (const run of [{ ...native, voice: { voice: "kokoro", backend: "native" } }, { ...native, voice: { voice: "piper", backend: "native" } },
      { ...native, voice: { voice: "kitten", backend: "wasm" } }, { ...native, audioSeconds: 0 }, { ...native, audioChunks: 0 }, { ...native, rtf: 2 }, unsupported]) {
      expect(() => defaultSpeechBackend(run, true)).toThrow();
    }
  });
  it("requires explicit native unavailability and zero neural audio on unsupported backends", () => {
    expect(() => defaultSpeechBackend(unsupported, false)).not.toThrow();
    for (const run of [{ ...unsupported, unavailable: "load" }, { ...unsupported, unavailable: "slow" },
      { ...unsupported, readyCount: 1 }, { ...unsupported, audioChunks: 1 }, { ...unsupported, audioSeconds: 0.1 }, native]) {
      expect(() => defaultSpeechBackend(run, false)).toThrow();
    }
  });
});
