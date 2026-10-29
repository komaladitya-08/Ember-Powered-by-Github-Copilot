/**
 * The command window's page, tested through its pure modules (vitest runs in Node: no DOM; critique integration-29):
 * the exact xterm options (\u00a73.10), the reducer that keeps the card apart from every output byte (critique
 * security-13), Allow's arming, and visibleText's tokens and mixed-script marks (critique security-10). A run's
 * terminal (terminal.ts) is driven with a fake xterm and a fake measuring element.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ITerminalOptions } from "@xterm/xterm";
import { INERT_LINKS, TERM_FONT_PX, XTERM_OPTIONS, termFontSize, terminalOptions, textScaleOf } from "../../app/renderer/command/terminal-options";
import { applyTextScale, fitTerminal, inputAtGrid, termChromePx } from "../../app/renderer/command/terminal-size";
import { cellSize, createRunTerminal, type TerminalCtor } from "../../app/renderer/command/terminal";
import {
  INITIAL_MODEL, MAX_PENDING_LINES, sameAnnouncement, allowAnswer, allowEnabled, allowHint, judgeMetrics, pendingLines, reduce, type CardMetrics, type Effect, type PageEvent, type PageModel,
  type TabView, type WindowView,
} from "../../app/renderer/command/model";
import { breaksLine, legendFor, segmentLabel, visibleText } from "../../app/renderer/command/visible";
import { shouldFocusTerminal, termKeyAction, type KeyLike } from "../../app/renderer/command/keys";
import type { CommandCard } from "../../app/main/commands/types";

const read = (f: string) => readFileSync(new URL(`../../app/renderer/command/${f}`, import.meta.url), "utf8");

// Measured on the built page in Chromium (scratchpad css2/r2/fit-inputs.mjs and the verifier's chrome.mjs), at the
// window main opens for each size (windows.ts): the panels' width, the cell cellSize() measures, the parts round the
// terminal (the window's height less the terminal's content box, typing line shown) and that content box.
const MEASURED = [
  { scale: 1, window: [760, 480], panels: 736, cell: { width: 7.826953125, height: 18 }, parts: 203, box: [720, 277], fit: { cols: 90, rows: 12 } },
  { scale: 1.15, window: [874, 552], panels: 850, cell: { width: 9.030859375, height: 22 }, parts: 219, box: [834, 333], fit: { cols: 91, rows: 12 } },
  { scale: 1.3, window: [988, 624], panels: 964, cell: { width: 10.23515625, height: 24 }, parts: 234, box: [948, 390], fit: { cols: 91, rows: 13 } },
];
/** xterm's cell at each type size it is given (px), as measured: the grid it draws is its columns and rows times this. */
const XTERM_CELL: Record<number, { width: number; height: number }> = { 13: MEASURED[0].cell, 15: MEASURED[1].cell, 17: MEASURED[2].cell };

/**
 * A stand-in for xterm's Terminal, as far as terminal.ts uses it: setting its type size redraws its grid (the
 * .xterm-screen element's size) at the cell of that size, as xterm does, and leaves its hidden input where it was
 * (xterm moves the input only when the cursor moves).
 */
function fakeXterm() {
  class FakeTerminal {
    readonly screen = { style: { width: "", height: "" } };
    readonly textarea = { style: { left: "", top: "", width: "", height: "", lineHeight: "" }, tabIndex: 0, setAttribute: () => {} };
    element: { querySelector(sel: string): unknown } | undefined;
    readonly cols: number;
    readonly rows: number;
    readonly options: ITerminalOptions;
    fontSets = 0;
    constructor(o: ITerminalOptions & { cols: number; rows: number }) {
      this.cols = o.cols;
      this.rows = o.rows;
      let font = o.fontSize;
      this.options = { ...o };
      Object.defineProperty(this.options, "fontSize", { get: () => font, set: (v: number) => { font = v; this.fontSets++; this.draw(); } });
      terms.push(this);
    }
    private draw() {
      if (!this.element) return;
      const c = XTERM_CELL[this.options.fontSize ?? 0];
      this.screen.style = { width: `${Math.round(this.cols * c.width)}px`, height: `${this.rows * c.height}px` };
    }
    /** What xterm does when the cursor moves: the input goes on the cursor's cell, which is its grid over its columns and rows. */
    moveCursor(col: number, row: number) {
      const w = Number.parseFloat(this.screen.style.width) / this.cols, h = Number.parseFloat(this.screen.style.height) / this.rows;
      this.textarea.style = { left: `${col * w}px`, top: `${row * h}px`, width: `${w}px`, height: `${h}px`, lineHeight: `${h}px` };
    }
    open() { this.element = { querySelector: (sel: string) => (sel === ".xterm-screen" ? this.screen : null) }; this.draw(); }
    onData() { return { dispose: () => {} }; }
    attachCustomKeyEventHandler() {}
    hasSelection() { return false; }
    write() {}
    refresh() {}
    focus() {}
    dispose() {}
  }
  const terms: FakeTerminal[] = [];
  return { Term: FakeTerminal as unknown as TerminalCtor, terms };
}

/**
 * The element cellSize measures in: the hidden line it puts there is as wide as 40 of `cell`, and its normal line height
 * just under `cell`'s height over xterm's line height (1.2), as the browser lays out the terminal's font.
 */
function fakeMeasureHost(cell: { width: number; height: number }) {
  const probes: { style: Record<string, string>; removed: boolean }[] = [];
  const el = {
    ownerDocument: {
      createElement: () => {
        const probe = { style: {} as Record<string, string>, textContent: "", removed: false, setAttribute: () => {}, remove: () => { probe.removed = true; },
          getBoundingClientRect: () => ({ width: cell.width * 40, height: cell.height ? (cell.height - 0.4) / (XTERM_OPTIONS.lineHeight ?? 1) : 0 }) };
        probes.push(probe);
        return probe;
      },
    },
    appendChild: () => {},
  };
  return { el: el as unknown as HTMLElement, probes };
}

