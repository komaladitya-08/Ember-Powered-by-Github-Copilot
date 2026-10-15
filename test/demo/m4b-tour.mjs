// Records M4 part 2: when accessibility can't do it, Ember borrows the mouse,
// only after the user says yes. It glides the real pointer (riding along),
// clicks, presses Ctrl+S, and hands the pointer back. In the second task the
// user grabs the mouse mid-way and Ember lets go at once.
// The model is the offline scripted mock; the app, input and policy are real.
// usage: DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m4b-tour.mjs <out-dir>
import { _electron as electron } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
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
    const ask = text(lastUser).toLowerCase();
    const afterUser = messages.slice(messages.lastIndexOf(lastUser) + 1);
    if (tools.includes("start_task")) {
      if (afterUser.some(m => m.role === "tool")) return { text: "On it." };
      const goal = ask.includes("scroll") ? "Scroll the notes down" : "Click the sketch pad, then save with Ctrl+S";
      return { reasoning: "That needs doing in their app, so I'll start a task.", tool: { name: "start_task", args: { goal } } };
    }
    const goal = text(messages.find(m => m.role === "user")).toLowerCase();
    const results = messages.filter(m => m.role === "tool");
    const step = results.length;
    const last = results.at(-1) ? text(results.at(-1)) : "";
    if (goal.includes("scroll")) {
      if (step === 0) return { reasoning: "I'll find the notes first.", tool: { name: "perceive_window", args: {} } };
      if (step === 1) return { reasoning: "Scrolling needs the mouse wheel, so I'll ask to borrow it.", tool: { name: "scroll", args: { id: idOf(messages, /^text "Notes"/), direction: "down", steps: 5 } } };
      if (step === 2) return { tool: { name: "finish_task", args: { success: false, summary: last.includes("took the mouse back") ? "You took the mouse back, so I stopped. The notes weren't scrolled." : "Scrolled the notes down." } } };
      return { text: "Done." };
    }
    if (step === 0) return { reasoning: "Let me look at the window.", tool: { name: "perceive_window", args: {} } };
    if (step === 1) return { reasoning: "The sketch pad is a plain area with no buttons; I'll click it.", tool: { name: "click", args: { id: idOf(messages, /"Sketch pad"/) } } };
    if (step === 2) return { reasoning: "Clicked. Now Ctrl+S to save.", tool: { name: "press_keys", args: { keys: "ctrl+s" } } };
    if (step === 3) return { tool: { name: "finish_task", args: { success: true, summary: "Clicked the sketch pad and saved with Ctrl+S. Your mouse is back where you left it." } } };
    return { text: "Done." };
  },
});

const benchEvents = [];
const bench = spawn(python, [path.join(root, "test/fixtures/gtk3_bench.py")], { env, stdio: ["ignore", "pipe", "ignore"] });
readline.createInterface({ input: bench.stdout }).on("line", l => { try { benchEvents.push(JSON.parse(l)); } catch { /* not json */ } });
const userData = mkdtempSync(path.join(tmpdir(), "ember-m4b-"));
writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 1, character: "glassling", size: 64, speak: false, wakeWord: true, onboarded: true, grants: { "gtk3_bench.py": "act" } }));
await sleep(2500);
xdo("search", "--sync", "--name", "Ember Test Bench", "windowactivate", "--sync");
const recorder = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "1", "-video_size", "1280x800", "-framerate", "30", "-i", display,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", path.join(out, "m4b-tour.mp4")], { stdio: ["pipe", "inherit", "inherit"] });

