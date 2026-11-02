/** Device pixels for the floating pages (app/renderer/shared/pixels.ts): crisp at 100 %, 125 % and 150 %. */
import { describe, expect, it } from "vitest";
import { canvasSize, devicePixel } from "../../app/renderer/shared/pixels";

describe("a canvas on the floating layer", () => {
  it("has a backing store of whole device pixels and a CSS size that maps it 1:1, so it is never resampled", () => {
    for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
      for (const css of [102, 204, 229, 57]) {
        const s = canvasSize(css, dpr);
        expect(Number.isInteger(s.backing), `${css} at ${dpr}`).toBe(true);
        expect(s.backing).toBeGreaterThanOrEqual(css * dpr - 1e-6);
        expect(s.css * dpr).toBeCloseTo(s.backing, 9);
        expect(s.css - css).toBeLessThan(1);
      }
    }
    expect(canvasSize(204, 1.25)).toEqual({ backing: 255, css: 204 });
    expect(canvasSize(203, 1.25)).toEqual({ backing: 254, css: 203.2 });
  });

  it("draws hairlines of exactly one device pixel", () => {
    expect(devicePixel(1)).toBe(1);
    expect(devicePixel(1.25)).toBe(0.8);
    expect(devicePixel(2)).toBe(0.5);
    expect(devicePixel(0)).toBe(1);
  });
});