describe("the terminal's options (\u00a73.10)", () => {
  it("are exactly the design's: no proposed API, no window reports, 5000 lines, no newline conversion", () => {
    expect(XTERM_OPTIONS.allowProposedApi).toBe(false);
    expect(XTERM_OPTIONS.windowOptions).toEqual({});
    expect(Object.keys(XTERM_OPTIONS.windowOptions ?? {})).toHaveLength(0);
    expect(XTERM_OPTIONS.scrollback).toBe(5000);
    expect(XTERM_OPTIONS.convertEol).toBe(false);
    expect(XTERM_OPTIONS.disableStdin).toBe(true);
    expect(Object.isFrozen(XTERM_OPTIONS)).toBe(true);
    // No bell setting exists in xterm 5 (it never sounds one itself); none is set here either.
    expect(Object.keys(XTERM_OPTIONS).filter(k => /bell/i.test(k))).toEqual([]);
  });

  it("make OSC 8 links inert: activating one does nothing and only http(s) links are even recognised", () => {
    expect(XTERM_OPTIONS.linkHandler).toBe(INERT_LINKS);
    expect(INERT_LINKS.allowNonHttpProtocols).toBe(false);
    expect(INERT_LINKS.activate({} as MouseEvent, "javascript:alert(1)", { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } })).toBeUndefined();
    expect(INERT_LINKS.hover).toBeUndefined();
  });

  it("expose the output to a screen reader when one is running, and only then (review #43)", () => {
    expect(XTERM_OPTIONS.screenReaderMode).toBe(false);
    expect(terminalOptions({ interactive: false, cols: 100, rows: 30, screenReader: true }).screenReaderMode).toBe(true);
    expect(terminalOptions({ interactive: true, cols: 100, rows: 30, screenReader: false }).screenReaderMode).toBe(false);
    expect(terminalOptions({ interactive: true, cols: 100, rows: 30 }).screenReaderMode).toBe(false);
    const term = read("terminal.ts"), main = read("main.ts");
    expect(term).toMatch(/options\.screenReaderMode = /);
    expect(main).toMatch(/setScreenReader\(/);
  });

  it("take typing only for a run that takes it, at the run's size", () => {
    expect(terminalOptions({ interactive: true, cols: 120, rows: 40 })).toMatchObject({ disableStdin: false, cols: 120, rows: 40, scrollback: 5000 });
    expect(terminalOptions({ interactive: false, cols: 120, rows: 40 }).disableStdin).toBe(true);
    expect(terminalOptions({ interactive: false, cols: 3, rows: 9999 })).toMatchObject({ cols: 100, rows: 30 });
  });

  it("draw the type at the page's text size, as the rest of the window: 13, 15 and 17 px at Default, Large and Larger", () => {
    expect(XTERM_OPTIONS.fontSize).toBe(TERM_FONT_PX);
    expect(TERM_FONT_PX).toBe(13);
    // ember.css's scales, as getComputedStyle gives --text-scale.
    const shared = readFileSync(new URL("../../app/renderer/shared/ember.css", import.meta.url), "utf8");
    const scale = (size: string) => textScaleOf(` ${new RegExp(`html\\[data-text-size="${size}"\\] \\{ --text-scale: ([\\d.]+); \\}`).exec(shared)![1]}`);
    expect([1, scale("large"), scale("larger")].map(termFontSize)).toEqual([13, 15, 17]);
    // Whole px, and anything that isn't a scale from 1 to 2 is the default's.
    for (const bad of [Number.NaN, 0, 0.5, 2.5, Infinity]) expect(termFontSize(bad), String(bad)).toBe(13);
    for (const bad of ["", "  ", "large", null, undefined, "-1"]) expect(textScaleOf(bad), String(bad)).toBe(1);
    expect(textScaleOf(" 1.3")).toBe(1.3);
    expect(terminalOptions({ interactive: false, cols: 100, rows: 30, scale: 1.3 }).fontSize).toBe(17);
    expect(terminalOptions({ interactive: false, cols: 100, rows: 30 }).fontSize).toBe(13);
  });

  it("draw each row's last column whole: the window's tracking doesn't reach xterm's cells or the cell measured for new runs", () => {
    // The page's body tightens its letters (letter-spacing: -0.006em). Inherited into the terminal, xterm measured its
    // cells that much narrower than it drew them, so every full row ran past its box and lost its last character.
    const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/body \{[^}]*letter-spacing: -0\.006em/);
    expect(css).toMatch(/(^|\n)\.term \{[^}]*letter-spacing: normal;/);
    // The cell new runs are sized by is measured in a .term too.
    expect(readFileSync(new URL("../../app/renderer/command/index.html", import.meta.url), "utf8")).toMatch(/<div id="measure" class="term measure"/);
  });

  it("follow a text size changed while the window is open: every terminal is told, then the size new runs start at is reported", () => {
    const calls: string[] = [];
    const terms = ["a", "b", "c"].map(n => ({ setTextScale: (s: number) => void calls.push(`${n} ${s}`) }));
    const report = (s: number) => void calls.push(`report ${s}`);
    // Default -> Larger: each open terminal (shown or not) takes the new scale, and the report comes once, after them,
    // with the new scale (it measures the cell new runs get at it).
    expect(applyTextScale(1, 1.3, terms, report)).toBe(1.3);
    expect(calls).toEqual(["a 1.3", "b 1.3", "c 1.3", "report 1.3"]);
    // The same size again (main sets it on every settings change, whatever changed): nothing to do.
    calls.length = 0;
    expect(applyTextScale(1.3, 1.3, terms, report)).toBe(1.3);
    expect(calls).toEqual([]);
    // Back down, with no run open: only the report.
    expect(applyTextScale(1.3, 1, [], report)).toBe(1);
    expect(calls).toEqual(["report 1"]);
    // A scale that isn't one from 1 to 2 is the default's.
    calls.length = 0;
    expect(applyTextScale(1.15, Number.NaN, terms, report)).toBe(1);
    expect(calls).toEqual(["a 1", "b 1", "c 1", "report 1"]);
    // The page runs it whenever main sets html[data-text-size] (as it loads and when the setting changes), with every
    // run's terminal and its own report.
    const main = read("main.ts");
    expect(main).toMatch(/new MutationObserver\(\(\) => \{\s*textScale = applyTextScale\(textScale, pageScale\(\), \[\.\.\.tabEls\.values\(\)\]\.map\(t => t\.term\), reportSize\);\s*\}\)\.observe\(document\.documentElement, \{ attributes: true, attributeFilter: \["data-text-size"\] \}\);/);
  });

  it("start a run's terminal at the page's text size, and measure the cell new runs get at it", () => {
    for (const [scale, px] of [[1, 13], [1.15, 15], [1.3, 17]] as const) {
      const made = fakeXterm();
      createRunTerminal({ cols: 91, rows: 13, interactive: false, mac: false, screenReader: false, scale, onInput: () => {} }, made.Term);
      expect(made.terms[0].options.fontSize, String(scale)).toBe(px);
      expect(made.terms[0].options).toMatchObject({ cols: 91, rows: 13, disableStdin: true });
    }
    // The cell: a hidden line of 40 cells in the terminal's font, at the type's size; its width over 40, its height whole.
    for (const m of MEASURED) {
      const host = fakeMeasureHost(m.cell);
      expect(cellSize(host.el, m.scale), String(m.scale)).toEqual({ width: m.cell.width, height: m.cell.height });
      expect(host.probes[0].style.fontSize).toBe(`${termFontSize(m.scale)}px`);
      expect(host.probes[0].style.fontFamily).toBe(XTERM_OPTIONS.fontFamily);
      expect(host.probes[0].removed, "taken out again").toBe(true);
    }
    // Not laid out (a hidden window): nothing measured.
    expect(cellSize(fakeMeasureHost({ width: 0, height: 0 }).el, 1)).toBeNull();
  });

  it("put xterm's hidden input back on the cursor's cell when the type's size changes, so a smaller type leaves nothing past the grid", () => {
    // A finished 91x13 run that filled its screen, its cursor on the last row's last cell, at Larger (17 px type,
    // cells 10.235 x 24) and then at Default (13 px, 7.827 x 18): the grid xterm draws is 931 x 312, then 712 x 234.
    // xterm moves its input only when the cursor moves, so it stayed at 920.8, 288 (scrollbars on the box, for good).
    const larger = { left: "920.769px", top: "288px", width: "10.2308px", height: "24px", lineHeight: "24px" };
    const moved = inputAtGrid(larger, { width: 931, height: 312 }, { width: 712, height: 234 });
    const px = (v: string) => Number.parseFloat(v);
    expect(px(moved.left)).toBeCloseTo(90 * 712 / 91, 2);
    expect(px(moved.top)).toBeCloseTo(12 * 18, 2);
    expect(px(moved.width)).toBeCloseTo(712 / 91, 2);
    expect(px(moved.height)).toBeCloseTo(18, 2);
    expect(px(moved.lineHeight)).toBeCloseTo(18, 2);
    expect(px(moved.left) + px(moved.width)).toBeLessThanOrEqual(712 + 0.01);
    expect(px(moved.top) + px(moved.height)).toBeLessThanOrEqual(234 + 0.01);
    // And back up (Default -> Larger): the same cell at the larger size.
    const back = inputAtGrid(moved, { width: 712, height: 234 }, { width: 931, height: 312 });
    for (const k of ["left", "top", "width", "height", "lineHeight"] as const) expect(px(back[k]), k).toBeCloseTo(px(larger[k]), 2);
    // Not placed yet (xterm keeps it off the grid until the cursor first moves): it stays so.
    expect(inputAtGrid({ left: "", top: "", width: "", height: "", lineHeight: "" }, { width: 931, height: 312 }, { width: 712, height: 234 }))
      .toEqual({ left: "", top: "", width: "", height: "", lineHeight: "" });
    // A grid it can't read (a terminal never drawn): back to xterm's own place off the grid, never past it.
    for (const bad of [{ width: 0, height: 312 }, { width: Number.NaN, height: 312 }, { width: 931, height: -1 }]) {
      expect(inputAtGrid(larger, bad, { width: 712, height: 234 })).toEqual({ left: "", top: "", width: "", height: "", lineHeight: "" });
      expect(inputAtGrid(larger, { width: 931, height: 312 }, bad)).toEqual({ left: "", top: "", width: "", height: "", lineHeight: "" });
    }
  });

  it("move a run's terminal's hidden input with its type: the same cell at the new size, inside the grid xterm draws", () => {
    const made = fakeXterm();
    const run = createRunTerminal({ cols: 91, rows: 13, interactive: false, mac: false, screenReader: false, scale: 1.3, onInput: () => {} }, made.Term);
    // Not open yet (its tab never shown): the type's size changes, there is nothing to move.
    run.setTextScale(1.15);
    expect(made.terms[0].options.fontSize).toBe(15);
    run.setTextScale(1.3);
    run.open({} as HTMLElement);
    const xt = made.terms[0];
    // A finished run that filled its screen: the cursor on the last row's last cell, at Larger.
    xt.moveCursor(90, 12);
    expect(xt.screen.style).toEqual({ width: "931px", height: "312px" });
    run.setTextScale(1);
    expect(xt.options.fontSize).toBe(13);
    expect(xt.screen.style).toEqual({ width: "712px", height: "234px" });
    const px = (v: string) => Number.parseFloat(v);
    const s = xt.textarea.style;
    expect(px(s.left)).toBeCloseTo(90 * 712 / 91, 2);
    expect(px(s.top)).toBeCloseTo(12 * 18, 2);
    expect(px(s.left) + px(s.width)).toBeLessThanOrEqual(712 + 0.01);
    expect(px(s.top) + px(s.height)).toBeLessThanOrEqual(234 + 0.01);
    // The same size again: xterm isn't asked to redraw, and the input stays.
    const sets = xt.fontSets;
    run.setTextScale(1);
    expect(xt.fontSets).toBe(sets);
    expect(xt.textarea.style.left).toBe(s.left);
  });
});

