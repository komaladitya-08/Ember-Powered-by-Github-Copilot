/**
 * libX11 through koffi, on a real display (skipped without DISPLAY): captures
 * that reach off the screen, and input after the display was closed. Both used
 * to end the whole process (Xlib's BadMatch exit, a freed Display).
 */

import { describe, expect, it } from "vitest";
import { openX11 } from "../../app/main/x11";
import { openXInput } from "../../app/main/hands/input";

describe.skipIf(!process.env.DISPLAY)("X11 on a real display", () => {
  it("clips captures to the screen instead of failing", () => {
    const x11 = openX11();
    if (!x11) return;
    try {
      const whole = x11.capture(0, 0, 100000, 100000);
      expect(whole).not.toBeNull();
      const { width: w, height: h } = whole!;
      const corner = x11.capture(w - 40, h - 30, 200, 200);
      expect(corner).toMatchObject({ x: w - 40, y: h - 30, width: 40, height: 30 });
      expect(corner!.bgra.length).toBe(40 * 30 * 4);
      expect(x11.capture(-10, 5, 30, 20)).toMatchObject({ x: 0, y: 5, width: 20, height: 20 });
      expect(x11.capture(w + 10, 0, 50, 50)).toBeNull();
    } finally {
      x11.close();
    }
  });

  it("does nothing, safely, once input is closed", () => {
    const x = openXInput();
    if (!x) return;
    x.close();
    expect(x.pointer()).toBeNull();
    expect(x.pointerState()).toBeNull();
    x.move(10, 10);
    x.button(1, false);
    expect(x.keysym(x.keysymOf("a"), false)).toBe(false);
    x.keycode(38, false);
    expect(x.keycodeOf(0x61)).toBe(0);
    expect(x.needsShift(0x41)).toBe(false);
    expect(x.keysDown()).toEqual([]);
    expect(x.activeWindow()).toBe(0);
    expect(x.findWindow("anything")).toBe(0);
    x.activate(1);
    x.sync();
    x.close();
  });
});
