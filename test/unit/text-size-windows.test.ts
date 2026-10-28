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
    bounds: { x: number; y: number; width: number; height: number };
    min: [number, number] | null = null;
    destroyed = false;
    handlers: Record<string, (() => void)[]> = {};
    // The card windows close when their page crashes (review #91).
    webContents = { on() { /* not here */ } };
    constructor(options: Record<string, unknown>) {
      electron.made.push(options);
      this.bounds = { x: 400, y: 300, width: options.width as number, height: options.height as number };
    }
    setContentProtection() { /* not here */ }
    setAlwaysOnTop() { /* not here */ }
    loadFile() { return Promise.resolve(); }
    once() { /* not shown by the factories */ }
    on(event: string, fn: () => void) { (this.handlers[event] ??= []).push(fn); }
    isDestroyed() { return this.destroyed; }
    getBounds() { return { ...this.bounds }; }
    getContentBounds() { return { ...this.bounds }; }
    setBounds(b: { x: number; y: number; width: number; height: number }) { this.bounds = { ...b }; }
    setMinimumSize(width: number, height: number) { this.min = [width, height]; }
  },
  app: { on() { /* not here */ }, removeListener() { /* not here */ } },
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: electron.workArea }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, ...electron.workArea } }),
  },
}));

/** The mock's window, as a test reads it back. */
interface MockWindow { bounds: { x: number; y: number; width: number; height: number }; min: [number, number] | null; destroyed: boolean; handlers: Record<string, (() => void)[]> }

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

  it("grow or shrink with the text while they are open (made once, then hidden and shown again)", () => {
    const command = createCommandWindow("linux") as unknown as MockWindow;
    const prompt = createPromptWindow("linux") as unknown as MockWindow;
    setTextScale(1.15);
    expect(command.bounds).toEqual({ x: 343, y: 264, width: 874, height: 552 });
    expect(command.min).toEqual([552, 322]);
    expect(prompt.bounds).toMatchObject({ width: 506, height: 345 });
    setTextScale(1.3);
    expect(command.bounds).toMatchObject({ width: 988, height: 624 });
    expect(command.min).toEqual([624, 364]);
    // Back at the default: the usual size again, and its usual smallest size.
    setTextScale(1);
    expect(command.bounds).toEqual({ x: 400, y: 300, width: 760, height: 480 });
    expect(command.min).toEqual([480, 280]);
    expect(prompt.bounds).toMatchObject({ width: 440, height: 300 });
    // The same scale again changes nothing (main calls it on every change of the page prefs).
    command.bounds = { x: 5, y: 5, width: 900, height: 500 };
    setTextScale(1);
    expect(command.bounds).toEqual({ x: 5, y: 5, width: 900, height: 500 });
  });

  it("fit each card to its size grown with the text, as the window's first size is", () => {
    setTextScale(1.3);
    const prompt = createPromptWindow("linux");
    // A consent card (520 x 600 at the default size), as the prompt's controller asks for it.
    prompt.fit({ width: 520, height: 600 });
    expect((prompt as unknown as MockWindow).bounds).toMatchObject({ width: 676, height: 780 });
    setTextScale(1);
    prompt.fit({ width: 520, height: 600 });
    expect((prompt as unknown as MockWindow).bounds).toMatchObject({ width: 520, height: 600 });
  });

  it("leave a closed window alone", () => {
    const command = createCommandWindow("linux") as unknown as MockWindow;
    command.destroyed = true;
    for (const fn of command.handlers.closed ?? []) fn();
    setTextScale(1.3);
    expect(command.bounds).toMatchObject({ width: 760, height: 480 });
  });

  it("are made at the text size of the moment: main sets it at start and whenever it changes", () => {
    const main = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/let pagePrefsKey = [^\n]*\n\s*setTextScale\(textScale\(settings\.get\(\)\.textSize\)\);/);
    expect(main).toMatch(/pagePrefsKey = JSON\.stringify\(prefs\);\n\s*setTextScale\(textScale\(prefs\.textSize\)\);/);
  });
});