describe("a new run's size at each text size", () => {
  it("leaves room for the parts round the terminal, which grow with the words and buttons, but not much more", () => {
    for (const m of MEASURED) {
      const chrome = termChromePx(m.scale);
      expect(chrome, String(m.scale)).toBeGreaterThanOrEqual(m.parts);
      expect(chrome - m.parts, String(m.scale)).toBeLessThanOrEqual(50);
    }
    expect(termChromePx(1)).toBe(250);
    // A scale it can't use is the default's.
    for (const bad of [Number.NaN, 0, 3]) expect(termChromePx(bad), String(bad)).toBe(250);
  });

  it("fits a new run inside the terminal's box, whole, at the window main opens for each size", () => {
    for (const m of MEASURED) {
      const fit = fitTerminal(m.cell, m.panels, m.window[1] - termChromePx(m.scale));
      expect(fit, String(m.scale)).toEqual(m.fit);
      // The grid xterm draws (whole px, as it rounds) fits the box with nothing to scroll.
      expect(Math.round(fit.cols * m.cell.width), String(m.scale)).toBeLessThanOrEqual(m.box[0]);
      expect(fit.rows * m.cell.height, String(m.scale)).toBeLessThanOrEqual(m.box[1]);
    }
    // Never below 20 x 5 or above 500 x 200.
    expect(fitTerminal({ width: 8, height: 18 }, 100, 40)).toEqual({ cols: 20, rows: 5 });
    expect(fitTerminal({ width: 1, height: 1 }, 10_000, 10_000)).toEqual({ cols: 500, rows: 200 });
  });

  it("is what the page reports to main, from the cell measured at the text size", () => {
    const main = read("main.ts");
    expect(main).toMatch(/function reportSize\(scale = textScale\): void \{\s*const cell = cellSize\(\$\("measure"\), scale\);/);
    expect(main).toMatch(/fitTerminal\(cell, \$\("panels"\)\.clientWidth, window\.innerHeight - termChromePx\(scale\)\)/);
  });
});

describe("the terminal's sources", () => {
  it("load no addon and listen to no title, bell, clipboard or link event (read from the page's sources)", () => {
    const sources = ["terminal.ts", "terminal-options.ts", "terminal-size.ts", "main.ts"].map(read).join("\n");
    for (const banned of [/\.loadAddon\s*\(/, /\.onTitleChange\s*\(/, /\.onBell\s*\(/, /["']@xterm\/addon/, /registerLinkProvider\s*\(/, /navigator\.clipboard/, /\.onSelectionChange\s*\(/]) {
      expect(sources).not.toMatch(banned);
    }
    // Only terminal.ts loads xterm itself; nothing on the page is built from HTML.
    expect(read("main.ts")).not.toMatch(/from "@xterm\/xterm"/);
    expect(read("terminal.ts")).toMatch(/from "@xterm\/xterm"/);
    expect(read("terminal-size.ts")).not.toMatch(/from "@xterm\/xterm"/);
    for (const f of ["main.ts", "terminal.ts", "terminal-size.ts", "model.ts", "copy.ts", "visible.ts"]) expect(read(f)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

// \u2500\u2500\u2500\u2500\u2500 The reducer \u2500\u2500\u2500\u2500\u2500
const SHA = "d".repeat(64);
const cardOf = (n: number, over: Partial<CommandCard> = {}): CommandCard & { n: number } => ({
  n, runId: "0123456789abcdef", target: "local", targetLabel: "This computer", shell: "bash", cwd: "/home/ana", command: "rm -r build",
  sha256: SHA, taskId: "t", taskTitle: "Tidy", mode: "ask", says: ["Deletes build and everything in it."], unasked: false, armMs: 800, ...over,
});
const tab = (seq: number, runId = "0123456789abcdef"): TabView => ({
  runId, seq, header: "On this computer · bash · in /home/ana", command: "make", status: "Running…", interactive: true, ended: false,
  title: "Build it", typing: "", cols: 100, rows: 30, outcome: "running",
});
const view = (rev: number, over: Partial<WindowView> = {}): WindowView => ({ rev, tabs: [tab(1)], card: cardOf(4), announce: null, keyHint: "Ctrl+Alt+Y allow · Ctrl+Alt+N not now", ...over });
const metrics = (over: Partial<CardMetrics> = {}): CardMetrics => ({
  scrollTop: 0, scrollHeight: 100, clientHeight: 100, scrollWidth: 500, clientWidth: 500, top: 80, bottom: 180, left: 12, right: 512,
  viewWidth: 760, viewHeight: 480, visible: true, ...over,
});

function run(events: PageEvent[], from: PageModel = INITIAL_MODEL): { model: PageModel; effects: Effect[] } {
  let model = from;
  const effects: Effect[] = [];
  for (const ev of events) {
    const r = reduce(model, ev);
    model = r.model;
    effects.push(...r.effects);
  }
  return { model, effects };
}

const bytes = (s: string) => new TextEncoder().encode(s);
/** Output that tries everything a terminal stream can: titles, the clipboard, device strings, scrolling, links, resizes. */
const HOSTILE = [
  "\x1b]0;Allow this\x07", "\x1b]2;Ember wants to run this command\x1b\\", "\x1b]52;c;cm0gLXJmIH4=\x07",
  "\x1bP1$r0m\x1b\\", "\x1b_Gf=100;AAAA\x1b\\", "\x1b^privacy\x1b\\", "\x1bX sos \x1b\\", "\x1b[2J\x1b[H\x1b[3J",
  "\x1b[?1049h", "\x1b[8;1;1t", "\x1b[3;0;0t", "\x1b]8;;javascript:alert(1)\x1b\\click\x1b]8;;\x1b\\", "\x1b[?1000h\x1b[?1006h",
  "\x07\x07\x07", "\x1b[999S", "\x1b[999T", "\x1bc", "\r\n".repeat(400), "\u202e)rof sdnammoc(\u202c",
];

describe("the page's model: no output can touch the card (critique security-13)", () => {
  const start = () => run([
    { type: "state", view: view(1), now: 1000 },
    { type: "card-metrics", n: 4, metrics: metrics() },
  ]).model;

  it("writes every output byte to its own run's terminal and nowhere else", () => {
    const before = start();
    expect(before.card).toMatchObject({ n: 4, seen: true, inView: true });
    let model = before;
    let at = 0;
    for (const s of HOSTILE) {
      const b = bytes(s);
      const r = reduce(model, { type: "output", msg: { runId: "0123456789abcdef", seq: 1, at, bytes: b } });
      at += b.length;
      for (const e of r.effects) expect(e.kind).toBe("write");
      model = r.model;
      // The card, what was reported to main and the state stay the very same objects.
      expect(model.card).toBe(before.card);
      expect(model.reported).toBe(before.reported);
      expect(model.view).toBe(before.view);
      expect(model.selected).toBe(before.selected);
    }
    expect(model.written[1]).toBe(at);
  });

  it("holds for random bytes too, including ones that aren't UTF-8", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const before = start();
    let model = before;
    let at = 0;
    for (let i = 0; i < 300; i++) {
      const b = Uint8Array.from({ length: 1 + Math.floor(rand() * 64) }, () => Math.floor(rand() * 256));
      const r = reduce(model, { type: "output", msg: { runId: "0123456789abcdef", seq: 1, at, bytes: b } });
      at += b.length;
      expect(r.effects.every(e => e.kind === "write")).toBe(true);
      model = r.model;
    }
    expect(model.card).toBe(before.card);
    expect(model.reported).toBe(before.reported);
  });

  it("drops output for a run it doesn't show, and output it already wrote", () => {
    const m = start();
    expect(reduce(m, { type: "output", msg: { runId: "fedcba9876543210", seq: 1, at: 0, bytes: bytes("x") } }).effects).toEqual([]);
    expect(reduce(m, { type: "output", msg: { runId: "0123456789abcdef", seq: 9, at: 0, bytes: bytes("x") } }).effects).toEqual([]);
    const one = reduce(m, { type: "output", msg: { runId: "0123456789abcdef", seq: 1, at: 0, bytes: bytes("hello") } });
    // A replay that overlaps: only the new bytes are written.
    const two = reduce(one.model, { type: "output", msg: { runId: "0123456789abcdef", seq: 1, at: 3, bytes: bytes("lo world") } });
    expect(two.effects).toHaveLength(1);
    expect(new TextDecoder().decode((two.effects[0] as { bytes: Uint8Array }).bytes)).toBe(" world");
    expect(reduce(two.model, { type: "output", msg: { runId: "0123456789abcdef", seq: 1, at: 0, bytes: bytes("hello") } }).effects).toEqual([]);
    expect(reduce(m, { type: "output", msg: { runId: "0123456789abcdef", seq: 1, at: -1, bytes: bytes("x") } }).effects).toEqual([]);
  });

  it("keeps the card's state when main pushes a new state for the same question (output and tabs changing)", () => {
    const m = start();
    const r = reduce(m, { type: "state", view: view(2, { tabs: [tab(2, "fedcba9876543210"), tab(1)] }), now: 99_999 });
    expect(r.model.card).toEqual(m.card);
    expect(r.model.selected).toBe("fedcba9876543210");
    expect(r.effects).toEqual([]);
  });
});

describe("the page's model: seen, in view and Allow", () => {
  it("counts a command that fits and shows as seen and in view at once", () => {
    const { model, effects } = run([{ type: "state", view: view(1), now: 0 }, { type: "card-metrics", n: 4, metrics: metrics() }]);
    expect(model.card).toMatchObject({ fits: true, seen: true, inView: true });
    expect(effects).toEqual([{ kind: "report", msg: { n: 4, inView: true, seen: true } }]);
  });

  it("needs a long command scrolled to its end before it counts as seen, and never as in view", () => {
    const long = metrics({ scrollHeight: 900, clientHeight: 200 });
    const a = run([{ type: "state", view: view(1), now: 0 }, { type: "card-metrics", n: 4, metrics: long }]);
    expect(a.model.card).toMatchObject({ fits: false, seen: false, inView: false });
    expect(allowHint(a.model.card)).toBe("Read the whole command to allow it.");
    const b = run([{ type: "card-metrics", n: 4, metrics: { ...long, scrollTop: 700 } }], a.model);
    expect(b.model.card).toMatchObject({ atEnd: true, seen: true, inView: false });
    expect(allowHint(b.model.card)).toBeNull();
    // Seen sticks when it is scrolled back up.
    const c = run([{ type: "card-metrics", n: 4, metrics: long }], b.model);
    expect(c.model.card?.seen).toBe(true);
  });

  it("doesn't count a block that is cut off by the window, or a hidden page", () => {
    for (const m of [metrics({ bottom: 500 }), metrics({ top: -20 }), metrics({ right: 900 }), metrics({ visible: false }), metrics({ clientHeight: 0, scrollHeight: 0 })]) {
      const r = run([{ type: "state", view: view(1), now: 0 }, { type: "card-metrics", n: 4, metrics: m }]);
      expect(r.model.card?.seen, JSON.stringify(m)).toBe(false);
      expect(judgeMetrics(m).onScreen).toBe(false);
    }
  });

  it("doesn't count a block its scrolling card area cuts off, though it is inside the window, and withdraws 'in view' when it is", () => {
    // The card area ends at 150 px (an announcement above pushed the question down): the block (80-180) is cut off.
    const cut = metrics({ clip: { top: 12, bottom: 150, left: 12, right: 748 } });
    expect(judgeMetrics(cut).onScreen).toBe(false);
    const a = run([{ type: "state", view: view(1), now: 0 }, { type: "card-metrics", n: 4, metrics: cut }]);
    expect(a.model.card).toMatchObject({ seen: false, inView: false });
    // Inside the card area: seen and in view; scrolled out of it again: no longer in view (seen sticks).
    const b = run([{ type: "card-metrics", n: 4, metrics: metrics({ clip: { top: 12, bottom: 340, left: 12, right: 748 } }) }], a.model);
    expect(b.model.card).toMatchObject({ seen: true, inView: true });
    const c = run([{ type: "card-metrics", n: 4, metrics: metrics({ top: 0, bottom: 100, clip: { top: 12, bottom: 340, left: 12, right: 748 } }) }], b.model);
    expect(c.model.card).toMatchObject({ seen: true, inView: false });
    expect(c.effects).toEqual([{ kind: "report", msg: { n: 4, inView: false, seen: true } }]);
    expect(judgeMetrics(metrics({ clip: { top: Number.NaN, bottom: 340, left: 12, right: 748 } })).onScreen).toBe(false);
  });

  it("never counts a block whose lines run off to the side as read through, even scrolled to its end", () => {
    const wide = metrics({ scrollWidth: 900, clientWidth: 500 });
    expect(judgeMetrics(wide)).toMatchObject({ fits: false, atEnd: false });
    const r = run([{ type: "state", view: view(1), now: 0 }, { type: "card-metrics", n: 4, metrics: wide }]);
    expect(r.model.card).toMatchObject({ seen: false, inView: false });
  });

  it("reports only changes, ignores another question's measurements, and starts over for a new question", () => {
    const a = run([{ type: "state", view: view(1), now: 0 }, { type: "card-metrics", n: 4, metrics: metrics() }, { type: "card-metrics", n: 4, metrics: metrics() }]);
    expect(a.effects).toHaveLength(1);
    expect(run([{ type: "card-metrics", n: 5, metrics: metrics() }], a.model).model).toBe(a.model);
    const b = run([{ type: "state", view: view(2, { card: cardOf(5, { sha256: "e".repeat(64) }) }), now: 10 }], a.model);
    expect(b.model.card).toMatchObject({ n: 5, seen: false, inView: false, shownAt: 10 });
    // The old card's "in view" is withdrawn at once.
    expect(b.effects).toEqual([{ kind: "report", msg: { n: 4, inView: false, seen: true } }]);
    const c = run([{ type: "state", view: view(3, { card: null }), now: 20 }], a.model);
    expect(c.model.card).toBeNull();
  });

  it("ignores a state older than the one it has", () => {
    const a = run([{ type: "state", view: view(5), now: 0 }]);
    expect(run([{ type: "state", view: view(4, { card: null }), now: 1 }], a.model).model).toBe(a.model);
  });

  it("arms Allow only after the arm time and once the whole command was seen", () => {
    const a = run([{ type: "state", view: view(1), now: 1000 }]);
    expect(allowEnabled(a.model.card, 5000)).toBe(false);
    const b = run([{ type: "card-metrics", n: 4, metrics: metrics() }], a.model);
    expect(allowEnabled(b.model.card, 1799)).toBe(false);
    expect(allowEnabled(b.model.card, 1800)).toBe(true);
    expect(allowAnswer(cardOf(4), b.model.card, 1800)).toEqual({ n: 4, answer: "once", sha256: SHA });
    expect(allowAnswer(cardOf(4), b.model.card, 1000)).toBeNull();
    expect(allowAnswer(cardOf(4, { sha256: "f".repeat(64) }), b.model.card, 1800)).toBeNull();
    expect(allowAnswer(null, b.model.card, 1800)).toBeNull();
  });

  it("selects the newest run's tab, and keeps a choice while the tabs stay", () => {
    const a = run([{ type: "state", view: view(1, { tabs: [tab(1)] }), now: 0 }]);
    expect(a.model.selected).toBe("0123456789abcdef");
    const b = run([{ type: "state", view: view(2, { tabs: [tab(2, "fedcba9876543210"), tab(1)] }), now: 0 }], a.model);
    expect(b.model.selected).toBe("fedcba9876543210");
    const c = run([{ type: "select", runId: "0123456789abcdef" }, { type: "state", view: view(3, { tabs: [tab(2, "fedcba9876543210"), tab(1)] }), now: 0 }], b.model);
    expect(c.model.selected).toBe("0123456789abcdef");
    const d = run([{ type: "state", view: view(4, { tabs: [tab(2, "fedcba9876543210")] }), now: 0 }], c.model);
    expect(d.model.selected).toBe("fedcba9876543210");
    expect(d.model.written).toEqual({});
  });
});

describe("the page's pending lines (a task whose command has no tab yet)", () => {
  const view = (pending?: unknown): WindowView => ({ rev: 1, tabs: [], card: null, announce: null, keyHint: null, ...(pending === undefined ? {} : { pending }) } as WindowView);

  it("draws each different line once, in order, at most a few, and nothing for none or odd input", () => {
    expect(pendingLines(null)).toEqual([]);
    expect(pendingLines(view())).toEqual([]);
    expect(pendingLines(view([{ taskId: "t1", text: "Starting Ubuntu…" }, { taskId: "t2", text: "Starting Ubuntu…" }, { taskId: "t3", text: "Starting Debian…" }])))
      .toEqual(["Starting Ubuntu…", "Starting Debian…"]);
    expect(pendingLines(view([{ taskId: "t1", text: "  " }, null, { taskId: "t2" }, { taskId: "t3", text: 5 }]))).toEqual([]);
    expect(pendingLines(view("Starting Ubuntu…"))).toEqual([]);
    const many = Array.from({ length: 9 }, (_, k) => ({ taskId: `t${k}`, text: `Starting D${k}…` }));
    expect(pendingLines(view(many))).toHaveLength(MAX_PENDING_LINES);
  });

  it("are built as text nodes in their own status region, above the tabs, and hide the empty text", () => {
    const main = read("main.ts");
    expect(main).toMatch(/el\("p", "pending-line", text\)/);
    expect(main).toMatch(/\|\| lines\.length > 0;/);
    const html = read("index.html");
    expect(html).toMatch(/<div id="pending" class="pending" role="status" aria-live="polite" hidden><\/div>/);
    expect(html.indexOf('id="pending"')).toBeLessThan(html.indexOf('id="tabs"'));
  });
});

describe("visibleText (critique security-10)", () => {
  const kinds = (s: string) => visibleText(s).map(x => [x.kind, x.text]);

  it("shows controls, bidi controls, invisible characters, tabs and non-breaking spaces as tokens", () => {
    expect(kinds("echo\x1b[31m")).toEqual([["plain", "echo"], ["control", "⟨U+001B⟩"], ["plain", "[31m"]]);
    expect(kinds("ls\u202etxt.exe")).toEqual([["plain", "ls"], ["bidi", "⟨RLO⟩"], ["plain", "txt.exe"]]);
    expect(kinds("r\u200bm")).toEqual([["plain", "r"], ["invisible", "⟨ZWSP⟩"], ["plain", "m"]]);
    expect(kinds("a\tb")).toEqual([["plain", "a"], ["tab", "→"], ["plain", "b"]]);
    expect(kinds("a\u00a0b")).toEqual([["plain", "a"], ["nbsp", "⟨NBSP⟩"], ["plain", "b"]]);
    // An odd space is shown as one, in the same colour as a non-breaking space (CL's visibleText, which the pages use).
    expect(kinds("a\u2009b")).toEqual([["plain", "a"], ["nbsp", "⟨U+2009⟩"], ["plain", "b"]]);
    expect(kinds("\x85\x7f\u2028")).toEqual([["control", "⟨U+0085⟩"], ["control", "⟨U+007F⟩"], ["control", "⟨U+2028⟩"]]);
    expect(kinds("x\u{e0041}\ufe0f\u2066\u2069\u200e\u061c")).toEqual([
      ["plain", "x"], ["invisible", "⟨U+E0041⟩"], ["invisible", "⟨U+FE0F⟩"], ["bidi", "⟨LRI⟩"], ["bidi", "⟨PDI⟩"], ["bidi", "⟨LRM⟩"], ["bidi", "⟨ALM⟩"],
    ]);
    // An unpaired surrogate or a noncharacter would draw as a box or nothing: shown by its code point.
    expect(kinds("r\ud800m\uffff\ufdd0")).toEqual([["plain", "r"], ["invisible", "⟨U+D800⟩"], ["plain", "m"], ["invisible", "⟨U+FFFF⟩"], ["invisible", "⟨U+FDD0⟩"]]);
  });

  it("marks a letter from another alphabet in every token, Cyrillic in a Latin word or Latin in a Cyrillic one", () => {
    expect(kinds("cd bu\u0456ld")).toEqual([["plain", "cd bu"], ["mixed", "\u0456"], ["plain", "ld"]]);
    expect(kinds("r\u043c -rf")).toEqual([["plain", "r"], ["mixed", "\u043c"], ["plain", " -rf"]]);
    expect(kinds("\u043f\u0440\u0438\u0432\u0435\u0442 hello")).toEqual([["plain", "\u043f\u0440\u0438\u0432\u0435\u0442 hello"]]);
    expect(kinds("\u{1d42b}m")).toEqual([["mixed", "\u{1d42b}"], ["plain", "m"]]);
    // Japanese mixes its own scripts, and digits and punctuation belong to none; Latin letters beside them are marked
    // like any other mix (§3.9.1).
    expect(kinds("cat \u65e5\u672c\u8a9e\u306e\u30d5\u30a1\u30a4\u30eb-2.\u6587\u66f8")).toEqual([["plain", "cat \u65e5\u672c\u8a9e\u306e\u30d5\u30a1\u30a4\u30eb-2.\u6587\u66f8"]]);
    expect(kinds("cat \u65e5\u672c\u8a9e\u306e\u30d5\u30a1\u30a4\u30eb.txt")).toEqual([["plain", "cat \u65e5\u672c\u8a9e\u306e\u30d5\u30a1\u30a4\u30eb."], ["mixed", "txt"]]);
    expect(kinds("ls -la ./build-01/")).toEqual([["plain", "ls -la ./build-01/"]]);
  });

  it("keeps a plain command in one plain segment, and never throws on odd input", () => {
    expect(visibleText("git status")).toEqual([{ text: "git status", kind: "plain" }]);
    expect(visibleText("")).toEqual([]);
    expect(() => visibleText("\ud800 lone surrogate")).not.toThrow();
  });

  it("says which legend lines a string needs, and breaks lines after a newline token", () => {
    expect(legendFor(visibleText("ls"))).toEqual({ tokens: false, mixed: false, rtl: false });
    expect(legendFor(visibleText("ls\u200b"))).toEqual({ tokens: true, mixed: false, rtl: false });
    expect(legendFor(visibleText("bu\u0456ld"))).toEqual({ tokens: false, mixed: true, rtl: false });
    expect(legendFor(visibleText("a\tb"))).toEqual({ tokens: false, mixed: false, rtl: false });
    // A newline is the command's own line break (a here-document spans lines): kept as itself, the page's pre-wrap
    // block ends the line there; a segment that carries it as a control still ends its line.
    expect(kinds("a\nb")).toEqual([["plain", "a\nb"]]);
    expect(breaksLine({ kind: "control", text: "⟨U+000A⟩" })).toBe(true);
    expect(breaksLine({ kind: "control", text: "\n" })).toBe(true);
    expect(breaksLine({ kind: "control", text: "⟨U+000D⟩" })).toBe(false);
  });

  it("shows a raw character the same way when a segment carries it instead of its token", () => {
    expect(segmentLabel({ kind: "bidi", text: "\u202e" })).toBe("⟨RLO⟩");
    expect(segmentLabel({ kind: "control", text: "\x1b" })).toBe("⟨U+001B⟩");
    expect(segmentLabel({ kind: "tab", text: "\t" })).toBe("→");
    expect(segmentLabel({ kind: "nbsp", text: "\u00a0" })).toBe("⟨NBSP⟩");
    expect(segmentLabel({ kind: "invisible", text: "⟨ZWSP⟩" })).toBe("⟨ZWSP⟩");
    expect(segmentLabel({ kind: "mixed", text: "\u0456" })).toBe("\u0456");
  });
});

describe("right-to-left letters in a command (review #273)", () => {
  it("are noted by a legend line, so the user knows the card shows the order that runs", () => {
    expect(legendFor(visibleText("chmod -R 755 \u05e9\u05dc\u05d5\u05dd 777 /srv/data")).rtl).toBe(true);
    expect(legendFor(visibleText("cat \u0645\u0644\u0641.txt")).rtl).toBe(true);
    expect(legendFor(visibleText("rm -r build")).rtl).toBe(false);
    expect(legendFor(visibleText("ls \u043f\u0430\u043f\u043a\u0430")).rtl).toBe(false);
  });

  it("are drawn in the order the shell reads them: the command, the header and a tab's label override bidi", () => {
    const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const sel of [".command", ".where", ".tab-label"]) {
      const block = css.split("}").find(b => b.split("{")[0].split(",").map(x => x.trim()).includes(sel) && /unicode-bidi/.test(b)) ?? "";
      expect(block, sel).toMatch(/direction:\s*ltr/);
      expect(block, sel).toMatch(/unicode-bidi:\s*bidi-override/);
    }
  });
});

describe("the command block's semantics (review #48)", () => {
  it("is a read-only text box whose value is the command, and Allow and Stop are described by it", () => {
    const main = read("main.ts");
    const block = /function commandBlock[\s\S]*?\n}/.exec(main)?.[0] ?? "";
    expect(block).toMatch(/setAttribute\("role", "textbox"\)/);
    expect(block).toMatch(/setAttribute\("aria-readonly", "true"\)/);
    expect(block).toMatch(/setAttribute\("aria-multiline", "true"\)/);
    expect(main).toMatch(/allow\.setAttribute\("aria-describedby", "ask-cmd"\)/);
    expect(main).toMatch(/commandBlock\(card\.command, "[^"]+", "ask-cmd"\)/);
    expect(main).toMatch(/stop\.setAttribute\("aria-describedby", "announce-cmd"\)/);
  });
});

describe("a run's terminal and the keyboard (reviews #42, #261, #264, #268)", () => {
  const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
  const on = (mac = false, hasSelection = false) => ({ mac, hasSelection });

  it("lets Tab and Shift+Tab move the focus on every OS, so the terminal never traps the keyboard or types a tab into a prompt", () => {
    for (const mac of [false, true]) {
      expect(termKeyAction(k("Tab"), on(mac))).toBe("browser");
      expect(termKeyAction(k("Tab", { shiftKey: true }), on(mac))).toBe("browser");
    }
    // Ctrl+I is the tab character for a program that needs one; Esc and ordinary keys stay the terminal's.
    expect(termKeyAction(k("i", { ctrlKey: true }), on())).toBe("terminal");
    expect(termKeyAction(k("Escape"), on())).toBe("terminal");
    expect(termKeyAction(k("a"), on())).toBe("terminal");
    expect(termKeyAction(k("Enter"), on())).toBe("terminal");
  });

  it("pastes with Ctrl+V off the Mac (the browser's own paste, sent to the run as typing), never ^V", () => {
    expect(termKeyAction(k("v", { ctrlKey: true }), on())).toBe("browser");
    expect(termKeyAction(k("V", { ctrlKey: true, shiftKey: true }), on())).toBe("browser");
    // On a Mac, Command+V is the Edit menu's and Ctrl+V stays the terminal's.
    expect(termKeyAction(k("v", { ctrlKey: true }), on(true))).toBe("terminal");
  });

  it("copies a selection with Ctrl+C, interrupts without one, and always copies with Ctrl+Shift+C", () => {
    expect(termKeyAction(k("c", { ctrlKey: true }), on(false, true))).toBe("browser");
    expect(termKeyAction(k("c", { ctrlKey: true }), on(false, false))).toBe("terminal");
    expect(termKeyAction(k("C", { ctrlKey: true, shiftKey: true }), on(false, false))).toBe("copy");
    expect(termKeyAction(k("c", { ctrlKey: true }), on(true, true))).toBe("terminal");
    expect(termKeyAction(k("c", { ctrlKey: true, altKey: true }), on(false, true))).toBe("terminal");
  });

  it("puts the keyboard in a run's terminal only when it takes typing, no card is up and nothing else has the focus", () => {
    const base = { interactive: true, ended: false, cardUp: false, focusIdle: true };
    expect(shouldFocusTerminal(base)).toBe(true);
    expect(shouldFocusTerminal({ ...base, interactive: false })).toBe(false);
    expect(shouldFocusTerminal({ ...base, ended: true })).toBe(false);
    expect(shouldFocusTerminal({ ...base, cardUp: true })).toBe(false);
    expect(shouldFocusTerminal({ ...base, focusIdle: false })).toBe(false);
  });

  it("wires those keys into xterm, keeps a run that takes no typing out of the Tab order, and puts Stop before the terminal", () => {
    const term = read("terminal.ts"), main = read("main.ts"), css = read("styles.css");
    expect(term).toMatch(/attachCustomKeyEventHandler\(/);
    expect(term).toMatch(/termKeyAction\(e, /);
    expect(term).toMatch(/tabIndex = interactive \? 0 : -1/);
    expect(main).toMatch(/panel\.append\(header\.node, block, \.\.\.legends, foot, host, typing\)/);
    expect(main).toMatch(/foot\.append\(status, live, copy, action\)/);
    expect(css).toMatch(/\.term:focus-within\s*\{[^}]*--focus-ring/);
  });
});

describe("the question card's layout (review #265)", () => {
  it("keeps Allow and Not now in view at the bottom of the card area, and counts nothing under them as in view", () => {
    const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const block = (sel: string) => css.split("}").find(b => b.split("{")[0].split(",").map(x => x.trim()).includes(sel)) ?? "";
    expect(block(".card .actions")).toMatch(/position:\s*sticky/);
    expect(block(".card .actions")).toMatch(/bottom:\s*0/);
    expect(block(".window.cards-only .cards")).toMatch(/max-height:\s*none/);
    const main = read("main.ts");
    expect(main).toMatch(/actions\.append\(hint, row, keys\)/);
    expect(main).toMatch(/clip\.bottom = Math\.min\(clip\.bottom, ask\.actions\.getBoundingClientRect\(\)\.top\)/);
    expect(main).toMatch(/classList\.toggle\("cards-only"/);
  });

  it("judges a command block that runs under the buttons as not in view", () => {
    // The block's bottom (300) is below the top of the buttons' bar (280): the clip says so.
    const m = { scrollTop: 0, scrollHeight: 100, clientHeight: 100, scrollWidth: 500, clientWidth: 500, top: 200, bottom: 300, left: 12, right: 512, viewWidth: 760, viewHeight: 480, visible: true };
    expect(judgeMetrics({ ...m, clip: { top: 0, bottom: 280, left: 0, right: 760 } }).onScreen).toBe(false);
    expect(judgeMetrics({ ...m, clip: { top: 0, bottom: 320, left: 0, right: 760 } }).onScreen).toBe(true);
  });
});

describe("a tab's status line and a screen reader (review #276)", () => {
  it("announces a status once, not each second of a countdown", () => {
    const stalled = (n: number) => `build-01 isn't answering. This command stops in ${n} s unless the link comes back.`;
    expect(sameAnnouncement(stalled(14), stalled(13))).toBe(true);
    expect(sameAnnouncement(stalled(1), stalled(0))).toBe(true);
    expect(sameAnnouncement(stalled(5), "Running…")).toBe(false);
    expect(sameAnnouncement("Running…", "Finished in 3.2 s.")).toBe(false);
    expect(sameAnnouncement("Finished in 3.2 s.", "Ended with exit code 2 after 1.1 s.")).toBe(false);
  });

  it("keeps the visible status out of the live region; a hidden live line says each new status once", () => {
    const main = read("main.ts");
    const buildTab = /function buildTab[\s\S]*?\n}/.exec(main)?.[0] ?? "";
    expect(buildTab).not.toMatch(/status\.setAttribute\("role", "status"\)/);
    expect(buildTab).toMatch(/el\("p", "sr status-live"/);
    expect(buildTab).toMatch(/setAttribute\("role", "status"\)/);
    expect(main).toMatch(/sameAnnouncement\(/);
  });
});

describe("the page's wiring that only a real window shows (reviews #262, #264, #271)", () => {
  const main = read("main.ts");
  /** A top-level function's source, from its declaration to its closing brace at the start of a line. */
  const fn = (name: string) => new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n}`).exec(main)?.[0] ?? "";

  it("asks before closing with an alert dialog whose keyboard starts on Keep it open, and answers main both ways (#262)", () => {
    const closing = fn("buildClosing");
    expect(closing).toMatch(/setAttribute\("role", "alertdialog"\)/);
    expect(closing).toMatch(/requestAnimationFrame\(\(\) => keep\.focus\(\)\)/);
    expect(closing).toMatch(/stop\.addEventListener\("click", [^\n]*api\.closeWindow\(true\)/);
    expect(closing).toMatch(/keep\.addEventListener\("click", [^\n]*api\.closeWindow\(false\)/);
    // Only the user's own click answers it.
    expect(closing.match(/e\.isTrusted/g)).toHaveLength(2);
    expect(fn("render")).toMatch(/buildClosing\(closingRunning\)/);
  });

  it("gives the card's buttons back when main says the answer wasn't taken (#271)", () => {
    const render = fn("render");
    expect(render).toMatch(/\(card\.retry \?\? 0\) > ask\.retry/);
    expect(render).toMatch(/ask\.sent = false;/);
    expect(render).toMatch(/ask\.deny\.disabled = false;/);
    // Allow comes back through paintAllow, which enables it once nothing has been sent.
    expect(render).toMatch(/paintAllow\(\)/);
    expect(fn("paintAllow")).toMatch(/if \(!ask\.sent\) ask\.allow\.disabled = !on;/);
  });

  it("puts the keyboard in a run that takes typing after each render and when the window comes up (#264)", () => {
    expect(fn("render")).toMatch(/\n {2}focusTerminal\(\);/);
    expect(main).toMatch(/window\.addEventListener\("focus", \(\) => focusTerminal\(\)\)/);
    expect(fn("focusTerminal")).toMatch(/shouldFocusTerminal\(/);
    expect(fn("focusTerminal")).toMatch(/e\.term\.focus\(\)/);
  });
});
