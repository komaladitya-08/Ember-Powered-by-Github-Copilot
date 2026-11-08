/**
 * The corner card (no compositor) showing a question with a long typed text, on a real X server (Xvfb) with the built
 * pages (dist/app; `npm run build` first), at each text size, with the asking task's row under it as Ember shows it
 * (review #116, the verifier's second pass): the card grows to what it holds, so the question's own sentence stays in
 * view whole, the text's block shows at least three lines, and nothing runs into the buttons or the task row; Allow's
 * word that all of it was seen goes to main only once the block's end is in view on such a card, never on a card too
 * small to show the sentence beside it. The real HandleWindow sizes the window (its fit). Skipped without Xvfb, off
 * Linux, or without a build, except with EMBER_ATSPI_TEST=1 (RHEL 8 CI, which builds first): there a missing one fails.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { electronBinary } from "./vocabulary-clipboard";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distApp = path.join(root, "dist", "app");
const built = fs.existsSync(path.join(distApp, "renderer", "handle", "index.html")) && fs.existsSync(path.join(distApp, "preload", "handle.cjs"));
const xvfb = process.platform === "linux" && spawnSync("sh", ["-c", "command -v Xvfb"], { stdio: "ignore" }).status === 0;
const required = process.env.EMBER_ATSPI_TEST === "1" && process.platform === "linux";

/** A box on the card (CSS px from the window's top), its visible and full heights, and its line height. */
interface Box { top: number; bottom: number; ch: number; sh: number; lh: number; shown: boolean }
interface Layout { vh: number; thought: Box; whole: Box; hint: Box; step: Box; actions: Box; task: Box }
/** An ordinary question (no whole text, accessibility-visual-1): fitted, then squeezed, then fitted again; Allow's hold and what a click on it sent. */
interface Plain { height: number; layout: Layout; keys: { caps: string[]; text: string; stepRight: number; hints: { top: number; bottom: number; right: number; text: string }[] }; held: string | null; squeezedHeld: string | null; squeezedClick: string[]; freedHeld: string | null; freedClick: string[] }
/**
 * A question's key hints as drawn, measured by their text (Range.getClientRects), not their block's box, which is always
 * the column's width: how far right each one's words reach, on how many lines, and the tops of its keycaps.
 */
interface Hints { stepRight: number; winWidth: number; hints: { text: string; right: number; lines: number; capTops: number[] }[] }
interface Report { size: string; height: number; layout: Layout; before: string[]; scrolled: string[]; squeezed: Layout; squeezedSent: string[]; fits: string[]; plain: Plain; wholeKeys: Hints; shiftKeys: Hints }

