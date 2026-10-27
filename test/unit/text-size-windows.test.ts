/**
 * The command and prompt windows grow with the text size, so Allow and Not now stay in the window at Large and Larger
 * as at the default size (review #57): main keeps windows.ts's text scale up to date, and each window takes it as it is
 * made.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ made: [] as Record<string, unknown>[], workArea: { width: 1920, height: 1040 } }));
vi.mock("electron", () => ({
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) { electron.made.push(options); }
    setContentProtection() { /* not here */ }
    setAlwaysOnTop() { /* not here */ }
    loadFile() { return Promise.resolve(); }
    once() { /* not shown by the factories */ }
    on() { /* a window's own events: not here */ }
  },
  app: { on() { /* not here */ }, removeListener() { /* not here */ } },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: electron.workArea }) },
}));

const { createCommandWindow, createPromptWindow, setTextScale } = await import("../../app/main/windows");
const size = (o: Record<string, unknown>) => ({ width: o.width, height: o.height, minWidth: o.minWidth, minHeight: o.minHeight });

describe("the command and prompt windows at each text size (review #57)", () => {
  afterEach(() => { setTextScale(1); electron.workArea = { width: 1920, height: 1040 }; });

  it("open at their usual size at the default text size", () => {
    createCommandWindow("linux");
    expect(size(electron.made.at(-1)!)).toEqual({ width: 760, height: 480, minWidth: 480, minHeight: 280 });
    createPromptWindow("linux");
    expect(size(electron.made.at(-1)!)).toEqual({ width: 440, height: 300, minWidth: undefined, minHeight: undefined });
    // Whatever reaches it, a scale that isn't one is the default's.
    for (const odd of [Number.NaN, 0, -1, Infinity]) {
      setTextScale(odd);
      createCommandWindow("linux");
      expect(size(electron.made.at(-1)!), String(odd)).toEqual({ width: 760, height: 480, minWidth: 480, minHeight: 280 });
    }
  });

  it("grow with the text at Large and Larger, their smallest size too", () => {
    setTextScale(1.15);
    createCommandWindow("win32");
    expect(size(electron.made.at(-1)!)).toEqual({ width: 874, height: 552, minWidth: 552, minHeight: 322 });
    setTextScale(1.3);
    createCommandWindow("darwin");
    expect(size(electron.made.at(-1)!)).toEqual({ width: 988, height: 624, minWidth: 624, minHeight: 364 });
    createPromptWindow("linux");
    expect(size(electron.made.at(-1)!)).toMatchObject({ width: 572, height: 390 });
    expect(electron.made.at(-1)!.resizable).toBe(false);
  });

  it("stay inside a small screen's work area, and never get smaller than usual", () => {
    electron.workArea = { width: 1024, height: 560 };
    setTextScale(1.3);
    createCommandWindow("linux");
    expect(size(electron.made.at(-1)!)).toEqual({ width: 988, height: 560, minWidth: 624, minHeight: 364 });
  });

  it("are made at the text size of the moment: main sets it at start and whenever it changes", () => {
    const main = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/let pagePrefsKey = [^\n]*\n\s*setTextScale\(textScale\(settings\.get\(\)\.textSize\)\);/);
    expect(main).toMatch(/pagePrefsKey = JSON\.stringify\(prefs\);\n\s*setTextScale\(textScale\(prefs\.textSize\)\);/);
  });
});
