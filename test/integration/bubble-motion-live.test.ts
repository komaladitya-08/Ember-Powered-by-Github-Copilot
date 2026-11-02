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

/** The page's script: the real ReasoningBubble, driven through each sequence, sampling its scale and translate every frame. */
const PAGE = `
import { ReasoningBubble } from "./packages/bubble/src/bubble";
type Sample = { scale: string; translate: string; opacity: number };
const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function watch(b: ReasoningBubble, ms: number): Promise<Sample[]> {
  const out: Sample[] = [];
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const cs = getComputedStyle(b.root);
    out.push({ scale: cs.scale, translate: cs.translate, opacity: Number(cs.opacity) });
    await frame();
  }
  return out;
}
/** Shows a bubble posed as \`before\` (hidden), then a question: in one frame, or its mood a frame before it shows. */
async function question(before: string, sameFrame: boolean): Promise<Sample[]> {
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0";
  document.body.append(host);
  const b = new ReasoningBubble(host);
  b.setMood(before as never);
  b.setThought("Reading the window");
  b.setVisible(false);
  b.place({ x: 200, y: 120 }, { width: 900, height: 600 }, 60);
  await sleep(400);
  b.setMood("attention");
  b.setThought("May I click Send in Mail?");
  if (!sameFrame) await frame();
  b.setVisible(true);
  b.place({ x: 200, y: 120 }, { width: 900, height: 600 }, 60);
  const s = await watch(b, 600);
  host.remove();
  return s;
}
async function answer(): Promise<Sample[]> {
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0";
  document.body.append(host);
  const b = new ReasoningBubble(host);
  b.setThought("Revenue grew in every region.");
  b.setVisible(false);
  b.place({ x: 200, y: 120 }, { width: 900, height: 600 }, 60);
  await sleep(400);
  b.setVisible(true);
  b.place({ x: 200, y: 120 }, { width: 900, height: 600 }, 60);
  const s = await watch(b, 600);
  host.remove();
  return s;
}
(async () => {
  const result = {
    thinkingSame: await question("thinking", true),
    thinkingNext: await question("thinking", false),
    actingSame: await question("acting", true),
    idleNext: await question("idle", false),
    answer: await answer(),
  };
  (window as unknown as { done: unknown }).done = result;
})();
`;

const MAIN = `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.whenReady().then(async () => {
  setTimeout(() => app.exit(3), 30_000);
  const win = new BrowserWindow({ width: 1000, height: 700, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(path.join(__dirname, "page.html"));
  for (let i = 0; i < 200; i++) {
    const r = await win.webContents.executeJavaScript("window.done ?? null");
    if (r) { process.stdout.write("RESULT " + JSON.stringify(r) + "\\n"); app.exit(0); return; }
    await new Promise(r => setTimeout(r, 100));
  }
  app.exit(4);
});
`;

type Sample = { scale: string; translate: string; opacity: number };
type Result = Record<"thinkingSame" | "thinkingNext" | "actingSame" | "idleNext" | "answer", Sample[]>;

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
    const child = spawn(electronBinary(), [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), dir], { stdio: ["ignore", "pipe", "pipe"], env });
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
      expect(all.length).toBeGreaterThan(10);
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
});
