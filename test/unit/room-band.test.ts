import { describe, expect, it } from "vitest";
import { BandFilter, LEVEL_BAND } from "../../app/voice/room-band";

/** The level (dB, against the tone's own) at which a steady `hz` tone comes through LEVEL_BAND, once the filter has settled. */
function through(hz: number): number {
  const f = new BandFilter(LEVEL_BAND);
  let e = 0;
  for (let n = 0; n < 40; n++) {
    const frame = new Float32Array(512);
    for (let k = 0; k < 512; k++) frame[k] = Math.sin((2 * Math.PI * hz * (n * 512 + k)) / 16_000);
    const v = f.energy(frame);
    if (n >= 20) e += v / 20;
  }
  return 10 * Math.log10(e / 0.5);
}

describe("the speakers' stream as a room hears it (voice-safety-x9-2)", () => {
  it("leaves out a hum that no small speaker plays, which buried a page's own “Ember, allow it.” in its stream, and keeps a voice's syllables", () => {
    for (const hz of [50, 120, 200, 300]) expect(through(hz), `${hz} Hz`).toBeLessThan(-80);
    expect(through(500)).toBeLessThan(-45);
    for (const hz of [2000, 3000, 5000]) expect(through(hz), `${hz} Hz`).toBeGreaterThan(-0.5);
  });

  it("starts afresh after a frame that isn't a number rather than stay broken", () => {
    const f = new BandFilter(LEVEL_BAND);
    f.energy(Float32Array.from({ length: 512 }, () => Number.NaN));
    expect(f.energy(Float32Array.from({ length: 512 }, (_, k) => Math.sin((2 * Math.PI * 3000 * k) / 16_000)))).toBeGreaterThan(0.3);
  });
});