xdo("mousemove", "760", "330");
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)("electron"),
  args: [root, "--no-sandbox"],
  env: { ...env, EMBER_TEST_HOOKS: "1", EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: mock.baseUrl, EMBER_LOG_LEVEL: process.env.EMBER_LOG_LEVEL ?? "info" },
});
const typeAsk = async t => {
  xdo("key", "ctrl+alt+space");
  await sleep(900);
  xdo("type", "--delay", "35", t);
  await sleep(300);
  xdo("key", "Return");
};
const overlayPage = () => app.windows().find(w => w.url().includes("/renderer/overlay/"));
const clickBubble = async (label, name) => {
  for (let i = 0; i < 80; i++) {
    const r = await overlayPage()?.evaluate(l => {
      const b = [...document.querySelectorAll(".eb-actions button")].find(x => x.textContent === l);
      const rect = b?.getBoundingClientRect();
      return rect && rect.width ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
    }, label).catch(() => null);
    if (r) {
      await overlayPage()?.evaluate(() => {
        if (window.__ev) return;
        window.__ev = [];
        for (const t of ["pointerdown", "pointerup", "click"]) document.addEventListener(t, e => window.__ev.push(`${t}@${e.clientX},${e.clientY}:${e.target?.textContent?.slice(0, 10)}`), true);
      });
      xdo("mousemove", String(Math.round(r.x)), String(Math.round(r.y)));
      await sleep(800);
      shot(name);
      const r2 = await overlayPage()?.evaluate(l => {
        const b = [...document.querySelectorAll(".eb-actions button")].find(x => x.textContent === l);
        const rect = b?.getBoundingClientRect();
        return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
      }, label);
      xdo("click", "1");
      await sleep(200);
      if (process.env.DEBUG_TOUR) console.log(name, "at", JSON.stringify(r), "now", JSON.stringify(r2), "events", JSON.stringify((await overlayPage()?.evaluate(() => window.__ev.splice(0)))));
      return true;
    }
    await sleep(150);
  }
  console.log(`no ${label} button`);
  return false;
};
const status = () => app.evaluate(() => globalThis.__ember.overlay()?.getState().status ?? null);
const borrowing = async () => (await status())?.startsWith("Using your mouse") ?? false;
const waitTasks = async () => {
  for (let i = 0; i < 80; i++) {
    const tasks = await app.evaluate(() => globalThis.__ember.agent()?.tasks?.list().map(t => t.status) ?? []);
    if (tasks.length && tasks.every(s => s !== "running" && s !== "queued")) return;
    await sleep(250);
  }
};
try {
  await sleep(4000);
  for (let i = 0; i < 40; i++) {
    if ((await app.evaluate(() => globalThis.__ember.agent()?.getStatus().phase)) === "ready") break;
    await sleep(250);
  }
  await typeAsk("Click the sketch pad and save it");
  await clickBubble("Allow", "01-asks-to-borrow");
  for (let i = 0; i < 100 && !(await borrowing()); i++) await sleep(30);
  await sleep(250);
  shot("02-borrowing");
  await clickBubble("Allow", "03-asks-keys");
  await waitTasks();
  await sleep(800);
  shot("04-done-pointer-back");
  await sleep(3000);

  // The user changes their mind half-way.
  xdo("mousemove", "820", "300");
  await typeAsk("Scroll my notes down");
  await clickBubble("Allow", "05-asks-scroll");
  for (let i = 0; i < 200 && !(await borrowing()); i++) await sleep(15);
  await sleep(150);
  xdo("mousemove", "1050", "650");
  const t = Date.now();
  for (let i = 0; i < 50 && (await borrowing()); i++) await sleep(10);
  console.log(`Ember let go ${Date.now() - t} ms after the user moved (including polling)`);
  await waitTasks();
  await sleep(900);
  shot("06-user-took-over");
  await sleep(3000);
} finally {
  await app.close();
  await mock.close();
  bench.kill();
  recorder.stdin.write("q");
  await new Promise(r => recorder.on("exit", r));
}
const auditDir = path.join(userData, "audit");
const audit = readdirSync(auditDir).flatMap(f => readFileSync(path.join(auditDir, f), "utf8").trim().split("\n"));
writeFileSync(path.join(out, "audit.jsonl"), audit.join("\n") + "\n");
console.log(`bench events: ${benchEvents.map(e => `${e.event}:${e.name ?? ""}`).join(", ")}`);
console.log(`wrote ${out}`);