/** Ember's own HandleWindow and page prefs, in Electron: the card for one text size, the question, what the page sent. */
const CHILD = `
import { app, ipcMain } from "electron";
import { HandleWindow } from "./app/main/handle";
import { applyPagePrefs, pagePrefs } from "./app/main/page-prefs";
import { OVERLAY, type EmberState } from "./app/shared/overlay";

const size = process.argv[process.argv.length - 1];
const LONG = "Dear team, " + "the figures are attached and the plan holds. ".repeat(8) + "MIDDLE-SECRET-PAYLOAD " + "see you at lunch on Thursday. ".repeat(8) + "Bye";
const settings = { character: "cinder", size: 60, textSize: size, reduceMotion: false } as never;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const state = (n: number, text: string): EmberState => ({
  emotion: "curious", talking: false, status: null,
  tasks: [{ id: "t1", title: "Write to the team about the figures", status: "waiting", detail: "Needs your OK", actions: [{ id: "task:t1:stop", label: "Stop" }] }],
  bubble: {
    visible: true, mood: "attention", title: "May I?",
    thought: "Borrow your mouse and keyboard to type \\u201cDear team, \\u2026Bye\\u201d (771 characters) into the \\u201cMessage\\u201d text field in Thunderbird?\\nYour task: Write to the team about the figures",
    step: "Ctrl+Alt+Y shows the next part \\u00b7 Ctrl+Alt+N not now", streaming: false, task: "t1",
    actions: [{ id: "q" + n + ":once", label: "Allow", primary: true }, { id: "q" + n + ":deny", label: "Not now" }],
    whole: { n, text, seen: false, page: 0 },
  },
});
app.whenReady().then(async () => {
  setTimeout(() => app.exit(3), 60_000);
  const sent: string[] = [];
  let card: HandleWindow | null = null;
  ipcMain.on(OVERLAY.handleFit, (_e, h: number) => card?.fit(h));
  ipcMain.on(OVERLAY.bubbleAction, (_e, id: string) => { sent.push(id); });
  ipcMain.on(OVERLAY.handleMenu, () => undefined);
  card = new HandleWindow(() => settings, true);
  const wc = card.win.webContents;
  wc.on("dom-ready", () => void applyPagePrefs(wc, pagePrefs(settings)));
  await new Promise(r => wc.once("did-finish-load", r));
  await sleep(500);
  const measure = (): Promise<unknown> => wc.executeJavaScript(\`(() => {
    const box = id => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return { top: r.top, bottom: r.bottom, ch: e.clientHeight, sh: e.scrollHeight, lh: parseFloat(cs.lineHeight) || 0, shown: cs.display !== "none" && r.height > 0 }; };
    return { vh: innerHeight, thought: box("thought"), whole: box("whole"), hint: box("whole-hint"), step: box("step"), actions: box("actions"), task: box("task") };
  })()\`);
  const toEnd = () => wc.executeJavaScript('(() => { const b = document.getElementById("whole"); b.scrollTop = b.scrollHeight; })()');
  const measureKeys = (): Promise<unknown> => wc.executeJavaScript(\`(() => {
    const top = r => Math.round(r.top);
    const hints = [...document.querySelectorAll("#step .key-hint")].map(h => {
      const range = document.createRange(); range.selectNodeContents(h);
      const rects = [...range.getClientRects()].filter(r => r.width > 0);
      return { text: h.textContent, right: Math.max(...rects.map(r => r.right)), lines: new Set(rects.map(top)).size, capTops: [...h.querySelectorAll("kbd")].map(k => top(k.getBoundingClientRect())) };
    });
    return { stepRight: document.getElementById("step").getBoundingClientRect().right, winWidth: innerWidth, hints };
  })()\`);
  card.sendState(state(1, LONG));
  await sleep(1200);
  const height = card.win.getContentSize()[1];
  const layout = await measure();
  const wholeKeys = await measureKeys();
  const before = [...sent];
  await toEnd();
  await sleep(400);
  const scrolled = [...sent];
  // A card too small for the sentence beside the block (a work area that can't hold it): its end in view says nothing.
  card.sendState(state(2, LONG));
  await sleep(1000);
  card.win.setContentSize(360, 230);
  await sleep(500);
  const squeezed = await measure();
  await toEnd();
  await sleep(400);
  const squeezedSent = [...sent];
  // A short whole text that fits, on a card fitted to it again: in view at once.
  card.sendState(state(3, "Dear team,\\nsee you at lunch.\\nBye"));
  await sleep(1200);
  const fits = [...sent];
  // An ordinary question (no whole text) with three answers: the card grows until its sentence shows whole; on a card
  // too small for it, Allow holds (a real click on it sends nothing) until the card has room again.
  const plainState = state(4, "");
  delete plainState.bubble!.whole;
  plainState.bubble = { ...plainState.bubble!, thought: "Type \\u201cDear team, the meeting moved to Thursday\\u201d into the document in Mousepad?\\nYour task: write the note about the meeting", step: "Ctrl+Alt+Y allow \\u00b7 Ctrl+Alt+N not now",
    actions: [{ id: "q4:allow", label: "Allow", primary: true }, { id: "q4:always", label: "Always in Mousepad" }, { id: "q4:deny", label: "Not now" }] };
  card.sendState(plainState);
  await sleep(1200);
  const plainHeight = card.win.getContentSize()[1];
  const plainLayout = await measure();
  const plainKeys = await wc.executeJavaScript(\`(() => {
    const step = document.getElementById("step").getBoundingClientRect();
    const hints = [...document.querySelectorAll("#step .key-hint")].map(h => { const r = h.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right, text: h.textContent }; });
    return { caps: [...document.querySelectorAll("#step kbd")].map(k => k.textContent), text: document.getElementById("step").textContent, stepRight: step.right, hints };
  })()\`);
  const allowHeld = (): Promise<string | null> => wc.executeJavaScript('document.querySelector("#actions button").getAttribute("aria-disabled")');
  const clickAllow = async (): Promise<string[]> => {
    const at = await wc.executeJavaScript('(() => { const r = document.querySelector("#actions button").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()') as { x: number; y: number };
    const from = sent.length;
    wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
    await sleep(60);
    wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
    await sleep(300);
    return sent.slice(from);
  };
  const held = await allowHeld();
  card.win.setContentSize(360, 200);
  await sleep(500);
  const squeezedHeld = await allowHeld();
  const squeezedClick = await clickAllow();
  card.win.setContentSize(360, plainHeight);
  await sleep(500);
  const freedHeld = await allowHeld();
  const freedClick = await clickAllow();
  const plain = { height: plainHeight, layout: plainLayout, keys: plainKeys, held, squeezedHeld, squeezedClick, freedHeld, freedClick };
  // The same whole text where another app holds the keys, so the hint names the Shift chords (accessibility-visual-c3-1).
  const shiftState = state(5, LONG);
  shiftState.bubble = { ...shiftState.bubble!, step: "Ctrl+Alt+Shift+Y shows the next part \\u00b7 Ctrl+Alt+Shift+N not now" };
  card.sendState(shiftState);
  await sleep(1200);
  const shiftKeys = await measureKeys();
  process.stdout.write("RESULT " + JSON.stringify({ size, height, layout, before, scrolled, squeezed, squeezedSent, fits, plain, wholeKeys, shiftKeys }) + "\\n");
  app.exit(0);
});
`;

