/**
 * The bubble's motion in a real Chromium (Electron on Xvfb), frame by frame: a question comes in by its opacity alone,
 * never growing or sliding under the pointer, whatever the bubble showed before (design-system.md "Nothing near a
 * pending question moves"); an ordinary answer still grows out of Ember. The overlay never passes a mood to a hidden
 * bubble, so a question arrives on a bubble still posed as it was (thinking, working): the reviewer measured it scaling
 * 0.96 to 1 and sliding 4 px over 420 ms with the mood and the show in one frame, and for 160 ms with the mood a frame
 * earlier. Skipped without Xvfb or off Linux, except with EMBER_ATSPI_TEST=1 (RHEL 8 CI), where a missing one fails.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { electronBinary } from "./vocabulary-clipboard";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const xvfb = process.platform === "linux" && spawnSync("sh", ["-c", "command -v Xvfb"], { stdio: "ignore" }).status === 0;
const required = process.env.EMBER_ATSPI_TEST === "1" && process.platform === "linux";

/**
 * The page's script: the real ReasoningBubble, driven through each sequence. Its look is sampled on the transitions' own
 * clock (Web Animations: each one paused and sought every 20 ms over 600 ms), not by waiting for frames, so a slow runner,
 * or one that gives the window no frames for a while, samples the same as a fast one.
 */
const PAGE = `
import { ReasoningBubble } from "./packages/bubble/src/bubble";
type Sample = { scale: string; translate: string; opacity: number };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const look = (b: ReasoningBubble): Sample => { const cs = getComputedStyle(b.root); return { scale: cs.scale, translate: cs.translate, opacity: Number(cs.opacity) }; };
/** Its look every 20 ms of its first ms after the style that starts its transitions, on their own clock. */
function watch(b: ReasoningBubble, ms: number): Sample[] {
  look(b);
  const anims = b.root.getAnimations();
  for (const a of anims) a.pause();
  const out: Sample[] = [];
  for (let t = 0; t <= ms; t += 20) {
    for (const a of anims) a.currentTime = t;
    out.push(look(b));
  }
  for (const a of anims) a.finish();
  return out;
}
/** One frame passing: the style resolved, and what it started 16 ms on. */
function oneFrame(b: ReasoningBubble): void {
  look(b);
  for (const a of b.root.getAnimations()) a.currentTime = 16;
}
/** A bubble posed as it is once hidden after \`mood\`: every transition run to its end. */
function hiddenAs(mood: string, thought: string): { b: ReasoningBubble; host: HTMLElement } {
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0";
  document.body.append(host);
  const b = new ReasoningBubble(host);
  b.setMood(mood as never);
  b.setThought(thought);
  b.place({ x: 200, y: 120 }, { width: 900, height: 600 }, 60);
  look(b);
  b.setVisible(false);
  look(b);
  for (const a of b.root.getAnimations()) a.finish();
  return { b, host };
}
/** Then a question: its mood and the show in one frame, or its mood a frame before. */
async function question(before: string, sameFrame: boolean): Promise<Sample[]> {
  const { b, host } = hiddenAs(before, "Reading the window");
  await sleep(20);
  b.setMood("attention");
  b.setThought("May I click Send in Mail?");
  if (!sameFrame) oneFrame(b);
  b.setVisible(true);
  b.place({ x: 200, y: 120 }, { width: 900, height: 600 }, 60);
  const s = watch(b, 600);
  host.remove();
  return s;
}
async function answer(): Promise<Sample[]> {
  const { b, host } = hiddenAs("idle", "Revenue grew in every region.");
  await sleep(20);
  b.setVisible(true);
  b.place({ x: 200, y: 120 }, { width: 900, height: 600 }, 60);
  const s = watch(b, 600);
  host.remove();
  return s;
}
/** Ember's suggestions under an answer: where the chips are, and whether the overlay takes clicks there (interactiveRects). */
function chips(): { row: { x: number; y: number; w: number; h: number } | null; covered: boolean; buttons: number; labelledBy: string } {
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0";
  document.body.append(host);
  const b = new ReasoningBubble(host);
  b.setThought("Opened your notes in Text Editor.");
  b.setSuggestions([{ label: "Close it", onClick: () => undefined }, { label: "Read it out", onClick: () => undefined }]);
  b.place({ x: 200, y: 120 }, { width: 900, height: 600 }, 60);
  look(b);
  const row = b.root.querySelector<HTMLElement>(".eb-suggest")!;
  const r = row.getBoundingClientRect();
  const hot = b.interactiveRects(0);
  const covered = hot.some(h => h.x <= r.x + 1 && h.y <= r.y + 1 && h.x + h.width >= r.right - 1 && h.y + h.height >= r.bottom - 1);
  const out = { row: row.hidden ? null : { x: r.x, y: r.y, w: r.width, h: r.height }, covered, buttons: row.querySelectorAll("button").length, labelledBy: row.getAttribute("aria-labelledby") ?? "" };
  b.setSuggestions(null);
  const gone = row.hidden;
  host.remove();
  return gone ? out : { ...out, row: null };
}
/**
 * A question's key hint on each OS, at the narrowest the bubble gets and beside the Ask box, at Default and Larger text:
 * how far its keys reach past the glass's inner edge (the bubble's content box, px), how far the step's own text does
 * (a flex item as wide as its widest chord, so it widened with a hint that ran past and hid it: companion-v4-2), and for
 * each chord after the first whether the " · " before it shows and whether it shares a line with the chord before it.
 */
function keyHints(): { name: string; over: number; textOver: number; seps: { shown: boolean; sameLine: boolean }[] }[] {
  const out: { name: string; over: number; textOver: number; seps: { shown: boolean; sameLine: boolean }[] }[] = [];
  const html = document.documentElement;
  const steps: [string, string][] = [["linux", "Ctrl+Alt+Y allow · Ctrl+Alt+N not now"], ["windows", "Win+Alt+Y allow · Win+Alt+N not now"],
    ["mac", "Control+Shift+Command+Y allow · Control+Shift+Command+N not now"], ["mac whole text", "Control+Shift+Command+Y shows the next part · Control+Shift+Command+N not now"]];
  for (const [size, scale] of [["default", "1"], ["larger", "1.3"]]) {
    html.dataset.textSize = size;
    html.style.setProperty("--text-scale", scale);
    for (const [os, step] of steps) for (const width of [0, 220, 273]) {
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;inset:0";
      document.body.append(host);
      const b = new ReasoningBubble(host);
      b.setMood("attention");
      b.setThought("May I click Apply in Settings?");
      b.setActions([{ key: "q1:once", label: "Allow", primary: true, onClick: () => undefined }, { key: "q1:deny", label: "Not now", onClick: () => undefined }]);
      b.setStep(step);
      b.setVisible(true);
      // Its own width (0), or narrowed as place() narrows it (useWidth).
      if (width) { b.root.style.width = width + "px"; b.root.style.boxSizing = "border-box"; }
      const text = b.root.querySelector<HTMLElement>(".eb-step-text")!.getBoundingClientRect();
      const rs = getComputedStyle(b.root);
      const inner = b.root.getBoundingClientRect().right - parseFloat(rs.paddingRight) - parseFloat(rs.borderRightWidth);
      const reach = Math.max(...[...b.root.querySelectorAll<HTMLElement>(".eb-step kbd, .eb-step .eb-key-word")].map(e => e.getBoundingClientRect().right));
      const chords = [...b.root.querySelectorAll<HTMLElement>(".eb-key")];
      const em = parseFloat(getComputedStyle(b.root.querySelector(".eb-step-text")!).fontSize);
      // A chord's " · " is in the 1em before its keys; the list's first 1em, left of the row, is clipped.
      const seps = chords.slice(1).map((c, i) => {
        const r = c.getBoundingClientRect(), prev = chords[i].getBoundingClientRect();
        return { shown: r.left >= text.left - 0.5, sameLine: r.top < prev.bottom - 1 };
      });
      out.push({ name: os + " " + (width ? width + " px" : "at its own width") + " at " + size + " text", over: Math.max(0, reach - inner), textOver: Math.max(0, text.right - inner), seps });
      host.remove();
    }
  }
  delete html.dataset.textSize;
  html.style.removeProperty("--text-scale");
  return out;
}
(window as unknown as { start: () => Promise<void> }).start = async () => {
  // A first run, thrown away: the page's fonts, layout and the bubble's style sheet in place before anything counts.
  await question("thinking", true);
  const result = {
    thinkingSame: await question("thinking", true),
    thinkingNext: await question("thinking", false),
    actingSame: await question("acting", true),
    idleNext: await question("idle", false),
    answer: await answer(),
    chips: chips(),
    keyHints: keyHints(),
  };
  (window as unknown as { done: unknown }).done = result;
};
`;

