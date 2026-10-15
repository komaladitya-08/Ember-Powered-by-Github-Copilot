// Records M7: Ember's desk. Asked to fill in a form "on your desk", Ember opens
// the app on its own private display and works there with full mouse and
// keyboard while the user keeps using their own screen; a mini-view shows the
// desk live. Then the user takes over the desk from the mini-view, types, and
// hands it back. The model is the offline scripted mock; everything else is real.
// usage: DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m7-tour.mjs <out-dir>
import { _electron as electron } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
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
  if (!screen) throw new Error("no screen read yet");
  for (const line of text(screen).split(/\\n|\n/)) {
    const m = /\[(\d+)\] (.*)/.exec(line);
    if (m && pattern.test(m[2])) return Number(m[1]);
  }
  throw new Error(`no element ${pattern}`);
};

const mock = await startMockLlm({
  delayMs: 50,
  respond: (messages, tools) => {
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const after = messages.slice(messages.lastIndexOf(lastUser) + 1);
    if (tools.includes("start_task")) {
      if (after.some(m => m.role === "tool")) return { text: "On it, on my desk. You carry on!" };
      return { reasoning: "This is a typing job; my desk is the place for it.", tool: { name: "start_task", args: { goal: "On your desk, fill in the Ember Bench form with the name Ada Lovelace, tick the sketch pad, and save with Ctrl+S" } } };
    }
    const step = messages.filter(m => m.role === "tool").length;
    const plan = [
      () => ({ reasoning: "I'll open the bench on my own desk so I don't get in their way.", tool: { name: "open_on_desk", args: { name: "Ember Bench" } } }),
      () => ({ reasoning: "Let me see the form.", tool: { name: "perceive_window", args: {} } }),
      () => ({ reasoning: "Name first.", tool: { name: "type_text", args: { id: idOf(messages, /^text "Name"/), text: "Ada Lovelace" } } }),
      () => ({ reasoning: "Theme: Dark.", tool: { name: "choose_option", args: { id: idOf(messages, /^combo box "Theme"/), option: "Dark" } } }),
      () => ({ reasoning: "The sketch pad only takes real clicks; on my desk I can just click it.", tool: { name: "click", args: { id: idOf(messages, /"Sketch pad"/) } } }),
      () => ({ reasoning: "Now save with Ctrl+S.", tool: { name: "press_keys", args: { keys: "ctrl+s" } } }),
      () => ({ tool: { name: "finish_task", args: { success: true, summary: "Done on my desk: name filled in, Dark theme, saved. Your screen was all yours." } } }),
    ];
    return (plan[step] ?? (() => ({ text: "Done." })))();
  },
});

// The bench as an installed app (a .desktop file), so Ember finds it like any other.
const userData = mkdtempSync(path.join(tmpdir(), "ember-m7-"));
const share = path.join(userData, "share");
mkdirSync(path.join(share, "applications"), { recursive: true });
writeFileSync(path.join(share, "applications", "ember-bench.desktop"), `[Desktop Entry]\nType=Application\nName=Ember Bench\nExec=${python} ${path.join(root, "test/fixtures/gtk3_bench.py")}\n`);
const benchLog = path.join(userData, "bench.jsonl");
writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 1, character: "cinder", size: 64, speak: false, wakeWord: false, onboarded: true }));

const recorder = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "1", "-video_size", "1280x800", "-framerate", "30", "-i", display,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", path.join(out, "m7-tour.mp4")], { stdio: ["pipe", "inherit", "inherit"] });
xdo("search", "--onlyvisible", "--name", "Mousepad", "windowactivate");
xdo("mousemove", "600", "350");
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)("electron"),
  args: [root, "--no-sandbox"],
  env: { ...env, EMBER_TEST_HOOKS: "1", EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: mock.baseUrl, XDG_DATA_HOME: share, EMBER_BENCH_LOG: benchLog },
});
const typeAsk = async t => {
  xdo("key", "ctrl+alt+space");
  await sleep(900);
  xdo("type", "--delay", "30", t);
  await sleep(300);
  xdo("key", "Return");
};
const deskPage = () => app.windows().find(w => w.url().includes("/renderer/desk/"));
const deskBounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(b => b.webContents.getURL().includes("/renderer/desk/"))?.getContentBounds() ?? null);
try {
  await sleep(4000);
  for (let i = 0; i < 40; i++) {
    if ((await app.evaluate(() => globalThis.__ember.agent()?.getStatus().phase)) === "ready") break;
    await sleep(250);
  }
  await typeAsk("On your desk, fill in the Ember Bench form for me and save it");
  // Meanwhile the user does their own thing on their own screen.
  for (let i = 0; i < 5; i++) { xdo("mousemove", String(200 + i * 60), String(260 + (i % 2) * 40)); await sleep(500); }
  shot("01-desk-working");
  for (let i = 0; i < 80; i++) {
    const tasks = await app.evaluate(() => globalThis.__ember.agent()?.tasks?.list().map(t => t.status) ?? []);
    if (tasks.length && tasks.every(s => s !== "running" && s !== "queued")) break;
    await sleep(250);
  }
  await sleep(1200);
  shot("02-desk-done");

  // The user takes over the desk from the mini-view.
  const b = await deskBounds();
  if (b) {
    const btn = await deskPage()?.evaluate(() => { const r = document.getElementById("control").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    xdo("mousemove", String(Math.round(b.x + btn.x)), String(Math.round(b.y + btn.y)));
    await sleep(600);
    xdo("click", "1");
    await sleep(1500);
    const nb = await deskBounds();
    // Click into the desk's Notes box (desk coords ~ (350, 450)) through the view, then type.
    const pt = await deskPage()?.evaluate(() => {
      const img = document.getElementById("screen").getBoundingClientRect();
      const s = Math.min(img.width / 1280, img.height / 800);
      const ox = img.left + (img.width - 1280 * s) / 2, oy = img.top + (img.height - 800 * s) / 2;
      return { x: ox + 350 * s, y: oy + 455 * s };
    });
    xdo("mousemove", String(Math.round(nb.x + pt.x)), String(Math.round(nb.y + pt.y)));
    await sleep(500);
    xdo("click", "1");
    await sleep(300);
    xdo("key", "ctrl+End");
    xdo("type", "--delay", "60", " - typed by me on Ember's desk");
    await sleep(1200);
    shot("03-user-took-over");
    const btn2 = await deskPage()?.evaluate(() => { const r = document.getElementById("control").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    xdo("mousemove", String(Math.round(nb.x + btn2.x)), String(Math.round(nb.y + btn2.y)));
    await sleep(500);
    xdo("click", "1");
    await sleep(1500);
    shot("04-handed-back");
  }
  await sleep(1500);
} finally {
  await app.close();
  await mock.close();
  recorder.stdin.write("q");
  await new Promise(r => recorder.on("exit", r));
}
const events = existsSync(benchLog) ? readFileSync(benchLog, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
console.log(`desk bench events: ${events.map(e => `${e.event}:${e.name ?? ""}${e.value ? "=" + JSON.stringify(e.value).slice(0, 60) : ""}`).join(", ")}`);
const leftover = execFileSync("sh", ["-c", "ls /tmp/.X11-unix/ | grep -c '^X9' || true"]).toString().trim();
console.log(`desk displays left after quit: ${leftover}`);
console.log(`wrote ${out}`);
