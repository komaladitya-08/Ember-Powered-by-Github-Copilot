/**
 * The Ask box at a text size on real runners (review #57): ask-size.ts holds the steps and the sizes that handle-menu-live
 * (Xvfb, RHEL 8 CI), ember-win32 and ember-darwin expect. Its sizes are ask.ts's (so a real runner fails only when its
 * window system refuses the box's bounds), and Windows and macOS open the box at Larger, where it is wider and taller
 * than the default size's 560 × 92 (the only size their other cases open it at).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { askBounds, askSize, grownBounds } from "../../app/main/ask";
import { textScale } from "../../app/main/page-prefs";
import { ASK_AT, askHeight, askWant, type TextSize } from "../integration/ask-size";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const SIZES: TextSize[] = ["default", "large", "larger"];
/** A 1024 × 768 screen at 100 % (Windows' runner), its work area above a 40 px taskbar. */
const wa = { x: 0, y: 0, width: 1024, height: 728 };

describe("ask-size.ts: what the live suites expect of the Ask box (review #57)", () => {
  it("expects ask.ts's own sizes at each text size: one row, with the tip's, and with four lines and the note", () => {
    for (const size of SIZES) {
      const scale = textScale(size);
      expect(ASK_AT[size].scale, size).toBe(scale);
      expect({ width: ASK_AT[size].width, height: ASK_AT[size].height }, size).toEqual(askSize(scale));
      // The field's 18 px type times the scale, as Chromium gives it.
      expect(ASK_AT[size].font, size).toBe(`${Math.round(18 * scale * 10) / 10}px`);
      // As main opens it on Windows' runner: by Ember's handle, a row taller while the tip says to wait for it.
      const one = askBounds({ x: 900, y: 600, size: 60 }, wa, null, scale);
      for (const rows of [1, 2, 5]) expect(grownBounds(one, rows, wa, true, null, scale), `${size}, ${rows} rows`).toMatchObject({ width: ASK_AT[size].width, height: askHeight(size, rows) });
    }
    expect(askWant("larger", false)).toEqual({ visible: true, width: 728, height: 111, size: "larger", font: "23.4px", clipped: false });
    expect(askWant("larger", true)).toMatchObject({ width: 728, height: 142 });
    expect(askWant("large", true)).toMatchObject({ width: 644, height: 129 });
    expect(askWant("default", true)).toMatchObject({ width: 560, height: 116 });
    expect(askHeight("larger", 5)).toBe(236);
  });

  it("opens the box at Larger on real Windows and macOS, after the ask chord's case, and at every size on Linux", () => {
    for (const [suite, chord] of [["ember-win32", "opens the ask box from the real ask chord"], ["ember-darwin", "opens the ask box from the real ask chord"]] as const) {
      const src = read(`test/integration/${suite}.test.ts`);
      const at = src.indexOf('it("opens the ask box as large as its words at Larger text');
      expect(at, suite).toBeGreaterThan(src.indexOf(`it("${chord}`));
      const body = src.slice(at, src.indexOf("\n  });\n", at));
      expect(body, suite).toContain('await openAskAt(inEmber, "larger")');
      expect(body, suite).toContain('toMatchObject(askWant("larger", seen.tip))');
      expect(body, suite).toContain("toBeGreaterThanOrEqual(8)");
      // Put back in a finally: the box away and the default size, for the cases after it.
      expect(body.slice(body.indexOf("} finally {")), suite).toMatch(/await closeAsk\(inEmber\);\n\s+await setTextSize\(inEmber, "default"\)/);
    }
    const linux = read("test/integration/handle-menu-live.test.ts");
    expect(linux).toContain('for (const size of ["larger", "large", "default"] as const) {\n        const r = await openAskAt(inEmber, size);');
    expect(linux).toContain("toMatchObject({ ...askWant(size, false), tip: false })");
  });
});