const MAIN = `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.whenReady().then(async () => {
  setTimeout(() => app.exit(3), 30_000);
  const win = new BrowserWindow({ width: 1000, height: 700, show: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, "page.html"));
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => { window.start(); return true; })");
  for (let i = 0; i < 200; i++) {
    const r = await win.webContents.executeJavaScript("window.done ?? null");
    if (r) { process.stdout.write("RESULT " + JSON.stringify(r) + "\\n"); app.exit(0); return; }
    await new Promise(r => setTimeout(r, 100));
  }
  app.exit(4);
});
`;

type Sample = { scale: string; translate: string; opacity: number };
type Result = Record<"thinkingSame" | "thinkingNext" | "actingSame" | "idleNext" | "answer", Sample[]> & {
  chips: { row: { x: number; y: number; w: number; h: number } | null; covered: boolean; buttons: number; labelledBy: string };
  keyHints: { name: string; over: number; textOver: number; seps: { shown: boolean; sameLine: boolean }[] }[];
};

/** How far a sample is from at rest: its scale's distance from 1, its translate in px. */
const scaleOff = (s: Sample) => (s.scale === "none" ? 0 : Math.abs(Number(s.scale.split(" ")[0]) - 1));
const slide = (s: Sample) => (s.translate === "none" ? 0 : Math.max(...s.translate.split(" ").map(v => Math.abs(parseFloat(v)) || 0)));