describe.skipIf(!required && (!xvfb || !built))("the corner card with a question's whole text, on a real X server", () => {
  let server: ChildProcess;
  let display = "";
  let dir = "";

  beforeAll(async () => {
    if (!xvfb || !built) throw new Error(`the card can't be checked here: ${!xvfb ? "no Xvfb" : "no build (npm run build first)"}`);
    server = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    display = ":" + await new Promise<string>((resolve, reject) => {
      server.stdio[3]!.on("data", (d: Buffer) => resolve(d.toString().trim()));
      server.on("exit", () => reject(new Error("Xvfb didn't start")));
    });
    dir = path.join(root, ".cache", "test", "handle-card-whole-electron");
    fs.mkdirSync(dir, { recursive: true });
    // HandleWindow finds its page and preload beside itself (__dirname): the built ones.
    buildSync({
      stdin: { contents: CHILD, loader: "ts", resolveDir: root, sourcefile: "handle-card-whole-child.ts" },
      bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], outfile: path.join(dir, "main.cjs"), logLevel: "silent",
      define: { __dirname: JSON.stringify(distApp) },
    });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "ember-handle-card-whole-test", main: "main.cjs" }));
  }, 30_000);
  afterAll(() => { server?.kill(); });

  function run(size: string): Promise<Report> {
    const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: display, ELECTRON_ENABLE_LOGGING: "0" };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBinary(), [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), dir, size], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    return new Promise((resolve, reject) => child.on("exit", code => {
      const line = out.split("\n").find(l => l.startsWith("RESULT "));
      if (line) resolve(JSON.parse(line.slice("RESULT ".length)) as Report);
      else reject(new Error(`the card's Electron exited (${String(code)}) without a result\n${out}\n${err}`));
    }));
  }

  /** One run a text size, shared by the checks on it. */
  const runs = new Map<string, Promise<Report>>();
  const report = (size: string): Promise<Report> => {
    if (!runs.has(size)) runs.set(size, run(size));
    return runs.get(size)!;
  };

  /** Nothing in the words runs into the buttons, the buttons into the task row, or the task row off the card. */
  function clear(l: Layout): void {
    for (const k of ["thought", "whole", "hint", "step"] as const) if (l[k].shown) expect(l[k].bottom, `${k} ends above the buttons`).toBeLessThanOrEqual(l.actions.top + 0.5);
    expect(l.actions.bottom).toBeLessThanOrEqual(l.task.top + 0.5);
    expect(l.task.bottom).toBeLessThanOrEqual(l.vh + 0.5);
  }

  for (const size of ["default", "large", "larger"]) {
    it(`keeps the question's sentence whole beside the text, clear of the buttons and the task row (${size} text)`, async () => {
      const r = await report(size);
      const { thought, whole, hint, step } = r.layout;
      // The sentence: all of it in view (never squeezed to nothing by the block under it).
      expect(thought.ch, "the sentence's lines in view").toBeGreaterThanOrEqual(Math.min(thought.sh, 2 * thought.lh) - 1);
      expect(thought.ch).toBeGreaterThanOrEqual(thought.sh - 1);
      // The block shows at least three lines, the read hint and the keys under it, the buttons and the task row after.
      expect(whole.ch).toBeGreaterThanOrEqual(3 * whole.lh - 1);
      expect(hint.shown && step.shown).toBe(true);
      clear(r.layout);
      // Not in view yet (it runs on): nothing said; at its end, said.
      expect(r.before).not.toContain("ui:seen:1");
      expect(r.scrolled).toContain("ui:seen:1");
      // Squeezed (the sentence can't show beside it): its end in view says nothing.
      expect(r.squeezedSent).not.toContain("ui:seen:2");
      // A short text that fits, once the card is fitted to it: in view at once.
      expect(r.fits).toContain("ui:seen:3");
    }, 90_000);

    it(`grows for an ordinary question until its sentence shows whole, and holds Allow on a card too small for it (accessibility-visual-1, ${size} text)`, async () => {
      const { plain } = await report(size);
      const { thought } = plain.layout;
      // Held to 360 px before, the sentence showed 30 of its 156 px at Larger: now all of it, clear of the buttons.
      expect(thought.ch, "the sentence in view whole").toBeGreaterThanOrEqual(thought.sh - 1);
      clear(plain.layout);
      expect(plain.held).toBeNull();
      // Squeezed (a work area too short for the card): Allow takes no press, and a real click on it says nothing.
      expect(plain.squeezedHeld).toBe("true");
      expect(plain.squeezedClick).toEqual([]);
      // Room again: Allow works.
      expect(plain.freedHeld).toBeNull();
      expect(plain.freedClick).toEqual(["q4:allow"]);
    }, 90_000);

    it(`shows a question's keys as keycaps beside their words, as the bubble does (accessibility-visual-r3, ${size} text)`, async () => {
      const { plain } = await report(size);
      // It was one grey run of text: "Ctrl+Alt+Y allow · Ctrl+Alt+N not now".
      expect(plain.keys.caps).toEqual(["Ctrl", "Alt", "Y", "Ctrl", "Alt", "N"]);
      expect(plain.keys.text).toBe("CtrlAltYallowCtrlAltNnot now");
      clear(plain.layout);
    }, 90_000);

    it(`gives each chord its own line, with no separator left alone at a line's end (accessibility-visual-r2-2, ${size} text)`, async () => {
      const { plain } = await report(size);
      // The two chords always wrapped in the card's column, and the first line ended "Ctrl Alt Y allow ·".
      expect(plain.keys.text).not.toContain("\u00b7");
      expect(plain.keys.hints.map(h => h.text)).toEqual(["CtrlAltYallow", "CtrlAltNnot now"]);
      const [first, second] = plain.keys.hints;
      expect(second.top, "the second chord starts on a line of its own").toBeGreaterThanOrEqual(first.bottom - 0.5);
      for (const h of plain.keys.hints) expect(h.right, `${h.text} fits the card's column`).toBeLessThanOrEqual(plain.keys.stepRight + 0.5);
    }, 90_000);

    it(`keeps a whole text's key hint inside the card, its words wrapping under their keycaps, with the Shift chords too (accessibility-visual-c3-1, ${size} text)`, async () => {
      const { wholeKeys, shiftKeys } = await report(size);
      // Before, each hint was one unbroken line: at Larger with the Shift chords its words reached 401 px of a 360 px
      // window ("Ctrl Alt Shift Y shows the nex"), at Large 374, and the plain chords' 358, into the card's padding.
      for (const [keys, caps] of [[wholeKeys, ["CtrlAltYshows the next part", "CtrlAltNnot now"]], [shiftKeys, ["CtrlAltShiftYshows the next part", "CtrlAltShiftNnot now"]]] as const) {
        expect(keys.hints.map(h => h.text)).toEqual(caps);
        for (const h of keys.hints) {
          expect(h.right, `${h.text}: its words end inside the card's column`).toBeLessThanOrEqual(keys.stepRight + 0.5);
          expect(new Set(h.capTops).size, `${h.text}: its keycaps stay together on one line`).toBe(1);
        }
        expect(keys.stepRight).toBeLessThanOrEqual(keys.winWidth);
      }
    }, 90_000);
  }
});
