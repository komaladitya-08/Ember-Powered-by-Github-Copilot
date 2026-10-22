/**
 * The command window's page, tested through its pure modules (vitest runs in Node: no DOM, no xterm; critique
 * integration-29): the exact xterm options (\u00a73.10), the reducer that keeps the card apart from every output byte
 * (critique security-13), Allow's arming, and visibleText's tokens and mixed-script marks (critique security-10).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { INERT_LINKS, XTERM_OPTIONS, terminalOptions } from "../../app/renderer/command/terminal-options";
import {
  INITIAL_MODEL, allowAnswer, allowEnabled, allowHint, judgeMetrics, reduce, type CardMetrics, type Effect, type PageEvent, type PageModel, type TabView, type WindowView,
} from "../../app/renderer/command/model";
import { breaksLine, legendFor, segmentLabel, visibleText } from "../../app/renderer/command/visible";
import type { CommandCard } from "../../app/main/commands/types";

const read = (f: string) => readFileSync(new URL(`../../app/renderer/command/${f}`, import.meta.url), "utf8");

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

  it("take typing only for a run that takes it, at the run's size", () => {
    expect(terminalOptions({ interactive: true, cols: 120, rows: 40 })).toMatchObject({ disableStdin: false, cols: 120, rows: 40, scrollback: 5000 });
    expect(terminalOptions({ interactive: false, cols: 120, rows: 40 }).disableStdin).toBe(true);
    expect(terminalOptions({ interactive: false, cols: 3, rows: 9999 })).toMatchObject({ cols: 100, rows: 30 });
  });

  it("load no addon and listen to no title, bell, clipboard or link event (read from the page's sources)", () => {
    const sources = ["terminal.ts", "terminal-options.ts", "main.ts"].map(read).join("\n");
    for (const banned of [/\.loadAddon\s*\(/, /\.onTitleChange\s*\(/, /\.onBell\s*\(/, /["']@xterm\/addon/, /registerLinkProvider\s*\(/, /navigator\.clipboard/, /\.onSelectionChange\s*\(/]) {
      expect(sources).not.toMatch(banned);
    }
    // Only terminal.ts loads xterm itself; nothing on the page is built from HTML.
    expect(read("main.ts")).not.toMatch(/from "@xterm\/xterm"/);
    expect(read("terminal.ts")).toMatch(/from "@xterm\/xterm"/);
    for (const f of ["main.ts", "terminal.ts", "model.ts", "copy.ts", "visible.ts"]) expect(read(f)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
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
    // Japanese mixes its scripts; digits and punctuation belong to none.
    expect(kinds("cat \u65e5\u672c\u8a9e\u306e\u30d5\u30a1\u30a4\u30eb.txt")).toEqual([["plain", "cat \u65e5\u672c\u8a9e\u306e\u30d5\u30a1\u30a4\u30eb.txt"]]);
    expect(kinds("ls -la ./build-01/")).toEqual([["plain", "ls -la ./build-01/"]]);
  });

  it("keeps a plain command in one plain segment, and never throws on odd input", () => {
    expect(visibleText("git status")).toEqual([{ text: "git status", kind: "plain" }]);
    expect(visibleText("")).toEqual([]);
    expect(() => visibleText("\ud800 lone surrogate")).not.toThrow();
  });

  it("says which legend lines a string needs, and breaks lines after a newline token", () => {
    expect(legendFor(visibleText("ls"))).toEqual({ tokens: false, mixed: false });
    expect(legendFor(visibleText("ls\u200b"))).toEqual({ tokens: true, mixed: false });
    expect(legendFor(visibleText("bu\u0456ld"))).toEqual({ tokens: false, mixed: true });
    expect(legendFor(visibleText("a\tb"))).toEqual({ tokens: false, mixed: false });
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
