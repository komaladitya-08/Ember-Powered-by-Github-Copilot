// Records M4: Ember works in a real app while the user keeps their mouse.
// The user asks Ember to fill in the GTK3 bench; the conductor starts a task;
// a worker reads the window and acts through accessibility (no cursor). Ember
// flies to each control, asks once before acting in a new app (the user clicks
// Allow), refuses the password field, and reports back. Then a tier-0 setting.
// The model is the offline scripted mock; the app, actions and policy are real.
// usage: DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m4-tour.mjs <out-dir>
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
      // The conductor: hand the job to a worker, then say so.
      if (afterUser.some(m => m.role === "tool")) {
        return { text: ask.includes("disturb") ? "Sure, muting banners now." : "On it! I'll fill that in while you carry on." };
      }
      const goal = ask.includes("disturb") ? "Turn on Do Not Disturb" : "In the test bench: turn on Night Light, enter the name Ada Lovelace, choose the Dark theme, and save";
      return { reasoning: "This is something to do in their apps, so I'll start a task for it.", tool: { name: "start_task", args: { goal } } };
    }
    // A worker.
    const goal = text(messages.find(m => m.role === "user")).toLowerCase();
    const step = messages.filter(m => m.role === "tool").length;
    if (goal.includes("disturb")) {
      if (step === 0) return { reasoning: "There's a direct setting for this; no need to open Settings.", tool: { name: "change_setting", args: { setting: "do_not_disturb", value: "on" } } };
      if (step === 1) return { tool: { name: "finish_task", args: { success: true, summary: "Do Not Disturb is on. Banners are hidden until you turn it off." } } };
      return { text: "Done." };
    }
    const plan = [
      () => ({ reasoning: "First I'll read the window to see its controls.", tool: { name: "perceive_window", args: {} } }),
      () => ({ reasoning: "The switch next to the Night Light label is the one to turn on.", tool: { name: "toggle", args: { id: idOf(messages, /^toggle button/), on: true } } }),
      () => ({ reasoning: "Now the name goes in the Name box.", tool: { name: "type_text", args: { id: idOf(messages, /^text "Name"/), text: "Ada Lovelace" } } }),
      () => ({ reasoning: "There's a password box too. Let me see if I should fill it.", tool: { name: "type_text", args: { id: idOf(messages, /^password text/), text: "hunter2" } } }),
      () => ({ reasoning: "Right, passwords are for them. Theme next: Dark.", tool: { name: "choose_option", args: { id: idOf(messages, /^combo box "Theme"/), option: "Dark" } } }),
      () => ({ reasoning: "Everything's set, so I'll press Save.", tool: { name: "click", args: { id: idOf(messages, /^push button "Save"/) } } }),
      () => ({ tool: { name: "finish_task", args: { success: true, summary: "Night Light is on, your name is in, the theme is Dark and it's saved. I left the password for you." } } }),
    ];
    return (plan[step] ?? (() => ({ text: "Done." })))();
  },
});

const benchEvents = [];
const bench = spawn(python, [path.join(root, "test/fixtures/gtk3_bench.py")], { env, stdio: ["ignore", "pipe", "ignore"] });
readline.createInterface({ input: bench.stdout }).on("line", l => { try { benchEvents.push(JSON.parse(l)); } catch { /* not json */ } });
const userData = mkdtempSync(path.join(tmpdir(), "ember-m4-"));
writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 1, character: "cinder", size: 64, speak: false, wakeWord: true, onboarded: true }));
execFileSync("gsettings", ["set", "org.gnome.desktop.notifications", "show-banners", "true"], { env });
await sleep(2500);
xdo("search", "--sync", "--name", "Ember Test Bench", "windowactivate", "--sync");

const recorder = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "1280x800", "-framerate", "30", "-i", display,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", path.join(out, "m4-tour.mp4")], { stdio: ["pipe", "inherit", "inherit"] });

xdo("mousemove", "760", "330");
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
const overlayPage = () => app.windows().find(w => w.url().includes("/renderer/overlay/"));
/** Clicks a bubble button with the real mouse, like a person would. */
const clickBubble = async label => {
  for (let i = 0; i < 60; i++) {
    const r = await overlayPage()?.evaluate(l => {
      const b = [...document.querySelectorAll(".eb-actions button")].find(x => x.textContent === l);
      const rect = b?.getBoundingClientRect();
      return rect && rect.width ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
    }, label).catch(() => null);
    if (r) {
      xdo("mousemove", String(Math.round(r.x)), String(Math.round(r.y)));
      await sleep(700);
      shot("03-asks-first");
      xdo("click", "1");
      return true;
    }
    await sleep(150);
  }
  return false;
};
try {
  await sleep(4000);
  for (let i = 0; i < 40; i++) {
    if ((await app.evaluate(() => globalThis.__ember.agent()?.getStatus().phase)) === "ready") break;
    await sleep(250);
  }
  await typeAsk("Fill in the test bench for me: Night Light on, name Ada Lovelace, dark theme, then save");
  await sleep(2600);
  shot("01-on-it");
  if (!(await clickBubble("Allow"))) console.log("no Allow button appeared");
  // The user goes back to their own thing while Ember works.
  xdo("mousemove", "1000", "640");
  await sleep(1200);
  shot("04-working");
  xdo("mousemove", "1100", "700");
  await sleep(2200);
  shot("05-working-2");
  for (let i = 0; i < 60; i++) {
    const tasks = await app.evaluate(() => globalThis.__ember.agent()?.tasks?.list().map(t => t.status) ?? []);
    if (tasks.length && tasks.every(s => s !== "running" && s !== "queued")) break;
    await sleep(250);
  }
  await sleep(1200);
  shot("06-done");
  await sleep(3500);
  xdo("mousemove", "820", "300");
  await sleep(600);
  await typeAsk("Turn on do not disturb please");
  await sleep(5000);
  shot("07-dnd");
  await sleep(2500);
} finally {
  await app.close();
  await mock.close();
  bench.kill();
  recorder.stdin.write("q");
  await new Promise(r => recorder.on("exit", r));
}
const banners = execFileSync("gsettings", ["get", "org.gnome.desktop.notifications", "show-banners"], { env }).toString().trim();
const auditDir = path.join(userData, "audit");
const audit = readdirSync(auditDir).flatMap(f => readFileSync(path.join(auditDir, f), "utf8").trim().split("\n"));
writeFileSync(path.join(out, "audit.jsonl"), audit.join("\n") + "\n");
writeFileSync(path.join(out, "bench-events.json"), JSON.stringify(benchEvents, null, 2) + "\n");
console.log(`bench events: ${benchEvents.map(e => `${e.event}:${e.name ?? ""}`).join(", ")}`);
console.log(`show-banners now ${banners}; audit lines ${audit.length}`);
execFileSync("gsettings", ["set", "org.gnome.desktop.notifications", "show-banners", "true"], { env });
console.log(`wrote ${out}`);
