/**
 * The prompt window as windows.ts makes it (§8.6): fitted to each card by its controller, centred where it is and
 * inside its display's work area (review #182, #270). Electron is faked: a BrowserWindow that records its bounds and a
 * screen with one work area.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  made: [] as { options: Record<string, unknown>; bounds: { x: number; y: number; width: number; height: number }; setBounds: unknown[]; calls: string[] }[],
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
}));
vi.mock("electron", () => ({
  BrowserWindow: class {
    rec: (typeof electron.made)[number];
    destroyed = false;
    constructor(options: Record<string, unknown>) {
      const width = options.width as number, height = options.height as number;
      this.rec = { options, bounds: { x: Math.round((1920 - width) / 2), y: Math.round((1040 - height) / 2), width, height }, setBounds: [], calls: [] };
      electron.made.push(this.rec);
    }
    setContentProtection() { /* recorded elsewhere */ }
    setAlwaysOnTop() { /* recorded elsewhere */ }
    loadFile() { return Promise.resolve(); }
    show() { this.rec.calls.push("show"); }
    focus() { this.rec.calls.push("focus"); }
    once() { /* not shown by the factory */ }
    isDestroyed() { return this.destroyed; }
    getBounds() { return { ...this.rec.bounds }; }
    setBounds(b: { x: number; y: number; width: number; height: number }) { this.rec.setBounds.push(b); this.rec.bounds = { ...b }; }
  },
  screen: { getDisplayMatching: () => ({ workArea: electron.workArea }) },
}));

const { createPromptWindow } = await import("../../app/main/windows");
const { PROMPT_SIZE } = await import("../../app/main/remote/prompt-window");

afterEach(() => { electron.made = []; electron.workArea = { x: 0, y: 0, width: 1920, height: 1040 }; });

describe("the prompt window's fit (review #182, #270)", () => {
  it("starts at the small card's size and grows for a consent card around the same centre, then back", () => {
    const win = createPromptWindow("linux");
    const rec = electron.made[0];
    expect(rec.options).toMatchObject({ width: 440, height: 300, resizable: false });
    win.fit(PROMPT_SIZE.consent);
    expect(rec.bounds).toEqual({ x: 700, y: 220, width: 520, height: 600 });
    win.fit(PROMPT_SIZE.card);
    expect(rec.bounds).toEqual({ x: 740, y: 370, width: 440, height: 300 });
  });

  it("leaves a window that already has the size where it is, and is capped to a small work area", () => {
    const win = createPromptWindow("win32");
    const rec = electron.made[0];
    rec.bounds = { x: 20, y: 30, width: 440, height: 300 };
    win.fit(PROMPT_SIZE.card);
    expect(rec.setBounds).toEqual([]);
    electron.workArea = { x: 0, y: 0, width: 1366, height: 520 };
    win.fit(PROMPT_SIZE.consent);
    expect(rec.bounds).toEqual({ x: 16, y: 16, width: 520, height: 488 });
  });

  it("does nothing once the window is gone", () => {
    const win = createPromptWindow("darwin") as unknown as { destroyed: boolean; fit: (s: { width: number; height: number }) => void };
    win.destroyed = true;
    win.fit(PROMPT_SIZE.consent);
    expect(electron.made[0].setBounds).toEqual([]);
  });
});

describe("the prompt window and the keyboard (review #235)", () => {
  it("counts the first click on macOS, where Ember is often not the active app", () => {
    for (const os of ["linux", "win32", "darwin"] as const) {
      createPromptWindow(os);
      const { options } = electron.made.at(-1)!;
      if (os === "darwin") expect(options).toMatchObject({ acceptFirstMouse: true });
      else expect(options).not.toHaveProperty("acceptFirstMouse");
      // Still an ordinary window that takes the keyboard (a password is typed into it), not a panel.
      expect(options).not.toHaveProperty("type");
      expect(options).not.toHaveProperty("focusable");
    }
  });

  it("takes the keyboard through main's hook (as settings is brought to the front), else shows and focuses itself", () => {
    const given: unknown[] = [];
    const win = createPromptWindow("darwin", { takeKeyboard: w => { given.push(w); } });
    win.takeKeyboard();
    expect(given).toEqual([win]);
    expect(electron.made[0].calls).toEqual([]);
    const plain = createPromptWindow("linux");
    plain.takeKeyboard();
    expect(electron.made[1].calls).toEqual(["show", "focus"]);
  });
});
