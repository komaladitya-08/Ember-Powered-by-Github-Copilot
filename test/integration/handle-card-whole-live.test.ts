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
interface Report { size: string; height: number; layout: Layout; before: string[]; scrolled: string[]; squeezed: Layout; squeezedSent: string[]; fits: string[] }

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
  card.sendState(state(1, LONG));
  await sleep(1200);
  const height = card.win.getContentSize()[1];
  const layout = await measure();
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
  process.stdout.write("RESULT " + JSON.stringify({ size, height, layout, before, scrolled, squeezed, squeezedSent, fits: [...sent] }) + "\\n");
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

  /** Nothing in the words runs into the buttons, the buttons into the task row, or the task row off the card. */
  function clear(l: Layout): void {
    for (const k of ["thought", "whole", "hint", "step"] as const) if (l[k].shown) expect(l[k].bottom, `${k} ends above the buttons`).toBeLessThanOrEqual(l.actions.top + 0.5);
    expect(l.actions.bottom).toBeLessThanOrEqual(l.task.top + 0.5);
    expect(l.task.bottom).toBeLessThanOrEqual(l.vh + 0.5);
  }

  for (const size of ["default", "large", "larger"]) {
    it(`keeps the question's sentence whole beside the text, clear of the buttons and the task row (${size} text)`, async () => {
      const r = await run(size);
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
  }
});
