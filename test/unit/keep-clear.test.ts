/**
 * What Ember and its bubble keep clear of (windows.ts keepClearOf, review #125): the settings window while the user works
 * in it, as before, and now Ember's own approval windows while they ask (the prompt window's card, the command window
 * while a question's command card is up), which the overlay (always above them) would otherwise cover.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {}, screen: {} }));
const { askingWindows, keepClearOf } = await import("../../app/main/windows");

const rect = (x: number) => ({ x, y: 100, width: 400, height: 300 });
const shown = (x: number, more: { visible?: boolean; minimized?: boolean; focused?: boolean } = {}) =>
  ({ visible: true, minimized: false, focused: false, bounds: rect(x), ...more });

describe("keepClearOf (review #125)", () => {
  it("keeps today's rule for settings: only while it is shown and focused", () => {
    expect(keepClearOf({ home: shown(10, { focused: true }), prompt: null, command: null, commandCard: false })).toEqual({ aside: rect(10), avoid: [rect(10)] });
    expect(keepClearOf({ home: shown(10), prompt: null, command: null, commandCard: false })).toEqual({ aside: null, avoid: [] });
    expect(keepClearOf({ home: null, prompt: null, command: null, commandCard: false })).toEqual({ aside: null, avoid: [] });
  });

  it("steps beside the prompt window while it shows a card, and the bubble keeps off it, ahead of settings", () => {
    expect(keepClearOf({ home: shown(10, { focused: true }), prompt: shown(500), command: null, commandCard: false }))
      .toEqual({ aside: rect(500), avoid: [rect(500), rect(10)] });
    expect(keepClearOf({ home: null, prompt: shown(500, { minimized: true }), command: null, commandCard: false })).toEqual({ aside: null, avoid: [] });
    expect(keepClearOf({ home: null, prompt: shown(500, { visible: false }), command: null, commandCard: false })).toEqual({ aside: null, avoid: [] });
  });

  it("keeps clear of the command window only while a question's command card is up in it", () => {
    expect(keepClearOf({ home: null, prompt: null, command: shown(900), commandCard: true })).toEqual({ aside: rect(900), avoid: [rect(900)] });
    // Showing a run's output only: Ember follows the cursor as before.
    expect(keepClearOf({ home: null, prompt: null, command: shown(900), commandCard: false })).toEqual({ aside: null, avoid: [] });
    expect(keepClearOf({ home: null, prompt: null, command: shown(900, { visible: false }), commandCard: true })).toEqual({ aside: null, avoid: [] });
    expect(keepClearOf({ home: null, prompt: shown(500), command: shown(900), commandCard: true })).toEqual({ aside: rect(500), avoid: [rect(500), rect(900)] });
  });
});

describe("Ember's approval windows that ask", () => {
  it("are the prompt, the vault's form and the command window while its card is up, never Settings", () => {
    const w = (x: number) => ({ visible: true, minimized: false, focused: false, bounds: { x, y: 0, width: 100, height: 100 } });
    expect(askingWindows({ prompt: w(1), command: w(2), commandCard: true, vault: w(3) }).map(r => r.x)).toEqual([1, 3, 2]);
    expect(askingWindows({ prompt: null, command: w(2), commandCard: false })).toEqual([]);
    expect(askingWindows({ prompt: { ...w(1), minimized: true }, command: { ...w(2), visible: false }, commandCard: true })).toEqual([]);
  });
});