describe.skipIf(!required && !xvfb)("the bubble's motion, frame by frame in a real Chromium", () => {
  let server: ChildProcess;
  let display = "";
  let dir = "";
  let result: Result;

  beforeAll(async () => {
    if (!xvfb) throw new Error("the bubble's motion can't be checked here: no Xvfb");
    server = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    display = ":" + await new Promise<string>((resolve, reject) => {
      server.stdio[3]!.on("data", (d: Buffer) => resolve(d.toString().trim()));
      server.on("exit", () => reject(new Error("Xvfb didn't start")));
    });
    dir = path.join(root, ".cache", "test", "bubble-motion-electron");
    fs.mkdirSync(dir, { recursive: true });
    buildSync({
      stdin: { contents: PAGE, loader: "ts", resolveDir: root, sourcefile: "bubble-motion-page.ts" },
      bundle: true, platform: "browser", format: "iife", target: "chrome120", outfile: path.join(dir, "page.js"), logLevel: "silent",
    });
    // The page as Ember's overlay has it: the shared design system, then the bubble's own CSS (it adds it itself).
    fs.copyFileSync(path.join(root, "app", "renderer", "shared", "ember.css"), path.join(dir, "ember.css"));
    fs.writeFileSync(path.join(dir, "page.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ember.css"><style>html,body{margin:0;background:transparent}</style></head><body><script src="page.js"></script></body></html>`);
    fs.writeFileSync(path.join(dir, "main.cjs"), MAIN);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "ember-bubble-motion-test", main: "main.cjs" }));
    const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: display, ELECTRON_ENABLE_LOGGING: "0" };
    delete env.ELECTRON_RUN_AS_NODE;
    // A test harness that loads only its own local page, so it runs without the Chromium sandbox: on a runner whose
    // chrome-sandbox isn't set up setuid root (ubuntu's CI) Electron aborts at once with it ("The SUID sandbox helper
    // binary was found, but is not configured correctly"), and as root (EL8's container) it can't run with it at all.
    const child = spawn(electronBinary(), ["--no-sandbox", dir], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    result = await new Promise((resolve, reject) => child.on("exit", code => {
      const line = out.split("\n").find(l => l.startsWith("RESULT "));
      if (line) resolve(JSON.parse(line.slice("RESULT ".length)) as Result);
      else reject(new Error(`the page's Electron exited (${String(code)}) without a result\n${out}\n${err}`));
    }));
  }, 60_000);
  afterAll(() => { server?.kill(); });

  for (const [key, what] of [["thinkingSame", "after thinking, its mood and the show in one frame"], ["thinkingNext", "after thinking, its mood a frame before the show"],
    ["actingSame", "after working"], ["idleNext", "after an answer"]] as const) {
    it(`brings a question in by its opacity alone, never growing or sliding (${what})`, () => {
      const all = result[key];
      // Every 20 ms over 600 ms, on the transitions' own clock.
      expect(all.length).toBe(31);
      // What can be seen (a frame still at opacity 0 shows nothing).
      const s = all.filter(x => x.opacity > 0.001);
      expect(Math.max(...s.map(scaleOff)), JSON.stringify(s.slice(0, 4))).toBeLessThan(0.001);
      expect(Math.max(...s.map(slide)), JSON.stringify(s.slice(0, 4))).toBeLessThan(0.05);
      // It does fade in.
      expect(all[all.length - 1].opacity).toBeCloseTo(1, 2);
    });
  }

  it("still grows an ordinary answer out of Ember", () => {
    expect(Math.max(...result.answer.map(scaleOff))).toBeGreaterThan(0.005);
  });

  it("takes clicks on Ember's suggestions under an answer (interactiveRects covers their row), named by their caption (review of #145)", () => {
    const c = result.chips;
    expect(c.row).not.toBeNull();
    expect(c.row!.h).toBeGreaterThanOrEqual(24);
    expect(c.buttons).toBe(2);
    expect(c.covered).toBe(true);
    expect(c.labelledBy).toMatch(/^eb-suggest-cap-\d+$/);
  });

  it("keeps a question's key hint inside a narrowed bubble on every OS and text size, with no \" · \" ending or starting a line (companion-r3-2, accessibility-visual-r3-2, accessibility-visual-c3-1, companion-v4-2)", () => {
    const all = result.keyHints;
    expect(all.length).toBe(24);
    for (const k of all) {
      // A Mac's four keys at 220 px reached 34 px (Default) and 88 px (Larger) past the glass's inner edge, a whole
      // text's 173 px; measured against the step's own text, which widened with them, it read 0.
      expect(k.over, k.name).toBeLessThan(0.5);
      expect(k.textOver, k.name).toBeLessThan(0.5);
      // The " · " shows only between two chords on one line: never left at a line's end, nor starting the next.
      for (const sep of k.seps) expect(sep.shown, k.name).toBe(sep.sameLine);
    }
    // Where there is room, the two chords still share a line with the " · " between them.
    for (const name of ["linux at its own width at default text", "windows at its own width at larger text"]) {
      expect(all.find(k => k.name === name)!.seps, name).toEqual([{ shown: true, sameLine: true }]);
    }
  });
});
