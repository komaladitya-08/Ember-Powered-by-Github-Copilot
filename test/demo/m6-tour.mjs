// Records M6: Ember as a guide, and quick context.
// 1) "Show me how to turn on Night Light": Ember flies to the switch, points,
//    says what to do and waits; the user moves the mouse and clicks it.
// 2) The user selects text, then asks "What did I select?": Ember already knows,
//    because it took a snapshot of the window the moment it was called.
// The model is the offline scripted mock; windows, pointing and clicks are real.
// usage: DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m6-tour.mjs <out-dir>
import { _electron as electron } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import readline from "node:readline";
import { startMockLlm } from "../mock-llm/server.mjs";

const out = path.resolve(process.argv[2] ?? "dist/demo");
mkdirSync(out, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const display = process.env.DISPLAY ?? ":55";
const env = { ...process.env, DISPLAY: display };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const xdo = (...a) => execFileSync("xdotool", a, { env }).toString();
const shot = name => execFileSync("import", ["-window", "root", path.join(out, `${name}.png`)], { env });
const python = process.env.EMBER_PYTHON ?? "/usr/libexec/platform-python";

const text = m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const idOf = (messages, pattern) => {
  const screen = [...messages].reverse().find(m => m.role === "tool" && text(m).includes("<screen"));
  for (const line of text(screen).split(/\\n|\n/)) {
    const m = /\[(\d+)\] (.*)/.exec(line);
    if (m && pattern.test(m[2])) return Number(m[1]);
  }
  throw new Error(`no element ${pattern}`);
};

const mock = await startMockLlm({
  delayMs: 45,
  respond: (messages, tools) => {
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const ask = text(lastUser);
    const question = ask.trim().split("\n").at(-1);
    const afterUser = messages.slice(messages.lastIndexOf(lastUser) + 1);
    if (tools.includes("show_me")) {
      if (/show me/i.test(question)) {
        if (afterUser.some(m => m.role === "tool")) return { text: "Follow me, I'll point." };
        return { reasoning: "They want to learn, so I'll guide rather than do it.", tool: { name: "show_me", args: { goal: "Show me how to turn on Night Light" } } };
      }
      const sel = /Selected text: "([^"]*)"/.exec(ask)?.[1];
      const win = /window: "([^"]*)"/.exec(ask)?.[1];
      return { reasoning: "The context says what they had selected when they called me.", text: sel ? `You selected “${sel}” in ${win}.` : "I don't see a selection." };
    }
    const step = messages.filter(m => m.role === "tool").length;
    const plan = [
      () => ({ reasoning: "Let me find the Night Light switch.", tool: { name: "perceive_window", args: {} } }),
      () => ({ reasoning: "It's the switch next to the Night Light label.", tool: { name: "point_at", args: { id: idOf(messages, /^toggle button/), say: "Click this switch to turn Night Light on" } } }),
      () => ({ tool: { name: "wait_for_click", args: { id: idOf(messages, /^toggle button/), timeoutSeconds: 30 } } }),
      () => ({ tool: { name: "finish_task", args: { success: true, summary: "That's it: you turned on Night Light yourself." } } }),
    ];
    return (plan[step] ?? (() => ({ text: "Done." })))();
  },
});

const benchEvents = [];
const bench = spawn(python, [path.join(root, "test/fixtures/gtk3_bench.py")], { env, stdio: ["ignore", "pipe", "ignore"] });
readline.createInterface({ input: bench.stdout }).on("line", l => { try { benchEvents.push(JSON.parse(l)); } catch { /* not json */ } });
const userData = mkdtempSync(path.join(tmpdir(), "ember-m6-"));
writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 1, character: "glint", size: 64, speak: false, wakeWord: false, onboarded: true, consent: { version: 1, at: "2026-10-15T00:00:00.000Z" } }));
await sleep(2500);
xdo("search", "--sync", "--name", "Ember Test Bench", "windowactivate", "--sync");
const recorder = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "1", "-video_size", "1280x800", "-framerate", "30", "-i", display,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", path.join(out, "m6-tour.mp4")], { stdio: ["pipe", "inherit", "inherit"] });
xdo("mousemove", "1000", "650");
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)("electron"),
  args: [root, "--no-sandbox"],
  env: { ...env, EMBER_TEST_HOOKS: "1", EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: mock.baseUrl },
});
const typeAsk = async t => {
  xdo("key", "ctrl+alt+space");
  await sleep(900);
  xdo("type", "--delay", "35", t);
  await sleep(300);
  xdo("key", "Return");
};
const scale = 1;
const focusRect = () => app.evaluate(() => globalThis.__ember.overlay()?.getState().focus ?? null);
try {
  await sleep(4000);
  for (let i = 0; i < 40; i++) {
    if ((await app.evaluate(() => globalThis.__ember.agent()?.getStatus().phase)) === "ready") break;
    await sleep(250);
  }
  await typeAsk("Show me how to turn on Night Light");
  let f = null;
  for (let i = 0; i < 100 && !f; i++) { f = await focusRect(); await sleep(100); }
  await sleep(1500);
  shot("01-pointing");
  // The user follows Ember: moves to the switch and clicks it.
  if (f) {
    xdo("mousemove", "--sync", String(Math.round((f.x + f.width / 2) * scale)), String(Math.round((f.y + f.height / 2) * scale)));
    await sleep(900);
    xdo("click", "1");
  }
  for (let i = 0; i < 60; i++) {
    const tasks = await app.evaluate(() => globalThis.__ember.agent()?.tasks?.list().map(t => t.status) ?? []);
    if (tasks.length && tasks.every(s => s !== "running" && s !== "queued")) break;
    await sleep(250);
  }
  await sleep(900);
  shot("02-user-did-it");
  await sleep(2500);

  // Quick context: select "ship M3" in the notes, then ask.
  const nodes = await app.evaluate(async () => (await globalThis.__ember.perception().focused()).nodes.map(n => ({ role: n.role, name: n.name, bounds: n.bounds })));
  const notes = nodes.find(n => n.name === "Notes")?.bounds;
  if (notes) {
    xdo("mousemove", "--sync", String(notes.x + 9), String(notes.y + 26));
    await sleep(300);
    xdo("mousedown", "1");
    xdo("mousemove", "--sync", String(notes.x + 64), String(notes.y + 26));
    xdo("mouseup", "1");
    await sleep(600);
  }
  xdo("mousemove", "760", "600");
  await sleep(500);
  await typeAsk("What did I select?");
  await sleep(4500);
  shot("03-context");
  await sleep(3000);
} finally {
  await app.close();
  await mock.close();
  bench.kill();
  recorder.stdin.write("q");
  await new Promise(r => recorder.on("exit", r));
}
console.log(`bench events: ${benchEvents.map(e => `${e.event}:${e.name ?? ""}`).join(", ")}`);
console.log(`wrote ${out}`);
